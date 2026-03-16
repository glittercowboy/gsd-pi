// View renderers for the GSD workflow visualizer overlay.

import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import type { VisualizerData, VisualizerMilestone } from "./visualizer-data.js";
import { formatCost, formatTokenCount, classifyUnitPhase } from "./metrics.js";

// ─── Local Helpers ───────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function padRight(content: string, width: number): string {
  const vis = visibleWidth(content);
  return content + " ".repeat(Math.max(0, width - vis));
}

function joinColumns(left: string, right: string, width: number): string {
  const leftW = visibleWidth(left);
  const rightW = visibleWidth(right);
  if (leftW + rightW + 2 > width) {
    return truncateToWidth(`${left}  ${right}`, width);
  }
  return left + " ".repeat(width - leftW - rightW) + right;
}

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const chars = "▁▂▃▄▅▆▇█";
  const max = Math.max(...values);
  if (max === 0) return chars[0].repeat(values.length);
  return values.map(v => chars[Math.min(7, Math.floor((v / max) * 7))]).join("");
}

// ─── Progress View ───────────────────────────────────────────────────────────

export interface ProgressFilter {
  text: string;
  field: "all" | "status" | "risk" | "keyword";
}

export function renderProgressView(
  data: VisualizerData,
  th: Theme,
  width: number,
  filter?: ProgressFilter,
): string[] {
  const lines: string[] = [];

  // Risk Heatmap
  lines.push(...renderRiskHeatmap(data, th, width));
  if (data.milestones.length > 0) lines.push("");

  // Filter indicator
  if (filter && filter.text) {
    lines.push(th.fg("accent", `Filter (${filter.field}): ${filter.text}`));
    lines.push("");
  }

  for (const ms of data.milestones) {
    // Apply filter to milestones
    if (filter && filter.text) {
      const matchesMs = matchesFilter(ms, filter);
      if (!matchesMs) continue;
    }

    // Milestone header line
    const statusGlyph =
      ms.status === "complete"
        ? th.fg("success", "✓")
        : ms.status === "active"
          ? th.fg("accent", "▸")
          : th.fg("dim", "○");
    const statusLabel =
      ms.status === "complete"
        ? th.fg("success", "complete")
        : ms.status === "active"
          ? th.fg("accent", "active")
          : th.fg("dim", "pending");
    const msLeft = `${ms.id}: ${ms.title}`;
    const msRight = `${statusGlyph} ${statusLabel}`;
    lines.push(joinColumns(msLeft, msRight, width));

    if (ms.slices.length === 0 && ms.dependsOn.length > 0) {
      lines.push(th.fg("dim", `  (depends on ${ms.dependsOn.join(", ")})`));
      continue;
    }

    if (ms.status === "pending" && ms.dependsOn.length > 0) {
      lines.push(th.fg("dim", `  (depends on ${ms.dependsOn.join(", ")})`));
      continue;
    }

    for (const sl of ms.slices) {
      // Apply filter to slices
      if (filter && filter.text) {
        if (!matchesSliceFilter(sl, filter)) continue;
      }

      // Slice line
      const slGlyph = sl.done
        ? th.fg("success", "✓")
        : sl.active
          ? th.fg("accent", "▸")
          : th.fg("dim", "○");
      const riskColor =
        sl.risk === "high"
          ? "warning"
          : sl.risk === "medium"
            ? "text"
            : "dim";
      const riskBadge = th.fg(riskColor, sl.risk);
      const slLeft = `  ${slGlyph} ${sl.id}: ${sl.title}`;
      lines.push(joinColumns(slLeft, riskBadge, width));

      // Show tasks for active slice
      if (sl.active && sl.tasks.length > 0) {
        for (const task of sl.tasks) {
          const tGlyph = task.done
            ? th.fg("success", "✓")
            : task.active
              ? th.fg("accent", "▸")
              : th.fg("dim", "○");
          lines.push(`      ${tGlyph} ${task.id}: ${task.title}`);
        }
      }
    }
  }

  return lines;
}

function matchesFilter(ms: VisualizerMilestone, filter: ProgressFilter): boolean {
  const text = filter.text.toLowerCase();
  if (filter.field === "status") {
    return ms.status.includes(text);
  }
  if (filter.field === "risk") {
    return ms.slices.some(s => s.risk.toLowerCase().includes(text));
  }
  // "all" or "keyword"
  if (ms.id.toLowerCase().includes(text)) return true;
  if (ms.title.toLowerCase().includes(text)) return true;
  if (ms.status.includes(text)) return true;
  return ms.slices.some(s => matchesSliceFilter(s, filter));
}

function matchesSliceFilter(sl: { id: string; title: string; risk: string }, filter: ProgressFilter): boolean {
  const text = filter.text.toLowerCase();
  if (filter.field === "status") return true; // slices don't have named status
  if (filter.field === "risk") return sl.risk.toLowerCase().includes(text);
  return sl.id.toLowerCase().includes(text) ||
    sl.title.toLowerCase().includes(text) ||
    sl.risk.toLowerCase().includes(text);
}

// ─── Risk Heatmap ────────────────────────────────────────────────────────────

function renderRiskHeatmap(data: VisualizerData, th: Theme, width: number): string[] {
  const allSlices = data.milestones.flatMap(m => m.slices);
  if (allSlices.length === 0) return [];

  const lines: string[] = [];
  lines.push(th.fg("accent", th.bold("Risk Heatmap")));
  lines.push("");

  for (const ms of data.milestones) {
    if (ms.slices.length === 0) continue;
    const blocks = ms.slices.map(s => {
      const color = s.risk === "high" ? "error" : s.risk === "medium" ? "warning" : "success";
      return th.fg(color, "██");
    });
    const row = `  ${padRight(ms.id, 6)} ${blocks.join(" ")}`;
    lines.push(truncateToWidth(row, width));
  }

  lines.push("");
  lines.push(
    `  ${th.fg("success", "██")} low  ${th.fg("warning", "██")} med  ${th.fg("error", "██")} high`,
  );

  // Summary counts
  let low = 0, med = 0, high = 0;
  let highNotStarted = 0;
  for (const sl of allSlices) {
    if (sl.risk === "high") {
      high++;
      if (!sl.done && !sl.active) highNotStarted++;
    } else if (sl.risk === "medium") {
      med++;
    } else {
      low++;
    }
  }

  let summary = `  Risk: ${low} low, ${med} med, ${high} high`;
  if (highNotStarted > 0) {
    summary += ` | ${th.fg("error", `${highNotStarted} high-risk not started`)}`;
  }
  lines.push(summary);

  return lines;
}

// ─── Dependencies View ───────────────────────────────────────────────────────

export function renderDepsView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];

  // Milestone Dependencies
  lines.push(th.fg("accent", th.bold("Milestone Dependencies")));
  lines.push("");

  const msDeps = data.milestones.filter((ms) => ms.dependsOn.length > 0);
  if (msDeps.length === 0) {
    lines.push(th.fg("dim", "  No milestone dependencies."));
  } else {
    for (const ms of msDeps) {
      for (const dep of ms.dependsOn) {
        lines.push(
          `  ${th.fg("text", dep)} ${th.fg("accent", "──►")} ${th.fg("text", ms.id)}`,
        );
      }
    }
  }

  lines.push("");

  // Slice Dependencies (active milestone)
  lines.push(th.fg("accent", th.bold("Slice Dependencies (active milestone)")));
  lines.push("");

  const activeMs = data.milestones.find((ms) => ms.status === "active");
  if (!activeMs) {
    lines.push(th.fg("dim", "  No active milestone."));
  } else {
    const slDeps = activeMs.slices.filter((sl) => sl.depends.length > 0);
    if (slDeps.length === 0) {
      lines.push(th.fg("dim", "  No slice dependencies."));
    } else {
      for (const sl of slDeps) {
        for (const dep of sl.depends) {
          lines.push(
            `  ${th.fg("text", dep)} ${th.fg("accent", "──►")} ${th.fg("text", sl.id)}`,
          );
        }
      }
    }
  }

  lines.push("");

  // Critical Path section
  lines.push(...renderCriticalPath(data, th, width));

  return lines;
}

// ─── Critical Path ───────────────────────────────────────────────────────────

function renderCriticalPath(data: VisualizerData, th: Theme, _width: number): string[] {
  const lines: string[] = [];
  const cp = data.criticalPath;

  lines.push(th.fg("accent", th.bold("Critical Path")));
  lines.push("");

  if (cp.milestonePath.length === 0) {
    lines.push(th.fg("dim", "  No critical path data."));
    return lines;
  }

  // Milestone chain
  const chain = cp.milestonePath.map(id => {
    const ms = data.milestones.find(m => m.id === id);
    const badge = th.fg("error", "[CRITICAL]");
    return `${id} ${badge}`;
  }).join(` ${th.fg("accent", "──►")} `);
  lines.push(`  ${chain}`);
  lines.push("");

  // Non-critical milestones with slack
  for (const ms of data.milestones) {
    if (cp.milestonePath.includes(ms.id)) continue;
    const slack = cp.milestoneSlack.get(ms.id) ?? 0;
    lines.push(th.fg("dim", `  ${ms.id} (slack: ${slack})`));
  }

  // Slice-level critical path
  if (cp.slicePath.length > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Slice Critical Path")));
    lines.push("");

    const sliceChain = cp.slicePath.join(` ${th.fg("accent", "──►")} `);
    lines.push(`  ${sliceChain}`);

    // Bottleneck warnings
    const activeMs = data.milestones.find(m => m.status === "active");
    if (activeMs) {
      for (const sid of cp.slicePath) {
        const sl = activeMs.slices.find(s => s.id === sid);
        if (sl && !sl.done && !sl.active) {
          lines.push(th.fg("warning", `  ⚠ ${sid}: critical but not yet started`));
        }
      }
    }
  }

  return lines;
}

// ─── Metrics View ────────────────────────────────────────────────────────────

export function renderMetricsView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];

  if (data.totals === null) {
    lines.push(th.fg("dim", "No metrics data available."));
    return lines;
  }

  const totals = data.totals;

  // Summary line
  lines.push(
    th.fg("accent", th.bold("Summary")),
  );
  lines.push(
    `  Cost: ${th.fg("text", formatCost(totals.cost))}  ` +
    `Tokens: ${th.fg("text", formatTokenCount(totals.tokens.total))}  ` +
    `Units: ${th.fg("text", String(totals.units))}`,
  );
  lines.push("");

  const barWidth = Math.max(10, width - 40);

  // By Phase
  if (data.byPhase.length > 0) {
    lines.push(th.fg("accent", th.bold("By Phase")));
    lines.push("");

    const maxPhaseCost = Math.max(...data.byPhase.map((p) => p.cost));

    for (const phase of data.byPhase) {
      const pct = totals.cost > 0 ? (phase.cost / totals.cost) * 100 : 0;
      const fillLen =
        maxPhaseCost > 0
          ? Math.round((phase.cost / maxPhaseCost) * barWidth)
          : 0;
      const bar =
        th.fg("accent", "█".repeat(fillLen)) +
        th.fg("dim", "░".repeat(barWidth - fillLen));
      const label = padRight(phase.phase, 14);
      const costStr = formatCost(phase.cost);
      const pctStr = `${pct.toFixed(1)}%`;
      const tokenStr = formatTokenCount(phase.tokens.total);
      lines.push(`  ${label} ${bar} ${costStr} ${pctStr} ${tokenStr}`);
    }

    lines.push("");
  }

  // By Model
  if (data.byModel.length > 0) {
    lines.push(th.fg("accent", th.bold("By Model")));
    lines.push("");

    const maxModelCost = Math.max(...data.byModel.map((m) => m.cost));

    for (const model of data.byModel) {
      const pct = totals.cost > 0 ? (model.cost / totals.cost) * 100 : 0;
      const fillLen =
        maxModelCost > 0
          ? Math.round((model.cost / maxModelCost) * barWidth)
          : 0;
      const bar =
        th.fg("accent", "█".repeat(fillLen)) +
        th.fg("dim", "░".repeat(barWidth - fillLen));
      const label = padRight(model.model, 20);
      const costStr = formatCost(model.cost);
      const pctStr = `${pct.toFixed(1)}%`;
      lines.push(`  ${label} ${bar} ${costStr} ${pctStr}`);
    }

    lines.push("");
  }

  // Cost Projections
  lines.push(...renderCostProjections(data, th, width));

  return lines;
}

// ─── Cost Projections ────────────────────────────────────────────────────────

function renderCostProjections(data: VisualizerData, th: Theme, _width: number): string[] {
  const lines: string[] = [];

  if (!data.totals || data.bySlice.length === 0) return lines;

  lines.push(th.fg("accent", th.bold("Projections")));
  lines.push("");

  // Average cost per slice
  const sliceLevelEntries = data.bySlice.filter(s => s.sliceId.includes("/"));
  if (sliceLevelEntries.length < 2) {
    lines.push(th.fg("dim", "  Insufficient data for projections (need 2+ completed slices)."));
    return lines;
  }

  const totalSliceCost = sliceLevelEntries.reduce((sum, s) => sum + s.cost, 0);
  const avgCostPerSlice = totalSliceCost / sliceLevelEntries.length;
  const projectedRemaining = avgCostPerSlice * data.remainingSliceCount;

  lines.push(`  Avg cost/slice: ${th.fg("text", formatCost(avgCostPerSlice))}`);
  lines.push(
    `  Projected remaining: ${th.fg("text", formatCost(projectedRemaining))} ` +
    `(${formatCost(avgCostPerSlice)}/slice × ${data.remainingSliceCount} remaining)`,
  );

  // Burn rate
  if (data.totals.duration > 0) {
    const costPerHour = data.totals.cost / (data.totals.duration / 3_600_000);
    lines.push(`  Burn rate: ${th.fg("text", formatCost(costPerHour) + "/hr")}`);
  }

  // Sparkline of per-slice costs
  const sliceCosts = sliceLevelEntries.map(s => s.cost);
  if (sliceCosts.length > 0) {
    const spark = sparkline(sliceCosts);
    lines.push(`  Cost trend: ${spark}`);
  }

  // Budget warning: projected total > 2× current spend
  const projectedTotal = data.totals.cost + projectedRemaining;
  if (projectedTotal > 2 * data.totals.cost && data.remainingSliceCount > 0) {
    lines.push(th.fg("warning", `  ⚠ Projected total ${formatCost(projectedTotal)} exceeds 2× current spend`));
  }

  return lines;
}

// ─── Timeline View (Gantt) ──────────────────────────────────────────────────

export function renderTimelineView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];

  if (data.units.length === 0) {
    lines.push(th.fg("dim", "No execution history."));
    return lines;
  }

  // Gantt mode for wide terminals, list mode for narrow
  if (width >= 90) {
    return renderGanttView(data, th, width);
  }

  return renderTimelineList(data, th, width);
}

function renderTimelineList(data: VisualizerData, th: Theme, width: number): string[] {
  const lines: string[] = [];

  // Show up to 20 most recent (units are sorted by startedAt asc, show most recent)
  const recent = data.units.slice(-20).reverse();

  const maxDuration = Math.max(
    ...recent.map((u) => u.finishedAt - u.startedAt),
  );
  const timeBarWidth = Math.max(4, Math.min(12, width - 60));

  for (const unit of recent) {
    const dt = new Date(unit.startedAt);
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const time = `${hh}:${mm}`;

    const duration = unit.finishedAt - unit.startedAt;
    const glyph =
      unit.finishedAt > 0
        ? th.fg("success", "✓")
        : th.fg("accent", "▸");

    const typeLabel = padRight(unit.type, 16);
    const idLabel = padRight(unit.id, 14);

    const fillLen =
      maxDuration > 0
        ? Math.round((duration / maxDuration) * timeBarWidth)
        : 0;
    const bar =
      th.fg("accent", "█".repeat(fillLen)) +
      th.fg("dim", "░".repeat(timeBarWidth - fillLen));

    const durStr = formatDuration(duration);
    const costStr = formatCost(unit.cost);

    const line = `  ${time}  ${glyph} ${typeLabel} ${idLabel} ${bar}  ${durStr}  ${costStr}`;
    lines.push(truncateToWidth(line, width));
  }

  return lines;
}

function renderGanttView(data: VisualizerData, th: Theme, width: number): string[] {
  const lines: string[] = [];
  const recent = data.units.slice(-20);
  if (recent.length === 0) return lines;

  const finishedUnits = recent.filter(u => u.finishedAt > 0);
  if (finishedUnits.length === 0) return renderTimelineList(data, th, width);

  const minStart = Math.min(...recent.map(u => u.startedAt));
  const maxEnd = Math.max(...recent.map(u => u.finishedAt > 0 ? u.finishedAt : Date.now()));
  const totalSpan = maxEnd - minStart;
  if (totalSpan <= 0) return renderTimelineList(data, th, width);

  const gutterWidth = 20;
  const barArea = Math.max(10, width - gutterWidth - 25);

  // Time axis labels
  const startLabel = formatTimeLabel(minStart);
  const endLabel = formatTimeLabel(maxEnd);
  lines.push(
    `${" ".repeat(gutterWidth)} ${th.fg("dim", startLabel)}` +
    `${" ".repeat(Math.max(1, barArea - startLabel.length - endLabel.length))}` +
    `${th.fg("dim", endLabel)}`,
  );

  // Phase tracking for separators
  let lastPhase = "";

  for (const unit of recent) {
    const phase = classifyUnitPhase(unit.type);
    if (phase !== lastPhase && lastPhase !== "") {
      lines.push(th.fg("dim", "  " + "─".repeat(width - 4)));
    }
    lastPhase = phase;

    const end = unit.finishedAt > 0 ? unit.finishedAt : Date.now();
    const startPos = Math.round(((unit.startedAt - minStart) / totalSpan) * barArea);
    const endPos = Math.round(((end - minStart) / totalSpan) * barArea);
    const barLen = Math.max(1, endPos - startPos);

    const phaseColor =
      phase === "research" ? "dim" :
      phase === "planning" ? "accent" :
      phase === "execution" ? "success" :
      "warning";

    const barStr =
      " ".repeat(startPos) +
      th.fg(phaseColor, "█".repeat(barLen)) +
      " ".repeat(Math.max(0, barArea - startPos - barLen));

    const gutter = padRight(
      truncateToWidth(`${unit.type.slice(0, 8)} ${unit.id}`, gutterWidth - 1),
      gutterWidth,
    );

    const duration = end - unit.startedAt;
    const durStr = formatDuration(duration);
    const costStr = formatCost(unit.cost);

    lines.push(truncateToWidth(`${gutter}${barStr} ${durStr} ${costStr}`, width));
  }

  return lines;
}

function formatTimeLabel(ts: number): string {
  const dt = new Date(ts);
  return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

// ─── Agent View ──────────────────────────────────────────────────────────────

export function renderAgentView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];
  const activity = data.agentActivity;

  if (!activity) {
    lines.push(th.fg("dim", "No agent activity data."));
    return lines;
  }

  // Status line
  const statusDot = activity.active
    ? th.fg("success", "●")
    : th.fg("dim", "○");
  const statusText = activity.active ? "ACTIVE" : "IDLE";
  const elapsedStr = activity.active ? formatDuration(activity.elapsed) : "—";

  lines.push(
    joinColumns(
      `Status: ${statusDot} ${statusText}`,
      `Elapsed: ${elapsedStr}`,
      width,
    ),
  );

  if (activity.currentUnit) {
    lines.push(`Current: ${th.fg("accent", `${activity.currentUnit.type} ${activity.currentUnit.id}`)}`);
  } else {
    lines.push(th.fg("dim", "Not in auto mode"));
  }

  lines.push("");

  // Progress bar
  const completed = activity.completedUnits;
  const total = Math.max(completed, activity.totalSlices);
  if (total > 0) {
    const pct = Math.min(1, completed / total);
    const barW = Math.max(10, Math.min(30, width - 30));
    const fillLen = Math.round(pct * barW);
    const bar =
      th.fg("accent", "█".repeat(fillLen)) +
      th.fg("dim", "░".repeat(barW - fillLen));
    lines.push(`Progress ${bar} ${completed}/${total} slices`);
  }

  // Rate and session stats
  const rateStr = activity.completionRate > 0
    ? `${activity.completionRate.toFixed(1)} units/hr`
    : "—";
  lines.push(
    `Rate: ${th.fg("text", rateStr)}    ` +
    `Session: ${th.fg("text", formatCost(activity.sessionCost))}  ` +
    `${th.fg("text", formatTokenCount(activity.sessionTokens))} tokens`,
  );

  lines.push("");

  // Recent completed units (last 5)
  const recentUnits = data.units.filter(u => u.finishedAt > 0).slice(-5).reverse();
  if (recentUnits.length > 0) {
    lines.push(th.fg("accent", th.bold("Recent (last 5):")));
    for (const u of recentUnits) {
      const dt = new Date(u.startedAt);
      const hh = String(dt.getHours()).padStart(2, "0");
      const mm = String(dt.getMinutes()).padStart(2, "0");
      const dur = formatDuration(u.finishedAt - u.startedAt);
      const cost = formatCost(u.cost);
      const typeLabel = padRight(u.type, 16);
      lines.push(
        truncateToWidth(
          `  ${hh}:${mm}  ${th.fg("success", "✓")} ${typeLabel} ${padRight(u.id, 16)} ${dur}  ${cost}`,
          width,
        ),
      );
    }
  } else {
    lines.push(th.fg("dim", "No completed units yet."));
  }

  return lines;
}

// ─── Changelog View ──────────────────────────────────────────────────────────

export function renderChangelogView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];
  const changelog = data.changelog;

  if (changelog.entries.length === 0) {
    lines.push(th.fg("dim", "No completed slices yet."));
    return lines;
  }

  lines.push(th.fg("accent", th.bold("Changes")));
  lines.push("");

  for (const entry of changelog.entries) {
    const header = `${entry.milestoneId}/${entry.sliceId}: ${entry.title}`;
    lines.push(th.fg("success", header));

    if (entry.oneLiner) {
      lines.push(`  "${th.fg("text", entry.oneLiner)}"`);
    }

    if (entry.filesModified.length > 0) {
      lines.push("  Files:");
      for (const f of entry.filesModified) {
        lines.push(
          truncateToWidth(
            `    ${th.fg("success", "✓")} ${f.path} — ${f.description}`,
            width,
          ),
        );
      }
    }

    if (entry.completedAt) {
      lines.push(th.fg("dim", `  Completed: ${entry.completedAt}`));
    }

    lines.push("");
  }

  return lines;
}

// ─── Export View ─────────────────────────────────────────────────────────────

export function renderExportView(
  _data: VisualizerData,
  th: Theme,
  _width: number,
  lastExportPath?: string,
): string[] {
  const lines: string[] = [];

  lines.push(th.fg("accent", th.bold("Export Options")));
  lines.push("");
  lines.push(`  ${th.fg("accent", "[m]")}  Markdown report — full project summary with tables`);
  lines.push(`  ${th.fg("accent", "[j]")}  JSON report — machine-readable project data`);
  lines.push(`  ${th.fg("accent", "[s]")}  Snapshot — current view as plain text`);

  if (lastExportPath) {
    lines.push("");
    lines.push(th.fg("dim", `Last export: ${lastExportPath}`));
  }

  return lines;
}
