/**
 * Auto-mode Dashboard — progress widget rendering, elapsed time formatting,
 * unit description helpers, and slice progress caching.
 *
 * Pure functions that accept specific parameters — no module-level globals
 * or AutoContext dependency. State accessors are passed as callbacks.
 */

import type { ExtensionContext, ExtensionCommandContext, SessionMessageEntry } from "@gsd/pi-coding-agent";
import type { GSDState } from "./types.js";
import { getCurrentBranch } from "./worktree.js";
import { getActiveHook } from "./post-unit-hooks.js";
import { getLedger, getProjectTotals, formatCost, formatTokenCount, formatTierSavings } from "./metrics.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
} from "./paths.js";
import { parseRoadmap, parsePlan } from "./files.js";
import { readFileSync, existsSync } from "node:fs";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { makeUI, GLYPH, INDENT } from "../shared/mod.js";
import { computeProgressScore } from "./progress-score.js";

// ─── Dashboard Data ───────────────────────────────────────────────────────────

/** Dashboard data for the overlay */
export interface AutoDashboardData {
  active: boolean;
  paused: boolean;
  stepMode: boolean;
  startTime: number;
  elapsed: number;
  currentUnit: { type: string; id: string; startedAt: number } | null;
  completedUnits: { type: string; id: string; startedAt: number; finishedAt: number }[];
  basePath: string;
  /** Running cost and token totals from metrics ledger */
  totalCost: number;
  totalTokens: number;
  /** Projected remaining cost based on unit-type averages (undefined if insufficient data) */
  projectedRemainingCost?: number;
  /** Whether token profile has been auto-downgraded due to budget prediction */
  profileDowngraded?: boolean;
  /** Number of pending captures awaiting triage (0 if none or file missing) */
  pendingCaptureCount: number;
  /** Cross-process: another auto-mode session detected via auto.lock (PID, startedAt) */
  remoteSession?: { pid: number; startedAt: string; unitType: string; unitId: string };
}

// ─── Unit Description Helpers ─────────────────────────────────────────────────

export function unitVerb(unitType: string): string {
  if (unitType.startsWith("hook/")) return `hook: ${unitType.slice(5)}`;
  switch (unitType) {
    case "research-milestone":
    case "research-slice": return "researching";
    case "plan-milestone":
    case "plan-slice": return "planning";
    case "execute-task": return "executing";
    case "complete-slice": return "completing";
    case "replan-slice": return "replanning";
    case "rewrite-docs": return "rewriting";
    case "reassess-roadmap": return "reassessing";
    case "run-uat": return "running UAT";
    default: return unitType;
  }
}

export function unitPhaseLabel(unitType: string): string {
  if (unitType.startsWith("hook/")) return "HOOK";
  switch (unitType) {
    case "research-milestone": return "RESEARCH";
    case "research-slice": return "RESEARCH";
    case "plan-milestone": return "PLAN";
    case "plan-slice": return "PLAN";
    case "execute-task": return "EXECUTE";
    case "complete-slice": return "COMPLETE";
    case "replan-slice": return "REPLAN";
    case "rewrite-docs": return "REWRITE";
    case "reassess-roadmap": return "REASSESS";
    case "run-uat": return "UAT";
    default: return unitType.toUpperCase();
  }
}

function peekNext(unitType: string, state: GSDState): string {
  // Show active hook info in progress display
  const activeHookState = getActiveHook();
  if (activeHookState) {
    return `hook: ${activeHookState.hookName} (cycle ${activeHookState.cycle})`;
  }

  const sid = state.activeSlice?.id ?? "";
  if (unitType.startsWith("hook/")) return `continue ${sid}`;
  switch (unitType) {
    case "research-milestone": return "plan milestone roadmap";
    case "plan-milestone": return "plan or execute first slice";
    case "research-slice": return `plan ${sid}`;
    case "plan-slice": return "execute first task";
    case "execute-task": return `continue ${sid}`;
    case "complete-slice": return "reassess roadmap";
    case "replan-slice": return `re-execute ${sid}`;
    case "rewrite-docs": return "continue execution";
    case "reassess-roadmap": return "advance to next slice";
    case "run-uat": return "reassess roadmap";
    default: return "";
  }
}

/**
 * Describe what the next unit will be, based on current state.
 */
export function describeNextUnit(state: GSDState): { label: string; description: string } {
  const sid = state.activeSlice?.id;
  const sTitle = state.activeSlice?.title;
  const tid = state.activeTask?.id;
  const tTitle = state.activeTask?.title;

  switch (state.phase) {
    case "needs-discussion":
      return { label: "Discuss milestone draft", description: "Milestone has a draft context — needs discussion before planning." };
    case "pre-planning":
      return { label: "Research & plan milestone", description: "Scout the landscape and create the roadmap." };
    case "planning":
      return { label: `Plan ${sid}: ${sTitle}`, description: "Research and decompose into tasks." };
    case "executing":
      return { label: `Execute ${tid}: ${tTitle}`, description: "Run the next task in a fresh session." };
    case "summarizing":
      return { label: `Complete ${sid}: ${sTitle}`, description: "Write summary, UAT, and merge to main." };
    case "replanning-slice":
      return { label: `Replan ${sid}: ${sTitle}`, description: "Blocker found — replan the slice." };
    case "completing-milestone":
      return { label: "Complete milestone", description: "Write milestone summary." };
    default:
      return { label: "Continue", description: "Execute the next step." };
  }
}

// ─── Elapsed Time Formatting ──────────────────────────────────────────────────

/** Format elapsed time since auto-mode started */
export function formatAutoElapsed(autoStartTime: number): string {
  if (!autoStartTime) return "";
  const ms = Date.now() - autoStartTime;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs > 0 ? ` ${rs}s` : ""}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/** Format token counts for compact display */
export function formatWidgetTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

// ─── ETA Estimation ──────────────────────────────────────────────────────────

/**
 * Estimate remaining time based on average unit duration from the metrics ledger.
 * Returns a formatted string like "~12m remaining" or null if insufficient data.
 */
export function estimateTimeRemaining(): string | null {
  const ledger = getLedger();
  if (!ledger || ledger.units.length < 2) return null;

  const sliceProgress = getRoadmapSlicesSync();
  if (!sliceProgress || sliceProgress.total === 0) return null;

  const remainingSlices = sliceProgress.total - sliceProgress.done;
  if (remainingSlices <= 0) return null;

  // Compute average duration per completed slice from the ledger
  const completedSliceUnits = ledger.units.filter(
    u => u.finishedAt > 0 && u.startedAt > 0,
  );
  if (completedSliceUnits.length < 2) return null;

  const totalDuration = completedSliceUnits.reduce(
    (sum, u) => sum + (u.finishedAt - u.startedAt), 0,
  );
  const avgDuration = totalDuration / completedSliceUnits.length;

  // Rough estimate: remaining slices × average units per slice × avg duration
  const completedSlices = sliceProgress.done || 1;
  const unitsPerSlice = completedSliceUnits.length / completedSlices;
  const estimatedMs = remainingSlices * unitsPerSlice * avgDuration;

  if (estimatedMs < 5_000) return null; // Too small to display

  const s = Math.floor(estimatedMs / 1000);
  if (s < 60) return `~${s}s remaining`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m remaining`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `~${h}h ${rm}m remaining` : `~${h}h remaining`;
}

// ─── Slice Progress Cache ─────────────────────────────────────────────────────

/** Cached task detail for the widget task checklist */
interface CachedTaskDetail {
  id: string;
  title: string;
  done: boolean;
}

/** Cached slice progress for the widget — avoid async in render */
let cachedSliceProgress: {
  done: number;
  total: number;
  milestoneId: string;
  /** Real task progress for the active slice, if its plan file exists */
  activeSliceTasks: { done: number; total: number } | null;
  /** Full task list for the active slice checklist */
  taskDetails: CachedTaskDetail[] | null;
} | null = null;

export function updateSliceProgressCache(base: string, mid: string, activeSid?: string): void {
  try {
    const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
    if (!roadmapFile) return;
    const content = readFileSync(roadmapFile, "utf-8");
    const roadmap = parseRoadmap(content);

    let activeSliceTasks: { done: number; total: number } | null = null;
    let taskDetails: CachedTaskDetail[] | null = null;
    if (activeSid) {
      try {
        const planFile = resolveSliceFile(base, mid, activeSid, "PLAN");
        if (planFile && existsSync(planFile)) {
          const planContent = readFileSync(planFile, "utf-8");
          const plan = parsePlan(planContent);
          activeSliceTasks = {
            done: plan.tasks.filter(t => t.done).length,
            total: plan.tasks.length,
          };
          taskDetails = plan.tasks.map(t => ({ id: t.id, title: t.title, done: t.done }));
        }
      } catch {
        // Non-fatal — just omit task count
      }
    }

    cachedSliceProgress = {
      done: roadmap.slices.filter(s => s.done).length,
      total: roadmap.slices.length,
      milestoneId: mid,
      activeSliceTasks,
      taskDetails,
    };
  } catch {
    // Non-fatal — widget just won't show progress bar
  }
}

export function getRoadmapSlicesSync(): { done: number; total: number; activeSliceTasks: { done: number; total: number } | null; taskDetails: CachedTaskDetail[] | null } | null {
  return cachedSliceProgress;
}

export function clearSliceProgressCache(): void {
  cachedSliceProgress = null;
}

// ─── Footer Factory ───────────────────────────────────────────────────────────

/**
 * Footer factory that renders zero lines — hides the built-in footer entirely.
 * All footer info (pwd, branch, tokens, cost, model) is shown inside the
 * progress widget instead, so there's no gap or redundancy.
 */
export const hideFooter = () => ({
  render(_width: number): string[] { return []; },
  invalidate() {},
  dispose() {},
});

// ─── Compact Mode ─────────────────────────────────────────────────────────────

/** When true, the progress widget renders a minimal 2-line summary. */
let compactWidget = false;

/** Toggle compact/expanded widget mode. */
export function toggleCompactWidget(): boolean {
  compactWidget = !compactWidget;
  return compactWidget;
}

/** Get current compact mode state. */
export function isCompactWidget(): boolean {
  return compactWidget;
}

// ─── Progress Widget ──────────────────────────────────────────────────────────

/** State accessors passed to updateProgressWidget to avoid direct global access */
export interface WidgetStateAccessors {
  getAutoStartTime(): number;
  isStepMode(): boolean;
  getCmdCtx(): ExtensionCommandContext | null;
  getBasePath(): string;
  isVerbose(): boolean;
}

export function updateProgressWidget(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
  state: GSDState,
  accessors: WidgetStateAccessors,
  tierBadge?: string,
): void {
  if (!ctx.hasUI) return;

  const verb = unitVerb(unitType);
  const phaseLabel = unitPhaseLabel(unitType);
  const mid = state.activeMilestone;
  const slice = state.activeSlice;
  const task = state.activeTask;
  const next = peekNext(unitType, state);
  const isHook = unitType.startsWith("hook/");

  // Cache git branch at widget creation time (not per render)
  let cachedBranch: string | null = null;
  try { cachedBranch = getCurrentBranch(accessors.getBasePath()); } catch { /* not in git repo */ }

  // Cache pwd with ~ substitution
  let widgetPwd = process.cwd();
  const widgetHome = process.env.HOME || process.env.USERPROFILE;
  if (widgetHome && widgetPwd.startsWith(widgetHome)) {
    widgetPwd = `~${widgetPwd.slice(widgetHome.length)}`;
  }
  if (cachedBranch) widgetPwd = `${widgetPwd} (${cachedBranch})`;

  ctx.ui.setWidget("gsd-progress", (tui, theme) => {
    let pulseBright = true;
    let cachedLines: string[] | undefined;
    let cachedWidth: number | undefined;

    const pulseTimer = setInterval(() => {
      pulseBright = !pulseBright;
      cachedLines = undefined;
      tui.requestRender();
    }, 800);

    // Refresh progress cache from disk every 15s so the widget reflects
    // task/slice completion mid-unit. Without this, the progress bar only
    // updates at dispatch time, appearing frozen during long-running units.
    // 15s (vs 5s) reduces synchronous file I/O on the hot path.
    const progressRefreshTimer = mid ? setInterval(() => {
      try {
        updateSliceProgressCache(accessors.getBasePath(), mid.id, slice?.id);
        cachedLines = undefined;
      } catch { /* non-fatal */ }
    }, 15_000) : null;

    return {
      render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;

        const ui = makeUI(theme, width);
        const lines: string[] = [];
        const pad = INDENT.base;

        // ── Line 1: Top bar ───────────────────────────────────────────────
        lines.push(...ui.bar());

        const dot = pulseBright
          ? theme.fg("accent", GLYPH.statusActive)
          : theme.fg("dim", GLYPH.statusPending);
        const elapsed = formatAutoElapsed(accessors.getAutoStartTime());
        const modeTag = accessors.isStepMode() ? "NEXT" : "AUTO";
        const headerLeft = `${pad}${dot} ${theme.fg("accent", theme.bold("GSD"))}  ${theme.fg("success", modeTag)}`;
        const headerRight = elapsed ? theme.fg("dim", elapsed) : "";
        lines.push(rightAlign(headerLeft, headerRight, width));

        // ── Compact mode: 2-line summary ────────────────────────────────
        if (compactWidget) {
          const target = task ? `${task.id}: ${task.title}` : unitId;
          const compactLeft = `${pad}${theme.fg("accent", verb)}  ${theme.fg("text", target)}`;
          const roadmapSlices = mid ? getRoadmapSlicesSync() : null;
          let compactRight = "";
          if (roadmapSlices) {
            const { done, total, activeSliceTasks } = roadmapSlices;
            compactRight = theme.fg("dim", `${done}/${total} slices`);
            if (activeSliceTasks) {
              const tn = Math.min(activeSliceTasks.done + 1, activeSliceTasks.total);
              compactRight += theme.fg("dim", ` · task ${tn}/${activeSliceTasks.total}`);
            }
          }
          lines.push(rightAlign(compactLeft, compactRight, width));
          lines.push(...ui.bar());
          cachedLines = lines;
          cachedWidth = width;
          return lines;
        }

        lines.push("");

        // Context section: milestone + slice (only when present)
        const hasContext = !!(mid || (slice && unitType !== "research-milestone" && unitType !== "plan-milestone"));
        if (mid) {
          lines.push(truncateToWidth(`${pad}${theme.fg("dim", mid.title)}`, width));
        }
        if (slice && unitType !== "research-milestone" && unitType !== "plan-milestone") {
          lines.push(truncateToWidth(
            `${pad}${theme.fg("text", theme.bold(`${slice.id}: ${slice.title}`))}`,
            width,
          ));
        }
        if (hasContext) lines.push("");

        const target = task ? `${task.id}: ${task.title}` : unitId;
        const actionLeft = `${pad}${theme.fg("accent", "▸")} ${theme.fg("accent", verb)}  ${theme.fg("text", target)}`;
        const tierTag = tierBadge ? theme.fg("dim", `[${tierBadge}] `) : "";
        const phaseBadge = `${tierTag}${theme.fg("dim", phaseLabel)}`;
        lines.push(rightAlign(actionLeft, phaseBadge, width));

        lines.push("");

        // ── Two-column body ─────────────────────────────────────────────
        // Left: progress, health, next   Right: task checklist
        // Approach: pad each left line to a fixed visible width, then
        // concatenate the right text. No CSI cursor positioning needed.
        const minTwoColWidth = 76;
        const roadmapSlices = mid ? getRoadmapSlicesSync() : null;
        const taskDetailsCol = roadmapSlices?.taskDetails ?? null;
        const useTwoCol = width >= minTwoColWidth && taskDetailsCol !== null && taskDetailsCol.length > 0;
        // Left column: 45% at wide terminals, 50% at narrow
        const leftColWidth = useTwoCol
          ? Math.floor(width * (width >= 100 ? 0.45 : 0.50))
          : width;

        // Build left column: progress bar, health, next step
        const leftLines: string[] = [];

        if (roadmapSlices) {
          const { done, total, activeSliceTasks } = roadmapSlices;
          const barWidth = Math.max(6, Math.min(18, Math.floor(leftColWidth * 0.4)));
          const pct = total > 0 ? done / total : 0;
          const filled = Math.round(pct * barWidth);
          const bar = theme.fg("success", "█".repeat(filled))
            + theme.fg("dim", "░".repeat(barWidth - filled));

          let meta = `${theme.fg("text", `${done}`)}${theme.fg("dim", `/${total} slices`)}`;
          if (activeSliceTasks && activeSliceTasks.total > 0) {
            const taskNum = isHook
              ? Math.max(activeSliceTasks.done, 1)
              : Math.min(activeSliceTasks.done + 1, activeSliceTasks.total);
            meta += `${theme.fg("dim", " · task ")}${theme.fg("accent", `${taskNum}`)}${theme.fg("dim", `/${activeSliceTasks.total}`)}`;
          }
          leftLines.push(`${pad}${bar} ${meta}`);

          const eta = estimateTimeRemaining();
          if (eta) {
            leftLines.push(`${pad}${theme.fg("dim", eta)}`);
          }
        }

        // Health indicator (traffic light from progress score)
        {
          const score = computeProgressScore();
          const healthColor = score.level === "green" ? "success"
            : score.level === "yellow" ? "warning"
              : "error";
          const healthIcon = score.level === "green" ? GLYPH.statusActive
            : score.level === "yellow" ? "!"
              : "x";
          leftLines.push(
            `${pad}${theme.fg(healthColor, healthIcon)} ${theme.fg(healthColor, score.summary)}`,
          );
        }

        if (next) {
          leftLines.push(
            `${pad}${theme.fg("dim", "-> then")} ${theme.fg("accent", next)}`,
          );
        }

        // Token stats — built here, rendered below the two-column section
        const statsLine = (() => {
          const cmdCtx = accessors.getCmdCtx();
          let totalInput = 0, totalOutput = 0;
          let totalCacheRead = 0, totalCacheWrite = 0;
          if (cmdCtx) {
            for (const entry of cmdCtx.sessionManager.getEntries()) {
              if (entry.type === "message") {
                const msgEntry = entry as SessionMessageEntry;
                if (msgEntry.message?.role === "assistant") {
                  const u = (msgEntry.message as any).usage;
                  if (u) {
                    totalInput += u.input || 0;
                    totalOutput += u.output || 0;
                    totalCacheRead += u.cacheRead || 0;
                    totalCacheWrite += u.cacheWrite || 0;
                  }
                }
              }
            }
          }
          const mLedger = getLedger();
          const autoTotals = mLedger ? getProjectTotals(mLedger.units) : null;
          const cumulativeCost = autoTotals?.cost ?? 0;

          const cxUsage = cmdCtx?.getContextUsage?.();
          const cxWindow = cxUsage?.contextWindow ?? cmdCtx?.model?.contextWindow ?? 0;
          const cxPctVal = cxUsage?.percent ?? 0;
          const cxPct = cxUsage?.percent !== null ? cxPctVal.toFixed(1) : "?";

          const sp: string[] = [];
          if (totalInput) sp.push(`↑${formatWidgetTokens(totalInput)}`);
          if (totalOutput) sp.push(`↓${formatWidgetTokens(totalOutput)}`);
          if (totalCacheRead) sp.push(`R${formatWidgetTokens(totalCacheRead)}`);
          if (totalCacheWrite) sp.push(`W${formatWidgetTokens(totalCacheWrite)}`);
          if (totalCacheRead + totalInput > 0) {
            const hitRate = Math.round((totalCacheRead / (totalCacheRead + totalInput)) * 100);
            const hitColor = hitRate >= 70 ? "success" : hitRate >= 40 ? "warning" : "error";
            sp.push(theme.fg(hitColor, `${hitRate}%hit`));
          }
          if (cumulativeCost) sp.push(theme.fg("warning", `$${cumulativeCost.toFixed(3)}`));

          const cxDisplay = cxPct === "?"
            ? `?/${formatWidgetTokens(cxWindow)}`
            : `${cxPct}%/${formatWidgetTokens(cxWindow)}`;
          if (cxPctVal > 90) {
            sp.push(theme.fg("error", cxDisplay));
          } else if (cxPctVal > 70) {
            sp.push(theme.fg("warning", cxDisplay));
          } else {
            sp.push(cxDisplay);
          }

          const modelId = cmdCtx?.model?.id ?? "";
          const modelProvider = cmdCtx?.model?.provider ?? "";
          const modelName = modelProvider && modelId
            ? `${modelProvider}/${modelId}`
            : modelId;
          if (modelName) sp.push(modelName);

          if (mLedger && mLedger.units.some(u => u.tier)) {
            const savings = formatTierSavings(mLedger.units);
            if (savings) sp.push(savings);
          }

          return sp.map(p => p.includes("\x1b[") ? p : theme.fg("dim", p))
            .join(theme.fg("dim", " "));
        })();

        // Build right column: task checklist
        // Each entry is "G LABEL" where G is a single ASCII char (*, >, .)
        // so alignment is trivial — no multi-byte glyphs.
        const rightLines: string[] = [];
        const maxVisibleTasks = 8;

        function formatTaskLine(t: { id: string; title: string; done: boolean }, isCurrent: boolean): string {
          const glyph = t.done
            ? theme.fg("success", "*")
            : isCurrent
              ? theme.fg("accent", ">")
              : theme.fg("dim", ".");
          const id = isCurrent
            ? theme.fg("accent", t.id)
            : t.done
              ? theme.fg("muted", t.id)
              : theme.fg("dim", t.id);
          const title = isCurrent
            ? theme.fg("text", t.title)
            : t.done
              ? theme.fg("muted", t.title)
              : theme.fg("text", t.title);
          return `${glyph} ${id}: ${title}`;
        }

        if (useTwoCol && taskDetailsCol) {
          for (const t of taskDetailsCol.slice(0, maxVisibleTasks)) {
            rightLines.push(formatTaskLine(t, !!(task && t.id === task.id)));
          }
          if (taskDetailsCol.length > maxVisibleTasks) {
            rightLines.push(theme.fg("dim", `  +${taskDetailsCol.length - maxVisibleTasks} more`));
          }
        } else if (!useTwoCol && taskDetailsCol && taskDetailsCol.length > 0) {
          // Narrow single-column: tasks go into left column
          for (const t of taskDetailsCol.slice(0, maxVisibleTasks)) {
            leftLines.push(`${pad}${formatTaskLine(t, !!(task && t.id === task.id))}`);
          }
        }

        // Compose columns — pad left to fixed width, concatenate right
        if (useTwoCol) {
          const maxRows = Math.max(leftLines.length, rightLines.length);
          if (maxRows > 0) {
            lines.push("");
            for (let i = 0; i < maxRows; i++) {
              const left = padToWidth(truncateToWidth(leftLines[i] ?? "", leftColWidth), leftColWidth);
              const right = rightLines[i] ?? "";
              lines.push(`${left}${right}`);
            }
          }
        } else {
          if (leftLines.length > 0) {
            lines.push("");
            for (const l of leftLines) lines.push(truncateToWidth(l, width));
          }
        }

        // ── Footer: stats + pwd + hints ─────────────────────────────────
        lines.push("");
        if (statsLine) {
          lines.push(rightAlign("", statsLine, width));
        }
        const hintParts: string[] = [];
        hintParts.push("esc pause");
        hintParts.push(process.platform === "darwin" ? "⌃⌥G dashboard" : "Ctrl+Alt+G dashboard");
        const hintStr = theme.fg("dim", hintParts.join(" | "));
        const pwdStr = theme.fg("dim", widgetPwd);
        lines.push(rightAlign(`${pad}${pwdStr}`, hintStr, width));

        lines.push(...ui.bar());

        cachedLines = lines;
        cachedWidth = width;
        return lines;
      },
      invalidate() {
        cachedLines = undefined;
        cachedWidth = undefined;
      },
      dispose() {
        clearInterval(pulseTimer);
        if (progressRefreshTimer) clearInterval(progressRefreshTimer);
      },
    };
  });
}

// ─── Right-align Helper ───────────────────────────────────────────────────────

/** Right-align helper: build a line with left content and right content. */
function rightAlign(left: string, right: string, width: number): string {
  const leftVis = visibleWidth(left);
  const rightVis = visibleWidth(right);
  const gap = Math.max(1, width - leftVis - rightVis);
  return truncateToWidth(left + " ".repeat(gap) + right, width);
}

/** Pad a string with trailing spaces to fill exactly `colWidth` (ANSI-aware). */
function padToWidth(s: string, colWidth: number): string {
  const vis = visibleWidth(s);
  if (vis >= colWidth) return truncateToWidth(s, colWidth);
  return s + " ".repeat(colWidth - vis);
}
