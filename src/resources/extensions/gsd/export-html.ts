/**
 * GSD HTML Report Generator
 *
 * Produces a single self-contained HTML file with:
 *   - Branding header (project name, path, GSD version, generated timestamp)
 *   - Project summary & overall progress
 *   - Health & configuration overview
 *   - Progress tree (milestones → slices → tasks, with critical path)
 *   - Slice dependency graph (SVG DAG per milestone)
 *   - Cost & token metrics (bar charts, phase/slice/model/tier breakdowns)
 *   - Execution timeline (chronological unit history)
 *   - Changelog (completed slice summaries + file modifications)
 *   - Knowledge base (rules, patterns, lessons)
 *   - Captures log
 *   - Milestone planning / discussion state
 *
 * No external dependencies — all CSS and JS is inlined.
 * Printable to PDF from any browser.
 */

import type {
  VisualizerData,
  VisualizerMilestone,
  VisualizerSlice,
} from './visualizer-data.js';
import { formatDuration } from './history.js';
import { formatCost, formatTokenCount } from './metrics.js';

// ─── Public API ────────────────────────────────────────────────────────────────

export interface HtmlReportOptions {
  projectName: string;
  projectPath: string;
  gsdVersion: string;
  /** Set when this is a per-milestone snapshot */
  milestoneId?: string;
  /** Relative path back to the reports index */
  indexRelPath?: string;
}

export function generateHtmlReport(
  data: VisualizerData,
  opts: HtmlReportOptions,
): string {
  const generated = new Date().toISOString();

  const sections = [
    buildSummarySection(data, opts, generated),
    buildHealthSection(data),
    buildProgressSection(data),
    buildDepGraphSection(data),
    buildMetricsSection(data),
    buildTimelineSection(data),
    buildChangelogSection(data),
    buildKnowledgeSection(data),
    buildCapturesSection(data),
    buildDiscussionSection(data),
  ];

  const milestoneTag = opts.milestoneId
    ? ` <span class="header-sep">/</span> <span class="header-mid">${esc(opts.milestoneId)}</span>`
    : '';

  const backLink = opts.indexRelPath
    ? `<a class="back-link" href="${esc(opts.indexRelPath)}">← All Reports</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GSD Report — ${esc(opts.projectName)}${opts.milestoneId ? ` — ${esc(opts.milestoneId)}` : ''}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="branding">
      <span class="logo">GSD</span>
      <span class="version">v${esc(opts.gsdVersion)}</span>
    </div>
    <div class="header-meta">
      <h1>${esc(opts.projectName)}${milestoneTag}</h1>
      <span class="header-path">${esc(opts.projectPath)}</span>
    </div>
    <div class="header-right">
      ${backLink}
      <span class="generated-label">Generated</span>
      <span class="generated">${formatDateLong(generated)}</span>
    </div>
  </div>
</header>
<nav class="toc" aria-label="Report sections">
  <ul>
    <li><a href="#summary">Summary</a></li>
    <li><a href="#health">Health</a></li>
    <li><a href="#progress">Progress</a></li>
    <li><a href="#depgraph">Dependencies</a></li>
    <li><a href="#metrics">Metrics</a></li>
    <li><a href="#timeline">Timeline</a></li>
    <li><a href="#changelog">Changelog</a></li>
    <li><a href="#knowledge">Knowledge</a></li>
    <li><a href="#captures">Captures</a></li>
    <li><a href="#discussion">Planning</a></li>
  </ul>
</nav>
<main>
${sections.join('\n')}
</main>
<footer>
  <div class="footer-inner">
    <span class="footer-brand">GSD v${esc(opts.gsdVersion)}</span>
    <span class="footer-sep">—</span>
    <span>${esc(opts.projectName)}</span>
    ${opts.milestoneId ? `<span class="footer-sep">—</span><span class="footer-mid">${esc(opts.milestoneId)}</span>` : ''}
    <span class="footer-sep">—</span>
    <span>${formatDateLong(generated)}</span>
    ${backLink ? `<span class="footer-sep">—</span>${backLink}` : ''}
  </div>
</footer>
<script>${JS}</script>
</body>
</html>`;
}

// ─── Section: Summary ─────────────────────────────────────────────────────────

function buildSummarySection(
  data: VisualizerData,
  opts: HtmlReportOptions,
  generated: string,
): string {
  const t = data.totals;
  const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
  const doneSlices  = data.milestones.reduce((s, m) => s + m.slices.filter(sl => sl.done).length, 0);
  const doneMilestones = data.milestones.filter(m => m.status === 'complete').length;
  const activeMilestone = data.milestones.find(m => m.status === 'active');
  const pct = totalSlices > 0 ? Math.round((doneSlices / totalSlices) * 100) : 0;

  const statCards = [
    stat('Milestones', `${doneMilestones} / ${data.milestones.length}`),
    stat('Slices', `${doneSlices} / ${totalSlices}`),
    stat('Phase', data.phase),
    t ? stat('Total Cost', formatCost(t.cost)) : '',
    t ? stat('Total Tokens', formatTokenCount(t.tokens.total)) : '',
    t ? stat('Duration', formatDuration(t.duration)) : '',
    t ? stat('Tool Calls', String(t.toolCalls)) : '',
    t ? stat('Units Run', String(t.units)) : '',
    data.remainingSliceCount > 0 ? stat('Remaining Slices', String(data.remainingSliceCount)) : '',
  ].filter(Boolean).join('');

  const activityHtml = data.agentActivity?.active ? `
    <div class="activity-badge">
      <span class="pulse"></span>
      Agent running — ${esc(data.agentActivity.currentUnit?.type ?? '')}
      <span class="activity-id">${esc(data.agentActivity.currentUnit?.id ?? '')}</span>
      — ${formatDuration(data.agentActivity.elapsed)} elapsed
    </div>` : '';

  const activeSliceHtml = activeMilestone ? (() => {
    const active = activeMilestone.slices.find(s => s.active);
    if (!active) return '';
    return `<div class="active-slice-info">
      Currently executing: <strong>${esc(activeMilestone.id)}</strong> /
      <strong>${esc(active.id)}</strong> — ${esc(active.title)}
    </div>`;
  })() : '';

  return section('summary', 'Summary', `
    <div class="stat-grid">${statCards}</div>
    <div class="progress-bar-wrap">
      <div class="progress-bar-track">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
      <span class="progress-pct">${pct}% complete</span>
    </div>
    ${activeSliceHtml}
    ${activityHtml}
  `);
}

// ─── Section: Health ──────────────────────────────────────────────────────────

function buildHealthSection(data: VisualizerData): string {
  const h = data.health;
  const t = data.totals;

  const rows: string[] = [];
  rows.push(healthRow('Token profile', h.tokenProfile));
  if (h.budgetCeiling !== undefined) {
    const spent = t?.cost ?? 0;
    const pct = (spent / h.budgetCeiling) * 100;
    const status = pct > 90 ? 'warn' : pct > 75 ? 'caution' : 'ok';
    rows.push(healthRow(
      'Budget ceiling',
      `${formatCost(h.budgetCeiling)} (${formatCost(spent)} spent, ${pct.toFixed(0)}% used)`,
      status,
    ));
  }
  rows.push(healthRow(
    'Truncation rate',
    `${h.truncationRate.toFixed(1)}% per unit`,
    h.truncationRate > 20 ? 'warn' : h.truncationRate > 10 ? 'caution' : 'ok',
  ));
  rows.push(healthRow(
    'Continue-here rate',
    `${h.continueHereRate.toFixed(1)}% per unit`,
    h.continueHereRate > 15 ? 'warn' : h.continueHereRate > 8 ? 'caution' : 'ok',
  ));
  if (h.tierSavingsLine) rows.push(healthRow('Routing savings', h.tierSavingsLine));
  rows.push(healthRow('Tool calls', String(h.toolCalls)));
  rows.push(healthRow('Assistant messages', String(h.assistantMessages)));
  rows.push(healthRow('User messages', String(h.userMessages)));

  const tierRows = h.tierBreakdown.length > 0 ? `
    <h3>Model Tier Breakdown</h3>
    <table class="data-table">
      <thead><tr><th>Tier</th><th>Units</th><th>Cost</th><th>Tokens</th></tr></thead>
      <tbody>
        ${h.tierBreakdown.map(tb =>
          `<tr><td><span class="tier-badge tier-${tb.tier}">${esc(tb.tier)}</span></td>
           <td>${tb.units}</td><td>${formatCost(tb.cost)}</td>
           <td>${formatTokenCount(tb.tokens.total)}</td></tr>`
        ).join('')}
      </tbody>
    </table>` : '';

  return section('health', 'Health &amp; Configuration', `
    <table class="data-table health-table"><tbody>${rows.join('')}</tbody></table>
    ${tierRows}
  `);
}

// ─── Section: Progress ────────────────────────────────────────────────────────

function buildProgressSection(data: VisualizerData): string {
  if (data.milestones.length === 0) {
    return section('progress', 'Progress', '<p class="empty">No milestones found.</p>');
  }

  const critMS = new Set(data.criticalPath.milestonePath);
  const critSL = new Set(data.criticalPath.slicePath);

  const msHtml = data.milestones.map(ms => {
    const doneCount = ms.slices.filter(s => s.done).length;
    const onCrit = critMS.has(ms.id);
    const sliceHtml = ms.slices.length > 0
      ? ms.slices.map(sl => buildSliceRow(sl, critSL, data)).join('')
      : '<p class="empty indent">No slices in roadmap yet.</p>';

    return `
      <details class="ms-block ms-${ms.status}" ${ms.status !== 'pending' ? 'open' : ''}>
        <summary>
          <span class="status-icon">${msStatusIcon(ms.status)}</span>
          <span class="ms-id">${esc(ms.id)}</span>
          <span class="ms-title">${esc(ms.title)}</span>
          <span class="ms-progress">${doneCount}/${ms.slices.length} slices</span>
          ${onCrit ? '<span class="badge badge-critical">critical path</span>' : ''}
          ${ms.dependsOn.length > 0 ? `<span class="ms-deps">needs: ${ms.dependsOn.map(esc).join(', ')}</span>` : ''}
        </summary>
        <div class="slice-list">${sliceHtml}</div>
      </details>`;
  }).join('');

  return section('progress', 'Progress', msHtml);
}

function buildSliceRow(sl: VisualizerSlice, critSL: Set<string>, data: VisualizerData): string {
  const onCrit = critSL.has(sl.id);
  const ver = data.sliceVerifications.find(v => v.sliceId === sl.id);
  const slack = data.criticalPath.sliceSlack.get(sl.id);

  const taskHtml = sl.tasks.length > 0 ? `
    <ul class="task-list">
      ${sl.tasks.map(t => `
        <li class="task-row task-${t.done ? 'done' : t.active ? 'active' : 'pending'}">
          <span class="task-check">${t.done ? '✓' : t.active ? '▶' : '○'}</span>
          <span class="task-id">${esc(t.id)}</span>
          <span class="task-title">${esc(t.title)}</span>
          ${t.estimate ? `<span class="task-est">(${esc(t.estimate)})</span>` : ''}
        </li>`).join('')}
    </ul>` : '';

  const providesTags = (ver?.provides ?? []).map(p =>
    `<span class="tag tag-provides">${esc(p)}</span>`
  ).join('');

  const requiresTags = (ver?.requires ?? []).map(r =>
    `<span class="tag tag-requires">${esc(r.provides)}</span>`
  ).join('');

  const keyDecisions = ver?.keyDecisions?.length
    ? `<div class="detail-block"><strong>Key decisions:</strong><ul>${ver.keyDecisions.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>`
    : '';

  const patterns = ver?.patternsEstablished?.length
    ? `<div class="detail-block"><strong>Patterns:</strong><ul>${ver.patternsEstablished.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`
    : '';

  const verifBadge = ver?.verificationResult
    ? `<p class="verif-result ${ver.blockerDiscovered ? 'verif-blocker' : 'verif-ok'}">
        ${ver.blockerDiscovered ? '⚠ Blocker: ' : '✓ '}${esc(ver.verificationResult)}
       </p>`
    : '';

  return `
    <details class="sl-block sl-${sl.done ? 'done' : sl.active ? 'active' : 'pending'}">
      <summary class="${onCrit ? 'critical-path' : ''}">
        <span class="sl-check">${sl.done ? '✓' : sl.active ? '▶' : '○'}</span>
        <span class="sl-id">${esc(sl.id)}</span>
        <span class="sl-title">${esc(sl.title)}</span>
        <span class="sl-risk risk-${(sl.risk || 'unknown').toLowerCase()}">${esc(sl.risk || '?')}</span>
        ${sl.depends.length > 0 ? `<span class="sl-deps">← ${sl.depends.map(esc).join(', ')}</span>` : ''}
        ${onCrit ? '<span class="badge badge-critical">critical</span>' : ''}
        ${slack !== undefined && slack > 0 ? `<span class="badge badge-slack">+${slack} slack</span>` : ''}
      </summary>
      <div class="sl-detail">
        ${providesTags || requiresTags ? `<div class="tag-row">${providesTags}${requiresTags}</div>` : ''}
        ${verifBadge}
        ${keyDecisions}
        ${patterns}
        ${taskHtml}
      </div>
    </details>`;
}

// ─── Section: Dependency Graph ────────────────────────────────────────────────

function buildDepGraphSection(data: VisualizerData): string {
  const hasSlices = data.milestones.some(ms => ms.slices.length > 0);
  if (!hasSlices) return section('depgraph', 'Dependency Graph', '<p class="empty">No slices to graph.</p>');

  const hasDeps = data.milestones.some(ms => ms.slices.some(s => s.depends.length > 0));
  if (!hasDeps) return section('depgraph', 'Dependency Graph', '<p class="empty">No slice dependencies defined — all slices are independent.</p>');

  const svgs = data.milestones
    .filter(ms => ms.slices.length > 0)
    .map(ms => buildMilestoneDepSVG(ms, data))
    .filter(Boolean)
    .join('');

  return section('depgraph', 'Dependency Graph', svgs || '<p class="empty">No dependency data to render.</p>');
}

function buildMilestoneDepSVG(ms: VisualizerMilestone, data: VisualizerData): string {
  const slices = ms.slices;
  if (slices.length === 0) return '';

  const critSL = new Set(data.criticalPath.slicePath);
  const slMap = new Map(slices.map(s => [s.id, s]));

  // Assign columns via longest dependency chain
  const layerMap = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const s of slices) inDeg.set(s.id, 0);
  for (const s of slices) {
    for (const dep of s.depends) {
      if (slMap.has(dep)) inDeg.set(s.id, (inDeg.get(s.id) ?? 0) + 1);
    }
  }

  const visited = new Set<string>();
  const q: string[] = [];
  for (const [id, d] of inDeg) {
    if (d === 0) { q.push(id); visited.add(id); layerMap.set(id, 0); }
  }

  while (q.length > 0) {
    const node = q.shift()!;
    for (const s of slices) {
      if (!s.depends.includes(node)) continue;
      const newDeg = (inDeg.get(s.id) ?? 1) - 1;
      inDeg.set(s.id, newDeg);
      layerMap.set(s.id, Math.max(layerMap.get(s.id) ?? 0, (layerMap.get(node) ?? 0) + 1));
      if (newDeg === 0 && !visited.has(s.id)) { visited.add(s.id); q.push(s.id); }
    }
  }
  for (const s of slices) if (!layerMap.has(s.id)) layerMap.set(s.id, 0);

  const maxLayer = Math.max(...[...layerMap.values()]);
  const byLayer = new Map<number, string[]>();
  for (const [id, layer] of layerMap) {
    const arr = byLayer.get(layer) ?? [];
    arr.push(id);
    byLayer.set(layer, arr);
  }

  const NW = 124, NH = 42, CGAP = 58, RGAP = 16, PAD = 24;
  let maxRows = 0;
  for (let c = 0; c <= maxLayer; c++) maxRows = Math.max(maxRows, (byLayer.get(c) ?? []).length);
  const totalH = PAD * 2 + maxRows * NH + Math.max(0, maxRows - 1) * RGAP;
  const totalW = PAD * 2 + (maxLayer + 1) * NW + maxLayer * CGAP;

  const pos = new Map<string, { x: number; y: number }>();
  for (let col = 0; col <= maxLayer; col++) {
    const ids = byLayer.get(col) ?? [];
    const colH = ids.length * NH + Math.max(0, ids.length - 1) * RGAP;
    const startY = (totalH - colH) / 2;
    ids.forEach((id, i) => pos.set(id, { x: PAD + col * (NW + CGAP), y: startY + i * (NH + RGAP) }));
  }

  const edges = slices.flatMap(sl => sl.depends.flatMap(dep => {
    if (!pos.has(dep) || !pos.has(sl.id)) return [];
    const f = pos.get(dep)!, t = pos.get(sl.id)!;
    const x1 = f.x + NW, y1 = f.y + NH / 2;
    const x2 = t.x,       y2 = t.y + NH / 2;
    const mx = (x1 + x2) / 2;
    const crit = critSL.has(sl.id) && critSL.has(dep);
    return [`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" class="dep-edge${crit ? ' dep-edge-crit' : ''}" marker-end="url(#arr)"/>`];
  }));

  const nodes = slices.map(sl => {
    const p = pos.get(sl.id);
    if (!p) return '';
    const crit = critSL.has(sl.id);
    const sc = sl.done ? 'nd-done' : sl.active ? 'nd-active' : 'nd-pending';
    return `<g class="dep-node ${sc}${crit ? ' nd-crit' : ''}" transform="translate(${p.x},${p.y})">
      <rect width="${NW}" height="${NH}" rx="7"/>
      <text x="${NW/2}" y="17" class="nd-id">${esc(truncStr(sl.id, 16))}</text>
      <text x="${NW/2}" y="31" class="nd-ttl">${esc(truncStr(sl.title, 16))}</text>
      <title>${esc(sl.id)}: ${esc(sl.title)}</title>
    </g>`;
  });

  return `
    <div class="dep-ms-block">
      <h3 class="dep-ms-title">${esc(ms.id)}: ${esc(ms.title)}</h3>
      <div class="dep-legend">
        <span class="dleg nd-done-l">✓ done</span>
        <span class="dleg nd-active-l">▶ active</span>
        <span class="dleg nd-pending-l">○ pending</span>
        <span class="dleg nd-crit-l">— critical path</span>
      </div>
      <div class="dep-graph-wrap">
        <svg class="dep-svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}">
          <defs>
            <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L9,3 z" class="arrowhead"/>
            </marker>
          </defs>
          ${edges.join('')}
          ${nodes.join('')}
        </svg>
      </div>
    </div>`;
}

// ─── Section: Metrics ─────────────────────────────────────────────────────────

function buildMetricsSection(data: VisualizerData): string {
  if (!data.totals) return section('metrics', 'Metrics', '<p class="empty">No metrics data yet.</p>');
  const t = data.totals;

  const summaryGrid = `
    <div class="metrics-grid">
      ${metricBlock('Total Cost', formatCost(t.cost))}
      ${metricBlock('Total Tokens', formatTokenCount(t.tokens.total))}
      ${metricBlock('Input Tokens', formatTokenCount(t.tokens.input))}
      ${metricBlock('Output Tokens', formatTokenCount(t.tokens.output))}
      ${metricBlock('Cache Read', formatTokenCount(t.tokens.cacheRead))}
      ${metricBlock('Cache Write', formatTokenCount(t.tokens.cacheWrite))}
      ${metricBlock('Duration', formatDuration(t.duration))}
      ${metricBlock('Units', String(t.units))}
      ${metricBlock('Tool Calls', String(t.toolCalls))}
      ${metricBlock('Truncations', String(t.totalTruncationSections))}
    </div>`;

  const tokenBreakdown = buildTokenBreakdown(t.tokens);

  const phaseRow = data.byPhase.length > 0 ? `
    <div class="chart-row">
      ${buildBarChart('Cost by Phase', data.byPhase.map(p => ({
        label: p.phase, value: p.cost, display: formatCost(p.cost), sub: `${p.units} units`,
      })), 'cost')}
      ${buildBarChart('Tokens by Phase', data.byPhase.map(p => ({
        label: p.phase, value: p.tokens.total, display: formatTokenCount(p.tokens.total), sub: formatCost(p.cost),
      })), 'tokens')}
    </div>` : '';

  const sliceModelRow = (data.bySlice.length > 0 || data.byModel.length > 0) ? `
    <div class="chart-row">
      ${data.bySlice.length > 0 ? buildBarChart('Cost by Slice', data.bySlice.map(s => ({
        label: s.sliceId, value: s.cost, display: formatCost(s.cost),
        sub: `${s.units} units · ${formatTokenCount(s.tokens.total)}`,
      })), 'cost') : ''}
      ${data.byModel.length > 0 ? buildBarChart('Cost by Model', data.byModel.map(m => ({
        label: shortModel(m.model), value: m.cost, display: formatCost(m.cost),
        sub: `${m.units} units · ${formatTokenCount(m.tokens.total)}`,
      })), 'cost') : ''}
    </div>` : '';

  return section('metrics', 'Metrics', `
    ${summaryGrid}
    ${tokenBreakdown}
    ${phaseRow}
    ${sliceModelRow}
  `);
}

function buildTokenBreakdown(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }): string {
  if (tokens.total === 0) return '';
  const segs = [
    { label: 'Input',       value: tokens.input,      cls: 'seg-in'  },
    { label: 'Output',      value: tokens.output,     cls: 'seg-out' },
    { label: 'Cache Read',  value: tokens.cacheRead,  cls: 'seg-cr'  },
    { label: 'Cache Write', value: tokens.cacheWrite, cls: 'seg-cw'  },
  ].filter(s => s.value > 0);

  const bars = segs.map(s => {
    const pct = (s.value / tokens.total) * 100;
    return `<div class="tseg ${s.cls}" style="width:${pct.toFixed(2)}%" title="${s.label}: ${formatTokenCount(s.value)} (${pct.toFixed(1)}%)"></div>`;
  }).join('');

  const legend = segs.map(s => {
    const pct = ((s.value / tokens.total) * 100).toFixed(1);
    return `<span class="leg-item"><span class="leg-dot ${s.cls}"></span>${s.label}: ${formatTokenCount(s.value)} <em>(${pct}%)</em></span>`;
  }).join('');

  return `
    <div class="token-breakdown">
      <h3>Token Breakdown</h3>
      <div class="token-bar">${bars}</div>
      <div class="token-legend">${legend}</div>
    </div>`;
}

interface BarEntry { label: string; value: number; display: string; sub?: string }

function buildBarChart(title: string, entries: BarEntry[], kind: 'cost' | 'tokens'): string {
  if (entries.length === 0) return '';
  const max = Math.max(...entries.map(e => e.value), 1);
  const rows = entries.map(e => {
    const pct = (e.value / max) * 100;
    return `
      <div class="bar-row">
        <div class="bar-lbl" title="${esc(e.label)}">${esc(truncStr(e.label, 22))}</div>
        <div class="bar-track"><div class="bar-fill bar-${kind}" style="width:${pct.toFixed(2)}%"></div></div>
        <div class="bar-val">${esc(e.display)}</div>
        ${e.sub ? `<div class="bar-sub">${esc(e.sub)}</div>` : ''}
      </div>`;
  }).join('');
  return `<div class="chart-block"><h3>${esc(title)}</h3><div class="bar-chart">${rows}</div></div>`;
}

// ─── Section: Timeline ────────────────────────────────────────────────────────

function buildTimelineSection(data: VisualizerData): string {
  if (data.units.length === 0) return section('timeline', 'Execution Timeline', '<p class="empty">No units executed yet.</p>');

  const rows = [...data.units].sort((a, b) => a.startedAt - b.startedAt).map((u, i) => {
    const dur = u.finishedAt > 0 ? formatDuration(u.finishedAt - u.startedAt) : 'running…';
    const phase = unitPhase(u.type);
    return `
      <tr class="unit-${phase}">
        <td class="td-n">${i + 1}</td>
        <td><span class="unit-badge">${esc(u.type)}</span></td>
        <td class="td-mono">${esc(u.id)}</td>
        <td>${esc(shortModel(u.model))}</td>
        <td class="td-date">${formatDateShort(new Date(u.startedAt).toISOString())}</td>
        <td class="td-dur">${dur}</td>
        <td class="td-cost">${formatCost(u.cost)}</td>
        <td>${formatTokenCount(u.tokens.total)}</td>
        <td>${u.toolCalls}</td>
        <td>${u.tier ? `<span class="tier-badge tier-${u.tier}">${esc(u.tier)}</span>` : '<span class="na">—</span>'}</td>
        <td>${u.modelDowngraded ? '<span class="badge badge-routed">routed</span>' : '<span class="na">—</span>'}</td>
      </tr>`;
  }).join('');

  return section('timeline', 'Execution Timeline', `
    <div class="table-scroll">
      <table class="data-table tl-table">
        <thead><tr>
          <th>#</th><th>Type</th><th>ID</th><th>Model</th>
          <th>Started</th><th>Duration</th><th>Cost</th>
          <th>Tokens</th><th>Tools</th><th>Tier</th><th>Routing</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

// ─── Section: Changelog ───────────────────────────────────────────────────────

function buildChangelogSection(data: VisualizerData): string {
  if (data.changelog.entries.length === 0) return section('changelog', 'Changelog', '<p class="empty">No completed slices yet.</p>');

  const entries = data.changelog.entries.map(e => {
    const filesHtml = e.filesModified.length > 0 ? `
      <details class="files-detail">
        <summary>${e.filesModified.length} file${e.filesModified.length !== 1 ? 's' : ''} modified</summary>
        <ul class="file-list">
          ${e.filesModified.map(f => `<li><code>${esc(f.path)}</code>${f.description ? ` — ${esc(f.description)}` : ''}</li>`).join('')}
        </ul>
      </details>` : '';

    const ver = data.sliceVerifications.find(v => v.sliceId === e.sliceId);
    const decisionsHtml = ver?.keyDecisions?.length ? `
      <div class="cl-decisions">
        <strong>Key decisions:</strong>
        <ul>${ver.keyDecisions.map(d => `<li>${esc(d)}</li>`).join('')}</ul>
      </div>` : '';

    return `
      <div class="cl-entry">
        <div class="cl-header">
          <span class="cl-mid">${esc(e.milestoneId)}</span><span class="cl-sep">/</span><span class="cl-sid">${esc(e.sliceId)}</span>
          <span class="cl-title">${esc(e.title)}</span>
          ${e.completedAt ? `<span class="cl-date">${formatDateShort(e.completedAt)}</span>` : ''}
        </div>
        ${e.oneLiner ? `<p class="cl-liner">${esc(e.oneLiner)}</p>` : ''}
        ${decisionsHtml}
        ${filesHtml}
      </div>`;
  }).join('');

  return section('changelog', `Changelog <span class="sec-count">${data.changelog.entries.length}</span>`, entries);
}

// ─── Section: Knowledge ───────────────────────────────────────────────────────

function buildKnowledgeSection(data: VisualizerData): string {
  const k = data.knowledge;
  if (!k.exists) return section('knowledge', 'Knowledge Base', '<p class="empty">No KNOWLEDGE.md found.</p>');

  const total = k.rules.length + k.patterns.length + k.lessons.length;
  if (total === 0) return section('knowledge', 'Knowledge Base', '<p class="empty">KNOWLEDGE.md exists but no entries parsed.</p>');

  const rulesHtml = k.rules.length > 0 ? `
    <h3>Rules <span class="sec-count">${k.rules.length}</span></h3>
    <table class="data-table">
      <thead><tr><th>ID</th><th>Scope</th><th>Rule</th></tr></thead>
      <tbody>${k.rules.map(r => `<tr><td class="td-mono">${esc(r.id)}</td><td>${esc(r.scope)}</td><td>${esc(r.content)}</td></tr>`).join('')}</tbody>
    </table>` : '';

  const patternsHtml = k.patterns.length > 0 ? `
    <h3>Patterns <span class="sec-count">${k.patterns.length}</span></h3>
    <table class="data-table">
      <thead><tr><th>ID</th><th>Pattern</th></tr></thead>
      <tbody>${k.patterns.map(p => `<tr><td class="td-mono">${esc(p.id)}</td><td>${esc(p.content)}</td></tr>`).join('')}</tbody>
    </table>` : '';

  const lessonsHtml = k.lessons.length > 0 ? `
    <h3>Lessons Learned <span class="sec-count">${k.lessons.length}</span></h3>
    <table class="data-table">
      <thead><tr><th>ID</th><th>Lesson</th></tr></thead>
      <tbody>${k.lessons.map(l => `<tr><td class="td-mono">${esc(l.id)}</td><td>${esc(l.content)}</td></tr>`).join('')}</tbody>
    </table>` : '';

  return section('knowledge', `Knowledge Base <span class="sec-count">${total}</span>`, `${rulesHtml}${patternsHtml}${lessonsHtml}`);
}

// ─── Section: Captures ────────────────────────────────────────────────────────

function buildCapturesSection(data: VisualizerData): string {
  const c = data.captures;
  if (c.totalCount === 0) return section('captures', 'Captures', '<p class="empty">No captures recorded.</p>');

  const badge = c.pendingCount > 0
    ? `<span class="badge badge-warn">${c.pendingCount} pending</span>`
    : `<span class="badge badge-ok">all triaged</span>`;

  const rows = c.entries.map(e => `
    <tr class="cap-${e.status}">
      <td class="td-date">${formatDateShort(new Date(e.capturedAt).toISOString())}</td>
      <td><span class="cap-badge cap-${e.status}">${esc(e.status)}</span></td>
      <td>${e.resolution ? esc(e.resolution) : '<span class="na">—</span>'}</td>
      <td class="cap-text">${esc(e.text)}</td>
    </tr>`).join('');

  return section('captures', `Captures ${badge}`, `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Captured</th><th>Status</th><th>Resolution</th><th>Text</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

// ─── Section: Discussion ──────────────────────────────────────────────────────

function buildDiscussionSection(data: VisualizerData): string {
  if (data.discussion.length === 0) return section('discussion', 'Planning State', '<p class="empty">No milestones.</p>');

  const rows = data.discussion.map(d => {
    const icon = d.state === 'discussed' ? '✓' : d.state === 'draft' ? '~' : '○';
    return `
      <tr class="disc-${d.state}">
        <td class="td-mono">${esc(d.milestoneId)}</td>
        <td>${esc(d.title)}</td>
        <td><span class="disc-state disc-${d.state}">${icon} ${d.state}</span></td>
        <td>${d.hasContext ? '<span class="badge badge-ok">yes</span>' : '<span class="na">—</span>'}</td>
        <td>${d.hasDraft ? '<span class="badge badge-caution">draft</span>' : '<span class="na">—</span>'}</td>
        <td class="td-date">${d.lastUpdated ? formatDateShort(d.lastUpdated) : '<span class="na">—</span>'}</td>
      </tr>`;
  }).join('');

  return section('discussion', 'Planning State', `
    <table class="data-table">
      <thead><tr><th>ID</th><th>Milestone</th><th>State</th><th>Context</th><th>Draft</th><th>Updated</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
}

// ─── Primitives ────────────────────────────────────────────────────────────────

function section(id: string, title: string, body: string): string {
  return `\n<section id="${id}">\n  <h2>${title}</h2>\n  ${body}\n</section>`;
}

function stat(label: string, value: string): string {
  return `<div class="stat-card"><span class="stat-val">${esc(value)}</span><span class="stat-lbl">${esc(label)}</span></div>`;
}

function metricBlock(label: string, value: string): string {
  return `<div class="metric-block"><span class="metric-val">${esc(value)}</span><span class="metric-lbl">${esc(label)}</span></div>`;
}

function healthRow(label: string, value: string, status?: 'ok' | 'caution' | 'warn'): string {
  const icon = status === 'ok' ? ' ✓' : status === 'warn' ? ' ⚠' : status === 'caution' ? ' ◌' : '';
  return `<tr class="${status ? `health-${status}` : ''}"><td>${esc(label)}</td><td>${esc(value)}${icon ? `<span class="h-icon">${icon}</span>` : ''}</td></tr>`;
}

function msStatusIcon(s: string) { return s === 'complete' ? '✅' : s === 'active' ? '⏳' : '⬜'; }
function shortModel(m: string) { return m.replace(/^claude-/, '').replace(/^anthropic\//, ''); }
function unitPhase(t: string) {
  if (t.includes('research')) return 'research';
  if (t.includes('plan')) return 'plan';
  if (t.includes('execute')) return 'execute';
  if (t.includes('complete') || t.includes('reassess') || t.includes('validate')) return 'complete';
  return 'other';
}
function truncStr(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function formatDateLong(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  } catch { return iso; }
}

function formatDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function esc(s: string | undefined | null): string {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--bg4:#2d333b;
  --border:#30363d;--border2:#444c56;
  --text:#e6edf3;--text2:#8b949e;--text3:#6e7681;
  --accent:#58a6ff;--green:#3fb950;--yellow:#d29922;
  --red:#f85149;--purple:#bc8cff;--orange:#ffa657;--teal:#39d353;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif;
  --mono:'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,monospace;
  --r:8px;--r-sm:4px;
}
html{scroll-behavior:smooth;font-size:14px}
body{background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.6}
a{color:var(--accent)}
a:hover{text-decoration:underline}
h3{font-size:14px;font-weight:600;color:var(--text2);margin:20px 0 10px}
code{font-family:var(--mono);font-size:12px;background:var(--bg3);padding:1px 5px;border-radius:3px;color:var(--accent)}

/* Header */
header{background:var(--bg2);border-bottom:2px solid var(--border);padding:14px 32px;position:sticky;top:0;z-index:200}
.header-inner{display:flex;align-items:center;gap:16px;max-width:1440px;margin:0 auto}
.branding{display:flex;align-items:baseline;gap:6px;flex-shrink:0}
.logo{font-size:22px;font-weight:900;letter-spacing:-1px;background:linear-gradient(135deg,var(--accent),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.version{font-size:11px;color:var(--text3);font-family:var(--mono)}
.header-meta{flex:1;min-width:0}
.header-meta h1{font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-sep{color:var(--border2);margin:0 4px}
.header-mid{color:var(--accent);font-family:var(--mono);font-size:15px}
.header-path{font-size:11px;color:var(--text3);font-family:var(--mono);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header-right{text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:3px}
.generated-label{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}
.generated{font-size:12px;color:var(--text2)}
.back-link{font-size:12px;color:var(--accent);text-decoration:none;white-space:nowrap}
.back-link:hover{text-decoration:underline}

/* TOC */
.toc{background:var(--bg2);border-bottom:1px solid var(--border);overflow-x:auto}
.toc ul{display:flex;list-style:none;max-width:1440px;margin:0 auto;padding:0 32px}
.toc a{display:inline-block;padding:9px 14px;color:var(--text2);font-size:12px;font-weight:500;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap;text-decoration:none}
.toc a:hover{color:var(--text);border-bottom-color:var(--border2)}
.toc a.active{color:var(--accent);border-bottom-color:var(--accent)}

/* Layout */
main{max-width:1440px;margin:0 auto;padding:32px;display:flex;flex-direction:column;gap:52px}
section{scroll-margin-top:88px}
section>h2{font-size:18px;font-weight:700;margin-bottom:18px;padding-bottom:10px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
.sec-count{font-size:12px;font-weight:600;color:var(--text3);background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:1px 8px}
.empty{color:var(--text3);font-style:italic;padding:8px 0;font-size:13px}
.indent{padding-left:12px}
.na{color:var(--text3)}

/* Stats */
.stat-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:12px 16px;display:flex;flex-direction:column;gap:3px;min-width:110px}
.stat-val{font-size:20px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums}
.stat-lbl{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}

/* Progress bar */
.progress-bar-wrap{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.progress-bar-track{flex:1;height:8px;background:var(--bg3);border-radius:4px;overflow:hidden}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--green));border-radius:4px}
.progress-pct{font-size:13px;font-weight:600;color:var(--text2);min-width:80px;text-align:right}
.active-slice-info{font-size:13px;color:var(--text2);margin-bottom:6px}
.activity-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.3);border-radius:20px;padding:5px 14px;font-size:12px;color:var(--green);margin-top:6px}
.activity-id{font-family:var(--mono);font-size:11px}
.pulse{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 1.6s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.4)}}

/* Health */
.health-table td{padding:8px 14px}
.health-ok .h-icon{color:var(--green)}
.health-caution{color:var(--yellow)}
.health-warn{color:var(--red)}
.health-warn .h-icon,.health-caution .h-icon{color:inherit}

/* Tables */
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th{background:var(--bg3);color:var(--text2);font-weight:600;padding:9px 14px;text-align:left;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.4px;white-space:nowrap}
.data-table td{padding:8px 14px;border-bottom:1px solid rgba(48,54,61,.5);vertical-align:top}
.data-table tr:last-child td{border-bottom:none}
.data-table tbody tr:hover td{background:rgba(88,166,255,.03)}
.table-scroll{overflow-x:auto;border:1px solid var(--border);border-radius:var(--r)}
.table-scroll .data-table{border:none}
.td-mono{font-family:var(--mono);font-size:11px;color:var(--text2)}
.td-n{color:var(--text3);font-size:12px;width:32px}
.td-date{font-size:12px;color:var(--text2);white-space:nowrap}
.td-dur{font-size:12px;white-space:nowrap}
.td-cost{font-variant-numeric:tabular-nums}

/* Timeline */
.tl-table .unit-research td{border-left:3px solid var(--purple)}
.tl-table .unit-plan td{border-left:3px solid var(--accent)}
.tl-table .unit-execute td{border-left:3px solid var(--green)}
.tl-table .unit-complete td{border-left:3px solid var(--teal)}
.tl-table .unit-other td{border-left:3px solid var(--border)}
.unit-badge{background:var(--bg3);border-radius:3px;padding:2px 6px;font-size:11px;font-family:var(--mono);white-space:nowrap}
.tier-badge{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.tier-light{background:rgba(63,185,80,.15);color:var(--green)}
.tier-standard{background:rgba(88,166,255,.15);color:var(--accent)}
.tier-heavy{background:rgba(248,81,73,.15);color:var(--red)}

/* Badges */
.badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;white-space:nowrap}
.badge-critical{background:rgba(188,140,255,.15);color:var(--purple)}
.badge-slack{background:rgba(57,211,83,.1);color:var(--teal);font-size:10px}
.badge-warn{background:rgba(210,153,34,.15);color:var(--yellow)}
.badge-ok{background:rgba(63,185,80,.15);color:var(--green)}
.badge-caution{background:rgba(255,166,87,.15);color:var(--orange)}
.badge-routed{background:rgba(188,140,255,.15);color:var(--purple);font-size:10px}

/* Progress tree */
.ms-block{border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-bottom:10px}
.ms-block>summary{display:flex;align-items:center;gap:8px;padding:11px 16px;cursor:pointer;list-style:none;background:var(--bg2);user-select:none}
.ms-block>summary:hover{background:var(--bg3)}
.ms-block>summary::-webkit-details-marker{display:none}
.ms-complete>summary .ms-id{color:var(--green)}
.ms-active>summary .ms-id{color:var(--accent)}
.ms-pending>summary .ms-id{color:var(--text3)}
.ms-id{font-family:var(--mono);font-size:12px;font-weight:700;flex-shrink:0}
.ms-title{flex:1;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ms-progress{font-size:12px;color:var(--text3);flex-shrink:0}
.ms-deps{font-size:11px;color:var(--text3)}
.status-icon{font-size:15px;flex-shrink:0}
.critical-path{background:rgba(188,140,255,.04)!important}
.slice-list{padding:8px 12px 10px 24px;display:flex;flex-direction:column;gap:5px}
.sl-block{border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden}
.sl-block>summary{display:flex;align-items:center;gap:7px;padding:7px 11px;cursor:pointer;list-style:none;background:var(--bg3);font-size:13px;user-select:none}
.sl-block>summary:hover{background:var(--bg4)}
.sl-block>summary::-webkit-details-marker{display:none}
.sl-done>summary{opacity:.75}
.sl-active>summary .sl-title{color:var(--accent)}
.sl-check{width:14px;text-align:center;font-size:11px;flex-shrink:0}
.sl-done .sl-check{color:var(--green)}
.sl-active .sl-check{color:var(--accent)}
.sl-id{font-family:var(--mono);font-size:11px;color:var(--text3);flex-shrink:0}
.sl-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sl-risk{font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700;flex-shrink:0}
.risk-low{background:rgba(63,185,80,.15);color:var(--green)}
.risk-medium{background:rgba(210,153,34,.15);color:var(--yellow)}
.risk-high{background:rgba(248,81,73,.15);color:var(--red)}
.risk-unknown{background:var(--bg);color:var(--text3)}
.sl-deps{font-size:11px;color:var(--text3)}
.sl-detail{padding:10px 12px;background:var(--bg);border-top:1px solid var(--border)}
.tag-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.tag{font-size:11px;padding:2px 8px;border-radius:10px}
.tag-provides{background:rgba(63,185,80,.15);color:var(--green)}
.tag-requires{background:rgba(88,166,255,.15);color:var(--accent)}
.verif-result{font-size:12px;padding:4px 8px;border-radius:3px;margin-bottom:6px}
.verif-ok{background:rgba(63,185,80,.1);color:var(--green)}
.verif-blocker{background:rgba(248,81,73,.1);color:var(--red)}
.detail-block{font-size:12px;color:var(--text2);margin-bottom:6px}
.detail-block ul{padding-left:14px;margin-top:3px}
.detail-block li{margin-bottom:2px}
.task-list{list-style:none;padding:6px 0 0;display:flex;flex-direction:column;gap:3px}
.task-row{display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 8px;border-radius:3px}
.task-done{color:var(--text3)}
.task-active{background:rgba(88,166,255,.06);color:var(--accent)}
.task-check{width:13px;text-align:center;font-size:10px;flex-shrink:0}
.task-done .task-check{color:var(--green)}
.task-active .task-check{color:var(--accent)}
.task-id{font-family:var(--mono);color:var(--text3);font-size:11px;flex-shrink:0}
.task-title{flex:1}
.task-est{font-size:11px;color:var(--text3)}

/* Dep graph */
.dep-ms-block{margin-bottom:32px}
.dep-ms-title{font-size:15px;margin-bottom:6px}
.dep-legend{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
.dleg{font-size:12px;color:var(--text2)}
.nd-done-l{color:var(--green)}
.nd-active-l{color:var(--accent)}
.nd-pending-l{color:var(--text3)}
.nd-crit-l{color:var(--purple)}
.dep-graph-wrap{overflow-x:auto;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:16px}
.dep-svg{display:block}
.dep-edge{fill:none;stroke:var(--border2);stroke-width:1.5}
.dep-edge-crit{stroke:var(--purple);stroke-width:2.5}
.arrowhead{fill:var(--border2)}
.dep-node rect{fill:var(--bg3);stroke:var(--border2);stroke-width:1.5}
.nd-done rect{fill:rgba(63,185,80,.1);stroke:var(--green)}
.nd-active rect{fill:rgba(88,166,255,.1);stroke:var(--accent)}
.nd-crit rect{stroke:var(--purple)!important;stroke-width:2!important}
.nd-id{font-family:var(--mono);font-size:11px;fill:var(--text2);font-weight:600;text-anchor:middle}
.nd-ttl{font-size:10px;fill:var(--text3);text-anchor:middle}
.nd-done .nd-id{fill:var(--green)}
.nd-active .nd-id{fill:var(--accent)}

/* Metrics */
.metrics-grid{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.metric-block{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 14px;display:flex;flex-direction:column;gap:2px;min-width:100px}
.metric-val{font-size:17px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}
.metric-lbl{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px}
.token-breakdown{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:20px}
.token-bar{display:flex;height:24px;border-radius:3px;overflow:hidden;gap:1px;margin-bottom:10px}
.tseg{height:100%;min-width:2px}
.seg-in{background:var(--accent)}
.seg-out{background:var(--purple)}
.seg-cr{background:var(--green)}
.seg-cw{background:var(--orange)}
.token-legend{display:flex;flex-wrap:wrap;gap:12px}
.leg-item{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2)}
.leg-item em{color:var(--text3);font-style:normal}
.leg-dot{width:10px;height:10px;border-radius:2px;flex-shrink:0}
.chart-row{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
@media(max-width:860px){.chart-row{grid-template-columns:1fr}}
.chart-block{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:16px}
.bar-chart{display:flex;flex-direction:column;gap:7px}
.bar-row{display:grid;grid-template-columns:130px 1fr 72px;align-items:center;gap:8px}
.bar-lbl{font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.bar-track{height:18px;background:var(--bg3);border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px}
.bar-cost{background:linear-gradient(90deg,var(--accent),var(--purple))}
.bar-tokens{background:linear-gradient(90deg,var(--green),var(--teal))}
.bar-val{font-size:12px;font-variant-numeric:tabular-nums}
.bar-sub{grid-column:2/4;font-size:11px;color:var(--text3);padding-left:4px}

/* Changelog */
.cl-entry{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;margin-bottom:8px}
.cl-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.cl-mid,.cl-sid{font-family:var(--mono);font-size:12px;color:var(--text3)}
.cl-sep{color:var(--border2)}
.cl-title{flex:1;font-weight:600;min-width:0}
.cl-date{font-size:12px;color:var(--text3);white-space:nowrap;margin-left:auto}
.cl-liner{font-size:13px;color:var(--text2);margin-bottom:8px}
.cl-decisions{font-size:12px;color:var(--text2);margin-bottom:8px}
.cl-decisions ul{padding-left:14px;margin-top:3px}
.cl-decisions li{margin-bottom:2px}
.files-detail summary{font-size:12px;color:var(--text3);cursor:pointer}
.file-list{list-style:none;padding-left:10px;margin-top:6px;display:flex;flex-direction:column;gap:3px}
.file-list li{font-size:12px;color:var(--text2)}

/* Captures */
.cap-text{font-size:12px;max-width:480px}
.cap-badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600}
.cap-pending{background:rgba(210,153,34,.15);color:var(--yellow)}
.cap-resolved{background:rgba(63,185,80,.15);color:var(--green)}

/* Discussion */
.disc-state{font-size:12px;padding:2px 8px;border-radius:10px}
.disc-discussed{color:var(--green)}
.disc-draft{color:var(--yellow)}
.disc-undiscussed{color:var(--text3)}

/* Footer */
footer{border-top:1px solid var(--border);padding:24px 32px;margin-top:48px;background:var(--bg2)}
.footer-inner{display:flex;align-items:center;gap:8px;justify-content:center;font-size:12px;color:var(--text3);flex-wrap:wrap}
.footer-brand{font-weight:700;color:var(--text2)}
.footer-mid{font-family:var(--mono);font-size:11px}
.footer-sep{color:var(--border2)}

/* Print */
@media print{
  header,nav.toc{position:static}
  body{background:#fff;color:#000}
  :root{--bg:#fff;--bg2:#f6f8fa;--bg3:#f0f3f6;--bg4:#eaedf0;--border:#d0d7de;--border2:#afb8c1;--text:#1f2328;--text2:#57606a;--text3:#8c959f;--accent:#0969da;--green:#1a7f37;--red:#cf222e;--yellow:#9a6700;--purple:#8250df;--orange:#bc4c00}
  .logo{background:none;-webkit-text-fill-color:var(--accent)}
  section{page-break-inside:avoid}
  .table-scroll{overflow:visible}
}
`;

// ─── JS ────────────────────────────────────────────────────────────────────────

const JS = `
(function(){
  const sections=document.querySelectorAll('section[id]');
  const links=document.querySelectorAll('.toc a');
  if(!sections.length||!links.length)return;
  const obs=new IntersectionObserver(entries=>{
    for(const e of entries){
      if(!e.isIntersecting)continue;
      for(const l of links)l.classList.remove('active');
      const a=document.querySelector('.toc a[href="#'+e.target.id+'"]');
      if(a)a.classList.add('active');
    }
  },{rootMargin:'-10% 0px -80% 0px',threshold:0});
  for(const s of sections)obs.observe(s);
})();
`;
