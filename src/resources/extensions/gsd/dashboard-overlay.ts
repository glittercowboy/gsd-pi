/**
 * GSD Dashboard Overlay
 *
 * Full-screen overlay showing auto-mode progress: milestone/slice/task
 * breakdown, current unit, completed units, timing, and activity log.
 * Toggled with Ctrl+Alt+G (⌃⌥G on macOS) or opened from /gsd status.
 */

import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";
import { deriveState } from "./state.js";
import { loadFile } from "./files.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { resolveMilestoneFile, resolveSliceFile } from "./paths.js";
import { getAutoDashboardData } from "./auto.js";
import type { AutoDashboardData } from "./auto-dashboard.js";
import {
  getLedger, getProjectTotals, aggregateByPhase, aggregateBySlice,
  aggregateByModel, aggregateCacheHitRate, formatCost, formatTokenCount, formatCostProjection,
  type UnitMetrics,
} from "./metrics.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { getActiveWorktreeName } from "./worktree-command.js";
import { getWorkerBatches, hasActiveWorkers, type WorkerEntry } from "../subagent/worker-registry.js";
import { formatDuration, padRight, joinColumns, centerLine, fitColumns, STATUS_GLYPH, STATUS_COLOR } from "../shared/mod.js";
import { estimateTimeRemaining } from "./auto-dashboard.js";
import { computeProgressScore, formatProgressLine } from "./progress-score.js";
import { runEnvironmentChecks, type EnvironmentCheckResult } from "./doctor-environment.js";

function unitLabel(type: string): string {
  switch (type) {
    case "discuss-milestone":
    case "discuss-slice": return "Discuss";
    case "research-milestone": return "Research";
    case "plan-milestone": return "Plan";
    case "research-slice": return "Research";
    case "plan-slice": return "Plan";
    case "execute-task": return "Execute";
    case "complete-slice": return "Complete";
    case "reassess-roadmap": return "Reassess";
    case "triage-captures": return "Triage";
    case "quick-task": return "Quick Task";
    case "replan-slice": return "Replan";
    case "custom-step": return "Workflow Step";
    default: return type;
  }
}


export class GSDDashboardOverlay {
  private tui: { requestRender: () => void };
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private refreshTimer: ReturnType<typeof setInterval>;
  private scrollOffset = 0;
  private dashData: AutoDashboardData;
  private milestoneData: MilestoneView | null = null;
  private loading = true;
  private loadedDashboardIdentity?: string;
  private refreshInFlight: Promise<void> | null = null;
  private disposed = false;
  private resizeHandler: (() => void) | null = null;

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.dashData = getAutoDashboardData();

    // Invalidate cache on terminal resize
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);

    this.scheduleRefresh(true);

    this.refreshTimer = setInterval(() => {
      this.scheduleRefresh();
    }, 2000);
  }

  private scheduleRefresh(initial = false): void {
    if (this.refreshInFlight || this.disposed) return;
    this.refreshInFlight = this.refreshDashboard(initial)
      .finally(() => {
        this.refreshInFlight = null;
      });
  }

  private computeDashboardIdentity(dashData: AutoDashboardData): string {
    const base = dashData.basePath || process.cwd();
    const currentUnit = dashData.currentUnit
      ? `${dashData.currentUnit.type}:${dashData.currentUnit.id}:${dashData.currentUnit.startedAt}`
      : "-";
    return [
      base,
      dashData.active ? "1" : "0",
      dashData.paused ? "1" : "0",
      currentUnit,
    ].join("|");
  }

  private async refreshDashboard(initial = false): Promise<void> {
    if (this.disposed) return;
    this.dashData = getAutoDashboardData();
    const nextIdentity = this.computeDashboardIdentity(this.dashData);

    if (initial || nextIdentity !== this.loadedDashboardIdentity) {
      const loaded = await this.loadData();
      if (this.disposed) return;
      if (loaded) {
        this.loadedDashboardIdentity = nextIdentity;
      }
    }

    if (initial) {
      this.loading = false;
    }

    this.invalidate();
    this.tui.requestRender();
  }

  private async loadData(): Promise<boolean> {
    const base = this.dashData.basePath || process.cwd();
    try {
      const state = await deriveState(base);
      if (!state.activeMilestone) {
        this.milestoneData = null;
        return true;
      }

      const mid = state.activeMilestone.id;
      const view: MilestoneView = {
        id: mid,
        title: state.activeMilestone.title,
        slices: [],
        phase: state.phase,
        progress: {
          milestones: {
            total: state.progress?.milestones.total ?? state.registry.length,
            done: state.progress?.milestones.done ?? state.registry.filter(entry => entry.status === "complete").length,
          },
        },
      };

      const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
      const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
      // Normalize slices from DB
      type NormSlice = { id: string; done: boolean; title: string; risk: string };
      let normSlices: NormSlice[] = [];
      if (isDbAvailable()) {
        normSlices = getMilestoneSlices(mid).map(s => ({ id: s.id, done: s.status === "complete", title: s.title, risk: s.risk || "medium" }));
      }

      for (const s of normSlices) {
          const sliceView: SliceView = {
            id: s.id,
            title: s.title,
            done: s.done,
            risk: s.risk,
            active: state.activeSlice?.id === s.id,
            tasks: [],
          };

          if (sliceView.active) {
            // Normalize tasks from DB
            if (isDbAvailable()) {
              const dbTasks = getSliceTasks(mid, s.id);
              sliceView.taskProgress = {
                done: dbTasks.filter(t => t.status === "complete" || t.status === "done").length,
                total: dbTasks.length,
              };
              for (const t of dbTasks) {
                sliceView.tasks.push({
                  id: t.id,
                  title: t.title,
                  done: t.status === "complete" || t.status === "done",
                  active: state.activeTask?.id === t.id,
                });
              }
            }
          }

          view.slices.push(sliceView);
      }

      this.milestoneData = view;
      return true;
    } catch {
      // Don't crash the overlay
      return false;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrlAlt("g"))) {
      this.dispose();
      this.onClose();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.scrollOffset++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (data === "g") {
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (data === "G") {
      this.scrollOffset = 999;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const content = this.buildContentLines(width);
    const viewportHeight = Math.max(5, process.stdout.rows ? process.stdout.rows - 8 : 24);
    const chromeHeight = 2;
    const visibleContentRows = Math.max(1, viewportHeight - chromeHeight);
    const maxScroll = Math.max(0, content.length - visibleContentRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visibleContent = content.slice(this.scrollOffset, this.scrollOffset + visibleContentRows);

    const lines = this.wrapInBox(visibleContent, width);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private wrapInBox(inner: string[], width: number): string[] {
    const th = this.theme;
    const border = (s: string) => th.fg("borderAccent", s);
    const innerWidth = width - 4;
    const lines: string[] = [];

    lines.push(border("╭" + "─".repeat(width - 2) + "╮"));
    for (const line of inner) {
      const truncated = truncateToWidth(line, innerWidth);
      const padWidth = Math.max(0, innerWidth - visibleWidth(truncated));
      lines.push(border("│") + " " + truncated + " ".repeat(padWidth) + " " + border("│"));
    }
    lines.push(border("╰" + "─".repeat(width - 2) + "╯"));
    return lines;
  }

  private buildContentLines(width: number): string[] {
    const th = this.theme;
    const shellWidth = width - 4;
    const contentWidth = Math.min(shellWidth, 128);
    const sidePad = Math.max(0, Math.floor((shellWidth - contentWidth) / 2));
    const leftMargin = " ".repeat(sidePad);
    const lines: string[] = [];

    const row = (content = ""): string => {
      const truncated = truncateToWidth(content, contentWidth);
      return leftMargin + padRight(truncated, contentWidth);
    };
    const blank = () => row("");
    const hr = () => row(th.fg("dim", "─".repeat(contentWidth)));
    const centered = (content: string) => row(centerLine(content, contentWidth));

    const title = th.fg("accent", th.bold("GSD Dashboard"));
    const isRemote = !!this.dashData.remoteSession;
    const status = this.dashData.active
      ? `${Date.now() % 2000 < 1000 ? th.fg("success", "●") : th.fg("dim", "○")} ${th.fg("success", "AUTO")}`
      : this.dashData.paused
        ? th.fg("warning", "⏸ PAUSED")
        : isRemote
          ? `${Date.now() % 2000 < 1000 ? th.fg("success", "●") : th.fg("dim", "○")} ${th.fg("success", "AUTO")} ${th.fg("dim", `(PID ${this.dashData.remoteSession!.pid})`)}`
          : th.fg("dim", "idle");
    const worktreeName = getActiveWorktreeName();
    const worktreeTag = worktreeName
      ? `  ${th.fg("warning", `⎇ ${worktreeName}`)}`
      : "";
    let elapsedParts = "";
    if (this.dashData.active || this.dashData.paused) {
      // Guard: skip display when elapsed is zero or unreasonably large (>30 days)
      const elapsed = this.dashData.elapsed;
      elapsedParts = elapsed > 0 && elapsed < 30 * 24 * 3600_000
        ? th.fg("dim", formatDuration(elapsed))
        : "";
      const eta = estimateTimeRemaining();
      if (eta) elapsedParts += th.fg("dim", `  ·  ${eta}`);
    } else if (isRemote) {
      elapsedParts = th.fg("dim", `since ${this.dashData.remoteSession!.startedAt.replace("T", " ").slice(0, 19)}`);
    }
    lines.push(row(joinColumns(`${title}  ${status}${worktreeTag}`, elapsedParts, contentWidth)));

    // Progress score — traffic light indicator (#1221)
    if (this.dashData.active || this.dashData.paused) {
      const progressScore = computeProgressScore();
      const progressIcon = progressScore.level === "green" ? th.fg("success", "●")
        : progressScore.level === "yellow" ? th.fg("warning", "●")
          : th.fg("error", "●");
      lines.push(row(`${progressIcon} ${th.fg("text", progressScore.summary)}`));

      // Show signal details when degraded — real-time visibility into what doctor found
      if (progressScore.level !== "green" && progressScore.signals.length > 0) {
        for (const signal of progressScore.signals) {
          const prefix = signal.kind === "positive" ? th.fg("success", "  ✓")
            : signal.kind === "negative" ? th.fg("error", "  ✗")
              : th.fg("dim", "  ·");
          lines.push(row(`${prefix} ${th.fg("dim", signal.label)}`));
        }
      }
    }
    lines.push(blank());

    if (this.dashData.currentUnit) {
      const cu = this.dashData.currentUnit;
      const currentElapsed = th.fg("dim", formatDuration(Date.now() - cu.startedAt));
      lines.push(row(joinColumns(
        `${th.fg("text", "Now")}: ${th.fg("accent", unitLabel(cu.type))} ${th.fg("text", cu.id)}`,
        currentElapsed,
        contentWidth,
      )));
      lines.push(blank());
    } else if (this.dashData.paused) {
      lines.push(row(th.fg("dim", "/gsd auto to resume")));
      lines.push(blank());
    } else if (isRemote) {
      const rs = this.dashData.remoteSession!;
      const unitDisplay = rs.unitType === "starting" || rs.unitType === "resuming"
        ? rs.unitType
        : `${unitLabel(rs.unitType)} ${rs.unitId}`;
      lines.push(row(th.fg("text", `Remote session: ${unitDisplay}`)));
      lines.push(blank());
    } else {
      lines.push(row(th.fg("dim", "No unit running · /gsd auto to start")));
      lines.push(blank());
    }

    // Parallel workers section — shows active subagent sessions
    if (hasActiveWorkers()) {
      lines.push(hr());
      lines.push(row(th.fg("text", th.bold("Parallel Workers"))));
      lines.push(blank());

      const batches = getWorkerBatches();
      for (const [batchId, workers] of batches) {
        const running = workers.filter(w => w.status === "running").length;
        const done = workers.filter(w => w.status === "completed").length;
        const failed = workers.filter(w => w.status === "failed").length;
        const total = workers[0]?.batchSize ?? workers.length;

        lines.push(row(joinColumns(
          `  ${th.fg("accent", "⟐")} ${th.fg("text", `Batch ${batchId.slice(0, 8)}`)}`,
          th.fg("dim", `${done + failed}/${total} done`),
          contentWidth,
        )));

        for (const w of workers) {
          const icon = w.status === "running"
            ? th.fg("accent", "▸")
            : w.status === "completed"
              ? th.fg("success", "✓")
              : th.fg("error", "✗");
          const elapsed = th.fg("dim", formatDuration(Date.now() - w.startedAt));
          const taskPreview = truncateToWidth(w.task, Math.max(20, contentWidth - 30));
          lines.push(row(joinColumns(
            `    ${icon} ${th.fg("text", w.agent)} ${th.fg("dim", taskPreview)}`,
            elapsed,
            contentWidth,
          )));
        }
      }
      lines.push(blank());
    }

    // Pending captures badge — only shown when captures are waiting for triage
    if (this.dashData.pendingCaptureCount > 0) {
      const count = this.dashData.pendingCaptureCount;
      lines.push(row(th.fg("warning", `📌 ${count} pending capture${count === 1 ? "" : "s"} awaiting triage`)));
      lines.push(blank());
    }

    if (this.loading) {
      lines.push(centered(th.fg("dim", "Loading dashboard…")));
      return lines;
    }

    if (this.milestoneData) {
      const mv = this.milestoneData;
      lines.push(row(th.fg("text", th.bold(`${mv.id}: ${mv.title}`))));
      lines.push(blank());

      const totalSlices = mv.slices.length;
      const doneSlices = mv.slices.filter(s => s.done).length;
      const totalMilestones = mv.progress.milestones.total;
      const doneMilestones = mv.progress.milestones.done;
      const activeSlice = mv.slices.find(s => s.active);

      lines.push(blank());

      if (activeSlice?.taskProgress) {
        lines.push(row(this.renderProgressRow("Tasks", activeSlice.taskProgress.done, activeSlice.taskProgress.total, "accent", contentWidth)));
      }
      lines.push(row(this.renderProgressRow("Slices", doneSlices, totalSlices, "success", contentWidth)));
      lines.push(row(this.renderProgressRow("Milestones", doneMilestones, totalMilestones, "warning", contentWidth)));

      lines.push(blank());

      for (const s of mv.slices) {
        const sliceStatus = s.done ? "done" : s.active ? "active" : "pending";
        const icon = th.fg(STATUS_COLOR[sliceStatus], STATUS_GLYPH[sliceStatus]);
        const titleColor = s.active ? "accent" : s.done ? "muted" : "dim";
        const titleText = th.fg(titleColor, `${s.id}: ${s.title}`);
        const risk = th.fg("dim", s.risk);
        lines.push(row(joinColumns(`  ${icon} ${titleText}`, risk, contentWidth)));

        if (s.active && s.tasks.length > 0) {
          for (const t of s.tasks) {
            const taskStatus = t.done ? "done" : t.active ? "active" : "pending";
            const tIcon = th.fg(STATUS_COLOR[taskStatus], STATUS_GLYPH[taskStatus]);
            const tColor = t.active ? "warning" : t.done ? "muted" : "dim";
            const tTitle = th.fg(tColor, `${t.id}: ${t.title}`);
            lines.push(row(`      ${tIcon} ${truncateToWidth(tTitle, contentWidth - 6)}`));
          }
        }
      }
    } else {
      lines.push(centered(th.fg("dim", "No active milestone.")));
    }

    const ledger = getLedger();
    if (ledger && ledger.units.length > 0) {
      const totals = getProjectTotals(ledger.units);

      lines.push(blank());
      lines.push(hr());
      lines.push(row(th.fg("text", th.bold("Cost & Usage"))));
      lines.push(blank());

      // Show cost or request count (for copilot/subscription users where cost is 0)
      const costOrReqs = totals.cost > 0
        ? `${th.fg("warning", formatCost(totals.cost))} total`
        : `${th.fg("text", String(totals.apiRequests))} requests`;
      lines.push(row(fitColumns([
        costOrReqs,
        `${th.fg("text", formatTokenCount(totals.tokens.total))} tokens`,
        `${th.fg("text", String(totals.toolCalls))} tools`,
        `${th.fg("text", String(totals.units))} units`,
      ], contentWidth, `  ${th.fg("dim", "·")}  `)));

      lines.push(row(fitColumns([
        `${th.fg("dim", "in:")} ${th.fg("text", formatTokenCount(totals.tokens.input))}`,
        `${th.fg("dim", "out:")} ${th.fg("text", formatTokenCount(totals.tokens.output))}`,
        `${th.fg("dim", "cache-r:")} ${th.fg("text", formatTokenCount(totals.tokens.cacheRead))}`,
        `${th.fg("dim", "cache-w:")} ${th.fg("text", formatTokenCount(totals.tokens.cacheWrite))}`,
      ], contentWidth, "  ")));

      // Budget aggregate line — only when data exists
      if (totals.totalTruncationSections > 0 || totals.continueHereFiredCount > 0) {
        const budgetParts: string[] = [];
        if (totals.totalTruncationSections > 0) {
          budgetParts.push(th.fg("warning", `${totals.totalTruncationSections} sections truncated`));
        }
        if (totals.continueHereFiredCount > 0) {
          budgetParts.push(th.fg("error", `${totals.continueHereFiredCount} continue-here fired`));
        }
        lines.push(row(budgetParts.join(`  ${th.fg("dim", "·")}  `)));
      }

      const phases = aggregateByPhase(ledger.units);
      if (phases.length > 0) {
        lines.push(blank());
        lines.push(row(th.fg("dim", "By Phase")));
        for (const p of phases) {
          const pct = totals.cost > 0 ? Math.round((p.cost / totals.cost) * 100) : 0;
          const left = `  ${th.fg("text", p.phase.padEnd(14))}${th.fg("warning", formatCost(p.cost).padStart(8))}`;
          const right = th.fg("dim", `${String(pct).padStart(3)}%  ${formatTokenCount(p.tokens.total)} tok  ${p.units} units`);
          lines.push(row(joinColumns(left, right, contentWidth)));
        }
      }

      const slices = aggregateBySlice(ledger.units);
      if (slices.length > 0) {
        lines.push(blank());
        lines.push(row(th.fg("dim", "By Slice")));
        for (const s of slices) {
          const pct = totals.cost > 0 ? Math.round((s.cost / totals.cost) * 100) : 0;
          const left = `  ${th.fg("text", s.sliceId.padEnd(14))}${th.fg("warning", formatCost(s.cost).padStart(8))}`;
          const right = th.fg("dim", `${String(pct).padStart(3)}%  ${formatTokenCount(s.tokens.total)} tok  ${formatDuration(s.duration)}`);
          lines.push(row(joinColumns(left, right, contentWidth)));
        }
      }

      // Cost projection — only when active milestone data is available
      if (this.milestoneData) {
        const mv = this.milestoneData;
        const msTotalSlices = mv.slices.length;
        const msDoneSlices = mv.slices.filter(s => s.done).length;
        const remainingCount = msTotalSlices - msDoneSlices;
        const overlayPrefs = loadEffectiveGSDPreferences()?.preferences;
        const projLines = formatCostProjection(slices, remainingCount, overlayPrefs?.budget_ceiling);
        if (projLines.length > 0) {
          lines.push(blank());
          for (const line of projLines) {
            const colored = line.toLowerCase().includes('ceiling')
              ? th.fg("warning", line)
              : th.fg("dim", line);
            lines.push(row(colored));
          }
        }
      }

      const models = aggregateByModel(ledger.units);
      if (models.length >= 1) {
        lines.push(blank());
        lines.push(row(th.fg("dim", "By Model")));
        for (const m of models) {
          const pct = totals.cost > 0 ? Math.round((m.cost / totals.cost) * 100) : 0;
          const modelName = truncateToWidth(m.model, 38);
          const ctxWindow = m.contextWindowTokens !== undefined
            ? th.fg("dim", ` [${formatTokenCount(m.contextWindowTokens)}]`)
            : "";
          const left = `  ${th.fg("text", modelName.padEnd(38))}${th.fg("warning", formatCost(m.cost).padStart(8))}`;
          const right = th.fg("dim", `${String(pct).padStart(3)}%  ${m.units} units`) + ctxWindow;
          lines.push(row(joinColumns(left, right, contentWidth)));
        }
      }

      lines.push(blank());
      lines.push(row(`${th.fg("dim", "avg/unit:")} ${th.fg("text", formatCost(totals.cost / totals.units))}  ${th.fg("dim", "·")}  ${th.fg("text", formatTokenCount(Math.round(totals.tokens.total / totals.units)))} tokens`));

      // Cache hit rate
      const cacheRate = aggregateCacheHitRate();
      if (cacheRate > 0) {
        lines.push(row(`${th.fg("dim", "cache hit rate:")} ${th.fg("text", `${cacheRate}%`)}`));
      }

      if (this.dashData.rtkEnabled && this.dashData.rtkSavings && this.dashData.rtkSavings.commands > 0) {
        const rtk = this.dashData.rtkSavings;
        lines.push(row(
          `${th.fg("dim", "rtk saved:")} ${th.fg("text", formatTokenCount(rtk.savedTokens))} ${th.fg("dim", `(${Math.round(rtk.savingsPct)}% · ${rtk.commands} cmd${rtk.commands === 1 ? "" : "s"})`)}`,
        ));
      }
    }

    // Environment health section (#1221) — only show issues
    const envResults = runEnvironmentChecks(this.dashData.basePath || process.cwd());
    const envIssues = envResults.filter(r => r.status !== "ok");
    if (envIssues.length > 0) {
      lines.push(blank());
      lines.push(hr());
      lines.push(row(th.fg("text", th.bold("Environment"))));
      lines.push(blank());
      for (const r of envIssues) {
        const icon = r.status === "error" ? th.fg("error", "✗") : th.fg("warning", "⚠");
        lines.push(row(`  ${icon} ${th.fg("text", r.message)}`));
        if (r.detail) {
          lines.push(row(th.fg("dim", `     ${r.detail}`)));
        }
      }
    }

    lines.push(blank());
    lines.push(hr());
    lines.push(centered(th.fg("dim", "↑↓ scroll · g/G top/end · esc close")));

    return lines;
  }

  private renderProgressRow(
    label: string,
    done: number,
    total: number,
    color: "success" | "accent" | "warning",
    width: number,
  ): string {
    const th = this.theme;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const labelWidth = 12;
    const rightWidth = 14;
    const gap = 2;
    const labelText = truncateToWidth(label, labelWidth, "").padEnd(labelWidth);
    const ratioText = `${done}/${total}`;
    const rightText = `${String(pct).padStart(3)}%  ${ratioText.padStart(rightWidth - 5)}`;
    const barWidth = Math.max(12, width - labelWidth - rightWidth - gap * 2);
    const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
    const bar = th.fg(color, "█".repeat(filled)) + th.fg("dim", "░".repeat(Math.max(0, barWidth - filled)));
    return `${th.fg("dim", labelText)}${" ".repeat(gap)}${bar}${" ".repeat(gap)}${th.fg("dim", rightText)}`;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }
}

interface MilestoneView {
  id: string;
  title: string;
  slices: SliceView[];
  phase: string;
  progress: {
    milestones: {
      total: number;
      done: number;
    };
  };
}

interface SliceView {
  id: string;
  title: string;
  done: boolean;
  risk: string;
  active: boolean;
  tasks: TaskView[];
  taskProgress?: { done: number; total: number };
}

interface TaskView {
  id: string;
  title: string;
  done: boolean;
  active: boolean;
}
