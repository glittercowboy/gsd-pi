/**
 * GSD Reports Registry
 *
 * Manages .gsd/reports/ — the persistent progression log of HTML snapshots.
 *
 * Layout:
 *   .gsd/reports/
 *     reports.json          lightweight metadata index (never re-parses HTML)
 *     index.html            auto-regenerated on every new snapshot
 *     M001-20260101T120000.html    per-milestone snapshot
 *     final-20260201T090000.html   full-project final snapshot
 *
 * Auto-triggered: after each milestone completion (when auto_report: true).
 * Manual: /gsd export --html
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { gsdRoot } from './paths.js';
import { formatCost, formatTokenCount } from './metrics.js';
import { formatDuration } from './history.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReportEntry {
  /** Filename relative to the reports/ dir, e.g. "M001-20260101T120000.html" */
  filename: string;
  /** ISO timestamp when this report was generated */
  generatedAt: string;
  /** Milestone ID this snapshot covers, or "final" for a full-project snapshot */
  milestoneId: string | 'final';
  /** Milestone title at snapshot time */
  milestoneTitle: string;
  /** Human-readable label shown in the index */
  label: string;
  /** Snapshot kind */
  kind: 'milestone' | 'manual' | 'final';
  // Metrics at snapshot time — for the index progression view
  totalCost: number;
  totalTokens: number;
  totalDuration: number;
  doneSlices: number;
  totalSlices: number;
  doneMilestones: number;
  totalMilestones: number;
  phase: string;
}

export interface ReportsIndex {
  version: 1;
  projectName: string;
  projectPath: string;
  gsdVersion: string;
  entries: ReportEntry[];
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function reportsDir(basePath: string): string {
  return join(gsdRoot(basePath), 'reports');
}

function reportsIndexPath(basePath: string): string {
  return join(reportsDir(basePath), 'reports.json');
}

function reportsHtmlIndexPath(basePath: string): string {
  return join(reportsDir(basePath), 'index.html');
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export function loadReportsIndex(basePath: string): ReportsIndex | null {
  const p = reportsIndexPath(basePath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ReportsIndex;
  } catch {
    return null;
  }
}

function saveReportsIndex(basePath: string, index: ReportsIndex): void {
  const dir = reportsDir(basePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(reportsIndexPath(basePath), JSON.stringify(index, null, 2) + '\n', 'utf-8');
}

// ─── Write a report snapshot ──────────────────────────────────────────────────

export interface WriteReportSnapshotArgs {
  basePath: string;
  html: string;
  milestoneId: string | 'final';
  milestoneTitle: string;
  kind: 'milestone' | 'manual' | 'final';
  projectName: string;
  projectPath: string;
  gsdVersion: string;
  // metrics
  totalCost: number;
  totalTokens: number;
  totalDuration: number;
  doneSlices: number;
  totalSlices: number;
  doneMilestones: number;
  totalMilestones: number;
  phase: string;
}

/**
 * Write a report snapshot to .gsd/reports/, update reports.json, regenerate index.html.
 * Returns the path of the written report file.
 */
export function writeReportSnapshot(args: WriteReportSnapshotArgs): string {
  const dir = reportsDir(args.basePath);
  mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = args.milestoneId === 'final' ? 'final' : args.milestoneId;
  const filename = `${prefix}-${timestamp}.html`;
  const filePath = join(dir, filename);

  writeFileSync(filePath, args.html, 'utf-8');

  // Load or init registry
  const existing = loadReportsIndex(args.basePath);
  const index: ReportsIndex = existing ?? {
    version: 1,
    projectName: args.projectName,
    projectPath: args.projectPath,
    gsdVersion: args.gsdVersion,
    entries: [],
  };

  // Keep metadata fresh
  index.projectName = args.projectName;
  index.projectPath = args.projectPath;
  index.gsdVersion = args.gsdVersion;

  const label = args.milestoneId === 'final'
    ? 'Final Report'
    : `${args.milestoneId}: ${args.milestoneTitle}`;

  const entry: ReportEntry = {
    filename,
    generatedAt: new Date().toISOString(),
    milestoneId: args.milestoneId,
    milestoneTitle: args.milestoneTitle,
    label,
    kind: args.kind,
    totalCost: args.totalCost,
    totalTokens: args.totalTokens,
    totalDuration: args.totalDuration,
    doneSlices: args.doneSlices,
    totalSlices: args.totalSlices,
    doneMilestones: args.doneMilestones,
    totalMilestones: args.totalMilestones,
    phase: args.phase,
  };

  index.entries.push(entry);
  saveReportsIndex(args.basePath, index);
  regenerateHtmlIndex(args.basePath, index);

  return filePath;
}

// ─── HTML Index Generator ─────────────────────────────────────────────────────

export function regenerateHtmlIndex(basePath: string, index: ReportsIndex): void {
  const html = buildIndexHtml(index);
  writeFileSync(reportsHtmlIndexPath(basePath), html, 'utf-8');
}

function buildIndexHtml(index: ReportsIndex): string {
  const { projectName, projectPath, gsdVersion, entries } = index;
  const generated = new Date().toISOString();

  // Sort oldest → newest for the progression timeline
  const sorted = [...entries].sort(
    (a, b) => new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime()
  );

  const latestEntry = sorted[sorted.length - 1];
  const overallPct = latestEntry
    ? (latestEntry.totalSlices > 0
        ? Math.round((latestEntry.doneSlices / latestEntry.totalSlices) * 100)
        : 0)
    : 0;

  // TOC: group by milestone
  const milestoneGroups = new Map<string, ReportEntry[]>();
  for (const e of sorted) {
    const key = e.milestoneId;
    const arr = milestoneGroups.get(key) ?? [];
    arr.push(e);
    milestoneGroups.set(key, arr);
  }

  const tocHtml = [...milestoneGroups.entries()].map(([mid, group]) => {
    const links = group.map(e =>
      `<li><a href="${esc(e.filename)}">${formatDateShort(e.generatedAt)}</a> <span class="toc-kind toc-${e.kind}">${e.kind}</span></li>`
    ).join('');
    return `
      <div class="toc-group">
        <div class="toc-group-label">${esc(mid === 'final' ? 'Final' : mid)}</div>
        <ul>${links}</ul>
      </div>`;
  }).join('');

  // Progression cards
  const cardHtml = sorted.map((e, i) => {
    const pct = e.totalSlices > 0 ? Math.round((e.doneSlices / e.totalSlices) * 100) : 0;
    const isLatest = i === sorted.length - 1;

    // Delta vs previous
    let deltaHtml = '';
    if (i > 0) {
      const prev = sorted[i - 1];
      const dCost = e.totalCost - prev.totalCost;
      const dSlices = e.doneSlices - prev.doneSlices;
      const dMillestones = e.doneMilestones - prev.doneMilestones;
      const parts: string[] = [];
      if (dCost > 0) parts.push(`+${formatCost(dCost)}`);
      if (dSlices > 0) parts.push(`+${dSlices} slice${dSlices !== 1 ? 's' : ''}`);
      if (dMillestones > 0) parts.push(`+${dMillestones} milestone${dMillestones !== 1 ? 's' : ''}`);
      if (parts.length > 0) {
        deltaHtml = `<div class="card-delta">${parts.map(p => `<span>${esc(p)}</span>`).join('')}</div>`;
      }
    }

    return `
      <a class="report-card${isLatest ? ' card-latest' : ''}" href="${esc(e.filename)}">
        <div class="card-top">
          <span class="card-label">${esc(e.label)}</span>
          <span class="card-kind card-kind-${e.kind}">${e.kind}</span>
        </div>
        <div class="card-date">${formatDateShort(e.generatedAt)}</div>
        <div class="card-progress">
          <div class="card-bar-track">
            <div class="card-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="card-pct">${pct}%</span>
        </div>
        <div class="card-stats">
          <span>${esc(formatCost(e.totalCost))}</span>
          <span>${esc(formatTokenCount(e.totalTokens))}</span>
          <span>${esc(formatDuration(e.totalDuration))}</span>
          <span>${e.doneSlices}/${e.totalSlices} slices</span>
        </div>
        ${deltaHtml}
        ${isLatest ? '<div class="card-latest-badge">Latest</div>' : ''}
      </a>`;
  }).join('');

  // Cost progression mini-chart (inline SVG sparkline)
  const sparklineSvg = sorted.length > 1 ? buildCostSparkline(sorted) : '';

  // Summary of latest state
  const summaryHtml = latestEntry ? `
    <div class="idx-summary">
      <div class="idx-stat"><span class="idx-val">${formatCost(latestEntry.totalCost)}</span><span class="idx-lbl">Total Cost</span></div>
      <div class="idx-stat"><span class="idx-val">${formatTokenCount(latestEntry.totalTokens)}</span><span class="idx-lbl">Total Tokens</span></div>
      <div class="idx-stat"><span class="idx-val">${formatDuration(latestEntry.totalDuration)}</span><span class="idx-lbl">Duration</span></div>
      <div class="idx-stat"><span class="idx-val">${latestEntry.doneSlices}/${latestEntry.totalSlices}</span><span class="idx-lbl">Slices</span></div>
      <div class="idx-stat"><span class="idx-val">${latestEntry.doneMilestones}/${latestEntry.totalMilestones}</span><span class="idx-lbl">Milestones</span></div>
      <div class="idx-stat"><span class="idx-val">${entries.length}</span><span class="idx-lbl">Reports</span></div>
    </div>
    <div class="idx-progress">
      <div class="idx-bar-track"><div class="idx-bar-fill" style="width:${overallPct}%"></div></div>
      <span class="idx-pct">${overallPct}% complete</span>
    </div>` : '<p class="empty">No reports generated yet.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GSD Reports — ${esc(projectName)}</title>
<style>${INDEX_CSS}</style>
</head>
<body>
<header>
  <div class="hdr-inner">
    <div class="branding">
      <span class="logo">GSD</span>
      <span class="ver">v${esc(gsdVersion)}</span>
    </div>
    <div class="hdr-meta">
      <h1>${esc(projectName)} <span class="hdr-subtitle">Reports</span></h1>
      <span class="hdr-path">${esc(projectPath)}</span>
    </div>
    <div class="hdr-right">
      <span class="gen-lbl">Updated</span>
      <span class="gen">${formatDateShort(generated)}</span>
    </div>
  </div>
</header>

<div class="layout">
  <!-- Sidebar TOC -->
  <aside class="sidebar">
    <div class="sidebar-title">Reports</div>
    ${sorted.length > 0 ? tocHtml : '<p class="empty">No reports yet.</p>'}
  </aside>

  <!-- Main content -->
  <main>
    <section class="idx-overview">
      <h2>Project Overview</h2>
      ${summaryHtml}
      ${sparklineSvg ? `<div class="sparkline-wrap"><h3>Cost Progression</h3>${sparklineSvg}</div>` : ''}
    </section>

    <section class="idx-cards">
      <h2>Progression <span class="sec-count">${entries.length}</span></h2>
      ${sorted.length > 0
        ? `<div class="cards-grid">${cardHtml}</div>`
        : '<p class="empty">No reports generated yet. Run <code>/gsd export --html</code> or enable <code>auto_report: true</code>.</p>'}
    </section>
  </main>
</div>

<footer>
  <div class="ftr-inner">
    <span class="ftr-brand">GSD v${esc(gsdVersion)}</span>
    <span class="ftr-sep">—</span>
    <span>${esc(projectName)}</span>
    <span class="ftr-sep">—</span>
    <span>${esc(projectPath)}</span>
    <span class="ftr-sep">—</span>
    <span>Updated ${formatDateShort(generated)}</span>
  </div>
</footer>
</body>
</html>`;
}

// ─── Cost sparkline (inline SVG) ──────────────────────────────────────────────

function buildCostSparkline(entries: ReportEntry[]): string {
  const costs = entries.map(e => e.totalCost);
  const maxCost = Math.max(...costs, 0.001);
  const W = 600, H = 60, PAD = 12;
  const xStep = entries.length > 1 ? (W - PAD * 2) / (entries.length - 1) : W - PAD * 2;

  const points = costs.map((c, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - c / maxCost) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const dots = costs.map((c, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - c / maxCost) * (H - PAD * 2);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="spark-dot">
      <title>${esc(entries[i].label)} — ${formatCost(c)}</title>
    </circle>`;
  }).join('');

  // Labels at start and end
  const startLabel = formatCost(costs[0]);
  const endLabel   = formatCost(costs[costs.length - 1]);

  return `
    <div class="sparkline">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="spark-svg">
        <polyline points="${esc(points)}" class="spark-line" fill="none"/>
        ${dots}
        <text x="${PAD}" y="${H - 2}" class="spark-lbl">${esc(startLabel)}</text>
        <text x="${W - PAD}" y="${H - 2}" text-anchor="end" class="spark-lbl">${esc(endLabel)}</text>
      </svg>
      <div class="spark-axis">
        ${entries.map((e, i) => {
          const x = (PAD + i * xStep) / W * 100;
          return `<span class="spark-tick" style="left:${x.toFixed(1)}%" title="${esc(e.generatedAt)}">${esc(e.milestoneId === 'final' ? 'final' : e.milestoneId)}</span>`;
        }).join('')}
      </div>
    </div>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function esc(s: string | number | undefined | null): string {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Index CSS ────────────────────────────────────────────────────────────────

const INDEX_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--bg4:#2d333b;
  --border:#30363d;--border2:#444c56;
  --text:#e6edf3;--text2:#8b949e;--text3:#6e7681;
  --accent:#58a6ff;--green:#3fb950;--yellow:#d29922;
  --red:#f85149;--purple:#bc8cff;--orange:#ffa657;--teal:#39d353;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif;
  --mono:'JetBrains Mono','Fira Code',ui-monospace,monospace;
  --r:8px;--r-sm:4px;
}
html{font-size:14px}
body{background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.6}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h2{font-size:18px;font-weight:700;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid var(--border)}
h3{font-size:14px;font-weight:600;color:var(--text2);margin:16px 0 8px}
code{font-family:var(--mono);font-size:12px;background:var(--bg3);padding:1px 5px;border-radius:3px;color:var(--accent)}
.empty{color:var(--text3);font-style:italic;font-size:13px;padding:8px 0}
.sec-count{font-size:12px;font-weight:600;color:var(--text3);background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:1px 8px}

/* Header */
header{background:var(--bg2);border-bottom:2px solid var(--border);padding:14px 32px;position:sticky;top:0;z-index:100}
.hdr-inner{display:flex;align-items:center;gap:16px;max-width:1440px;margin:0 auto}
.branding{display:flex;align-items:baseline;gap:6px;flex-shrink:0}
.logo{font-size:22px;font-weight:900;letter-spacing:-1px;background:linear-gradient(135deg,var(--accent),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.ver{font-size:11px;color:var(--text3);font-family:var(--mono)}
.hdr-meta{flex:1;min-width:0}
.hdr-meta h1{font-size:18px;font-weight:700}
.hdr-subtitle{color:var(--text3);font-weight:400;font-size:15px;margin-left:4px}
.hdr-path{font-size:11px;color:var(--text3);font-family:var(--mono);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hdr-right{text-align:right;flex-shrink:0}
.gen-lbl{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;display:block}
.gen{font-size:12px;color:var(--text2)}

/* Layout */
.layout{display:grid;grid-template-columns:220px 1fr;gap:0;max-width:1440px;margin:0 auto;min-height:calc(100vh - 130px)}

/* Sidebar */
.sidebar{background:var(--bg2);border-right:1px solid var(--border);padding:24px 16px;position:sticky;top:66px;height:calc(100vh - 66px);overflow-y:auto}
.sidebar-title{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
.toc-group{margin-bottom:16px}
.toc-group-label{font-size:11px;font-weight:700;color:var(--text2);margin-bottom:4px;font-family:var(--mono)}
.toc-group ul{list-style:none;display:flex;flex-direction:column;gap:2px}
.toc-group li{display:flex;align-items:center;gap:6px}
.toc-group a{font-size:12px;color:var(--text2);padding:3px 6px;border-radius:4px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toc-group a:hover{background:var(--bg3);color:var(--text)}
.toc-kind{font-size:10px;padding:1px 5px;border-radius:8px;font-weight:600;flex-shrink:0}
.toc-milestone{background:rgba(88,166,255,.15);color:var(--accent)}
.toc-manual{background:rgba(188,140,255,.15);color:var(--purple)}
.toc-final{background:rgba(63,185,80,.15);color:var(--green)}

/* Main */
main{padding:32px;display:flex;flex-direction:column;gap:48px}

/* Overview */
.idx-summary{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.idx-stat{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:12px 16px;display:flex;flex-direction:column;gap:3px;min-width:110px}
.idx-val{font-size:20px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums}
.idx-lbl{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}
.idx-progress{display:flex;align-items:center;gap:10px;margin-top:10px}
.idx-bar-track{flex:1;height:8px;background:var(--bg3);border-radius:4px;overflow:hidden}
.idx-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--green));border-radius:4px}
.idx-pct{font-size:13px;font-weight:600;color:var(--text2);min-width:80px;text-align:right}

/* Sparkline */
.sparkline-wrap{margin-top:20px}
.sparkline{position:relative}
.spark-svg{display:block;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);overflow:visible;max-width:100%}
.spark-line{stroke:var(--accent);stroke-width:2;fill:none}
.spark-dot{fill:var(--accent);stroke:var(--bg2);stroke-width:2;cursor:pointer}
.spark-dot:hover{fill:var(--purple);r:5}
.spark-lbl{font-size:10px;fill:var(--text3);font-family:var(--mono)}
.spark-axis{display:flex;position:relative;height:20px;margin-top:2px}
.spark-tick{position:absolute;transform:translateX(-50%);font-size:10px;color:var(--text3);font-family:var(--mono);white-space:nowrap}

/* Report cards */
.cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.report-card{
  display:flex;flex-direction:column;gap:8px;
  background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);
  padding:16px;text-decoration:none;color:var(--text);
  transition:border-color .15s,background .15s;position:relative;
}
.report-card:hover{border-color:var(--accent);background:var(--bg3);text-decoration:none}
.card-latest{border-color:var(--green)!important;background:rgba(63,185,80,.04)!important}
.card-top{display:flex;align-items:center;gap:8px}
.card-label{flex:1;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-kind{font-size:10px;padding:2px 7px;border-radius:8px;font-weight:700;flex-shrink:0}
.card-kind-milestone{background:rgba(88,166,255,.15);color:var(--accent)}
.card-kind-manual{background:rgba(188,140,255,.15);color:var(--purple)}
.card-kind-final{background:rgba(63,185,80,.15);color:var(--green)}
.card-date{font-size:11px;color:var(--text3)}
.card-progress{display:flex;align-items:center;gap:8px}
.card-bar-track{flex:1;height:6px;background:var(--bg3);border-radius:3px;overflow:hidden}
.card-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--green));border-radius:3px}
.card-pct{font-size:11px;color:var(--text2);min-width:34px;text-align:right}
.card-stats{display:flex;gap:8px;flex-wrap:wrap}
.card-stats span{font-size:11px;color:var(--text3);font-variant-numeric:tabular-nums}
.card-delta{display:flex;gap:6px;flex-wrap:wrap}
.card-delta span{font-size:11px;color:var(--green);background:rgba(63,185,80,.1);border-radius:4px;padding:1px 6px}
.card-latest-badge{position:absolute;top:10px;right:10px;font-size:10px;font-weight:700;color:var(--green);background:rgba(63,185,80,.12);border:1px solid rgba(63,185,80,.3);border-radius:8px;padding:2px 8px}

/* Footer */
footer{border-top:1px solid var(--border);padding:20px 32px;background:var(--bg2)}
.ftr-inner{display:flex;align-items:center;gap:8px;justify-content:center;font-size:12px;color:var(--text3);flex-wrap:wrap}
.ftr-brand{font-weight:700;color:var(--text2)}
.ftr-sep{color:var(--border2)}

@media(max-width:768px){
  .layout{grid-template-columns:1fr}
  .sidebar{position:static;height:auto;border-right:none;border-bottom:1px solid var(--border)}
}
@media print{
  .sidebar{display:none}
  header{position:static}
  body{background:#fff;color:#000}
  :root{--bg:#fff;--bg2:#f6f8fa;--bg3:#f0f3f6;--border:#d0d7de;--text:#1f2328;--text2:#57606a;--text3:#8c959f;--accent:#0969da;--green:#1a7f37}
  .logo{background:none;-webkit-text-fill-color:var(--accent)}
}
`;
