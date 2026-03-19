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
import { loadFile, parseRoadmap, parsePlan } from "./files.js";
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
import { formatDuration, padRight, joinColumns, centerLine, fitColumns, stripAnsi, STATUS_GLYPH, STATUS_COLOR, type ProgressStatus } from "../shared/mod.js";
import { estimateTimeRemaining } from "./auto-dashboard.js";
import { computeProgressScore, formatProgressLine } from "./progress-score.js";
import { runEnvironmentChecks, type EnvironmentCheckResult } from "./doctor-environment.js";
import {
  isParallelActive, getWorkerStatuses, refreshWorkerStatuses,
  getOrchestratorState, pauseWorker, resumeWorker, stopParallel,
  type WorkerInfo,
} from "./parallel-orchestrator.js";
import { isSessionStale, readSessionStatus, readTeamSignals } from "./session-status-io.js";
import { parseMergeLogTail } from "./merge-healing.js";
import type { GSDState } from "./types.js";

function unitLabel(type: string): string {
  switch (type) {
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

  // ── Parallel mode state ──
  private parallelMode = false;
  private activeWorkerTab = -1; // -1 = overview, 0+ = worker index
  private workerList: WorkerInfo[] = [];
  private workerStates = new Map<string, GSDState>();
  private confirmingStop = false; // D048 state machine (wired in T02)
  private confirmTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── Filter mode state ──
  private filterMode = false;
  private filterText = "";

  // ── Port callbacks (optional — dashboard stays decoupled from port module) ──
  private onPort?: (workerId: string) => Promise<void>;
  private onDetach?: () => Promise<void>;
  private isPortActiveFn?: () => boolean;
  private getPortedWorkerIdFn?: () => string | null;

  // ── Add-worker callback (optional — wired in S02 for mid-session worker addition) ──
  private onAdd?: () => Promise<void>;

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    onClose: () => void,
    portOpts?: {
      onPort?: (workerId: string) => Promise<void>;
      onDetach?: () => Promise<void>;
      isPortActive?: () => boolean;
      getPortedWorkerId?: () => string | null;
      onAdd?: () => Promise<void>;
    },
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.dashData = getAutoDashboardData();

    // Port callbacks — all optional for backward compatibility
    if (portOpts) {
      this.onPort = portOpts.onPort;
      this.onDetach = portOpts.onDetach;
      this.isPortActiveFn = portOpts.isPortActive;
      this.getPortedWorkerIdFn = portOpts.getPortedWorkerId;
      this.onAdd = portOpts.onAdd;
    }

    // Invalidate cache on terminal resize
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);

    // Enable SGR mouse tracking
    process.stdout.write("\x1b[?1003h\x1b[?1006h");

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
    const lastCompleted = dashData.completedUnits.length > 0
      ? dashData.completedUnits[dashData.completedUnits.length - 1]
      : null;
    const completedKey = lastCompleted
      ? `${dashData.completedUnits.length}:${lastCompleted.type}:${lastCompleted.id}:${lastCompleted.finishedAt}`
      : "0";
    return [
      base,
      dashData.active ? "1" : "0",
      dashData.paused ? "1" : "0",
      currentUnit,
      completedKey,
    ].join("|");
  }

  private async refreshDashboard(initial = false): Promise<void> {
    if (this.disposed) return;
    this.dashData = getAutoDashboardData();

    // ── Parallel orchestration state ──
    if (isParallelActive()) {
      const basePath = this.dashData.basePath || process.cwd();
      refreshWorkerStatuses(basePath);
      this.workerList = getWorkerStatuses().sort((a, b) => a.milestoneId.localeCompare(b.milestoneId));
      // Derive state for active workers asynchronously
      const nextStates = new Map<string, GSDState>();
      for (const worker of this.workerList) {
        if (worker.state === "running" || worker.state === "paused") {
          try {
            const ws = await deriveState(worker.worktreePath);
            if (this.disposed) return;
            nextStates.set(worker.milestoneId, ws);
          } catch {
            // Non-fatal — worker state may not be readable yet
          }
        }
      }
      this.workerStates = nextStates;
      this.parallelMode = true;
      // Clamp activeWorkerTab if workers changed
      if (this.activeWorkerTab >= this.workerList.length) {
        this.activeWorkerTab = -1;
      }
    } else {
      this.parallelMode = false;
      this.workerList = [];
      this.workerStates.clear();
      this.activeWorkerTab = -1;
    }

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
      if (roadmapContent) {
        const roadmap = parseRoadmap(roadmapContent);
        for (const s of roadmap.slices) {
          const sliceView: SliceView = {
            id: s.id,
            title: s.title,
            done: s.done,
            risk: s.risk,
            active: state.activeSlice?.id === s.id,
            tasks: [],
          };

          if (sliceView.active) {
            const planFile = resolveSliceFile(base, mid, s.id, "PLAN");
            const planContent = planFile ? await loadFile(planFile) : null;
            if (planContent) {
              const plan = parsePlan(planContent);
              sliceView.taskProgress = {
                done: plan.tasks.filter(t => t.done).length,
                total: plan.tasks.length,
              };
              for (const t of plan.tasks) {
                sliceView.tasks.push({
                  id: t.id,
                  title: t.title,
                  done: t.done,
                  active: state.activeTask?.id === t.id,
                });
              }
            }
          }

          view.slices.push(sliceView);
        }
      }

      this.milestoneData = view;
      return true;
    } catch {
      // Don't crash the overlay
      return false;
    }
  }

  handleInput(data: string): void {
    // ── Filter mode routing (must come before Esc/close handler) ──
    if (this.filterMode) {
      if (matchesKey(data, Key.escape)) {
        this.filterMode = false;
        this.filterText = "";
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.filterMode = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.filterText = this.filterText.slice(0, -1);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      // Append printable characters
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.filterText += data;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrlAlt("g"))) {
      // K008: Escape priority — (1) filter mode handled above, (2) port active → detach, (3) close overlay
      if (matchesKey(data, Key.escape) && this.isPortActiveFn?.()) {
        // Port is active — Escape means detach, not close
        void this.onDetach?.();
        return;
      }
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

    // Tab cycling for parallel mode: overview → worker0 → worker1 → ... → overview
    if (this.parallelMode && matchesKey(data, Key.tab)) {
      if (this.workerList.length > 0) {
        this.activeWorkerTab =
          this.activeWorkerTab >= this.workerList.length - 1 ? -1 : this.activeWorkerTab + 1;
        this.scrollOffset = 0;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (this.parallelMode && matchesKey(data, Key.shift("tab"))) {
      if (this.workerList.length > 0) {
        this.activeWorkerTab =
          this.activeWorkerTab <= -1 ? this.workerList.length - 1 : this.activeWorkerTab - 1;
        this.scrollOffset = 0;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // ── Parallel signal controls: Enter/p/r/x (only when a specific worker tab is focused) ──
    if (this.parallelMode && this.activeWorkerTab >= 0) {
      const focusedWorker = this.workerList[this.activeWorkerTab];
      if (focusedWorker) {
        const basePath = this.dashData.basePath || process.cwd();

        // Enter key → port into focused worker (D056: dispose-and-recreate)
        if (matchesKey(data, Key.enter)) {
          if (this.onPort && focusedWorker.state === "running") {
            const mid = focusedWorker.milestoneId;
            this.dispose();
            void this.onPort(mid);
          }
          return;
        }

        if (data === "p") {
          pauseWorker(basePath, focusedWorker.milestoneId);
          this.invalidate();
          this.tui.requestRender();
          return;
        }

        if (data === "r") {
          resumeWorker(basePath, focusedWorker.milestoneId);
          this.invalidate();
          this.tui.requestRender();
          return;
        }

        if (data === "x") {
          if (!this.confirmingStop) {
            // First press — start D048 confirmation window
            this.confirmingStop = true;
            this.confirmTimeout = setTimeout(() => {
              this.confirmingStop = false;
              this.confirmTimeout = null;
              this.invalidate();
              this.tui.requestRender();
            }, 3000);
            this.invalidate();
            this.tui.requestRender();
            return;
          }
          // Second press within 3s — dispatch stop (fire-and-forget)
          if (this.confirmTimeout) clearTimeout(this.confirmTimeout);
          this.confirmingStop = false;
          this.confirmTimeout = null;
          void stopParallel(basePath, focusedWorker.milestoneId);
          this.invalidate();
          this.tui.requestRender();
          return;
        }
      }
    }

    // Any other key while confirmingStop is active → reset confirmation
    if (this.confirmingStop) {
      if (this.confirmTimeout) clearTimeout(this.confirmTimeout);
      this.confirmingStop = false;
      this.confirmTimeout = null;
      this.invalidate();
      this.tui.requestRender();
    }

    // ── `a` key: add worker mid-session (parallel mode only) ──
    if (data === "a") {
      if (this.parallelMode && this.onAdd) {
        this.dispose();
        void this.onAdd();
        return;
      }
    }

    // ── Mouse handling (SGR 1006 protocol) ──
    const mouse = this.parseSGRMouse(data);
    if (mouse) {
      if (mouse.button === 64) {
        // Wheel up
        this.scrollOffset = Math.max(0, this.scrollOffset - 3);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (mouse.button === 65) {
        // Wheel down
        this.scrollOffset += 3;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (mouse.button === 0 && mouse.press && this.parallelMode && this.activeWorkerTab === -1) {
        // Left click on worker row in parallel overview — switch to worker detail
        const contentRow = mouse.y - 2 + this.scrollOffset;
        const workerIndex = contentRow - 4; // 4 header rows: title, blank, column header, separator
        if (workerIndex >= 0 && workerIndex < this.workerList.length) {
          this.activeWorkerTab = workerIndex;
          this.scrollOffset = 0;
          this.invalidate();
          this.tui.requestRender();
        }
        return;
      }
      return;
    }

    // ── `/` enters filter mode ──
    if (data === "/") {
      this.filterMode = true;
      this.filterText = "";
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

    // Apply text filter before scroll slicing
    const filteredContent = this.filterText
      ? content.filter(line => stripAnsi(line).toLowerCase().includes(this.filterText.toLowerCase()))
      : content;

    const viewportHeight = Math.max(5, process.stdout.rows ? process.stdout.rows - 8 : 24);
    const chromeHeight = 2;
    const visibleContentRows = Math.max(1, viewportHeight - chromeHeight);
    const maxScroll = Math.max(0, filteredContent.length - visibleContentRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visibleContent = filteredContent.slice(this.scrollOffset, this.scrollOffset + visibleContentRows);

    const lines = this.wrapInBox(visibleContent, width, this.scrollOffset, visibleContentRows, filteredContent.length);

    // Filter mode indicator
    if (this.filterMode) {
      const th = this.theme;
      const filterLine = th.fg("accent", `  Filter: ${this.filterText}▌`);
      lines.push(filterLine);
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private wrapInBox(inner: string[], width: number, offset?: number, visibleRows?: number, totalLines?: number): string[] {
    const th = this.theme;
    const border = (s: string) => th.fg("borderAccent", s);
    const innerWidth = width - 4;
    const lines: string[] = [];

    // Compute scroll-thumb positions
    const scrollable = totalLines !== undefined && visibleRows !== undefined && totalLines > visibleRows;
    let thumbStart = -1;
    let thumbLen = 0;
    const innerRows = inner.length;
    if (scrollable && innerRows > 0 && totalLines! > 0) {
      thumbStart = Math.round(((offset ?? 0) / totalLines!) * innerRows);
      thumbLen = Math.max(1, Math.round((visibleRows! / totalLines!) * innerRows));
    }

    lines.push(border("╭" + "─".repeat(width - 2) + "╮"));
    for (let i = 0; i < inner.length; i++) {
      const line = inner[i];
      const truncated = truncateToWidth(line, innerWidth);
      const padWidth = Math.max(0, innerWidth - visibleWidth(truncated));
      const rightBorder = scrollable && i >= thumbStart && i < thumbStart + thumbLen
        ? border("┃")
        : border("│");
      lines.push(border("│") + " " + truncated + " ".repeat(padWidth) + " " + rightBorder);
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

    // ── Parallel mode delegation ──
    if (this.parallelMode) {
      if (this.activeWorkerTab === -1) {
        return this.buildParallelOverviewLines(width, { row, blank, hr, centered, th, contentWidth, leftMargin });
      }
      return this.buildWorkerDetailLines(width, this.activeWorkerTab, { row, blank, hr, centered, th, contentWidth, leftMargin });
    }

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
      elapsedParts = th.fg("dim", formatDuration(this.dashData.elapsed));
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

    if (this.dashData.completedUnits.length > 0) {
      lines.push(blank());
      lines.push(hr());
      lines.push(row(th.fg("text", th.bold("Completed"))));
      lines.push(blank());

      // Build ledger lookup for budget indicators (last entry wins for retries)
      const ledgerLookup = new Map<string, UnitMetrics>();
      const currentLedger = getLedger();
      if (currentLedger) {
        for (const lu of currentLedger.units) {
          ledgerLookup.set(`${lu.type}:${lu.id}`, lu);
        }
      }

      const recent = [...this.dashData.completedUnits].reverse().slice(0, 10);
      for (const u of recent) {
        // Budget indicators from ledger — use warning glyph for pressured units
        const ledgerEntry = ledgerLookup.get(`${u.type}:${u.id}`);
        const hadPressure = ledgerEntry?.continueHereFired === true;
        const hadTruncation = (ledgerEntry?.truncationSections ?? 0) > 0;
        const unitGlyph = hadPressure
          ? th.fg(STATUS_COLOR.warning, STATUS_GLYPH.warning)
          : th.fg(STATUS_COLOR.done, STATUS_GLYPH.done);
        const left = `  ${unitGlyph} ${th.fg("muted", unitLabel(u.type))} ${th.fg("muted", u.id)}`;

        let budgetMarkers = "";
        if (hadTruncation) {
          budgetMarkers += th.fg("warning", ` ▼${ledgerEntry!.truncationSections}`);
        }
        if (hadPressure) {
          budgetMarkers += th.fg("error", " → wrap-up");
        }

        const right = th.fg("dim", formatDuration(u.finishedAt - u.startedAt));
        lines.push(row(joinColumns(`${left}${budgetMarkers}`, right, contentWidth)));
      }

      if (this.dashData.completedUnits.length > 10) {
        lines.push(row(th.fg("dim", `  ...and ${this.dashData.completedUnits.length - 10} more`)));
      }
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

  // ── Parallel overview: summary table of all workers ──

  private buildParallelOverviewLines(
    _width: number,
    h: RenderHelpers,
  ): string[] {
    const { row, blank, hr, centered, th, contentWidth } = h;
    const lines: string[] = [];

    // Title
    const title = th.fg("accent", th.bold("GSD Dashboard"));
    const orchState = getOrchestratorState();
    const elapsed = orchState ? th.fg("dim", formatDuration(Date.now() - orchState.startedAt)) : "";
    const workerCount = th.fg("text", `${this.workerList.length} worker${this.workerList.length !== 1 ? "s" : ""}`);
    lines.push(row(joinColumns(`${title}  ${th.fg("success", "▶ PARALLEL")}  ${workerCount}`, elapsed, contentWidth)));
    lines.push(blank());

    // Total cost
    const totalCost = orchState?.totalCost ?? this.workerList.reduce((sum, w) => sum + w.cost, 0);
    lines.push(row(th.fg("dim", `Total cost: `) + th.fg("warning", formatCost(totalCost))));
    lines.push(blank());

    // Worker summary table header — include Domain column if terminal is wide enough
    const showDomain = _width >= 90;
    const showSignals = _width >= 110;
    const headerCols = [
      th.fg("dim", "Milestone"),
      ...(showDomain ? [th.fg("dim", "Domain")] : []),
      ...(showSignals ? [th.fg("dim", "Signals")] : []),
      th.fg("dim", "State"),
      th.fg("dim", "Progress"),
      th.fg("dim", "Cost"),
      th.fg("dim", "Heartbeat"),
    ];
    lines.push(row(fitColumns(headerCols, contentWidth, "  ")));
    lines.push(hr());

    // Worker rows
    for (const worker of this.workerList) {
      const workerStatus = workerStateToProgressStatus(worker.state);
      const stateIcon = th.fg(STATUS_COLOR[workerStatus], STATUS_GLYPH[workerStatus]);
      const stateLabel = worker.state;

      // Progress from cached GSDState
      const ws = this.workerStates.get(worker.milestoneId);
      let progressStr = th.fg("dim", "—");
      if (ws?.progress?.slices) {
        const pct = ws.progress.slices.total > 0
          ? Math.round((ws.progress.slices.done / ws.progress.slices.total) * 100)
          : 0;
        progressStr = th.fg("text", `${pct}%`);
      }

      const costStr = th.fg("warning", formatCost(worker.cost));

      // Heartbeat age from session status
      const basePath = this.dashData.basePath || process.cwd();
      const session = readSessionStatus(basePath, worker.milestoneId);
      let heartbeatStr = th.fg("dim", "—");
      if (session) {
        const age = Date.now() - session.lastHeartbeat;
        heartbeatStr = isSessionStale(session)
          ? th.fg("error", formatDuration(age) + " ⚠")
          : th.fg("dim", formatDuration(age));
      }

      const domainStr = th.fg("dim", domainShortLabel(worker.domain));

      // Signal flow — last signal type + age
      let signalStr = th.fg("dim", "—");
      if (showSignals) {
        const signals = readTeamSignals(basePath, worker.milestoneId);
        if (signals.length > 0) {
          const last = signals[signals.length - 1]!;
          const sigAge = formatDuration(Date.now() - last.timestamp);
          signalStr = th.fg("text", `${last.type} ${sigAge}`);
        }
      }

      const rowCols = [
        `${stateIcon} ${th.fg("accent", worker.milestoneId)}`,
        ...(showDomain ? [domainStr] : []),
        ...(showSignals ? [signalStr] : []),
        th.fg("text", stateLabel),
        progressStr,
        costStr,
        heartbeatStr,
      ];
      lines.push(row(fitColumns(rowCols, contentWidth, "  ")));
    }

    if (this.workerList.length === 0) {
      lines.push(row(th.fg("dim", "No workers active.")));
    }

    lines.push(blank());
    lines.push(hr());
    lines.push(centered(th.fg("dim", "Tab: select worker · a add worker · Esc close")));

    return lines;
  }

  // ── Worker detail: progress bars, active slice/task, ETA, cost ──

  private buildWorkerDetailLines(
    _width: number,
    workerIndex: number,
    h: RenderHelpers,
  ): string[] {
    const { row, blank, hr, centered, th, contentWidth } = h;
    const lines: string[] = [];

    const worker = this.workerList[workerIndex];
    if (!worker) {
      lines.push(row(th.fg("error", "Worker not found.")));
      return lines;
    }

    const ws = this.workerStates.get(worker.milestoneId);

    // Header — milestone, state, PID, elapsed
    const workerStatus = workerStateToProgressStatus(worker.state);
    const stateIcon = th.fg(STATUS_COLOR[workerStatus], STATUS_GLYPH[workerStatus]);
    const stateLabel = th.fg("text", worker.state);
    const elapsed = formatDuration(Date.now() - worker.startedAt);

    const title = th.fg("accent", th.bold("GSD Dashboard"));
    const tabLabel = th.fg("accent", worker.milestoneId);
    lines.push(row(joinColumns(
      `${title}  ${tabLabel}  ${stateIcon} ${stateLabel}`,
      th.fg("dim", `PID ${worker.pid} · ${elapsed}`),
      contentWidth,
    )));
    lines.push(blank());

    // Worker title
    if (worker.title) {
      lines.push(row(th.fg("text", th.bold(worker.title))));
      lines.push(blank());
    }

    // Progress bars — slices and tasks
    if (ws?.progress?.slices) {
      lines.push(row(this.renderProgressRow("Slices", ws.progress.slices.done, ws.progress.slices.total, "success", contentWidth)));
    }
    if (ws?.progress?.tasks) {
      lines.push(row(this.renderProgressRow("Tasks", ws.progress.tasks.done, ws.progress.tasks.total, "accent", contentWidth)));
    }
    if (!ws?.progress?.slices && !ws?.progress?.tasks) {
      lines.push(row(th.fg("dim", "Progress data not yet available.")));
    }
    lines.push(blank());

    // Active slice/task
    if (ws?.activeSlice) {
      lines.push(row(`${th.fg("dim", "Active slice:")} ${th.fg("text", `${ws.activeSlice.id}: ${ws.activeSlice.title}`)}`));
    }
    if (ws?.activeTask) {
      lines.push(row(`${th.fg("dim", "Active task: ")} ${th.fg("warning", `${ws.activeTask.id}: ${ws.activeTask.title}`)}`));
    }
    if (!ws?.activeSlice && !ws?.activeTask) {
      lines.push(row(th.fg("dim", "No active work unit.")));
    }
    lines.push(blank());

    // ETA
    if (ws?.progress?.slices) {
      const { done, total } = ws.progress.slices;
      const remaining = total - done;
      if (done > 0 && remaining > 0) {
        const elapsedMs = Date.now() - worker.startedAt;
        const etaMs = (remaining / done) * elapsedMs;
        lines.push(row(`${th.fg("dim", "ETA:")} ${th.fg("text", formatDuration(etaMs))}`));
      } else if (done === 0) {
        lines.push(row(`${th.fg("dim", "ETA:")} ${th.fg("dim", "calculating…")}`));
      } else {
        lines.push(row(`${th.fg("dim", "ETA:")} ${th.fg("success", "complete")}`));
      }
    }

    // Cost & completed units
    lines.push(row(`${th.fg("dim", "Cost:")} ${th.fg("warning", formatCost(worker.cost))}  ${th.fg("dim", "·")}  ${th.fg("dim", "Units:")} ${th.fg("text", String(worker.completedUnits))}`));

    // Restart count (only if > 0)
    if (worker.restartCount > 0) {
      lines.push(row(th.fg("warning", `⟳ Restarted ${worker.restartCount} time${worker.restartCount > 1 ? "s" : ""}`)));
    }

    // Stderr lines (last 10, from buffer of up to 50)
    if (worker.stderrLines.length > 0) {
      lines.push(blank());
      lines.push(row(th.fg("error", th.bold("⚠ Errors"))));
      const recentErrors = worker.stderrLines.slice(-10);
      for (const errLine of recentErrors) {
        lines.push(row(`  ${th.fg("dim", truncateToWidth(errLine, contentWidth - 2))}`));
      }
      if (worker.stderrLines.length > 10) {
        lines.push(row(th.fg("dim", `  …and ${worker.stderrLines.length - 10} more`)));
      }
    }

    // Recent team signals (last 5)
    const basePath = this.dashData.basePath || process.cwd();
    const signals = readTeamSignals(basePath, worker.milestoneId);
    if (signals.length > 0) {
      lines.push(blank());
      lines.push(row(th.fg("accent", th.bold("📡 Team Signals"))));
      const recent = signals.slice(-5);
      for (const sig of recent) {
        const age = formatDuration(Date.now() - sig.timestamp);
        lines.push(row(`  ${th.fg("dim", sig.type)} from ${th.fg("text", sig.source)} ${th.fg("dim", age + " ago")}`));
      }
      if (signals.length > 5) {
        lines.push(row(th.fg("dim", `  …and ${signals.length - 5} more`)));
      }
    }

    // Merge healing status (last 3 entries from MERGE-LOG.md)
    const mergeEntries = parseMergeLogTail(basePath);
    if (mergeEntries.length > 0) {
      lines.push(blank());
      lines.push(row(th.fg("accent", th.bold("🔧 Merge Healing"))));
      const recentMerges = mergeEntries.slice(-3);
      for (const entry of recentMerges) {
        const tierLabel = `T${entry.tier}`;
        const outcomeColor = entry.outcome === "applied" ? "success" : entry.outcome === "escalated" ? "warning" : "error";
        lines.push(row(`  ${th.fg("dim", tierLabel)} ${th.fg("text", entry.file)} → ${th.fg(outcomeColor, entry.outcome)}`));
      }
    }

    lines.push(blank());
    lines.push(hr());
    // Dynamic footer — reflects D048 stop confirmation state
    if (this.confirmingStop) {
      lines.push(centered(th.fg("warning", th.bold("Press x again to confirm stop"))));
    } else {
      lines.push(centered(th.fg("dim", "p pause · r resume · x stop · ⏎ port · Tab next · Esc close")));
    }

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

  private parseSGRMouse(data: string): { button: number; x: number; y: number; press: boolean } | null {
    const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
    if (!match) return null;
    return {
      button: parseInt(match[1], 10),
      x: parseInt(match[2], 10),
      y: parseInt(match[3], 10),
      press: match[4] === "M",
    };
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.confirmTimeout) {
      clearTimeout(this.confirmTimeout);
      this.confirmTimeout = null;
    }
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    // Disable SGR mouse tracking
    process.stdout.write("\x1b[?1003l\x1b[?1006l");
  }
}

/** Map WorkerInfo.state → ProgressStatus for STATUS_GLYPH/STATUS_COLOR. */
/** Short label for domain in the parallel overview table. */
export function domainShortLabel(domain?: string): string {
  switch (domain) {
    case "frontend": return "FE";
    case "backend": return "BE";
    case "infra": return "INF";
    case "data": return "DAT";
    case "test": return "TST";
    default: return "—";
  }
}

function workerStateToProgressStatus(state: WorkerInfo["state"]): ProgressStatus {
  switch (state) {
    case "running": return "active";
    case "paused":  return "paused";
    case "stopped": return "done";
    case "error":   return "failed";
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

/** Shared rendering helpers passed from buildContentLines() to parallel renderers. */
interface RenderHelpers {
  row: (content?: string) => string;
  blank: () => string;
  hr: () => string;
  centered: (content: string) => string;
  th: Theme;
  contentWidth: number;
  leftMargin: string;
}
