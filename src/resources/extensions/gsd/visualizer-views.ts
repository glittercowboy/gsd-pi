// View renderers for the GSD workflow visualizer overlay.

import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import type { VisualizerData, VisualizerMilestone, SliceVerification, VisualizerSliceActivity, VisualizerStats, VisualizerSliceRef } from "./visualizer-data.js";
import { formatCost, formatTokenCount, classifyUnitPhase } from "./metrics.js";
import { formatDuration, padRight, joinColumns, sparkline, STATUS_GLYPH, STATUS_COLOR } from "../shared/mod.js";

function formatCompletionDate(input: string): string {
  if (!input) return "unknown";
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return input;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sliceLabel(slice: VisualizerSliceRef): string {
  return `${slice.milestoneId}/${slice.sliceId}`;
}

function renderFeatureStats(data: VisualizerData, th: Theme, width: number): string[] {
  const stats = data.stats;
  const lines: string[] = [];
  lines.push(th.fg("accent", th.bold("Feature Snapshot")));
  lines.push("");

  const missingLabel = `Missing slices: ${th.fg("warning", String(stats.missingCount))}`;
  lines.push(truncateToWidth(`  ${missingLabel}`, width));
  if (stats.missingSlices.length > 0) {
    for (const slice of stats.missingSlices) {
      const row = `    ${th.fg("dim", sliceLabel(slice))} ${slice.title}`;
      lines.push(truncateToWidth(row, width));
    }
    const remaining = stats.missingCount - stats.missingSlices.length;
    if (remaining > 0) {
      lines.push(truncateToWidth(`    ... and ${remaining} more`, width));
    }
  }

  lines.push("");
  const updatedLabel = `Updated (last 7 days): ${th.fg("accent", String(stats.updatedCount))}`;
  lines.push(truncateToWidth(`  ${updatedLabel}`, width));
  if (stats.updatedSlices.length > 0) {
    for (const slice of stats.updatedSlices) {
      const when = formatCompletionDate(slice.completedAt);
      const row = `    ${th.fg("text", sliceLabel(slice))} ${th.fg("dim", when)} ${slice.title}`;
      lines.push(truncateToWidth(row, width));
    }
  }

  lines.push("");
  lines.push(truncateToWidth(`  Recent completions: ${th.fg("success", String(stats.recentEntries.length))}`, width));
  for (const entry of stats.recentEntries) {
    const when = formatCompletionDate(entry.completedAt);
    const row = `    ${th.fg("text", entry.sliceId)} — ${entry.oneLiner || entry.title} ${th.fg("dim", when)}`;
    lines.push(truncateToWidth(row, width));
  }

  lines.push("");
  return lines;
}

function renderDiscussionStatus(data: VisualizerData, th: Theme, width: number): string[] {
  const states = data.discussion;
  if (states.length === 0) return [];

  const counts = {
    discussed: 0,
    draft: 0,
    undiscussed: 0,
  };
  for (const state of states) counts[state.state]++;

  const lines: string[] = [];
  lines.push(th.fg("accent", th.bold("Discussion Status")));
  lines.push("");
  const summary = `  Discussed: ${th.fg("success", String(counts.discussed))}  Draft: ${th.fg("warning", String(counts.draft))}  Pending: ${th.fg("dim", String(counts.undiscussed))}`;
  lines.push(truncateToWidth(summary, width));
  lines.push("");

  for (const state of states) {
    const badge =
      state.state === "discussed"
        ? th.fg("success", "Discussed")
        : state.state === "draft"
          ? th.fg("warning", "Draft")
          : th.fg("dim", "Pending");
    const when = state.lastUpdated ? ` ${th.fg("dim", formatCompletionDate(state.lastUpdated))}` : "";
    const row = `    ${th.fg("text", state.milestoneId)} ${badge} ${state.title}${when}`;
    lines.push(truncateToWidth(row, width));
  }

  lines.push("");
  return lines;
}

function findVerification(data: VisualizerData, milestoneId: string, sliceId: string): SliceVerification | undefined {
  return data.sliceVerifications.find(v => v.milestoneId === milestoneId && v.sliceId === sliceId);
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
  collapsed?: Set<string>,
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

  lines.push(...renderFeatureStats(data, th, width));
  lines.push(...renderDiscussionStatus(data, th, width));

  for (const ms of data.milestones) {
    // Apply filter to milestones
    if (filter && filter.text) {
      const matchesMs = matchesFilter(ms, filter);
      if (!matchesMs) continue;
    }

    // Milestone header line
    const msStatus = ms.status === "complete" ? "done" : ms.status === "active" ? "active" : ms.status === "parked" ? "paused" : "pending";
    const statusGlyph = th.fg(STATUS_COLOR[msStatus], STATUS_GLYPH[msStatus]);
    const statusLabel = th.fg(STATUS_COLOR[msStatus], ms.status);

    const collapseIndicator = collapsed?.has(ms.id) ? "[+] " : "";
    const msLeft = `${collapseIndicator}${ms.id}: ${ms.title}`;
    const msRight = `${statusGlyph} ${statusLabel}`;
    lines.push(joinColumns(msLeft, msRight, width));

    // If collapsed, skip rendering slices/tasks
    if (collapsed?.has(ms.id)) continue;

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
      const slStatus = sl.done ? "done" : sl.active ? "active" : "pending";
      const slGlyph = th.fg(STATUS_COLOR[slStatus], STATUS_GLYPH[slStatus]);
      const riskColor =
        sl.risk === "high"
          ? "warning"
          : sl.risk === "medium"
            ? "text"
            : "dim";
      const riskBadge = th.fg(riskColor, sl.risk);

      // Verification badge
      const ver = findVerification(data, ms.id, sl.id);
      let verBadge = "";
      if (ver) {
        if (ver.verificationResult === "passed") {
          verBadge = " " + th.fg("success", "\u2713");
        } else if (ver.verificationResult === "failed") {
          verBadge = " " + th.fg("error", "\u2717");
        } else if (ver.verificationResult === "untested" || ver.verificationResult === "") {
          verBadge = " " + th.fg("dim", "?");
        }
        if (ver.blockerDiscovered) {
          verBadge += " " + th.fg("warning", "\u26a0");
        }
      }

      const slLeft = `  ${slGlyph} ${sl.id}: ${sl.title}${verBadge}`;
      lines.push(joinColumns(slLeft, riskBadge, width));

      // Show tasks for active slice
      if (sl.active && sl.tasks.length > 0) {
        for (const task of sl.tasks) {
          const tStatus = task.done ? "done" : task.active ? "active" : "pending";
          const tGlyph = th.fg(STATUS_COLOR[tStatus], STATUS_GLYPH[tStatus]);
          const estimateStr = task.estimate ? th.fg("dim", ` (${task.estimate})`) : "";
          lines.push(`      ${tGlyph} ${task.id}: ${task.title}${estimateStr}`);
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
      return th.fg(color, "\u2588\u2588");
    });
    const row = `  ${padRight(ms.id, 6)} ${blocks.join(" ")}`;
    lines.push(truncateToWidth(row, width));
  }

  lines.push("");
  lines.push(
    `  ${th.fg("success", "\u2588\u2588")} low  ${th.fg("warning", "\u2588\u2588")} med  ${th.fg("error", "\u2588\u2588")} high`,
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
          `  ${th.fg("text", dep)} ${th.fg("accent", "\u2500\u2500\u25ba")} ${th.fg("text", ms.id)}`,
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
            `  ${th.fg("text", dep)} ${th.fg("accent", "\u2500\u2500\u25ba")} ${th.fg("text", sl.id)}`,
          );
        }
      }
    }
  }

  lines.push("");

  // Critical Path section
  lines.push(...renderCriticalPath(data, th, width));

  // Data Flow section from slice verifications
  lines.push("");
  lines.push(...renderDataFlow(data, th));

  return lines;
}

// ─── Data Flow ───────────────────────────────────────────────────────────────

function renderDataFlow(data: VisualizerData, th: Theme): string[] {
  const lines: string[] = [];
  const versWithProvides = data.sliceVerifications.filter(v => v.provides.length > 0);
  const versWithRequires = data.sliceVerifications.filter(v => v.requires.length > 0);

  if (versWithProvides.length === 0 && versWithRequires.length === 0) return lines;

  lines.push(th.fg("accent", th.bold("Data Flow")));
  lines.push("");

  for (const v of versWithProvides) {
    for (const artifact of v.provides) {
      lines.push(`  ${th.fg("text", v.sliceId)} ${th.fg("accent", "\u2500\u2500\u25ba")} ${th.fg("dim", `[${artifact}]`)}`);
    }
  }

  for (const v of versWithRequires) {
    for (const req of v.requires) {
      lines.push(`  ${th.fg("dim", `[${req.provides}]`)} ${th.fg("accent", "\u25c4\u2500\u2500")} ${th.fg("text", req.slice)}`);
    }
  }

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
    const badge = th.fg("error", "[CRITICAL]");
    return `${id} ${badge}`;
  }).join(` ${th.fg("accent", "\u2500\u2500\u25ba")} `);
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

    const sliceChain = cp.slicePath.join(` ${th.fg("accent", "\u2500\u2500\u25ba")} `);
    lines.push(`  ${sliceChain}`);

    // Bottleneck warnings
    const activeMs = data.milestones.find(m => m.status === "active");
    if (activeMs) {
      for (const sid of cp.slicePath) {
        const sl = activeMs.slices.find(s => s.id === sid);
        if (sl && !sl.done && !sl.active) {
          lines.push(th.fg("warning", `  \u26a0 ${sid}: critical but not yet started`));
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
  lines.push(
    `  Tools: ${th.fg("text", String(totals.toolCalls))}  ` +
    `Messages: ${th.fg("text", String(totals.assistantMessages))} sent / ${th.fg("text", String(totals.userMessages))} received`,
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
        th.fg("accent", "\u2588".repeat(fillLen)) +
        th.fg("dim", "\u2591".repeat(barWidth - fillLen));
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
        th.fg("accent", "\u2588".repeat(fillLen)) +
        th.fg("dim", "\u2591".repeat(barWidth - fillLen));
      const label = padRight(model.model, 20);
      const costStr = formatCost(model.cost);
      const pctStr = `${pct.toFixed(1)}%`;
      lines.push(`  ${label} ${bar} ${costStr} ${pctStr}`);
    }

    lines.push("");
  }

  // By Tier
  if (data.byTier.length > 0) {
    lines.push(th.fg("accent", th.bold("By Tier")));
    lines.push("");

    const maxTierCost = Math.max(...data.byTier.map((t) => t.cost));

    for (const tier of data.byTier) {
      const pct = totals.cost > 0 ? (tier.cost / totals.cost) * 100 : 0;
      const fillLen =
        maxTierCost > 0
          ? Math.round((tier.cost / maxTierCost) * barWidth)
          : 0;
      const bar =
        th.fg("accent", "\u2588".repeat(fillLen)) +
        th.fg("dim", "\u2591".repeat(barWidth - fillLen));
      const label = padRight(tier.tier, 12);
      const costStr = formatCost(tier.cost);
      const pctStr = `${pct.toFixed(1)}%`;
      const unitsStr = `${tier.units} units`;
      lines.push(`  ${label} ${bar} ${costStr} ${pctStr} ${unitsStr}`);
    }

    if (data.tierSavingsLine) {
      lines.push(`  ${th.fg("success", data.tierSavingsLine)}`);
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
    `(${formatCost(avgCostPerSlice)}/slice \u00d7 ${data.remainingSliceCount} remaining)`,
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

  // Budget warning: projected total > 2x current spend
  const projectedTotal = data.totals.cost + projectedRemaining;
  if (projectedTotal > 2 * data.totals.cost && data.remainingSliceCount > 0) {
    lines.push(th.fg("warning", `  \u26a0 Projected total ${formatCost(projectedTotal)} exceeds 2\u00d7 current spend`));
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

function shortenModel(model: string): string {
  return model.replace(/^claude-/, "").slice(0, 12);
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
    const unitStatus = unit.finishedAt > 0 ? "done" : "active";
    const glyph = th.fg(STATUS_COLOR[unitStatus], STATUS_GLYPH[unitStatus]);

    const typeLabel = padRight(unit.type, 16);
    const idLabel = padRight(unit.id, 14);

    const fillLen =
      maxDuration > 0
        ? Math.round((duration / maxDuration) * timeBarWidth)
        : 0;
    const bar =
      th.fg("accent", "\u2588".repeat(fillLen)) +
      th.fg("dim", "\u2591".repeat(timeBarWidth - fillLen));

    const durStr = formatDuration(duration);
    const costStr = formatCost(unit.cost);

    // Tier and model info
    const tierLabel = unit.tier ? th.fg("dim", `[${unit.tier}]`) : "";
    const modelLabel = th.fg("dim", shortenModel(unit.model));
    const tierModelPart = [tierLabel, modelLabel].filter(Boolean).join(" ");

    const line = `  ${time}  ${glyph} ${typeLabel} ${tierModelPart} ${idLabel} ${bar}  ${durStr}  ${costStr}`;
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
      lines.push(th.fg("dim", "  " + "\u2500".repeat(width - 4)));
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
      th.fg(phaseColor, "\u2588".repeat(barLen)) +
      " ".repeat(Math.max(0, barArea - startPos - barLen));

    const tierTag = unit.tier ? `[${unit.tier[0]}]` : "";
    const gutter = padRight(
      truncateToWidth(`${unit.type.slice(0, 8)} ${unit.id}${tierTag}`, gutterWidth - 1),
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
  const agentStatus = activity.active ? "active" : "pending";
  const statusDot = th.fg(STATUS_COLOR[agentStatus], STATUS_GLYPH[agentStatus]);
  const statusText = activity.active ? "ACTIVE" : "IDLE";
  const elapsedStr = activity.active ? formatDuration(activity.elapsed) : "\u2014";

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
      th.fg("accent", "\u2588".repeat(fillLen)) +
      th.fg("dim", "\u2591".repeat(barW - fillLen));
    lines.push(`Progress ${bar} ${completed}/${total} slices`);
  }

  // Rate and session stats
  const rateStr = activity.completionRate > 0
    ? `${activity.completionRate.toFixed(1)} units/hr`
    : "\u2014";
  lines.push(
    `Rate: ${th.fg("text", rateStr)}    ` +
    `Session: ${th.fg("text", formatCost(activity.sessionCost))}  ` +
    `${th.fg("text", formatTokenCount(activity.sessionTokens))} tokens`,
  );

  lines.push("");

  // Budget pressure
  const health = data.health;
  const truncColor = health.truncationRate < 10 ? "success" : health.truncationRate < 30 ? "warning" : "error";
  const contColor = health.continueHereRate < 10 ? "success" : health.continueHereRate < 30 ? "warning" : "error";
  lines.push(th.fg("accent", th.bold("Pressure")));
  lines.push(`  Truncation rate: ${th.fg(truncColor, `${health.truncationRate.toFixed(1)}%`)}`);
  lines.push(`  Continue-here rate: ${th.fg(contColor, `${health.continueHereRate.toFixed(1)}%`)}`);

  // Pending captures
  if (data.captures.pendingCount > 0) {
    lines.push(`  Pending captures: ${th.fg("warning", String(data.captures.pendingCount))}`);
  }

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
          `  ${hh}:${mm}  ${th.fg(STATUS_COLOR.done, STATUS_GLYPH.done)} ${typeLabel} ${padRight(u.id, 16)} ${dur}  ${cost}`,
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
            `    ${th.fg(STATUS_COLOR.done, STATUS_GLYPH.done)} ${f.path} \u2014 ${f.description}`,
            width,
          ),
        );
      }
    }

    // Decisions and patterns from slice verification
    const ver = findVerification(data, entry.milestoneId, entry.sliceId);
    if (ver) {
      if (ver.keyDecisions.length > 0) {
        lines.push("  Decisions:");
        for (const d of ver.keyDecisions) {
          lines.push(`    - ${d}`);
        }
      }
      if (ver.patternsEstablished.length > 0) {
        lines.push("  Patterns:");
        for (const p of ver.patternsEstablished) {
          lines.push(`    - ${p}`);
        }
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
  lines.push(`  ${th.fg("accent", "[m]")}  Markdown report \u2014 full project summary with tables`);
  lines.push(`  ${th.fg("accent", "[j]")}  JSON report \u2014 machine-readable project data`);
  lines.push(`  ${th.fg("accent", "[s]")}  Snapshot \u2014 current view as plain text`);

  if (lastExportPath) {
    lines.push("");
    lines.push(th.fg("dim", `Last export: ${lastExportPath}`));
  }

  return lines;
}

// ─── Knowledge View ──────────────────────────────────────────────────────────

export function renderKnowledgeView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];
  const knowledge = data.knowledge;

  if (!knowledge.exists) {
    lines.push(th.fg("dim", "No KNOWLEDGE.md found"));
    return lines;
  }

  if (knowledge.rules.length === 0 && knowledge.patterns.length === 0 && knowledge.lessons.length === 0) {
    lines.push(th.fg("dim", "KNOWLEDGE.md exists but is empty"));
    return lines;
  }

  // Rules section
  if (knowledge.rules.length > 0) {
    lines.push(th.fg("accent", th.bold("Rules")));
    lines.push("");
    for (const rule of knowledge.rules) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", rule.id)}  ${th.fg("dim", `[${rule.scope}]`)}  ${rule.content}`,
        width,
      ));
    }
    lines.push("");
  }

  // Patterns section
  if (knowledge.patterns.length > 0) {
    lines.push(th.fg("accent", th.bold("Patterns")));
    lines.push("");
    for (const pattern of knowledge.patterns) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", pattern.id)}  ${pattern.content}`,
        width,
      ));
    }
    lines.push("");
  }

  // Lessons section
  if (knowledge.lessons.length > 0) {
    lines.push(th.fg("accent", th.bold("Lessons Learned")));
    lines.push("");
    for (const lesson of knowledge.lessons) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", lesson.id)}  ${lesson.content}`,
        width,
      ));
    }
    lines.push("");
  }

  return lines;
}

// ─── Captures View ───────────────────────────────────────────────────────────

export function renderCapturesView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];
  const captures = data.captures;

  // Summary line
  const resolved = captures.entries.filter(e => e.status === "resolved").length;
  lines.push(
    `${th.fg("text", String(captures.totalCount))} total \u00b7 ` +
    `${th.fg("warning", String(captures.pendingCount))} pending \u00b7 ` +
    `${th.fg("dim", String(resolved))} resolved`,
  );
  lines.push("");

  if (captures.entries.length === 0) {
    lines.push(th.fg("dim", "No captures recorded."));
    return lines;
  }

  // Group by status: pending first, then triaged, then resolved
  const statusOrder: Record<string, number> = { pending: 0, triaged: 1, resolved: 2 };
  const sorted = [...captures.entries].sort((a, b) =>
    (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3),
  );

  for (const entry of sorted) {
    const statusColor =
      entry.status === "pending" ? "warning" :
      entry.status === "triaged" ? "accent" :
      "dim";

    const classColor =
      entry.classification === "inject" ? "warning" :
      entry.classification === "quick-task" ? "accent" :
      entry.classification === "replan" ? "error" :
      entry.classification === "defer" ? "text" :
      "dim";

    const classBadge = entry.classification
      ? th.fg(classColor, `(${entry.classification})`)
      : "";

    const statusBadge = th.fg(statusColor, `[${entry.status}]`);
    const textPreview = truncateToWidth(entry.text, Math.max(20, width - 50));

    lines.push(`  ${th.fg("accent", entry.id)} ${statusBadge} ${textPreview} ${classBadge}`);
    if (entry.timestamp) {
      lines.push(`    ${th.fg("dim", entry.timestamp)}`);
    }
  }

  return lines;
}

// ─── Health View ─────────────────────────────────────────────────────────────

export function renderHealthView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];
  const health = data.health;

  // Budget section
  lines.push(th.fg("accent", th.bold("Budget")));
  lines.push("");
  if (health.budgetCeiling !== undefined) {
    const currentSpend = data.totals?.cost ?? 0;
    const pct = health.budgetCeiling > 0 ? Math.min(1, currentSpend / health.budgetCeiling) : 0;
    const barW = Math.max(10, Math.min(30, width - 40));
    const fillLen = Math.round(pct * barW);
    const budgetColor = pct < 0.7 ? "success" : pct < 0.9 ? "warning" : "error";
    const bar =
      th.fg(budgetColor, "\u2588".repeat(fillLen)) +
      th.fg("dim", "\u2591".repeat(barW - fillLen));
    lines.push(`  Ceiling: ${th.fg("text", formatCost(health.budgetCeiling))}`);
    lines.push(`  Spend:   ${bar} ${formatCost(currentSpend)} (${(pct * 100).toFixed(1)}%)`);
  } else {
    lines.push(th.fg("dim", "  No budget ceiling set"));
  }
  lines.push(`  Token profile: ${th.fg("text", health.tokenProfile)}`);
  lines.push("");

  // Pressure section
  lines.push(th.fg("accent", th.bold("Pressure")));
  lines.push("");
  const truncColor = health.truncationRate < 10 ? "success" : health.truncationRate < 30 ? "warning" : "error";
  const contColor = health.continueHereRate < 10 ? "success" : health.continueHereRate < 30 ? "warning" : "error";
  const pressBarW = Math.max(10, Math.min(20, width - 50));

  const truncFill = Math.round((Math.min(health.truncationRate, 100) / 100) * pressBarW);
  const truncBar = th.fg(truncColor, "\u2588".repeat(truncFill)) + th.fg("dim", "\u2591".repeat(pressBarW - truncFill));
  lines.push(`  Truncation:    ${truncBar} ${health.truncationRate.toFixed(1)}%`);

  const contFill = Math.round((Math.min(health.continueHereRate, 100) / 100) * pressBarW);
  const contBar = th.fg(contColor, "\u2588".repeat(contFill)) + th.fg("dim", "\u2591".repeat(pressBarW - contFill));
  lines.push(`  Continue-here: ${contBar} ${health.continueHereRate.toFixed(1)}%`);
  lines.push("");

  // Routing section
  if (health.tierBreakdown.length > 0) {
    lines.push(th.fg("accent", th.bold("Routing")));
    lines.push("");
    for (const tier of health.tierBreakdown) {
      const downTag = tier.downgraded > 0 ? th.fg("warning", ` (${tier.downgraded} downgraded)`) : "";
      lines.push(`  ${padRight(tier.tier, 12)} ${tier.units} units  ${formatCost(tier.cost)}${downTag}`);
    }
    if (health.tierSavingsLine) {
      lines.push(`  ${th.fg("success", health.tierSavingsLine)}`);
    }
    lines.push("");
  }

  // Session section
  lines.push(th.fg("accent", th.bold("Session")));
  lines.push("");
  lines.push(`  Tool calls: ${th.fg("text", String(health.toolCalls))}`);
  lines.push(`  Messages: ${th.fg("text", String(health.assistantMessages))} sent / ${th.fg("text", String(health.userMessages))} received`);

  // Environment section — issues only (from doctor-environment.ts, #1221)
  if (health.environmentIssues?.length > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Environment")));
    lines.push("");
    for (const r of health.environmentIssues) {
      const icon = r.status === "error" ? th.fg("error", "✗") : th.fg("warning", "⚠");
      lines.push(`  ${icon} ${th.fg("text", r.message)}`);
      if (r.detail) lines.push(`    ${th.fg("dim", r.detail)}`);
    }
  }

  // Providers section
  if (health.providers?.length > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Providers")));
    lines.push("");
    const categoryOrder = ["llm", "remote", "search", "tool"];
    const categoryLabels: Record<string, string> = { llm: "LLM", remote: "Notifications", search: "Search", tool: "Tools" };
    const grouped = new Map<string, typeof health.providers>();
    for (const p of health.providers) {
      const cat = p.category;
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(p);
    }
    for (const cat of categoryOrder) {
      const items = grouped.get(cat);
      if (!items || items.length === 0) continue;
      lines.push(`  ${th.fg("dim", categoryLabels[cat] ?? cat)}`);
      for (const p of items) {
        const icon = p.ok ? th.fg("success", "✓") : th.fg("error", "✗");
        const msg = p.ok ? th.fg("dim", p.message) : th.fg("text", p.message);
        lines.push(`    ${icon} ${msg}`);
      }
    }
  }

  // Progress score section — current traffic light status
  if (health.progressScore) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Progress Score")));
    lines.push("");
    const ps = health.progressScore;
    const scoreColor = ps.level === "green" ? "success" : ps.level === "yellow" ? "warning" : "error";
    const scoreIcon = ps.level === "green" ? "●" : ps.level === "yellow" ? "◐" : "○";
    lines.push(`  ${th.fg(scoreColor, scoreIcon)} ${th.fg(scoreColor, ps.summary)}`);
    for (const signal of ps.signals) {
      const prefix = signal.kind === "positive" ? th.fg("success", "  ✓")
        : signal.kind === "negative" ? th.fg("error", "  ✗")
          : th.fg("dim", "  ·");
      lines.push(`  ${prefix} ${th.fg("dim", signal.label)}`);
    }
  }

  // Doctor history section — persisted across sessions
  const doctorHistory = health.doctorHistory ?? [];
  if (doctorHistory.length > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Doctor History")));
    lines.push("");

    for (const entry of doctorHistory.slice(0, 10)) {
      const icon = entry.ok ? th.fg("success", "✓") : th.fg("error", "✗");
      const ts = entry.ts.replace("T", " ").slice(0, 19);
      const scopeTag = entry.scope ? th.fg("accent", ` [${entry.scope}]`) : "";
      // Prefer human-readable summary, fall back to counts
      const detail = entry.summary
        ? th.fg("text", entry.summary)
        : th.fg("text", `${entry.errors} errors, ${entry.warnings} warnings, ${entry.fixes} fixes`);
      lines.push(`  ${icon} ${th.fg("dim", ts)}${scopeTag}  ${detail}`);

      // Show issue details if available
      if (entry.issues && entry.issues.length > 0) {
        for (const issue of entry.issues.slice(0, 3)) {
          const issuePfx = issue.severity === "error" ? th.fg("error", "    ✗") : th.fg("warning", "    ⚠");
          lines.push(`  ${issuePfx} ${th.fg("dim", truncateToWidth(issue.message, width - 12))}`);
        }
        if (entry.issues.length > 3) {
          lines.push(`    ${th.fg("dim", `+${entry.issues.length - 3} more`)}`);
        }
      }

      // Show fixes if available
      if (entry.fixDescriptions && entry.fixDescriptions.length > 0) {
        for (const fix of entry.fixDescriptions.slice(0, 2)) {
          lines.push(`    ${th.fg("success", "↳")} ${th.fg("dim", truncateToWidth(fix, width - 12))}`);
        }
      }
    }

    if (doctorHistory.length > 10) {
      lines.push(`  ${th.fg("dim", `...${doctorHistory.length - 10} older entries`)}`);
    }
  }

  // Skills section
  if (health.skillSummary?.total > 0) {
    lines.push("");
    lines.push(th.fg("accent", th.bold("Skills")));
    lines.push("");
    const { total, warningCount, criticalCount, topIssue } = health.skillSummary;
    const issueColor = criticalCount > 0 ? "error" : warningCount > 0 ? "warning" : "success";
    const issueTag = criticalCount > 0
      ? `${criticalCount} critical`
      : warningCount > 0
        ? `${warningCount} warning${warningCount > 1 ? "s" : ""}`
        : "all healthy";
    lines.push(`  ${th.fg("text", String(total))} skills tracked  ·  ${th.fg(issueColor, issueTag)}`);
    if (topIssue) lines.push(`  ${th.fg("warning", "⚠")} ${th.fg("dim", topIssue)}`);
    lines.push(`  ${th.fg("dim", "→ /gsd skill-health for full report")}`);
  }

  return lines;
}
