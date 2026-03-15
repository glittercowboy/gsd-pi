/**
 * Auto-mode Dashboard — progress widget rendering, elapsed time formatting,
 * unit description helpers, and slice progress caching.
 *
 * Pure functions that accept specific parameters — no module-level globals
 * or AutoContext dependency. State accessors are passed as callbacks.
 */

import type { ExtensionContext, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import type { GSDState } from "./types.js";
import { getCurrentBranch } from "./worktree.js";
import { getActiveHook } from "./post-unit-hooks.js";
import { getLedger, getProjectTotals, formatCost, formatTokenCount } from "./metrics.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
} from "./paths.js";
import { parseRoadmap, parsePlan } from "./files.js";
import { readFileSync, existsSync } from "node:fs";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { makeUI, GLYPH, INDENT } from "../shared/ui.js";

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

// ─── Slice Progress Cache ─────────────────────────────────────────────────────

/** Cached slice progress for the widget — avoid async in render */
let cachedSliceProgress: {
  done: number;
  total: number;
  milestoneId: string;
  /** Real task progress for the active slice, if its plan file exists */
  activeSliceTasks: { done: number; total: number } | null;
} | null = null;

export function updateSliceProgressCache(base: string, mid: string, activeSid?: string): void {
  try {
    const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
    if (!roadmapFile) return;
    const content = readFileSync(roadmapFile, "utf-8");
    const roadmap = parseRoadmap(content);

    let activeSliceTasks: { done: number; total: number } | null = null;
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
    };
  } catch {
    // Non-fatal — widget just won't show progress bar
  }
}

export function getRoadmapSlicesSync(): { done: number; total: number; activeSliceTasks: { done: number; total: number } | null } | null {
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
): void {
  if (!ctx.hasUI) return;

  const verb = unitVerb(unitType);
  const phaseLabel = unitPhaseLabel(unitType);
  const mid = state.activeMilestone;
  const slice = state.activeSlice;
  const task = state.activeTask;
  const next = peekNext(unitType, state);

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

        lines.push("");

        if (mid) {
          lines.push(truncateToWidth(`${pad}${theme.fg("dim", mid.title)}`, width));
        }

        if (slice && unitType !== "research-milestone" && unitType !== "plan-milestone") {
          lines.push(truncateToWidth(
            `${pad}${theme.fg("text", theme.bold(`${slice.id}: ${slice.title}`))}`,
            width,
          ));
        }

        lines.push("");

        const target = task ? `${task.id}: ${task.title}` : unitId;
        const actionLeft = `${pad}${theme.fg("accent", "▸")} ${theme.fg("accent", verb)}  ${theme.fg("text", target)}`;
        const phaseBadge = theme.fg("dim", phaseLabel);
        lines.push(rightAlign(actionLeft, phaseBadge, width));
        lines.push("");

        if (mid) {
          const roadmapSlices = getRoadmapSlicesSync();
          if (roadmapSlices) {
            const { done, total, activeSliceTasks } = roadmapSlices;
            const barWidth = Math.max(8, Math.min(24, Math.floor(width * 0.3)));
            const pct = total > 0 ? done / total : 0;
            const filled = Math.round(pct * barWidth);
            const bar = theme.fg("success", "█".repeat(filled))
              + theme.fg("dim", "░".repeat(barWidth - filled));

            let meta = theme.fg("dim", `${done}/${total} slices`);

            if (activeSliceTasks && activeSliceTasks.total > 0) {
              meta += theme.fg("dim", `  ·  task ${activeSliceTasks.done + 1}/${activeSliceTasks.total}`);
            }

            lines.push(truncateToWidth(`${pad}${bar}  ${meta}`, width));
          }
        }

        lines.push("");

        if (next) {
          lines.push(truncateToWidth(
            `${pad}${theme.fg("dim", "→")} ${theme.fg("dim", `then ${next}`)}`,
            width,
          ));
        }

        // ── Footer info (pwd, tokens, cost, context, model) ──────────────
        lines.push("");
        lines.push(truncateToWidth(theme.fg("dim", `${pad}${widgetPwd}`), width, theme.fg("dim", "…")));

        // Token stats from current unit session + cumulative cost from metrics
        {
          const cmdCtx = accessors.getCmdCtx();
          let totalInput = 0, totalOutput = 0;
          let totalCacheRead = 0, totalCacheWrite = 0;
          if (cmdCtx) {
            for (const entry of cmdCtx.sessionManager.getEntries()) {
              if (entry.type === "message" && (entry as any).message?.role === "assistant") {
                const u = (entry as any).message.usage;
                if (u) {
                  totalInput += u.input || 0;
                  totalOutput += u.output || 0;
                  totalCacheRead += u.cacheRead || 0;
                  totalCacheWrite += u.cacheWrite || 0;
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
          if (cumulativeCost) sp.push(`$${cumulativeCost.toFixed(3)}`);

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

          const sLeft = sp.map(p => p.includes("\x1b[") ? p : theme.fg("dim", p))
            .join(theme.fg("dim", " "));

          const modelId = cmdCtx?.model?.id ?? "";
          const modelProvider = cmdCtx?.model?.provider ?? "";
          const modelPhase = phaseLabel ? theme.fg("dim", `[${phaseLabel}] `) : "";
          const modelDisplay = modelProvider && modelId
            ? `${modelProvider}/${modelId}`
            : modelId;
          const sRight = modelDisplay
            ? `${modelPhase}${theme.fg("dim", modelDisplay)}`
            : "";
          lines.push(rightAlign(`${pad}${sLeft}`, sRight, width));
        }

        const hintParts: string[] = [];
        hintParts.push("esc pause");
        hintParts.push(process.platform === "darwin" ? "⌃⌥G dashboard" : "Ctrl+Alt+G dashboard");
        lines.push(...ui.hints(hintParts));

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
