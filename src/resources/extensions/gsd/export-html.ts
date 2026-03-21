/**
 * GSD HTML Report Generator
 *
 * Produces a single self-contained HTML file with:
 *   - Branding header (project name, path, GSD version, generated timestamp)
 *   - Project summary & overall progress
 *   - Progress tree (milestones → slices → tasks, with critical path)
 *   - Execution timeline (chronological unit history)
 *   - Slice dependency graph (SVG DAG per milestone)
 *   - Cost & token metrics (bar charts, phase/slice/model/tier breakdowns)
 *   - Health & configuration overview
 *   - Changelog (completed slice summaries + file modifications)
 *   - Knowledge base (rules, patterns, lessons)
 *   - Captures log
 *   - Artifacts & milestone planning / discussion state
 *
 * No external dependencies — all CSS and JS is inlined.
 * Printable to PDF from any browser.
 *
 * Design: Linear-inspired — restrained palette, geometric status, no emoji.
 */

import type {
  VisualizerData,
  VisualizerMilestone,
  VisualizerSlice,
} from './visualizer-data.js';
import { formatDateShort, formatDuration } from '../shared/format-utils.js';
import { formatCost, formatTokenCount } from './metrics.js';
import type { UnitMetrics } from './metrics.js';

// ─── Public API ────────────────────────────────────────────────────────────────

export interface HtmlReportOptions {
  projectName: string;
  projectPath: string;
  gsdVersion: string;
  milestoneId?: string;
  indexRelPath?: string;
}

export function generateHtmlReport(
  data: VisualizerData,
  opts: HtmlReportOptions,
): string {
  const generated = new Date().toISOString();

  const sections = [
    buildSummarySection(data, opts, generated),
    buildBlockersSection(data),
    buildProgressSection(data),
    buildTimelineSection(data),
    buildDepGraphSection(data),
    buildMetricsSection(data),
    buildHealthSection(data),
    buildChangelogSection(data),
    buildKnowledgeSection(data),
    buildCapturesSection(data),
    buildStatsSection(data),
    buildDiscussionSection(data),
  ];

  const milestoneTag = opts.milestoneId
    ? ` <span class="sep">/</span> <span class="mono accent">${esc(opts.milestoneId)}</span>`
    : '';

  const backLink = opts.indexRelPath
    ? `<a class="back-link" href="${esc(opts.indexRelPath)}">All Reports</a>`
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
      <div class="generated">${formatDateLong(generated)}</div>
    </div>
  </div>
</header>
<nav class="toc" aria-label="Report sections">
  <ul>
    <li><a href="#summary">Summary</a></li>
    <li><a href="#blockers">Blockers</a></li>
    <li><a href="#progress">Progress</a></li>
    <li><a href="#timeline">Timeline</a></li>
    <li><a href="#depgraph">Dependencies</a></li>
    <li><a href="#metrics">Metrics</a></li>
    <li><a href="#health">Health</a></li>
    <li><a href="#changelog">Changelog</a></li>
    <li><a href="#knowledge">Knowledge</a></li>
    <li><a href="#captures">Captures</a></li>
    <li><a href="#stats">Artifacts</a></li>
    <li><a href="#discussion">Planning</a></li>
  </ul>
</nav>
<main>
${sections.join('\n')}
</main>
<footer>
  <div class="footer-inner">
    <span>GSD v${esc(opts.gsdVersion)}</span>
    <span class="sep">/</span>
    <span>${esc(opts.projectName)}</span>
    ${opts.milestoneId ? `<span class="sep">/</span><span class="mono">${esc(opts.milestoneId)}</span>` : ''}
    <span class="sep">/</span>
    <span>${formatDateLong(generated)}</span>
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
  _generated: string,
): string {
  const t = data.totals;
  const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
  const doneSlices  = data.milestones.reduce((s, m) => s + m.slices.filter(sl => sl.done).length, 0);
  const doneMilestones = data.milestones.filter(m => m.status === 'complete').length;
  const activeMilestone = data.milestones.find(m => m.status === 'active');
  const pct = totalSlices > 0 ? Math.round((doneSlices / totalSlices) * 100) : 0;

  const act = data.agentActivity;
  const kv = [
    kvi('Milestones', `${doneMilestones}/${data.milestones.length}`),
    kvi('Slices', `${doneSlices}/${totalSlices}`),
    kvi('Phase', data.phase),
    t ? kvi('Cost', formatCost(t.cost)) : '',
    t ? kvi('Tokens', formatTokenCount(t.tokens.total)) : '',
    t ? kvi('Duration', formatDuration(t.duration)) : '',
    t ? kvi('Tool calls', String(t.toolCalls)) : '',
    t ? kvi('Units', String(t.units)) : '',
    data.remainingSliceCount > 0 ? kvi('Remaining', String(data.remainingSliceCount)) : '',
    act ? kvi('Rate', `${act.completionRate.toFixed(1)}/hr`) : '',
    t && doneSlices > 0 ? kvi('Cost/slice', formatCost(t.cost / doneSlices)) : '',
    t && t.toolCalls > 0 ? kvi('Tokens/tool', formatTokenCount(t.tokens.total / t.toolCalls)) : '',
    t && (t.tokens.input + t.tokens.cacheRead) > 0
      ? kvi('Cache hit', ((t.tokens.cacheRead / (t.tokens.input + t.tokens.cacheRead)) * 100).toFixed(1) + '%')
      : '',
    opts.milestoneId ? kvi('Scope', opts.milestoneId) : '',
  ].filter(Boolean).join('');

  const activeInfo = activeMilestone ? (() => {
    const active = activeMilestone.slices.find(s => s.active);
    if (!active) return '';
    return `<div class="active-info">
      Executing <span class="mono">${esc(activeMilestone.id)}/${esc(active.id)}</span> — ${esc(active.title)}
    </div>`;
  })() : '';

  const activityHtml = act?.active ? `
    <div class="activity-line">
      <span class="dot dot-active"></span>
      <span class="mono">${esc(act.currentUnit?.type ?? '')}</span>
      <span class="mono muted">${esc(act.currentUnit?.id ?? '')}</span>
      <span class="muted">${formatDuration(act.elapsed)} elapsed</span>
    </div>` : '';

  const execSummary = buildExecutiveSummary(data, opts);
  const etaLine = buildEtaLine(data);

  return section('summary', 'Summary', `
    ${execSummary}
    <div class="kv-grid">${kv}</div>
    <div class="progress-wrap">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-label">${pct}%</span>
    </div>
    ${activeInfo}
    ${activityHtml}
    ${etaLine}
  `);
}

function buildExecutiveSummary(data: VisualizerData, opts: HtmlReportOptions): string {
  const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
  const doneSlices = data.milestones.reduce((s, m) => s + m.slices.filter(sl => sl.done).length, 0);
  const pct = totalSlices > 0 ? Math.round((doneSlices / totalSlices) * 100) : 0;
  const spent = data.totals?.cost ?? 0;
  const activeMilestone = data.milestones.find(m => m.status === 'active');
  const activeSlice = activeMilestone?.slices.find(s => s.active);
  const currentExec = activeMilestone && activeSlice
    ? ` Currently executing ${esc(activeMilestone.id)}/${esc(activeSlice.id)}.`
    : '';
  const budgetCtx = data.health.budgetCeiling
    ? ` Budget: ${formatCost(spent)} of ${formatCost(data.health.budgetCeiling)} ceiling (${((spent / data.health.budgetCeiling) * 100).toFixed(0)}% used).`
    : '';
  return `<p class="exec-summary">${esc(opts.projectName)} is ${pct}% complete across ${data.milestones.length} milestones. ${formatCost(spent)} spent.${currentExec}${budgetCtx}</p>`;
}

function buildEtaLine(data: VisualizerData): string {
  const act = data.agentActivity;
  if (!act || act.completionRate <= 0 || data.remainingSliceCount <= 0) return '';
  const hoursRemaining = data.remainingSliceCount / act.completionRate;
  const formatted = formatDuration(hoursRemaining * 3_600_000);
  return `<div class="eta-line">ETA: ~${formatted} remaining (${data.remainingSliceCount} slices at ${act.completionRate.toFixed(1)}/hr)</div>`;
}

// ─── Section: Blockers ────────────────────────────────────────────────────────

function buildBlockersSection(data: VisualizerData): string {
  const blockers = data.sliceVerifications.filter(v => v.blockerDiscovered === true);
  const highRisk: { msId: string; slId: string }[] = [];
  for (const ms of data.milestones) {
    for (const sl of ms.slices) {
      if (!sl.done && sl.risk?.toLowerCase() === 'high') {
        highRisk.push({ msId: ms.id, slId: sl.id });
      }
    }
  }

  if (blockers.length === 0 && highRisk.length === 0) {
    return section('blockers', 'Blockers', '<p class="empty">No blockers or high-risk items found.</p>');
  }

  const blockerCards = blockers.map(v => `
    <div class="blocker-card">
      <div class="blocker-id">${esc(v.milestoneId)}/${esc(v.sliceId)}</div>
      <div class="blocker-text">${esc(v.verificationResult ?? 'Blocker discovered')}</div>
    </div>`).join('');

  const riskCards = highRisk
    .filter(hr => !blockers.some(b => b.milestoneId === hr.msId && b.sliceId === hr.slId))
    .map(hr => `
    <div class="blocker-card">
      <div class="blocker-id">${esc(hr.msId)}/${esc(hr.slId)}</div>
      <div class="blocker-text">High risk — incomplete</div>
    </div>`).join('');

  return section('blockers', 'Blockers', `${blockerCards}${riskCards}`);
}

// ─── Section: Health ──────────────────────────────────────────────────────────

function buildHealthSection(data: VisualizerData): string {
  const h = data.health;
  const t = data.totals;

  const rows: string[] = [];
  rows.push(hRow('Token profile', h.tokenProfile));
  if (h.budgetCeiling !== undefined) {
    const spent = t?.cost ?? 0;
    const pct = (spent / h.budgetCeiling) * 100;
    const status = pct > 90 ? 'warn' : pct > 75 ? 'caution' : 'ok';
    rows.push(hRow(
      'Budget ceiling',
      `${formatCost(h.budgetCeiling)} (${formatCost(spent)} spent, ${pct.toFixed(0)}% used)`,
      status,
    ));
  }
  rows.push(hRow(
    'Truncation rate',
    `${h.truncationRate.toFixed(1)}% per unit (${t?.totalTruncationSections ?? 0} total)`,
    h.truncationRate > 20 ? 'warn' : h.truncationRate > 10 ? 'caution' : 'ok',
  ));
  rows.push(hRow(
    'Continue-here rate',
    `${h.continueHereRate.toFixed(1)}% per unit (${t?.continueHereFiredCount ?? 0} total)`,
    h.continueHereRate > 15 ? 'warn' : h.continueHereRate > 8 ? 'caution' : 'ok',
  ));
  if (h.tierSavingsLine) rows.push(hRow('Routing savings', h.tierSavingsLine));
  rows.push(hRow('Tool calls', String(h.toolCalls)));
  rows.push(hRow('Messages', `${h.assistantMessages} assistant / ${h.userMessages} user`));

  const tierRows = h.tierBreakdown.length > 0 ? `
    <h3>Tier breakdown</h3>
    <table class="tbl">
      <thead><tr><th>Tier</th><th>Units</th><th>Cost</th><th>Tokens</th></tr></thead>
      <tbody>
        ${h.tierBreakdown.map(tb =>
          `<tr><td class="mono">${esc(tb.tier)}</td>
           <td>${tb.units}</td><td>${formatCost(tb.cost)}</td>
           <td>${formatTokenCount(tb.tokens.total)}</td></tr>`
        ).join('')}
      </tbody>
    </table>` : '';

  // Progress score section
  let progressHtml = '';
  if (h.progressScore) {
    const ps = h.progressScore;
    const scoreColor = ps.level === 'green' ? '#22c55e' : ps.level === 'yellow' ? '#eab308' : '#ef4444';
    const signalRows = ps.signals.map(s => {
      const icon = s.kind === 'positive' ? '✓' : s.kind === 'negative' ? '✗' : '·';
      const color = s.kind === 'positive' ? '#22c55e' : s.kind === 'negative' ? '#ef4444' : '#888';
      return `<div style="margin-left:1em;color:${color}">${icon} ${esc(s.label)}</div>`;
    }).join('');
    progressHtml = `
      <h3>Progress Score</h3>
      <div style="font-size:1.1em;font-weight:bold;color:${scoreColor}">● ${esc(ps.summary)}</div>
      ${signalRows}`;
  }

  // Doctor history section
  let historyHtml = '';
  const doctorHistory = h.doctorHistory ?? [];
  if (doctorHistory.length > 0) {
    const historyRows = doctorHistory.slice(0, 20).map(entry => {
      const statusIcon = entry.ok ? '✓' : '✗';
      const statusColor = entry.ok ? '#22c55e' : '#ef4444';
      const ts = entry.ts.replace('T', ' ').slice(0, 19);
      const scopeTag = entry.scope ? `<span class="mono" style="color:#888"> [${esc(entry.scope)}]</span>` : '';
      const summaryText = entry.summary ? esc(entry.summary) : `${entry.errors} errors, ${entry.warnings} warnings, ${entry.fixes} fixes`;
      const issueDetails = (entry.issues ?? []).slice(0, 3).map(i => {
        const iColor = i.severity === 'error' ? '#ef4444' : '#eab308';
        return `<div style="margin-left:2em;color:${iColor};font-size:0.85em">${i.severity === 'error' ? '✗' : '⚠'} ${esc(i.message)} <span class="mono" style="color:#888">${esc(i.unitId)}</span></div>`;
      }).join('');
      const fixDetails = (entry.fixDescriptions ?? []).slice(0, 2).map(f =>
        `<div style="margin-left:2em;color:#22c55e;font-size:0.85em">↳ ${esc(f)}</div>`
      ).join('');
      return `<tr style="color:${statusColor}">
        <td class="mono">${statusIcon}</td>
        <td class="mono">${esc(ts)}${scopeTag}</td>
        <td>${summaryText}</td>
      </tr>
      ${issueDetails || fixDetails ? `<tr><td colspan="3">${issueDetails}${fixDetails}</td></tr>` : ''}`;
    }).join('');

    historyHtml = `
      <h3>Doctor Run History</h3>
      <table class="tbl">
        <thead><tr><th></th><th>Time</th><th>Summary</th></tr></thead>
        <tbody>${historyRows}</tbody>
      </table>`;
  }

  return section('health', 'Health', `
    <table class="tbl tbl-kv"><tbody>${rows.join('')}</tbody></table>
    ${tierRows}
    ${progressHtml}
    ${historyHtml}
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
      <details class="ms-block" ${ms.status !== 'pending' && ms.status !== 'parked' ? 'open' : ''}>
        <summary class="ms-summary ms-${ms.status}">
          <span class="dot dot-${ms.status}"></span>
          <span class="mono ms-id">${esc(ms.id)}</span>
          <span class="ms-title">${esc(ms.title)}</span>
          <span class="muted">${doneCount}/${ms.slices.length}</span>
          ${onCrit ? '<span class="label">critical path</span>' : ''}
          ${ms.dependsOn.length > 0 ? `<span class="muted">needs ${ms.dependsOn.map(esc).join(', ')}</span>` : ''}
        </summary>
        <div class="ms-body">${sliceHtml}</div>
      </details>`;
  }).join('');

  return section('progress', 'Progress', msHtml);
}

function buildSliceRow(sl: VisualizerSlice, critSL: Set<string>, data: VisualizerData): string {
  const onCrit = critSL.has(sl.id);
  const ver = data.sliceVerifications.find(v => v.sliceId === sl.id);
  const slack = data.criticalPath.sliceSlack.get(sl.id);
  const status = sl.done ? 'complete' : sl.active ? 'active' : 'pending';

  const taskHtml = sl.tasks.length > 0 ? `
    <ul class="task-list">
      ${sl.tasks.map(t => `
        <li class="task-row">
          <span class="dot dot-${t.done ? 'complete' : t.active ? 'active' : 'pending'} dot-sm"></span>
          <span class="mono muted">${esc(t.id)}</span>
          <span class="${t.done ? 'muted' : ''}">${esc(t.title)}</span>
          ${t.estimate ? `<span class="muted">${esc(t.estimate)}</span>` : ''}
        </li>`).join('')}
    </ul>` : '';

  const tags = [
    ...(ver?.provides ?? []).map(p => `<span class="tag">provides: ${esc(p)}</span>`),
    ...(ver?.requires ?? []).map(r => `<span class="tag">requires: ${esc(r.provides)}</span>`),
  ].join('');

  const keyDecisions = ver?.keyDecisions?.length
    ? `<div class="detail-block"><span class="detail-label">Decisions</span><ul>${ver.keyDecisions.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>`
    : '';

  const patterns = ver?.patternsEstablished?.length
    ? `<div class="detail-block"><span class="detail-label">Patterns</span><ul>${ver.patternsEstablished.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`
    : '';

  const verifBadge = ver?.verificationResult
    ? `<div class="verif ${ver.blockerDiscovered ? 'verif-blocker' : ''}">
        ${ver.blockerDiscovered ? 'Blocker: ' : ''}${esc(ver.verificationResult)}
       </div>`
    : '';

  return `
    <details class="sl-block">
      <summary class="sl-summary ${onCrit ? 'sl-crit' : ''}">
        <span class="dot dot-${status} dot-sm"></span>
        <span class="mono muted">${esc(sl.id)}</span>
        <span class="${status === 'active' ? 'accent' : sl.done ? 'muted' : ''}">${esc(sl.title)}</span>
        <span class="risk risk-${(sl.risk || 'unknown').toLowerCase()}">${esc(sl.risk || '?')}</span>
        ${sl.depends.length > 0 ? `<span class="muted sl-deps">${sl.depends.map(esc).join(', ')}</span>` : ''}
        ${onCrit ? '<span class="label">critical</span>' : ''}
        ${slack !== undefined && slack > 0 ? `<span class="muted">+${slack} slack</span>` : ''}
      </summary>
      <div class="sl-detail">
        ${tags ? `<div class="tag-row">${tags}</div>` : ''}
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
  if (!hasSlices) return section('depgraph', 'Dependencies', '<p class="empty">No slices to graph.</p>');

  const hasDeps = data.milestones.some(ms => ms.slices.some(s => s.depends.length > 0));
  if (!hasDeps) return section('depgraph', 'Dependencies', '<p class="empty">No dependencies defined.</p>');

  const svgs = data.milestones
    .filter(ms => ms.slices.length > 0)
    .map(ms => buildMilestoneDepSVG(ms, data))
    .filter(Boolean)
    .join('');

  return section('depgraph', 'Dependencies', svgs);
}

function buildMilestoneDepSVG(ms: VisualizerMilestone, data: VisualizerData): string {
  const slices = ms.slices;
  if (slices.length === 0) return '';

  const critSL = new Set(data.criticalPath.slicePath);
  const slMap = new Map(slices.map(s => [s.id, s]));

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

  const NW = 130, NH = 40, CGAP = 56, RGAP = 14, PAD = 20;
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
    return [`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" class="edge${crit ? ' edge-crit' : ''}" marker-end="url(#arr${crit ? '-crit' : ''})"/>`];
  }));

  const nodes = slices.map(sl => {
    const p = pos.get(sl.id);
    if (!p) return '';
    const crit = critSL.has(sl.id);
    const sc = sl.done ? 'n-done' : sl.active ? 'n-active' : 'n-pending';
    return `<g class="node ${sc}${crit ? ' n-crit' : ''}" transform="translate(${p.x},${p.y})">
      <rect width="${NW}" height="${NH}" rx="4"/>
      <text x="${NW/2}" y="16" class="n-id">${esc(truncStr(sl.id, 18))}</text>
      <text x="${NW/2}" y="30" class="n-title">${esc(truncStr(sl.title, 18))}</text>
      <title>${esc(sl.id)}: ${esc(sl.title)}</title>
    </g>`;
  });

  const legend = `<div class="dep-legend">
    <span><span class="dot dot-complete dot-sm"></span> done</span>
    <span><span class="dot dot-active dot-sm"></span> active</span>
    <span><span class="dot dot-pending dot-sm"></span> pending</span>
    <span><span class="dot dot-parked dot-sm"></span> parked</span>
  </div>`;

  return `
    <div class="dep-block">
      <h3>${esc(ms.id)}: ${esc(ms.title)}</h3>
      ${legend}
      <div class="dep-wrap">
        <svg class="dep-svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}">
          <defs>
            <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="var(--border-2)"/>
            </marker>
            <marker id="arr-crit" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="var(--accent)"/>
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

  const grid = [
    kvi('Total cost', formatCost(t.cost)),
    kvi('Total tokens', formatTokenCount(t.tokens.total)),
    kvi('Input', formatTokenCount(t.tokens.input)),
    kvi('Output', formatTokenCount(t.tokens.output)),
    kvi('Cache read', formatTokenCount(t.tokens.cacheRead)),
    kvi('Cache write', formatTokenCount(t.tokens.cacheWrite)),
    kvi('Duration', formatDuration(t.duration)),
    kvi('Units', String(t.units)),
    kvi('Tool calls', String(t.toolCalls)),
    kvi('Truncations', String(t.totalTruncationSections)),
  ].join('');

  const tokenBreakdown = buildTokenBreakdown(t.tokens);

  const phaseRow = data.byPhase.length > 0 ? `
    <div class="chart-row">
      ${buildBarChart('Cost by phase', data.byPhase.map(p => ({
        label: p.phase, value: p.cost, display: formatCost(p.cost), sub: `${p.units} units`,
      })))}
      ${buildBarChart('Tokens by phase', data.byPhase.map(p => ({
        label: p.phase, value: p.tokens.total, display: formatTokenCount(p.tokens.total), sub: formatCost(p.cost),
      })))}
    </div>` : '';

  const sliceModelRow = (data.bySlice.length > 0 || data.byModel.length > 0) ? `
    <div class="chart-row">
      ${data.bySlice.length > 0 ? buildBarChart('Cost by slice', data.bySlice.map(s => ({
        label: s.sliceId, value: s.cost, display: formatCost(s.cost),
        sub: `${s.units} units`,
      }))) : ''}
      ${data.byModel.length > 0 ? buildBarChart('Cost by model', data.byModel.map(m => ({
        label: shortModel(m.model), value: m.cost, display: formatCost(m.cost),
        sub: `${m.units} units`,
      }))) : ''}
      ${data.bySlice.length > 0 ? buildBarChart('Duration by slice', data.bySlice.map(s => ({
        label: s.sliceId, value: s.duration, display: formatDuration(s.duration),
        sub: formatCost(s.cost),
      }))) : ''}
    </div>` : '';

  const costOverTime = buildCostOverTimeChart(data.units);
  const budgetBurndown = buildBudgetBurndown(data);
  const gantt = buildSliceGantt(data);

  return section('metrics', 'Metrics', `
    <div class="kv-grid">${grid}</div>
    ${budgetBurndown}
    ${tokenBreakdown}
    ${costOverTime}
    ${phaseRow}
    ${sliceModelRow}
    ${gantt}
  `);
}

function buildCostOverTimeChart(units: UnitMetrics[]): string {
  if (units.length < 2) return '';
  const sorted = [...units].sort((a, b) => a.startedAt - b.startedAt);
  const cumulative: number[] = [];
  let running = 0;
  for (const u of sorted) {
    running += u.cost;
    cumulative.push(running);
  }

  const padL = 50, padR = 30, padT = 20, padB = 30;
  const w = 600, h = 200;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const maxCost = cumulative[cumulative.length - 1] || 1;
  const n = cumulative.length;

  const points = cumulative.map((c, i) => {
    const x = padL + (i / (n - 1)) * plotW;
    const y = padT + plotH - (c / maxCost) * plotH;
    return { x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${points[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  const gridLines: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i;
    const val = formatCost(maxCost * (1 - i / 4));
    gridLines.push(`<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" class="cost-grid"/>`);
    gridLines.push(`<text x="${padL - 4}" y="${y + 3}" class="cost-axis" text-anchor="end">${val}</text>`);
  }

  return `
    <div class="token-block">
      <h3>Cost over time</h3>
      <svg class="cost-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
        ${gridLines.join('')}
        <path d="${areaPath}" class="cost-area"/>
        <path d="${linePath}" class="cost-line"/>
        <text x="${padL}" y="${h - 4}" class="cost-axis">#1</text>
        <text x="${w - padR}" y="${h - 4}" class="cost-axis" text-anchor="end">#${n}</text>
      </svg>
    </div>`;
}

function buildBudgetBurndown(data: VisualizerData): string {
  if (!data.health.budgetCeiling) return '';
  const ceiling = data.health.budgetCeiling;
  const spent = data.totals?.cost ?? 0;
  const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
  const doneSlices = data.milestones.reduce((s, m) => s + m.slices.filter(sl => sl.done).length, 0);
  const avgCostPerSlice = doneSlices > 0 ? spent / doneSlices : 0;
  const projected = avgCostPerSlice > 0 ? avgCostPerSlice * data.remainingSliceCount + spent : spent;
  const maxVal = Math.max(ceiling, projected, spent);

  const spentPct = (spent / maxVal) * 100;
  const projectedRemPct = Math.max(0, ((projected - spent) / maxVal) * 100);
  const overshoot = projected > ceiling ? ((projected - ceiling) / maxVal) * 100 : 0;
  const projectedClean = projectedRemPct - overshoot;

  const legend = [
    `<span><span class="burndown-dot" style="background:var(--accent)"></span> Spent: ${formatCost(spent)}</span>`,
    `<span><span class="burndown-dot" style="background:var(--caution)"></span> Projected remaining: ${formatCost(Math.max(0, projected - spent))}</span>`,
    `<span><span class="burndown-dot" style="background:var(--border-2)"></span> Ceiling: ${formatCost(ceiling)}</span>`,
    overshoot > 0 ? `<span><span class="burndown-dot" style="background:var(--warn)"></span> Overshoot: ${formatCost(projected - ceiling)}</span>` : '',
  ].filter(Boolean).join('');

  return `
    <div class="burndown-wrap">
      <h3>Budget burndown</h3>
      <div class="burndown-bar">
        <div class="burndown-spent" style="width:${spentPct.toFixed(1)}%"></div>
        ${projectedClean > 0 ? `<div class="burndown-projected" style="width:${projectedClean.toFixed(1)}%"></div>` : ''}
        ${overshoot > 0 ? `<div class="burndown-overshoot" style="width:${overshoot.toFixed(1)}%"></div>` : ''}
      </div>
      <div class="burndown-legend">${legend}</div>
    </div>`;
}

function buildSliceGantt(data: VisualizerData): string {
  const sliceTimings = new Map<string, { min: number; max: number }>();
  for (const u of data.units) {
    const parts = u.id.split('/');
    const sliceKey = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : u.id;
    if (u.startedAt <= 0) continue;
    const existing = sliceTimings.get(sliceKey);
    const end = u.finishedAt > 0 ? u.finishedAt : Date.now();
    if (existing) {
      existing.min = Math.min(existing.min, u.startedAt);
      existing.max = Math.max(existing.max, end);
    } else {
      sliceTimings.set(sliceKey, { min: u.startedAt, max: end });
    }
  }

  if (sliceTimings.size < 2) return '';

  const sliceEntries = [...sliceTimings.entries()].sort((a, b) => a[1].min - b[1].min);
  const globalMin = Math.min(...sliceEntries.map(e => e[1].min));
  const globalMax = Math.max(...sliceEntries.map(e => e[1].max));
  const range = globalMax - globalMin || 1;

  const sliceCount = sliceEntries.length;
  const barH = 18, rowH = 30, padL = 140, padR = 20, padT = 30, padB = 30;
  const plotW = 700 - padL - padR;
  const svgH = sliceCount * rowH + padT + padB;

  // Build a lookup of slice status
  const sliceStatusMap = new Map<string, string>();
  for (const ms of data.milestones) {
    for (const sl of ms.slices) {
      const key = `${ms.id}/${sl.id}`;
      sliceStatusMap.set(key, sl.done ? 'done' : sl.active ? 'active' : 'pending');
    }
  }

  const bars = sliceEntries.map(([sliceId, timing], i) => {
    const x = padL + ((timing.min - globalMin) / range) * plotW;
    const w = Math.max(2, ((timing.max - timing.min) / range) * plotW);
    const y = padT + i * rowH + (rowH - barH) / 2;
    const status = sliceStatusMap.get(sliceId) ?? 'pending';
    return `<text x="${padL - 6}" y="${y + barH / 2 + 4}" class="gantt-label" text-anchor="end">${esc(truncStr(sliceId, 18))}</text>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH}" rx="2" class="gantt-bar-${status}"><title>${esc(sliceId)}: ${formatDuration(timing.max - timing.min)}</title></rect>`;
  }).join('\n');

  // Time axis labels
  const axisLabels = [0, 0.25, 0.5, 0.75, 1].map(frac => {
    const t = globalMin + frac * range;
    const x = padL + frac * plotW;
    return `<text x="${x.toFixed(1)}" y="${svgH - 8}" class="gantt-axis" text-anchor="middle">${formatDateShort(new Date(t).toISOString())}</text>`;
  }).join('');

  return `
    <div class="gantt-wrap">
      <h3>Slice timeline</h3>
      <svg class="gantt-svg" viewBox="0 0 700 ${svgH}" width="700" height="${svgH}">
        ${bars}
        ${axisLabels}
      </svg>
    </div>`;
}

function buildTokenBreakdown(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }): string {
  if (tokens.total === 0) return '';
  const segs = [
    { label: 'Input',       value: tokens.input,      cls: 'seg-1' },
    { label: 'Output',      value: tokens.output,     cls: 'seg-2' },
    { label: 'Cache read',  value: tokens.cacheRead,  cls: 'seg-3' },
    { label: 'Cache write', value: tokens.cacheWrite, cls: 'seg-4' },
  ].filter(s => s.value > 0);

  const bars = segs.map(s => {
    const pct = (s.value / tokens.total) * 100;
    return `<div class="tseg ${s.cls}" style="width:${pct.toFixed(2)}%" title="${s.label}: ${formatTokenCount(s.value)} (${pct.toFixed(1)}%)"></div>`;
  }).join('');

  const legend = segs.map(s => {
    const pct = ((s.value / tokens.total) * 100).toFixed(1);
    return `<span class="leg-item"><span class="leg-dot ${s.cls}"></span>${s.label}: ${formatTokenCount(s.value)} (${pct}%)</span>`;
  }).join('');

  return `
    <div class="token-block">
      <h3>Token breakdown</h3>
      <div class="token-bar">${bars}</div>
      <div class="token-legend">${legend}</div>
    </div>`;
}

interface BarEntry { label: string; value: number; display: string; sub?: string; color?: number }

const CHART_COLORS = 6;

function buildBarChart(title: string, entries: BarEntry[]): string {
  if (entries.length === 0) return '';
  const max = Math.max(...entries.map(e => e.value), 1);
  const rows = entries.map((e, i) => {
    const pct = (e.value / max) * 100;
    const ci = e.color ?? i;
    return `
      <div class="bar-row">
        <div class="bar-lbl">${esc(truncStr(e.label, 22))}</div>
        <div class="bar-track"><div class="bar-fill bar-c${ci % CHART_COLORS}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="bar-val">${esc(e.display)}</div>
      </div>
      ${e.sub ? `<div class="bar-sub">${esc(e.sub)}</div>` : ''}`;
  }).join('');
  return `<div class="chart-block"><h3>${esc(title)}</h3>${rows}</div>`;
}

// ─── Section: Timeline ────────────────────────────────────────────────────────

function buildTimelineSection(data: VisualizerData): string {
  if (data.units.length === 0) return section('timeline', 'Timeline', '<p class="empty">No units executed yet.</p>');

  const sorted = [...data.units].sort((a, b) => a.startedAt - b.startedAt);
  const maxCost = Math.max(...sorted.map(u => u.cost), 0.01);

  const rows = sorted.map((u, i) => {
    const dur = u.finishedAt > 0 ? formatDuration(u.finishedAt - u.startedAt) : 'running';
    // Cost heatmap: subtle red background for expensive rows
    const intensity = Math.min(u.cost / maxCost, 1);
    const heatStyle = intensity > 0.15 ? ` style="background:rgba(239,68,68,${(intensity * 0.15).toFixed(3)})"` : '';
    return `
      <tr${heatStyle}>
        <td class="muted">${i + 1}</td>
        <td class="mono">${esc(u.type)}</td>
        <td class="mono muted">${esc(u.id)}</td>
        <td>${esc(shortModel(u.model))}</td>
        <td class="muted">${formatDateShort(new Date(u.startedAt).toISOString())}</td>
        <td>${dur}</td>
        <td class="num">${formatCost(u.cost)}</td>
        <td class="num">${formatTokenCount(u.tokens.total)}</td>
        <td class="num">${u.toolCalls}</td>
        <td class="mono">${u.tier ?? ''}</td>
        <td>${u.modelDowngraded ? 'routed' : ''}</td>
        <td class="num">${(u.truncationSections ?? 0) > 0 ? u.truncationSections : ''}</td>
        <td>${u.continueHereFired ? 'yes' : ''}</td>
      </tr>`;
  }).join('');

  return section('timeline', 'Timeline', `
    <div class="table-scroll">
      <table class="tbl">
        <thead><tr>
          <th>#</th><th>Type</th><th>ID</th><th>Model</th>
          <th>Started</th><th>Duration</th><th>Cost</th>
          <th>Tokens</th><th>Tools</th><th>Tier</th><th>Routed</th><th>Trunc</th><th>CHF</th>
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
        <summary class="muted">${e.filesModified.length} file${e.filesModified.length !== 1 ? 's' : ''} modified</summary>
        <ul class="file-list">
          ${e.filesModified.map(f => `<li><code>${esc(f.path)}</code>${f.description ? ` — ${esc(f.description)}` : ''}</li>`).join('')}
        </ul>
      </details>` : '';

    const ver = data.sliceVerifications.find(v => v.sliceId === e.sliceId);
    const decisionsHtml = ver?.keyDecisions?.length ? `
      <div class="detail-block"><span class="detail-label">Decisions</span>
        <ul>${ver.keyDecisions.map(d => `<li>${esc(d)}</li>`).join('')}</ul>
      </div>` : '';

    return `
      <div class="cl-entry">
        <div class="cl-header">
          <span class="mono muted">${esc(e.milestoneId)}/${esc(e.sliceId)}</span>
          <span class="cl-title">${esc(e.title)}</span>
          ${e.completedAt ? `<span class="muted cl-date">${formatDateShort(e.completedAt)}</span>` : ''}
        </div>
        ${e.oneLiner ? `<p class="cl-liner">${esc(e.oneLiner)}</p>` : ''}
        ${decisionsHtml}
        ${filesHtml}
      </div>`;
  }).join('');

  return section('changelog', `Changelog <span class="count">${data.changelog.entries.length}</span>`, entries);
}

// ─── Section: Knowledge ───────────────────────────────────────────────────────

function buildKnowledgeSection(data: VisualizerData): string {
  const k = data.knowledge;
  if (!k.exists) return section('knowledge', 'Knowledge', '<p class="empty">No KNOWLEDGE.md found.</p>');
  const total = k.rules.length + k.patterns.length + k.lessons.length;
  if (total === 0) return section('knowledge', 'Knowledge', '<p class="empty">KNOWLEDGE.md exists but no entries parsed.</p>');

  const rulesHtml = k.rules.length > 0 ? `
    <h3>Rules <span class="count">${k.rules.length}</span></h3>
    <table class="tbl">
      <thead><tr><th>ID</th><th>Scope</th><th>Rule</th></tr></thead>
      <tbody>${k.rules.map(r => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.scope)}</td><td>${esc(r.content)}</td></tr>`).join('')}</tbody>
    </table>` : '';

  const patternsHtml = k.patterns.length > 0 ? `
    <h3>Patterns <span class="count">${k.patterns.length}</span></h3>
    <table class="tbl">
      <thead><tr><th>ID</th><th>Pattern</th></tr></thead>
      <tbody>${k.patterns.map(p => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.content)}</td></tr>`).join('')}</tbody>
    </table>` : '';

  const lessonsHtml = k.lessons.length > 0 ? `
    <h3>Lessons <span class="count">${k.lessons.length}</span></h3>
    <table class="tbl">
      <thead><tr><th>ID</th><th>Lesson</th></tr></thead>
      <tbody>${k.lessons.map(l => `<tr><td class="mono">${esc(l.id)}</td><td>${esc(l.content)}</td></tr>`).join('')}</tbody>
    </table>` : '';

  return section('knowledge', `Knowledge <span class="count">${total}</span>`, `${rulesHtml}${patternsHtml}${lessonsHtml}`);
}

// ─── Section: Captures ────────────────────────────────────────────────────────

function buildCapturesSection(data: VisualizerData): string {
  const c = data.captures;
  if (c.totalCount === 0) return section('captures', 'Captures', '<p class="empty">No captures recorded.</p>');

  const badge = c.pendingCount > 0
    ? `<span class="count count-warn">${c.pendingCount} pending</span>`
    : `<span class="count">all triaged</span>`;

  const rows = c.entries.map(e => `
    <tr>
      <td class="muted">${formatDateShort(new Date(e.timestamp).toISOString())}</td>
      <td class="mono">${esc(e.status)}</td>
      <td class="mono">${e.classification ?? ''}</td>
      <td>${e.resolution ?? ''}</td>
      <td>${esc(e.text)}</td>
      <td class="muted">${e.rationale ?? ''}</td>
      <td class="muted">${e.resolvedAt ? formatDateShort(e.resolvedAt) : ''}</td>
      <td>${e.executed !== undefined ? (e.executed ? 'yes' : 'no') : ''}</td>
    </tr>`).join('');

  return section('captures', `Captures ${badge}`, `
    <div class="table-scroll">
      <table class="tbl">
        <thead><tr><th>Captured</th><th>Status</th><th>Class</th><th>Resolution</th><th>Text</th><th>Rationale</th><th>Resolved</th><th>Executed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

// ─── Section: Stats ───────────────────────────────────────────────────────────

function buildStatsSection(data: VisualizerData): string {
  const s = data.stats;

  const missingHtml = s.missingCount > 0 ? `
    <h3>Missing changelogs <span class="count">${s.missingCount}</span></h3>
    <table class="tbl">
      <thead><tr><th>Milestone</th><th>Slice</th><th>Title</th></tr></thead>
      <tbody>
        ${s.missingSlices.map(sl => `<tr><td class="mono">${esc(sl.milestoneId)}</td><td class="mono">${esc(sl.sliceId)}</td><td>${esc(sl.title)}</td></tr>`).join('')}
        ${s.missingCount > s.missingSlices.length
          ? `<tr><td colspan="3" class="muted">and ${s.missingCount - s.missingSlices.length} more</td></tr>`
          : ''}
      </tbody>
    </table>` : '';

  const updatedHtml = s.updatedCount > 0 ? `
    <h3>Recently completed <span class="count">${s.updatedCount}</span></h3>
    <table class="tbl">
      <thead><tr><th>Milestone</th><th>Slice</th><th>Title</th><th>Completed</th></tr></thead>
      <tbody>${s.updatedSlices.map(sl => `
        <tr><td class="mono">${esc(sl.milestoneId)}</td><td class="mono">${esc(sl.sliceId)}</td><td>${esc(sl.title)}</td><td class="muted">${sl.completedAt ? formatDateShort(sl.completedAt) : ''}</td></tr>`).join('')}
      </tbody>
    </table>` : '';

  if (!missingHtml && !updatedHtml) {
    return section('stats', 'Artifacts', '<p class="empty">All artifacts accounted for.</p>');
  }

  return section('stats', 'Artifacts', `${missingHtml}${updatedHtml}`);
}

// ─── Section: Discussion ──────────────────────────────────────────────────────

function buildDiscussionSection(data: VisualizerData): string {
  if (data.discussion.length === 0) return section('discussion', 'Planning', '<p class="empty">No milestones.</p>');

  const rows = data.discussion.map(d => `
    <tr>
      <td class="mono">${esc(d.milestoneId)}</td>
      <td>${esc(d.title)}</td>
      <td class="mono">${d.state}</td>
      <td>${d.hasContext ? 'yes' : ''}</td>
      <td>${d.hasDraft ? 'draft' : ''}</td>
      <td class="muted">${d.lastUpdated ? formatDateShort(d.lastUpdated) : ''}</td>
    </tr>`).join('');

  return section('discussion', 'Planning', `
    <table class="tbl">
      <thead><tr><th>ID</th><th>Milestone</th><th>State</th><th>Context</th><th>Draft</th><th>Updated</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
}

// ─── Primitives ────────────────────────────────────────────────────────────────

function section(id: string, title: string, body: string): string {
  return `\n<section id="${id}">\n  <h2>${title}</h2>\n  ${body}\n</section>`;
}

function kvi(label: string, value: string): string {
  return `<div class="kv"><span class="kv-val">${esc(value)}</span><span class="kv-lbl">${esc(label)}</span></div>`;
}

function hRow(label: string, value: string, status?: 'ok' | 'caution' | 'warn'): string {
  const cls = status ? ` class="h-${status}"` : '';
  return `<tr${cls}><td>${esc(label)}</td><td>${esc(value)}</td></tr>`;
}

function shortModel(m: string) { return m.replace(/^claude-/, '').replace(/^anthropic\//, ''); }
function truncStr(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

function formatDateLong(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  } catch { return iso; }
}


function esc(s: string | undefined | null): string {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── CSS ───────────────────────────────────────────────────────────────────────
// Linear-inspired: restrained palette, one accent, no emoji, no gradients.

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg-0:#0f1115;--bg-1:#16181d;--bg-2:#1e2028;--bg-3:#272a33;
  --border-1:#2b2e38;--border-2:#3b3f4c;
  --text-0:#ededef;--text-1:#a1a1aa;--text-2:#71717a;
  --accent:#5e6ad2;--accent-subtle:rgba(94,106,210,.12);
  --ok:#22c55e;--ok-subtle:rgba(34,197,94,.12);--warn:#ef4444;--caution:#eab308;
  /* Chart palette — 6 hues for bar charts */
  --c0:#5e6ad2;--c1:#e5796d;--c2:#14b8a6;--c3:#a78bfa;--c4:#f59e0b;--c5:#10b981;
  /* Token breakdown — 4 distinct hues */
  --tk-input:#5e6ad2;--tk-output:#e5796d;--tk-cache-r:#2dd4bf;--tk-cache-w:#64748b;
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono','Fira Code',ui-monospace,SFMono-Regular,monospace;
}
html{scroll-behavior:smooth;font-size:13px}
body{background:var(--bg-0);color:var(--text-0);font-family:var(--font);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:12px;background:var(--bg-3);padding:1px 5px;border-radius:3px}
.mono{font-family:var(--mono);font-size:12px}
.muted{color:var(--text-2)}
.accent{color:var(--accent)}
.sep{color:var(--border-2);margin:0 4px}
.empty{color:var(--text-2);padding:8px 0;font-size:13px}
.indent{padding-left:12px}
.num{font-variant-numeric:tabular-nums;text-align:right}

/* Status dots — geometric, no emoji */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;vertical-align:middle}
.dot-sm{width:6px;height:6px}
.dot-complete{background:var(--ok);opacity:.6}
.dot-active{background:var(--accent)}
.dot-pending{background:transparent;border:1.5px solid var(--border-2)}
.dot-parked{background:var(--warn);opacity:.5}

/* Header */
header{background:var(--bg-1);border-bottom:1px solid var(--border-1);padding:12px 32px;position:sticky;top:0;z-index:200}
.header-inner{display:flex;align-items:center;gap:16px;max-width:1280px;margin:0 auto}
.branding{display:flex;align-items:baseline;gap:6px;flex-shrink:0}
.logo{font-size:18px;font-weight:800;letter-spacing:-.5px;color:var(--text-0)}
.version{font-size:10px;color:var(--text-2);font-family:var(--mono)}
.header-meta{flex:1;min-width:0}
.header-meta h1{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-path{font-size:11px;color:var(--text-2);font-family:var(--mono);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header-right{text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.generated{font-size:11px;color:var(--text-2)}
.back-link{font-size:12px;color:var(--text-1)}
.back-link:hover{color:var(--accent)}

/* TOC nav */
.toc{background:var(--bg-1);border-bottom:1px solid var(--border-1);overflow-x:auto}
.toc ul{display:flex;list-style:none;max-width:1280px;margin:0 auto;padding:0 32px}
.toc a{display:inline-block;padding:8px 12px;color:var(--text-2);font-size:12px;font-weight:500;border-bottom:2px solid transparent;transition:color .12s,border-color .12s;white-space:nowrap;text-decoration:none}
.toc a:hover{color:var(--text-0);border-bottom-color:var(--border-2)}
.toc a.active{color:var(--text-0);border-bottom-color:var(--accent)}

/* Layout */
main{max-width:1280px;margin:0 auto;padding:32px;display:flex;flex-direction:column;gap:48px}
section{scroll-margin-top:82px}
section>h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-1);margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border-1);display:flex;align-items:center;gap:8px}
h3{font-size:13px;font-weight:600;color:var(--text-1);margin:20px 0 8px}
.count{font-size:11px;font-weight:500;color:var(--text-2);background:var(--bg-3);border-radius:3px;padding:1px 6px}
.count-warn{color:var(--caution)}

/* KV grid (stats/metrics) */
.kv-grid{display:flex;flex-wrap:wrap;gap:1px;background:var(--border-1);border:1px solid var(--border-1);border-radius:4px;overflow:hidden;margin-bottom:16px}
.kv{background:var(--bg-1);padding:10px 16px;display:flex;flex-direction:column;gap:2px;min-width:110px;flex:1}
.kv-val{font-size:18px;font-weight:600;color:var(--text-0);font-variant-numeric:tabular-nums}
.kv-lbl{font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px}

/* Progress bar */
.progress-wrap{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.progress-track{flex:1;height:4px;background:var(--bg-3);border-radius:2px;overflow:hidden}
.progress-fill{height:100%;background:var(--accent);border-radius:2px}
.progress-label{font-size:12px;font-weight:600;color:var(--text-1);min-width:40px;text-align:right}
.active-info{font-size:12px;color:var(--text-1);margin-bottom:4px}
.activity-line{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-1);padding:6px 0}

/* Tables */
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{color:var(--text-2);font-weight:500;padding:6px 12px;text-align:left;border-bottom:1px solid var(--border-1);font-size:11px;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.tbl td{padding:6px 12px;border-bottom:1px solid var(--border-1);vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl tbody tr:hover td{background:var(--accent-subtle)}
.tbl-kv td:first-child{color:var(--text-2);width:180px}
.table-scroll{overflow-x:auto;border:1px solid var(--border-1);border-radius:4px}
.table-scroll .tbl{border:none}

/* Health */
.h-ok td:first-child{color:var(--text-1)}
.h-caution td{color:var(--caution)}
.h-warn td{color:var(--warn)}

/* Labels */
.label{font-size:10px;font-weight:500;color:var(--accent);text-transform:uppercase;letter-spacing:.4px}
.risk{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;flex-shrink:0}
.risk-low{color:var(--text-2)}
.risk-medium{color:var(--caution)}
.risk-high{color:var(--warn)}
.risk-unknown{color:var(--text-2)}

/* Tags */
.tag-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.tag{font-size:11px;font-family:var(--mono);color:var(--text-2);background:var(--bg-3);border-radius:3px;padding:1px 6px}

/* Verification */
.verif{font-size:12px;color:var(--text-1);padding:4px 0;margin-bottom:6px}
.verif-blocker{color:var(--warn)}

/* Detail blocks */
.detail-block{font-size:12px;color:var(--text-2);margin-bottom:6px}
.detail-label{font-weight:600;color:var(--text-1);display:block;margin-bottom:2px}
.detail-block ul{padding-left:16px;margin-top:2px}
.detail-block li{margin-bottom:1px}

/* Progress tree */
.ms-block{border:1px solid var(--border-1);border-radius:4px;overflow:hidden;margin-bottom:8px}
.ms-summary{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;list-style:none;background:var(--bg-1);user-select:none;font-size:13px}
.ms-summary:hover{background:var(--bg-2)}
.ms-summary::-webkit-details-marker{display:none}
.ms-id{font-weight:600}
.ms-title{flex:1;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ms-body{padding:6px 12px 8px 24px;display:flex;flex-direction:column;gap:4px}

.sl-block{border:1px solid var(--border-1);border-radius:3px;overflow:hidden}
.sl-summary{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;list-style:none;background:var(--bg-2);font-size:12px;user-select:none}
.sl-summary:hover{background:var(--bg-3)}
.sl-summary::-webkit-details-marker{display:none}
.sl-crit{border-left:2px solid var(--accent)}
.sl-deps::before{content:'\\2190 ';color:var(--border-2)}
.sl-detail{padding:8px 12px;background:var(--bg-0);border-top:1px solid var(--border-1)}

.task-list{list-style:none;padding:4px 0 0;display:flex;flex-direction:column;gap:2px}
.task-row{display:flex;align-items:center;gap:6px;font-size:12px;padding:3px 6px;border-radius:2px}

/* Dep graph */
.dep-block{margin-bottom:28px}
.dep-legend{display:flex;gap:14px;font-size:12px;color:var(--text-2);margin-bottom:8px;align-items:center}
.dep-legend span{display:flex;align-items:center;gap:4px}
.dep-wrap{overflow-x:auto;background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:16px}
.dep-svg{display:block}
.edge{fill:none;stroke:var(--border-2);stroke-width:1.5}
.edge-crit{stroke:var(--accent);stroke-width:2}
.node rect{fill:var(--bg-2);stroke:var(--border-2);stroke-width:1}
.n-done rect{fill:var(--ok-subtle);stroke:rgba(34,197,94,.4)}
.n-active rect{fill:var(--accent-subtle);stroke:var(--accent)}
.n-crit rect{stroke:var(--accent)!important;stroke-width:1.5!important}
.n-id{font-family:var(--mono);font-size:10px;fill:var(--text-1);font-weight:600;text-anchor:middle}
.n-title{font-size:9px;fill:var(--text-2);text-anchor:middle}
.n-active .n-id{fill:var(--accent)}

/* Metrics */
.token-block{background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:14px;margin-bottom:16px}
.token-bar{display:flex;height:16px;border-radius:2px;overflow:hidden;gap:1px;margin-bottom:8px}
.tseg{height:100%;min-width:2px}
.seg-1{background:var(--tk-input)}
.seg-2{background:var(--tk-output)}
.seg-3{background:var(--tk-cache-r)}
.seg-4{background:var(--tk-cache-w)}
.token-legend{display:flex;flex-wrap:wrap;gap:12px}
.leg-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-2)}
.leg-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.chart-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:16px}
.chart-block{background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:14px}
.bar-row{display:grid;grid-template-columns:120px 1fr 68px;align-items:center;gap:6px;margin-bottom:2px}
.bar-lbl{font-size:12px;color:var(--text-2);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{height:14px;background:var(--bg-3);border-radius:2px;overflow:hidden}
.bar-fill{height:100%;border-radius:2px;background:var(--c0)}
.bar-c0{background:var(--c0)}.bar-c1{background:var(--c1)}.bar-c2{background:var(--c2)}
.bar-c3{background:var(--c3)}.bar-c4{background:var(--c4)}.bar-c5{background:var(--c5)}
.bar-val{font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-1)}
.bar-sub{font-size:10px;color:var(--text-2);padding-left:128px;margin-bottom:6px}

/* Changelog */
.cl-entry{border-bottom:1px solid var(--border-1);padding:12px 0}
.cl-entry:last-child{border-bottom:none}
.cl-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.cl-title{flex:1;font-weight:500}
.cl-date{margin-left:auto;white-space:nowrap}
.cl-liner{font-size:13px;color:var(--text-1);margin-bottom:6px}
.files-detail summary{font-size:12px;cursor:pointer}
.file-list{list-style:none;padding-left:10px;margin-top:4px;display:flex;flex-direction:column;gap:2px}
.file-list li{font-size:12px;color:var(--text-1)}

/* Footer */
footer{border-top:1px solid var(--border-1);padding:20px 32px;margin-top:40px}
.footer-inner{display:flex;align-items:center;gap:6px;justify-content:center;font-size:11px;color:var(--text-2)}

/* Executive summary & ETA */
.exec-summary{font-size:13px;color:var(--text-1);margin-bottom:12px;line-height:1.7}
.eta-line{font-size:12px;color:var(--accent);margin-top:4px}

/* Cost over time chart */
.cost-svg{display:block;margin:8px 0;background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px}
.cost-line{fill:none;stroke:var(--accent);stroke-width:2}
.cost-area{fill:var(--accent-subtle);stroke:none}
.cost-axis{fill:var(--text-2);font-family:var(--mono);font-size:10px}
.cost-grid{stroke:var(--border-1);stroke-width:1;stroke-dasharray:4,4}

/* Budget burndown */
.burndown-wrap{background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:14px;margin-bottom:16px}
.burndown-bar{display:flex;height:20px;border-radius:3px;overflow:hidden;gap:1px;margin-bottom:8px}
.burndown-spent{background:var(--accent);height:100%}
.burndown-projected{background:var(--caution);height:100%;opacity:.6}
.burndown-overshoot{background:var(--warn);height:100%;opacity:.7}
.burndown-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--text-2)}
.burndown-legend span{display:flex;align-items:center;gap:4px}
.burndown-dot{display:inline-block;width:8px;height:8px;border-radius:2px}

/* Blockers */
.blocker-card{border-left:3px solid var(--warn);background:var(--bg-1);border-radius:0 4px 4px 0;padding:10px 14px;margin-bottom:8px}
.blocker-id{font-family:var(--mono);font-size:12px;color:var(--warn);margin-bottom:2px}
.blocker-text{font-size:12px;color:var(--text-1)}
.blocker-risk{font-size:11px;color:var(--caution);margin-top:2px}

/* Gantt */
.gantt-wrap{overflow-x:auto;background:var(--bg-1);border:1px solid var(--border-1);border-radius:4px;padding:16px;margin-top:16px}
.gantt-svg{display:block}
.gantt-bar-done{fill:var(--ok);opacity:.7}
.gantt-bar-active{fill:var(--accent)}
.gantt-bar-pending{fill:var(--border-2)}
.gantt-label{fill:var(--text-2);font-family:var(--mono);font-size:10px}
.gantt-axis{fill:var(--text-2);font-family:var(--mono);font-size:9px}

/* Interactive */
.tl-filter{display:block;width:100%;padding:6px 10px;margin-bottom:8px;background:var(--bg-2);border:1px solid var(--border-1);border-radius:4px;color:var(--text-0);font-size:12px;font-family:var(--font);outline:none}
.tl-filter:focus{border-color:var(--accent)}
.tl-filter::placeholder{color:var(--text-2)}
.sec-toggle{background:none;border:1px solid var(--border-2);color:var(--text-2);width:20px;height:20px;border-radius:3px;cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.sec-toggle:hover{border-color:var(--text-1);color:var(--text-1)}
.theme-toggle{background:var(--bg-3);border:1px solid var(--border-2);color:var(--text-1);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:var(--font)}
.theme-toggle:hover{border-color:var(--accent);color:var(--accent)}

/* Light theme */
.light-theme{--bg-0:#fff;--bg-1:#fafafa;--bg-2:#f5f5f5;--bg-3:#ebebeb;--border-1:#e5e5e5;--border-2:#d4d4d4;--text-0:#1a1a1a;--text-1:#525252;--text-2:#a3a3a3;--accent:#4f46e5;--accent-subtle:rgba(79,70,229,.08);--ok:#16a34a;--ok-subtle:rgba(22,163,74,.08);--warn:#dc2626;--caution:#ca8a04;--c0:#4f46e5;--c1:#dc2626;--c2:#0d9488;--c3:#7c3aed;--c4:#d97706;--c5:#059669;--tk-input:#4f46e5;--tk-output:#dc2626;--tk-cache-r:#0d9488;--tk-cache-w:#64748b}

/* Responsive */
@media(max-width:768px){
  header{padding:10px 16px}
  .header-inner{flex-wrap:wrap;gap:8px}
  .header-meta h1{font-size:13px}
  main{padding:16px}
  .kv-grid{gap:1px}
  .kv{min-width:80px;padding:8px 10px}
  .kv-val{font-size:14px}
  .chart-row{grid-template-columns:1fr}
  .toc ul{padding:0 16px}
  .toc a{padding:6px 8px;font-size:11px}
  .bar-row{grid-template-columns:80px 1fr 56px}
  .ms-body{padding-left:12px}
}
@media(max-width:480px){
  .kv{min-width:60px;padding:6px 8px}
  .kv-val{font-size:12px}
  .kv-lbl{font-size:9px}
  .bar-row{grid-template-columns:60px 1fr 48px}
  .bar-lbl{font-size:10px}
  .toc ul{flex-wrap:wrap}
  .header-right{display:none}
  .gantt-wrap{overflow-x:auto}
}

/* Print */
@media print{
  header,nav.toc{position:static}
  body{background:#fff;color:#1a1a1a}
  :root{--bg-0:#fff;--bg-1:#fafafa;--bg-2:#f5f5f5;--bg-3:#ebebeb;--border-1:#e5e5e5;--border-2:#d4d4d4;--text-0:#1a1a1a;--text-1:#525252;--text-2:#a3a3a3;--accent:#4f46e5;--ok:#16a34a;--ok-subtle:rgba(22,163,74,.08);--c0:#4f46e5;--c1:#dc2626;--c2:#0d9488;--c3:#7c3aed;--c4:#d97706;--c5:#059669;--tk-input:#4f46e5;--tk-output:#dc2626;--tk-cache-r:#0d9488;--tk-cache-w:#64748b}
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
(function(){
  var tl=document.getElementById('timeline');
  if(!tl)return;
  var table=tl.querySelector('.tbl');
  if(!table)return;
  var input=document.createElement('input');
  input.className='tl-filter';
  input.placeholder='Filter timeline\\u2026';
  input.type='text';
  table.parentNode.insertBefore(input,table);
  var rows=table.querySelectorAll('tbody tr');
  input.addEventListener('input',function(){
    var q=this.value.toLowerCase();
    for(var i=0;i<rows.length;i++){
      rows[i].style.display=rows[i].textContent.toLowerCase().indexOf(q)>-1?'':'none';
    }
  });
})();
(function(){
  var saved=JSON.parse(localStorage.getItem('gsd-collapsed')||'{}');
  document.querySelectorAll('section[id]').forEach(function(sec){
    var h2=sec.querySelector('h2');
    if(!h2)return;
    var btn=document.createElement('button');
    btn.className='sec-toggle';
    btn.textContent=saved[sec.id]?'+':'-';
    btn.setAttribute('aria-label','Toggle section');
    h2.prepend(btn);
    if(saved[sec.id])toggleSection(sec,true);
    btn.addEventListener('click',function(e){
      e.preventDefault();
      var collapsed=btn.textContent==='-';
      toggleSection(sec,collapsed);
      btn.textContent=collapsed?'+':'-';
      saved[sec.id]=collapsed;
      localStorage.setItem('gsd-collapsed',JSON.stringify(saved));
    });
  });
  function toggleSection(sec,hide){
    var children=sec.children;
    for(var i=0;i<children.length;i++){
      if(children[i].tagName!=='H2')children[i].style.display=hide?'none':'';
    }
  }
})();
(function(){
  var hr=document.querySelector('.header-right');
  if(!hr)return;
  var btn=document.createElement('button');
  btn.className='theme-toggle';
  btn.textContent=localStorage.getItem('gsd-theme')==='light'?'Dark':'Light';
  if(localStorage.getItem('gsd-theme')==='light')document.documentElement.classList.add('light-theme');
  btn.addEventListener('click',function(){
    document.documentElement.classList.toggle('light-theme');
    var isLight=document.documentElement.classList.contains('light-theme');
    btn.textContent=isLight?'Dark':'Light';
    localStorage.setItem('gsd-theme',isLight?'light':'dark');
  });
  hr.prepend(btn);
})();
`;
