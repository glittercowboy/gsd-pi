/**
 * GSD Auto Mode — Fresh Session Per Unit
 *
 * State machine driven by .gsd/ files on disk. Each "unit" of work
 * (plan slice, execute task, complete slice) gets a fresh session via
 * the stashed ctx.newSession() pattern.
 *
 * The extension reads disk state after each agent_end, determines the
 * next unit type, creates a fresh session, and injects a focused prompt
 * telling the LLM which files to read and what to do.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { deriveState } from "./state.js";
import type { GSDState } from "./types.js";
import { loadFile, parseContinue, parsePlan, parseRoadmap, parseSummary, extractUatType, inlinePriorMilestoneSummary } from "./files.js";
export { inlinePriorMilestoneSummary };
import type { UatType } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
import {
  gsdRoot, resolveMilestoneFile, resolveSliceFile, resolveSlicePath,
  resolveMilestonePath, resolveDir, resolveTasksDir, resolveTaskFiles, resolveTaskFile,
  relMilestoneFile, relSliceFile, relTaskFile, relSlicePath, relMilestonePath,
  milestonesDir, resolveGsdRootFile, relGsdRootFile,
  buildMilestoneFileName, buildSliceFileName, buildTaskFileName,
} from "./paths.js";
import { saveActivityLog } from "./activity-log.js";
import { synthesizeCrashRecovery, getDeepDiagnostic } from "./session-forensics.js";
import { writeLock, clearLock, readCrashLock, formatCrashInfo } from "./crash-recovery.js";
import {
  clearUnitRuntimeRecord,
  formatExecuteTaskRecoveryStatus,
  inspectExecuteTaskDurability,
  readUnitRuntimeRecord,
  writeUnitRuntimeRecord,
} from "./unit-runtime.js";
import { resolveAutoSupervisorConfig, resolveModelForUnit, resolveSkillDiscoveryMode, loadEffectiveGSDPreferences } from "./preferences.js";
import type { GSDPreferences } from "./preferences.js";
import {
  validatePlanBoundary,
  validateExecuteBoundary,
  validateCompleteBoundary,
  formatValidationIssues,
} from "./observability-validator.js";
import { ensureGitignore } from "./gitignore.js";
import { runGSDDoctor, rebuildState } from "./doctor.js";
import { snapshotSkills, clearSkillSnapshot } from "./skill-discovery.js";
import {
  initMetrics, resetMetrics, snapshotUnitMetrics, getLedger,
  getProjectTotals, formatCost, formatTokenCount,
} from "./metrics.js";
import { join } from "node:path";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  autoCommitCurrentBranch,
  ensureSliceBranch,
  getCurrentBranch,
  getSliceBranchName,
  switchToMain,
  mergeSliceToMain,
  getCurrentBranch,
} from "./worktree.ts";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { makeUI, GLYPH, INDENT } from "../shared/ui.js";
import { showNextAction } from "../shared/next-action-ui.js";

// ─── State ────────────────────────────────────────────────────────────────────

let active = false;
let paused = false;
let stepMode = false;
let verbose = false;
let cmdCtx: ExtensionCommandContext | null = null;
let basePath = "";

/** Track last dispatched unit to detect stuck loops */
let lastUnit: { type: string; id: string } | null = null;
let retryCount = 0;
const MAX_RETRIES = 1;

/** Crash recovery prompt — set by startAuto, consumed by first dispatchNextUnit */
let pendingCrashRecovery: string | null = null;

/** Dashboard tracking */
let autoStartTime: number = 0;
let completedUnits: { type: string; id: string; startedAt: number; finishedAt: number }[] = [];
let currentUnit: { type: string; id: string; startedAt: number } | null = null;

/** Track current milestone to detect transitions */
let currentMilestoneId: string | null = null;

/** Model the user had selected before auto-mode started */
let originalModelId: string | null = null;

/** Progress-aware timeout supervision */
let unitTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let wrapupWarningHandle: ReturnType<typeof setTimeout> | null = null;
let idleWatchdogHandle: ReturnType<typeof setInterval> | null = null;

/** Format token counts for compact display */
function formatWidgetTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * Footer factory that renders zero lines — hides the built-in footer entirely.
 * All footer info (pwd, branch, tokens, cost, model) is shown inside the
 * progress widget instead, so there's no gap or redundancy.
 */
const hideFooter = () => ({
  render(_width: number): string[] { return []; },
  invalidate() {},
  dispose() {},
});

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

export function getAutoDashboardData(): AutoDashboardData {
  const ledger = getLedger();
  const totals = ledger ? getProjectTotals(ledger.units) : null;
  return {
    active,
    paused,
    stepMode,
    startTime: autoStartTime,
    elapsed: (active || paused) ? Date.now() - autoStartTime : 0,
    currentUnit: currentUnit ? { ...currentUnit } : null,
    completedUnits: [...completedUnits],
    basePath,
    totalCost: totals?.cost ?? 0,
    totalTokens: totals?.tokens.total ?? 0,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function isAutoActive(): boolean {
  return active;
}

export function isAutoPaused(): boolean {
  return paused;
}

export function isStepMode(): boolean {
  return stepMode;
}

function clearUnitTimeout(): void {
  if (unitTimeoutHandle) {
    clearTimeout(unitTimeoutHandle);
    unitTimeoutHandle = null;
  }
  if (wrapupWarningHandle) {
    clearTimeout(wrapupWarningHandle);
    wrapupWarningHandle = null;
  }
  if (idleWatchdogHandle) {
    clearInterval(idleWatchdogHandle);
    idleWatchdogHandle = null;
  }
}

export async function stopAuto(ctx?: ExtensionContext, pi?: ExtensionAPI): Promise<void> {
  if (!active && !paused) return;
  clearUnitTimeout();
  if (basePath) clearLock(basePath);
  clearSkillSnapshot();

  // Show final cost summary before resetting
  const ledger = getLedger();
  if (ledger && ledger.units.length > 0) {
    const totals = getProjectTotals(ledger.units);
    ctx?.ui.notify(
      `Auto-mode stopped. Session: ${formatCost(totals.cost)} · ${formatTokenCount(totals.tokens.total)} tokens · ${ledger.units.length} units`,
      "info",
    );
  } else {
    ctx?.ui.notify("Auto-mode stopped.", "info");
  }

  resetMetrics();
  active = false;
  paused = false;
  stepMode = false;
  lastUnit = null;
  currentUnit = null;
  currentMilestoneId = null;
  cachedSliceProgress = null;
  pendingCrashRecovery = null;
  ctx?.ui.setStatus("gsd-auto", undefined);
  ctx?.ui.setWidget("gsd-progress", undefined);
  ctx?.ui.setFooter(undefined);

  // Restore the user's original model
  if (pi && ctx && originalModelId) {
    const original = ctx.modelRegistry.find("anthropic", originalModelId);
    if (original) await pi.setModel(original);
    originalModelId = null;
  }

  cmdCtx = null;
}

/**
 * Pause auto-mode without destroying state. Context is preserved.
 * The user can interact with the agent, then `/gsd auto` resumes
 * from disk state. Called when the user presses Escape during auto-mode.
 */
export async function pauseAuto(ctx?: ExtensionContext, _pi?: ExtensionAPI): Promise<void> {
  if (!active) return;
  clearUnitTimeout();
  if (basePath) clearLock(basePath);
  active = false;
  paused = true;
  // Preserve: lastUnit, currentUnit, basePath, verbose, cmdCtx,
  // completedUnits, autoStartTime, currentMilestoneId, originalModelId
  // — all needed for resume and dashboard display
  ctx?.ui.setStatus("gsd-auto", "paused");
  ctx?.ui.setWidget("gsd-progress", undefined);
  ctx?.ui.setFooter(undefined);
  const resumeCmd = stepMode ? "/gsd next" : "/gsd auto";
  ctx?.ui.notify(
    `${stepMode ? "Step" : "Auto"}-mode paused (Escape). Type to interact, or ${resumeCmd} to resume.`,
    "info",
  );
}

export async function startAuto(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  options?: { step?: boolean },
): Promise<void> {
  const requestedStepMode = options?.step ?? false;

  // If resuming from paused state, just re-activate and dispatch next unit.
  // The conversation is still intact — no need to reinitialize everything.
  if (paused) {
    paused = false;
    active = true;
    verbose = verboseMode;
    // Allow switching between step/auto on resume
    stepMode = requestedStepMode;
    cmdCtx = ctx;
    basePath = base;
    // Re-initialize metrics in case ledger was lost during pause
    if (!getLedger()) initMetrics(base);
    ctx.ui.setStatus("gsd-auto", stepMode ? "next" : "auto");
    ctx.ui.setFooter(hideFooter);
    ctx.ui.notify(stepMode ? "Step-mode resumed." : "Auto-mode resumed.", "info");
    // Rebuild disk state before resuming — user interaction during pause may have changed files
    try { await rebuildState(base); } catch { /* non-fatal */ }
    try {
      const report = await runGSDDoctor(base, { fix: true });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(`Resume: applied ${report.fixesApplied.length} fix(es) to state.`, "info");
      }
    } catch { /* non-fatal */ }
    await dispatchNextUnit(ctx, pi);
    return;
  }

  // Ensure git repo exists — GSD needs it for branch-per-slice
  try {
    execSync("git rev-parse --git-dir", { cwd: base, stdio: "pipe" });
  } catch {
    execSync("git init", { cwd: base, stdio: "pipe" });
  }

  // Ensure .gitignore has baseline patterns
  ensureGitignore(base);

  // Bootstrap .gsd/ if it doesn't exist
  const gsdDir = join(base, ".gsd");
  if (!existsSync(gsdDir)) {
    mkdirSync(join(gsdDir, "milestones"), { recursive: true });
    try {
      execSync("git add -A .gsd .gitignore && git commit -m 'chore: init gsd'", {
        cwd: base, stdio: "pipe",
      });
    } catch { /* nothing to commit */ }
  }

  // Check for crash from previous session
  const crashLock = readCrashLock(base);
  if (crashLock) {
    // Synthesize a rich recovery briefing from the surviving pi session file
    // (pi writes entries incrementally, so it contains every tool call up to the crash)
    const activityDir = join(gsdRoot(base), "activity");
    const recovery = synthesizeCrashRecovery(
      base, crashLock.unitType, crashLock.unitId,
      crashLock.sessionFile, activityDir,
    );
    if (recovery && recovery.trace.toolCallCount > 0) {
      pendingCrashRecovery = recovery.prompt;
      ctx.ui.notify(
        `${formatCrashInfo(crashLock)}\nRecovered ${recovery.trace.toolCallCount} tool calls from crashed session. Resuming with full context.`,
        "warning",
      );
    } else {
      ctx.ui.notify(
        `${formatCrashInfo(crashLock)}\nNo session data recovered. Resuming from disk state.`,
        "warning",
      );
    }
    clearLock(base);
  }

  const state = await deriveState(base);

  // No active work at all — start a new milestone via the discuss flow.
  if (!state.activeMilestone || state.phase === "complete") {
    const { showSmartEntry } = await import("./guided-flow.js");
    await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
    return;
  }

  // Active milestone exists but has no roadmap — check if context exists.
  // If context was pre-written (multi-milestone planning), auto-mode can
  // research and plan it. If no context either, need user discussion.
  if (state.phase === "pre-planning") {
    const contextFile = resolveMilestoneFile(base, state.activeMilestone.id, "CONTEXT");
    const hasContext = !!(contextFile && await loadFile(contextFile));
    if (!hasContext) {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
      return;
    }
    // Has context, no roadmap — auto-mode will research + plan it
  }

  active = true;
  stepMode = requestedStepMode;
  verbose = verboseMode;
  cmdCtx = ctx;
  basePath = base;
  lastUnit = null;
  retryCount = 0;
  autoStartTime = Date.now();
  completedUnits = [];
  currentUnit = null;
  currentMilestoneId = state.activeMilestone?.id ?? null;
  originalModelId = ctx.model?.id ?? null;

  // Initialize metrics — loads existing ledger from disk
  initMetrics(base);

  // Snapshot installed skills so we can detect new ones after research
  if (resolveSkillDiscoveryMode() !== "off") {
    snapshotSkills();
  }

  ctx.ui.setStatus("gsd-auto", stepMode ? "next" : "auto");
  ctx.ui.setFooter(hideFooter);
  const modeLabel = stepMode ? "Step-mode" : "Auto-mode";
  const pendingCount = state.registry.filter(m => m.status !== 'complete').length;
  const scopeMsg = pendingCount > 1
    ? `Will loop through ${pendingCount} milestones.`
    : "Will loop until milestone complete.";
  ctx.ui.notify(`${modeLabel} started. ${scopeMsg}`, "info");

  // Dispatch the first unit
  await dispatchNextUnit(ctx, pi);
}

// ─── Agent End Handler ────────────────────────────────────────────────────────

export async function handleAgentEnd(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!active || !cmdCtx) return;

  // Unit completed — clear its timeout
  clearUnitTimeout();

  // Small delay to let files settle (git commits, file writes)
  await new Promise(r => setTimeout(r, 500));

  // Auto-commit any dirty files the LLM left behind on the current branch.
  if (currentUnit) {
    try {
      const commitMsg = autoCommitCurrentBranch(basePath, currentUnit.type, currentUnit.id);
      if (commitMsg) {
        ctx.ui.notify(`Auto-committed uncommitted changes.`, "info");
      }
    } catch {
      // Non-fatal
    }

    // Post-hook: fix mechanical bookkeeping the LLM may have skipped.
    // 1. Doctor handles: checkbox marking, stub summaries/UATs.
    // 2. STATE.md is always rebuilt from disk state (purely derived, no LLM needed).
    // This is more reliable than prompt instructions for mechanical tasks.
    // Scope to slice level (M001/S01) so doctor checks all tasks within the slice.
    try {
      const scopeParts = currentUnit.id.split("/").slice(0, 2);
      const doctorScope = scopeParts.join("/");
      const report = await runGSDDoctor(basePath, { fix: true, scope: doctorScope });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(`Post-hook: applied ${report.fixesApplied.length} fix(es).`, "info");
      }
    } catch {
      // Non-fatal — doctor failure should never block dispatch
    }
    try {
      await rebuildState(basePath);
      autoCommitCurrentBranch(basePath, currentUnit.type, currentUnit.id);
    } catch {
      // Non-fatal
    }
  }

  // In step mode, pause and show a wizard instead of immediately dispatching
  if (stepMode) {
    await showStepWizard(ctx, pi);
    return;
  }

  await dispatchNextUnit(ctx, pi);
}

// ─── Step Mode Wizard ─────────────────────────────────────────────────────

/**
 * Show the step-mode wizard after a unit completes.
 * Derives the next unit from disk state and presents it to the user.
 * If the user confirms, dispatches the next unit. If not, pauses.
 */
async function showStepWizard(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!cmdCtx) return;

  const state = await deriveState(basePath);
  const mid = state.activeMilestone?.id;

  // Build summary of what just completed
  const justFinished = currentUnit
    ? `${unitVerb(currentUnit.type)} ${currentUnit.id}`
    : "previous unit";

  // If no active milestone or everything is complete, stop
  if (!mid || state.phase === "complete") {
    await stopAuto(ctx, pi);
    return;
  }

  // Peek at what's next by examining state
  const nextDesc = describeNextUnit(state);

  const choice = await showNextAction(cmdCtx, {
    title: `GSD — ${justFinished} complete`,
    summary: [
      `${mid}: ${state.activeMilestone?.title ?? mid}`,
      ...(state.activeSlice ? [`${state.activeSlice.id}: ${state.activeSlice.title}`] : []),
    ],
    actions: [
      {
        id: "continue",
        label: nextDesc.label,
        description: nextDesc.description,
        recommended: true,
      },
      {
        id: "auto",
        label: "Switch to auto",
        description: "Continue without pausing between steps.",
      },
      {
        id: "status",
        label: "View status",
        description: "Open the dashboard.",
      },
    ],
    notYetMessage: "Run /gsd next when ready to continue.",
  });

  if (choice === "continue") {
    await dispatchNextUnit(ctx, pi);
  } else if (choice === "auto") {
    stepMode = false;
    ctx.ui.setStatus("gsd-auto", "auto");
    ctx.ui.notify("Switched to auto-mode.", "info");
    await dispatchNextUnit(ctx, pi);
  } else if (choice === "status") {
    // Show status then re-show the wizard
    const { fireStatusViaCommand } = await import("./commands.js");
    await fireStatusViaCommand(ctx as ExtensionCommandContext);
    await showStepWizard(ctx, pi);
  } else {
    // "not_yet" — pause
    await pauseAuto(ctx, pi);
  }
}

/**
 * Describe what the next unit will be, based on current state.
 */
function describeNextUnit(state: GSDState): { label: string; description: string } {
  const sid = state.activeSlice?.id;
  const sTitle = state.activeSlice?.title;
  const tid = state.activeTask?.id;
  const tTitle = state.activeTask?.title;

  switch (state.phase) {
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

// ─── Progress Widget ──────────────────────────────────────────────────────

function unitVerb(unitType: string): string {
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

function unitPhaseLabel(unitType: string): string {
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
  const sid = state.activeSlice?.id ?? "";
  switch (unitType) {
    case "research-milestone": return "plan milestone roadmap";
    case "plan-milestone": return "research first slice";
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



/** Right-align helper: build a line with left content and right content. */
function rightAlign(left: string, right: string, width: number): string {
  const leftVis = visibleWidth(left);
  const rightVis = visibleWidth(right);
  const gap = Math.max(1, width - leftVis - rightVis);
  return truncateToWidth(left + " ".repeat(gap) + right, width);
}

function updateProgressWidget(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
  state: GSDState,
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
  try { cachedBranch = getCurrentBranch(basePath); } catch { /* not in git repo */ }

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
        const elapsed = formatAutoElapsed();
        const modeTag = stepMode ? "NEXT" : "AUTO";
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
          const sRight = modelId ? theme.fg("dim", modelId) : "";
          lines.push(rightAlign(`${pad}${sLeft}`, sRight, width));
        }

        const hintParts: string[] = [];
        hintParts.push("esc pause");
        hintParts.push("Ctrl+Alt+G dashboard");
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

/** Format elapsed time since auto-mode started */
function formatAutoElapsed(): string {
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

/** Cached slice progress for the widget — avoid async in render */
let cachedSliceProgress: {
  done: number;
  total: number;
  milestoneId: string;
  /** Real task progress for the active slice, if its plan file exists */
  activeSliceTasks: { done: number; total: number } | null;
} | null = null;

function updateSliceProgressCache(base: string, mid: string, activeSid?: string): void {
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

function getRoadmapSlicesSync(): { done: number; total: number; activeSliceTasks: { done: number; total: number } | null } | null {
  return cachedSliceProgress;
}

// ─── Core Loop ────────────────────────────────────────────────────────────────

async function dispatchNextUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!active || !cmdCtx) {
    if (active && !cmdCtx) {
      ctx.ui.notify("Auto-mode dispatch failed: no command context. Run /gsd auto to restart.", "error");
    }
    return;
  }

  let state = await deriveState(basePath);
  let mid = state.activeMilestone?.id;
  let midTitle = state.activeMilestone?.title;

  // Detect milestone transition
  if (mid && currentMilestoneId && mid !== currentMilestoneId) {
    ctx.ui.notify(
      `Milestone ${currentMilestoneId} complete. Advancing to ${mid}: ${midTitle}.`,
      "info",
    );
    // Reset stuck detection for new milestone
    lastUnit = null;
    retryCount = 0;
  }
  if (mid) currentMilestoneId = mid;

  if (!mid) {
    // Save final session before stopping
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    await stopAuto(ctx, pi);
    return;
  }

  // ── General merge guard: merge completed slice branches before advancing ──
  // If we're on a gsd/MID/SID branch and that slice is done (roadmap [x]),
  // merge to main before dispatching the next unit. This handles:
  //   - Normal complete-slice → merge → reassess flow
  //   - LLM writes summary during task execution, skipping complete-slice
  //   - Doctor post-hook marks everything done, skipping complete-slice
  //   - complete-milestone runs on a slice branch (last slice bypass)
  {
    const currentBranch = getCurrentBranch(basePath);
    const branchMatch = currentBranch.match(/^gsd\/(M\d+)\/(S\d+)$/);
    if (branchMatch) {
      const branchMid = branchMatch[1]!;
      const branchSid = branchMatch[2]!;
      // Check if this slice is marked done in the roadmap
      const roadmapFile = resolveMilestoneFile(basePath, branchMid, "ROADMAP");
      const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
      if (roadmapContent) {
        const roadmap = parseRoadmap(roadmapContent);
        const sliceEntry = roadmap.slices.find(s => s.id === branchSid);
        if (sliceEntry?.done) {
          try {
            const sliceTitleForMerge = sliceEntry.title || branchSid;
            switchToMain(basePath);
            const mergeResult = mergeSliceToMain(
              basePath, branchMid, branchSid, sliceTitleForMerge,
            );
            ctx.ui.notify(
              `Merged ${mergeResult.branch} → main.`,
              "info",
            );
            // Re-derive state from main so downstream logic sees merged state
            state = await deriveState(basePath);
            mid = state.activeMilestone?.id;
            midTitle = state.activeMilestone?.title;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(
              `Slice merge failed: ${message}`,
              "error",
            );
            // Re-derive state so dispatch can figure out what to do
            state = await deriveState(basePath);
            mid = state.activeMilestone?.id;
            midTitle = state.activeMilestone?.title;
          }
        }
      }
    }
  }

  // Determine next unit
  let unitType: string;
  let unitId: string;
  let prompt: string;

  if (state.phase === "complete") {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    await stopAuto(ctx, pi);
    return;
  }

  if (state.phase === "blocked") {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    await stopAuto(ctx, pi);
    ctx.ui.notify(`Blocked: ${state.blockers.join(", ")}. Fix and run /gsd auto.`, "warning");
    return;
  }

  // ── UAT Dispatch: run-uat fires after complete-slice merge, before reassessment ──
  // Ensures the UAT file and slice summary are both on main when UAT runs.
  const prefs = loadEffectiveGSDPreferences()?.preferences;

  // Budget ceiling guard — pause before starting next unit if ceiling is hit
  const budgetCeiling = prefs?.budget_ceiling;
  if (budgetCeiling !== undefined) {
    const currentLedger = getLedger();
    const totalCost = currentLedger ? getProjectTotals(currentLedger.units).cost : 0;
    if (totalCost >= budgetCeiling) {
      ctx.ui.notify(
        `Budget ceiling ${formatCost(budgetCeiling)} reached (spent ${formatCost(totalCost)}). Pausing auto-mode — /gsd auto to continue.`,
        "warning",
      );
      await pauseAuto(ctx, pi);
      return;
    }
  }

  const needsRunUat = await checkNeedsRunUat(basePath, mid, state, prefs);
  // Flag: for human/mixed UAT, pause auto-mode after the prompt is sent so the user
  // can perform the UAT manually. On next resume, result file will exist → skip.
  let pauseAfterUatDispatch = false;

  // ── Adaptive Replanning: check if last completed slice needs reassessment ──
  // After a slice completes, we reassess the roadmap before moving to the next slice.
  // Skip reassessment for the final slice (milestone complete) or if already assessed.
  const needsReassess = await checkNeedsReassessment(basePath, mid, state);
  if (needsRunUat) {
    const { sliceId, uatType } = needsRunUat;
    unitType = "run-uat";
    unitId = `${mid}/${sliceId}`;
    const uatFile = resolveSliceFile(basePath, mid, sliceId, "UAT")!;
    const uatContent = await loadFile(uatFile);
    prompt = await buildRunUatPrompt(
      mid, sliceId, relSliceFile(basePath, mid, sliceId, "UAT"), uatContent ?? "", basePath,
    );
    // For non-artifact-driven UAT types, pause after the prompt is dispatched.
    // The agent receives the prompt, writes S0x-UAT-RESULT.md surfacing the UAT,
    // then auto-mode pauses for human execution. On resume, result file exists → skip.
    if (uatType !== "artifact-driven") {
      pauseAfterUatDispatch = true;
    }
  } else if (needsReassess) {
    unitType = "reassess-roadmap";
    unitId = `${mid}/${needsReassess.sliceId}`;
    prompt = await buildReassessRoadmapPrompt(mid, midTitle!, needsReassess.sliceId, basePath);
  } else if (state.phase === "pre-planning") {
    // Need roadmap — check if context exists
    const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
    const hasContext = !!(contextFile && await loadFile(contextFile));

    if (!hasContext) {
      await stopAuto(ctx, pi);
      ctx.ui.notify("No context or roadmap yet. Run /gsd to discuss first.", "warning");
      return;
    }

    // Research before roadmap if no research exists
    const researchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
    const hasResearch = !!(researchFile && await loadFile(researchFile));

    if (!hasResearch) {
      unitType = "research-milestone";
      unitId = mid;
      prompt = await buildResearchMilestonePrompt(mid, midTitle!, basePath);
    } else {
      unitType = "plan-milestone";
      unitId = mid;
      prompt = await buildPlanMilestonePrompt(mid, midTitle!, basePath);
    }

  } else if (state.phase === "planning") {
    // Slice needs planning — but research first if no research exists
    const sid = state.activeSlice!.id;
    const sTitle = state.activeSlice!.title;
    const researchFile = resolveSliceFile(basePath, mid, sid, "RESEARCH");
    const hasResearch = !!(researchFile && await loadFile(researchFile));

    if (!hasResearch) {
      unitType = "research-slice";
      unitId = `${mid}/${sid}`;
      prompt = await buildResearchSlicePrompt(mid, midTitle!, sid, sTitle, basePath);
    } else {
      unitType = "plan-slice";
      unitId = `${mid}/${sid}`;
      prompt = await buildPlanSlicePrompt(mid, midTitle!, sid, sTitle, basePath);
    }

  } else if (state.phase === "replanning-slice") {
    // Blocker discovered — replan the slice before continuing
    const sid = state.activeSlice!.id;
    const sTitle = state.activeSlice!.title;
    unitType = "replan-slice";
    unitId = `${mid}/${sid}`;
    prompt = await buildReplanSlicePrompt(mid, midTitle!, sid, sTitle, basePath);

  } else if (state.phase === "executing" && state.activeTask) {
    // Execute next task
    const sid = state.activeSlice!.id;
    const sTitle = state.activeSlice!.title;
    const tid = state.activeTask.id;
    const tTitle = state.activeTask.title;
    unitType = "execute-task";
    unitId = `${mid}/${sid}/${tid}`;
    prompt = await buildExecuteTaskPrompt(mid, sid, sTitle, tid, tTitle, basePath);

  } else if (state.phase === "summarizing") {
    // All tasks done — complete the slice
    const sid = state.activeSlice!.id;
    const sTitle = state.activeSlice!.title;
    unitType = "complete-slice";
    unitId = `${mid}/${sid}`;
    prompt = await buildCompleteSlicePrompt(mid, midTitle!, sid, sTitle, basePath);

  } else if (state.phase === "completing-milestone") {
    // All slices done — complete the milestone
    unitType = "complete-milestone";
    unitId = mid;
    prompt = await buildCompleteMilestonePrompt(mid, midTitle!, basePath);

  } else {
    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
      saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);
    }
    await stopAuto(ctx, pi);
    ctx.ui.notify(`Unexpected phase: ${state.phase}. Stopping auto-mode.`, "warning");
    return;
  }

  await emitObservabilityWarnings(ctx, unitType, unitId);

  // Stuck detection — same unit dispatched again means the LLM didn't produce
  // the expected artifact. Retry once (the LLM may have hit an error or run out
  // of context), then stop with a diagnostic.
  if (lastUnit && lastUnit.type === unitType && lastUnit.id === unitId) {
    retryCount++;

    if (retryCount > MAX_RETRIES) {
      if (currentUnit) {
        const modelId = ctx.model?.id ?? "unknown";
        snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
      }
      saveActivityLog(ctx, basePath, lastUnit.type, lastUnit.id);

      // Diagnostic: what file was expected?
      const expected = diagnoseExpectedArtifact(unitType, unitId, basePath);
      await stopAuto(ctx, pi);
      ctx.ui.notify(
        `Stuck: ${unitType} ${unitId} fired ${retryCount + 1} times. Expected artifact not found.${expected ? `\n   Expected: ${expected}` : ""}\n   Check .gsd/ and activity logs.`,
        "error",
      );
      return;
    }
    ctx.ui.notify(
      `${unitType} ${unitId} didn't produce expected artifact. Retrying (${retryCount}/${MAX_RETRIES}).`,
      "warning",
    );
  } else {
    retryCount = 0;
  }
  // Snapshot metrics + activity log for the PREVIOUS unit before we reassign.
  // The session still holds the previous unit's data (newSession hasn't fired yet).
  if (currentUnit) {
    const modelId = ctx.model?.id ?? "unknown";
    snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
    saveActivityLog(ctx, basePath, currentUnit.type, currentUnit.id);

    completedUnits.push({
      type: currentUnit.type,
      id: currentUnit.id,
      startedAt: currentUnit.startedAt,
      finishedAt: Date.now(),
    });
    clearUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id);
  }

  lastUnit = { type: unitType, id: unitId };
  currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
    phase: "dispatched",
    wrapupWarningSent: false,
    timeoutAt: null,
    lastProgressAt: currentUnit.startedAt,
    progressCount: 0,
    lastProgressKind: "dispatch",
  });

  // Status bar + progress widget
  ctx.ui.setStatus("gsd-auto", "auto");
  if (mid) updateSliceProgressCache(basePath, mid, state.activeSlice?.id);
  updateProgressWidget(ctx, unitType, unitId, state);

  // Ensure preconditions — create directories, branches, etc.
  // so the LLM doesn't have to get these right
  ensurePreconditions(unitType, unitId, basePath, state);

  // Fresh session
  const result = await cmdCtx!.newSession();
  if (result.cancelled) {
    await stopAuto(ctx, pi);
    ctx.ui.notify("New session cancelled — auto-mode stopped.", "warning");
    return;
  }

  // NOTE: Slice merge happens AFTER the complete-slice unit finishes,
  // not here at dispatch time. See the merge logic at the top of
  // dispatchNextUnit where we check if the previous unit was complete-slice.

  // Write lock AFTER newSession so we capture the session file path.
  // Pi appends entries incrementally via appendFileSync, so on crash the
  // session file survives with every tool call up to the crash point.
  const sessionFile = ctx.sessionManager.getSessionFile();
  writeLock(basePath, unitType, unitId, completedUnits.length, sessionFile);

  // On crash recovery, prepend the full recovery briefing
  // On retry (stuck detection), prepend deep diagnostic from last attempt
  let finalPrompt = prompt;
  if (pendingCrashRecovery) {
    finalPrompt = `${pendingCrashRecovery}\n\n---\n\n${finalPrompt}`;
    pendingCrashRecovery = null;
  } else if (retryCount > 0) {
    const diagnostic = getDeepDiagnostic(basePath);
    if (diagnostic) {
      finalPrompt = `**RETRY — your previous attempt did not produce the required artifact.**\n\nDiagnostic from previous attempt:\n${diagnostic}\n\nFix whatever went wrong and make sure you write the required file this time.\n\n---\n\n${finalPrompt}`;
    }
  }

  // Switch model if preferences specify one for this unit type
  const preferredModelId = resolveModelForUnit(unitType);
  if (preferredModelId) {
    // Try to find the model across all providers
    const allModels = ctx.modelRegistry.getAll();
    const model = allModels.find(m => m.id === preferredModelId);
    if (model) {
      const ok = await pi.setModel(model, { persist: false });
      if (ok) {
        ctx.ui.notify(`Model: ${preferredModelId}`, "info");
      }
    }
  }

  // Start progress-aware supervision: a soft warning, an idle watchdog, and
  // a larger hard ceiling. Productive long-running tasks may continue past the
  // soft timeout; only idle/stalled tasks pause early.
  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const softTimeoutMs = supervisor.soft_timeout_minutes * 60 * 1000;
  const idleTimeoutMs = supervisor.idle_timeout_minutes * 60 * 1000;
  const hardTimeoutMs = supervisor.hard_timeout_minutes * 60 * 1000;

  wrapupWarningHandle = setTimeout(() => {
    wrapupWarningHandle = null;
    if (!active || !currentUnit) return;
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "wrapup-warning-sent",
      wrapupWarningSent: true,
    });
    pi.sendMessage(
      {
        customType: "gsd-auto-wrapup",
        display: verbose,
        content: [
          "**TIME BUDGET WARNING — keep going only if progress is real.**",
          "This unit crossed the soft time budget.",
          "If you are making progress, continue. If not, switch to wrap-up mode now:",
          "1. rerun the minimal required verification",
          "2. write or update the required durable artifacts",
          "3. mark task or slice state on disk correctly",
          "4. leave precise resume notes if anything remains unfinished",
        ].join("\n"),
      },
      { triggerTurn: true },
    );
  }, softTimeoutMs);

  idleWatchdogHandle = setInterval(async () => {
    if (!active || !currentUnit) return;
    const runtime = readUnitRuntimeRecord(basePath, unitType, unitId);
    if (!runtime) return;
    if (Date.now() - runtime.lastProgressAt < idleTimeoutMs) return;

    // Before triggering recovery, check if the agent is actually producing
    // work on disk.  `git status --porcelain` is cheap and catches any
    // staged/unstaged/untracked changes the agent made since lastProgressAt.
    if (detectWorkingTreeActivity(basePath)) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        lastProgressAt: Date.now(),
        lastProgressKind: "filesystem-activity",
      });
      return;
    }

    if (currentUnit) {
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
    }
    saveActivityLog(ctx, basePath, unitType, unitId);

    const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "idle");
    if (recovery === "recovered") return;

    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "paused",
    });
    ctx.ui.notify(
      `Unit ${unitType} ${unitId} made no meaningful progress for ${supervisor.idle_timeout_minutes}min. Pausing auto-mode.`,
      "warning",
    );
    await pauseAuto(ctx, pi);
  }, 15000);

  unitTimeoutHandle = setTimeout(async () => {
    unitTimeoutHandle = null;
    if (!active) return;
    if (currentUnit) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        phase: "timeout",
        timeoutAt: Date.now(),
      });
      const modelId = ctx.model?.id ?? "unknown";
      snapshotUnitMetrics(ctx, currentUnit.type, currentUnit.id, currentUnit.startedAt, modelId);
    }
    saveActivityLog(ctx, basePath, unitType, unitId);

    const recovery = await recoverTimedOutUnit(ctx, pi, unitType, unitId, "hard");
    if (recovery === "recovered") return;

    ctx.ui.notify(
      `Unit ${unitType} ${unitId} exceeded ${supervisor.hard_timeout_minutes}min hard timeout. Pausing auto-mode.`,
      "warning",
    );
    await pauseAuto(ctx, pi);
  }, hardTimeoutMs);

  // Inject prompt — verify auto-mode still active (guards against race with timeout/pause)
  if (!active) return;
  pi.sendMessage(
    { customType: "gsd-auto", content: finalPrompt, display: verbose },
    { triggerTurn: true },
  );

  // For non-artifact-driven UAT types, pause auto-mode after sending the prompt.
  // The agent will write the UAT result file surfacing it for human review,
  // then on resume the result file exists and run-uat is skipped automatically.
  if (pauseAfterUatDispatch) {
    ctx.ui.notify(
      "UAT requires human execution. Auto-mode will pause after this unit writes the result file.",
      "info",
    );
    await pauseAuto(ctx, pi);
  }
}

// ─── Skill Discovery ──────────────────────────────────────────────────────────

/**
 * Build the skill discovery template variables for research prompts.
 * Returns { skillDiscoveryMode, skillDiscoveryInstructions } for template substitution.
 */
function buildSkillDiscoveryVars(): { skillDiscoveryMode: string; skillDiscoveryInstructions: string } {
  const mode = resolveSkillDiscoveryMode();

  if (mode === "off") {
    return {
      skillDiscoveryMode: "off",
      skillDiscoveryInstructions: " Skill discovery is disabled. Skip this step.",
    };
  }

  const autoInstall = mode === "auto";
  const instructions = `
   Identify the key technologies, frameworks, and services this work depends on (e.g. Stripe, Clerk, Supabase, JUCE, SwiftUI).
   For each, check if a professional agent skill already exists:
   - First check \`<available_skills>\` in your system prompt — a skill may already be installed.
   - For technologies without an installed skill, run: \`npx skills find "<technology>"\`
   - Only consider skills that are **directly relevant** to core technologies — not tangentially related.
   - Evaluate results by install count and relevance to the actual work.${autoInstall
    ? `
   - Install relevant skills: \`npx skills add <owner/repo@skill> -g -y\`
   - Record installed skills in the "Skills Discovered" section of your research output.
   - Installed skills will automatically appear in subsequent units' system prompts — no manual steps needed.`
    : `
   - Note promising skills in your research output with their install commands, but do NOT install them.
   - The user will decide which to install.`
  }`;

  return {
    skillDiscoveryMode: mode,
    skillDiscoveryInstructions: instructions,
  };
}

// ─── Inline Helpers ───────────────────────────────────────────────────────────

/**
 * Load a file and format it for inlining into a prompt.
 * Returns the content wrapped with a source path header, or a fallback
 * message if the file doesn't exist. This eliminates tool calls — the LLM
 * gets the content directly instead of "Read this file:".
 */
async function inlineFile(
  absPath: string | null, relPath: string, label: string,
): Promise<string> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) {
    return `### ${label}\nSource: \`${relPath}\`\n\n_(not found — file does not exist yet)_`;
  }
  return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

/**
 * Load a file for inlining, returning null if it doesn't exist.
 * Use when the file is optional and should be omitted entirely if absent.
 */
async function inlineFileOptional(
  absPath: string | null, relPath: string, label: string,
): Promise<string | null> {
  const content = absPath ? await loadFile(absPath) : null;
  if (!content) return null;
  return `### ${label}\nSource: \`${relPath}\`\n\n${content.trim()}`;
}

/**
 * Load and inline dependency slice summaries (full content, not just paths).
 */
async function inlineDependencySummaries(
  mid: string, sid: string, base: string,
): Promise<string> {
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return "- (no dependencies)";

  const roadmap = parseRoadmap(roadmapContent);
  const sliceEntry = roadmap.slices.find(s => s.id === sid);
  if (!sliceEntry || sliceEntry.depends.length === 0) return "- (no dependencies)";

  const sections: string[] = [];
  for (const dep of sliceEntry.depends) {
    const summaryFile = resolveSliceFile(base, mid, dep, "SUMMARY");
    const summaryContent = summaryFile ? await loadFile(summaryFile) : null;
    const relPath = relSliceFile(base, mid, dep, "SUMMARY");
    if (summaryContent) {
      sections.push(`#### ${dep} Summary\nSource: \`${relPath}\`\n\n${summaryContent.trim()}`);
    } else {
      sections.push(`- \`${relPath}\` _(not found)_`);
    }
  }
  return sections.join("\n\n");
}

/**
 * Load a well-known .gsd/ root file for optional inlining.
 * Handles the existsSync check internally.
 */
async function inlineGsdRootFile(
  base: string, filename: string, label: string,
): Promise<string | null> {
  const key = filename.replace(/\.md$/i, "").toUpperCase() as "PROJECT" | "DECISIONS" | "QUEUE" | "STATE" | "REQUIREMENTS";
  const absPath = resolveGsdRootFile(base, key);
  if (!existsSync(absPath)) return null;
  return inlineFileOptional(absPath, relGsdRootFile(key), label);
}

// ─── Prompt Builders ──────────────────────────────────────────────────────────

async function buildResearchMilestonePrompt(mid: string, midTitle: string, base: string): Promise<string> {
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");

  const inlined: string[] = [];
  inlined.push(await inlineFile(contextPath, contextRel, "Milestone Context"));
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relMilestoneFile(base, mid, "RESEARCH");
  const outputAbsPath = resolveMilestoneFile(base, mid, "RESEARCH") ?? join(base, outputRelPath);
  return loadPrompt("research-milestone", {
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    outputPath: outputRelPath,
    outputAbsPath,
    inlinedContext,
    ...buildSkillDiscoveryVars(),
  });
}

async function buildPlanMilestonePrompt(mid: string, midTitle: string, base: string): Promise<string> {
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const researchRel = relMilestoneFile(base, mid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(contextPath, contextRel, "Milestone Context"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Milestone Research");
  if (researchInline) inlined.push(researchInline);
  const priorSummaryInline = await inlinePriorMilestoneSummary(mid, base);
  if (priorSummaryInline) inlined.push(priorSummaryInline);
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relMilestoneFile(base, mid, "ROADMAP");
  const outputAbsPath = resolveMilestoneFile(base, mid, "ROADMAP") ?? join(base, outputRelPath);
  return loadPrompt("plan-milestone", {
    milestoneId: mid, milestoneTitle: midTitle,
    milestonePath: relMilestonePath(base, mid),
    contextPath: contextRel,
    researchPath: researchRel,
    outputPath: outputRelPath,
    outputAbsPath,
    inlinedContext,
  });
}

async function buildResearchSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const milestoneResearchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const milestoneResearchRel = relMilestoneFile(base, mid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);
  const researchInline = await inlineFileOptional(milestoneResearchPath, milestoneResearchRel, "Milestone Research");
  if (researchInline) inlined.push(researchInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);

  const depContent = await inlineDependencySummaries(mid, sid, base);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relSliceFile(base, mid, sid, "RESEARCH");
  const outputAbsPath = resolveSliceFile(base, mid, sid, "RESEARCH") ?? join(base, outputRelPath);
  return loadPrompt("research-slice", {
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    contextPath: contextRel,
    milestoneResearchPath: milestoneResearchRel,
    outputPath: outputRelPath,
    outputAbsPath,
    inlinedContext,
    dependencySummaries: depContent,
    ...buildSkillDiscoveryVars(),
  });
}

async function buildPlanSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const researchPath = resolveSliceFile(base, mid, sid, "RESEARCH");
  const researchRel = relSliceFile(base, mid, sid, "RESEARCH");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  const researchInline = await inlineFileOptional(researchPath, researchRel, "Slice Research");
  if (researchInline) inlined.push(researchInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);

  const depContent = await inlineDependencySummaries(mid, sid, base);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const outputRelPath = relSliceFile(base, mid, sid, "PLAN");
  const outputAbsPath = resolveSliceFile(base, mid, sid, "PLAN") ?? join(base, outputRelPath);
  const sliceAbsPath = resolveSlicePath(base, mid, sid) ?? join(base, relSlicePath(base, mid, sid));
  return loadPrompt("plan-slice", {
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    sliceAbsPath,
    roadmapPath: roadmapRel,
    researchPath: researchRel,
    outputPath: outputRelPath,
    outputAbsPath,
    inlinedContext,
    dependencySummaries: depContent,
  });
}

async function buildExecuteTaskPrompt(
  mid: string, sid: string, sTitle: string,
  tid: string, tTitle: string, base: string,
): Promise<string> {

  const priorSummaries = await getPriorTaskSummaryPaths(mid, sid, tid, base);
  const priorLines = priorSummaries.length > 0
    ? priorSummaries.map(p => `- \`${p}\``).join("\n")
    : "- (no prior tasks)";

  const taskPlanPath = resolveTaskFile(base, mid, sid, tid, "PLAN");
  const taskPlanContent = taskPlanPath ? await loadFile(taskPlanPath) : null;
  const taskPlanRelPath = relTaskFile(base, mid, sid, tid, "PLAN");
  const taskPlanInline = taskPlanContent
    ? [
      "## Inlined Task Plan (authoritative local execution contract)",
      `Source: \`${taskPlanRelPath}\``,
      "",
      taskPlanContent.trim(),
    ].join("\n")
    : [
      "## Inlined Task Plan (authoritative local execution contract)",
      `Task plan not found at dispatch time. Read \`${taskPlanRelPath}\` before executing.`,
    ].join("\n");

  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanContent = slicePlanPath ? await loadFile(slicePlanPath) : null;
  const slicePlanExcerpt = extractSliceExecutionExcerpt(slicePlanContent, relSliceFile(base, mid, sid, "PLAN"));

  // Check for continue file (new naming or legacy)
  const continueFile = resolveSliceFile(base, mid, sid, "CONTINUE");
  const legacyContinueDir = resolveSlicePath(base, mid, sid);
  const legacyContinuePath = legacyContinueDir ? join(legacyContinueDir, "continue.md") : null;
  const continueContent = continueFile ? await loadFile(continueFile) : null;
  const legacyContinueContent = !continueContent && legacyContinuePath ? await loadFile(legacyContinuePath) : null;
  const continueRelPath = relSliceFile(base, mid, sid, "CONTINUE");
  const resumeSection = buildResumeSection(
    continueContent,
    legacyContinueContent,
    continueRelPath,
    legacyContinuePath ? `${relSlicePath(base, mid, sid)}/continue.md` : null,
  );

  const carryForwardSection = await buildCarryForwardSection(priorSummaries, base);

  const sliceDirAbs = resolveSlicePath(base, mid, sid) ?? join(base, relSlicePath(base, mid, sid));
  const taskSummaryAbsPath = join(sliceDirAbs, "tasks", `${tid}-SUMMARY.md`);

  return loadPrompt("execute-task", {
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle, taskId: tid, taskTitle: tTitle,
    planPath: relSliceFile(base, mid, sid, "PLAN"),
    slicePath: relSlicePath(base, mid, sid),
    taskPlanPath: taskPlanRelPath,
    taskPlanInline,
    slicePlanExcerpt,
    carryForwardSection,
    resumeSection,
    priorTaskLines: priorLines,
    taskSummaryAbsPath,
  });
}

async function buildCompleteSlicePrompt(
  mid: string, _midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {

  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Slice Plan"));
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);

  // Inline all task summaries for this slice
  const tDir = resolveTasksDir(base, mid, sid);
  if (tDir) {
    const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
    for (const file of summaryFiles) {
      const absPath = join(tDir, file);
      const content = await loadFile(absPath);
      const sRel = relSlicePath(base, mid, sid);
      const relPath = `${sRel}/tasks/${file}`;
      if (content) {
        inlined.push(`### Task Summary: ${file.replace(/-SUMMARY\.md$/i, "")}\nSource: \`${relPath}\`\n\n${content.trim()}`);
      }
    }
  }

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const sliceDirAbs = resolveSlicePath(base, mid, sid) ?? join(base, relSlicePath(base, mid, sid));
  const sliceSummaryAbsPath = join(sliceDirAbs, `${sid}-SUMMARY.md`);
  const sliceUatAbsPath = join(sliceDirAbs, `${sid}-UAT.md`);

  return loadPrompt("complete-slice", {
    milestoneId: mid, sliceId: sid, sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    roadmapPath: roadmapRel,
    inlinedContext,
    sliceSummaryAbsPath,
    sliceUatAbsPath,
  });
}

async function buildCompleteMilestonePrompt(
  mid: string, midTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));

  // Inline all slice summaries
  const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
  if (roadmapContent) {
    const roadmap = parseRoadmap(roadmapContent);
    for (const slice of roadmap.slices) {
      const summaryPath = resolveSliceFile(base, mid, slice.id, "SUMMARY");
      const summaryRel = relSliceFile(base, mid, slice.id, "SUMMARY");
      inlined.push(await inlineFile(summaryPath, summaryRel, `${slice.id} Summary`));
    }
  }

  // Inline root GSD files
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  // Inline milestone context file (milestone-level, not GSD root)
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextInline = await inlineFileOptional(contextPath, contextRel, "Milestone Context");
  if (contextInline) inlined.push(contextInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const milestoneDirAbs = resolveMilestonePath(base, mid) ?? join(base, relMilestonePath(base, mid));
  const milestoneSummaryAbsPath = join(milestoneDirAbs, `${mid}-SUMMARY.md`);

  return loadPrompt("complete-milestone", {
    milestoneId: mid,
    milestoneTitle: midTitle,
    roadmapPath: roadmapRel,
    inlinedContext,
    milestoneSummaryAbsPath,
  });
}

// ─── Replan Slice Prompt ───────────────────────────────────────────────────────

async function buildReplanSlicePrompt(
  mid: string, midTitle: string, sid: string, sTitle: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const slicePlanPath = resolveSliceFile(base, mid, sid, "PLAN");
  const slicePlanRel = relSliceFile(base, mid, sid, "PLAN");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
  inlined.push(await inlineFile(slicePlanPath, slicePlanRel, "Current Slice Plan"));

  // Find the blocker task summary — the completed task with blocker_discovered: true
  let blockerTaskId = "";
  const tDir = resolveTasksDir(base, mid, sid);
  if (tDir) {
    const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
    for (const file of summaryFiles) {
      const absPath = join(tDir, file);
      const content = await loadFile(absPath);
      if (!content) continue;
      const summary = parseSummary(content);
      const sRel = relSlicePath(base, mid, sid);
      const relPath = `${sRel}/tasks/${file}`;
      if (summary.frontmatter.blocker_discovered) {
        blockerTaskId = summary.frontmatter.id || file.replace(/-SUMMARY\.md$/i, "");
        inlined.push(`### Blocker Task Summary: ${blockerTaskId}\nSource: \`${relPath}\`\n\n${content.trim()}`);
      }
    }
  }

  // Inline decisions
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const sliceDirAbs = resolveSlicePath(base, mid, sid) ?? join(base, relSlicePath(base, mid, sid));
  const replanAbsPath = join(sliceDirAbs, `${sid}-REPLAN.md`);

  return loadPrompt("replan-slice", {
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    slicePath: relSlicePath(base, mid, sid),
    planPath: slicePlanRel,
    blockerTaskId,
    inlinedContext,
    replanAbsPath,
  });
}

// ─── Adaptive Replanning ──────────────────────────────────────────────────────

/**
 * Check if the most recently completed slice needs reassessment.
 * Returns { sliceId } if reassessment is needed, null otherwise.
 *
 * Skips reassessment when:
 * - No roadmap exists yet
 * - No slices are completed
 * - The last completed slice already has an assessment file
 * - All slices are complete (milestone done — no point reassessing)
 */
async function checkNeedsReassessment(
  base: string, mid: string, state: GSDState,
): Promise<{ sliceId: string } | null> {
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return null;

  const roadmap = parseRoadmap(roadmapContent);
  const completedSlices = roadmap.slices.filter(s => s.done);
  const incompleteSlices = roadmap.slices.filter(s => !s.done);

  // No completed slices or all slices done — skip
  if (completedSlices.length === 0 || incompleteSlices.length === 0) return null;

  // Check the last completed slice
  const lastCompleted = completedSlices[completedSlices.length - 1];
  const assessmentFile = resolveSliceFile(base, mid, lastCompleted.id, "ASSESSMENT");
  const hasAssessment = !!(assessmentFile && await loadFile(assessmentFile));

  if (hasAssessment) return null;

  // Also need a summary to reassess against
  const summaryFile = resolveSliceFile(base, mid, lastCompleted.id, "SUMMARY");
  const hasSummary = !!(summaryFile && await loadFile(summaryFile));

  if (!hasSummary) return null;

  return { sliceId: lastCompleted.id };
}

/**
 * Check if the most recently completed slice needs a UAT run.
 * Returns { sliceId, uatType } if UAT should be dispatched, null otherwise.
 *
 * Skips when:
 * - No roadmap or no completed slices
 * - All slices are done (milestone complete path — reassessment handles it)
 * - uat_dispatch preference is not enabled
 * - No UAT file exists for the slice
 * - UAT result file already exists (idempotent — already ran)
 */
async function checkNeedsRunUat(
  base: string, mid: string, state: GSDState, prefs: GSDPreferences | undefined,
): Promise<{ sliceId: string; uatType: UatType } | null> {
  const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) return null;

  const roadmap = parseRoadmap(roadmapContent);
  const completedSlices = roadmap.slices.filter(s => s.done);
  const incompleteSlices = roadmap.slices.filter(s => !s.done);

  // No completed slices — nothing to UAT yet
  if (completedSlices.length === 0) return null;

  // All slices done — milestone complete path, skip (reassessment handles)
  if (incompleteSlices.length === 0) return null;

  // uat_dispatch must be opted in
  if (!prefs?.uat_dispatch) return null;

  // Take the last completed slice
  const lastCompleted = completedSlices[completedSlices.length - 1];
  const sid = lastCompleted.id;

  // UAT file must exist
  const uatFile = resolveSliceFile(base, mid, sid, "UAT");
  if (!uatFile) return null;
  const uatContent = await loadFile(uatFile);
  if (!uatContent) return null;

  // If UAT result already exists, skip (idempotent)
  const uatResultFile = resolveSliceFile(base, mid, sid, "UAT-RESULT");
  if (uatResultFile) {
    const hasResult = !!(await loadFile(uatResultFile));
    if (hasResult) return null;
  }

  // Classify UAT type; unknown type → treat as human-experience (human review)
  const uatType = extractUatType(uatContent) ?? "human-experience";

  return { sliceId: sid, uatType };
}

async function buildRunUatPrompt(
  mid: string, sliceId: string, uatPath: string, uatContent: string, base: string,
): Promise<string> {
  const inlined: string[] = [];
  inlined.push(await inlineFile(resolveSliceFile(base, mid, sliceId, "UAT"), uatPath, `${sliceId} UAT`));

  const summaryPath = resolveSliceFile(base, mid, sliceId, "SUMMARY");
  const summaryRel = relSliceFile(base, mid, sliceId, "SUMMARY");
  if (summaryPath) {
    const summaryInline = await inlineFileOptional(summaryPath, summaryRel, `${sliceId} Summary`);
    if (summaryInline) inlined.push(summaryInline);
  }

  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const sliceDirAbs = resolveSlicePath(base, mid, sliceId) ?? join(base, relSlicePath(base, mid, sliceId));
  const uatResultAbsPath = join(sliceDirAbs, `${sliceId}-UAT-RESULT.md`);
  const uatResultPath = relSliceFile(base, mid, sliceId, "UAT-RESULT");
  const uatType = extractUatType(uatContent) ?? "human-experience";

  return loadPrompt("run-uat", {
    milestoneId: mid,
    sliceId,
    uatPath,
    uatResultAbsPath,
    uatResultPath,
    uatType,
    inlinedContext,
  });
}

async function buildReassessRoadmapPrompt(
  mid: string, midTitle: string, completedSliceId: string, base: string,
): Promise<string> {
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const summaryPath = resolveSliceFile(base, mid, completedSliceId, "SUMMARY");
  const summaryRel = relSliceFile(base, mid, completedSliceId, "SUMMARY");

  const inlined: string[] = [];
  inlined.push(await inlineFile(roadmapPath, roadmapRel, "Current Roadmap"));
  inlined.push(await inlineFile(summaryPath, summaryRel, `${completedSliceId} Summary`));
  const projectInline = await inlineGsdRootFile(base, "project.md", "Project");
  if (projectInline) inlined.push(projectInline);
  const requirementsInline = await inlineGsdRootFile(base, "requirements.md", "Requirements");
  if (requirementsInline) inlined.push(requirementsInline);
  const decisionsInline = await inlineGsdRootFile(base, "decisions.md", "Decisions");
  if (decisionsInline) inlined.push(decisionsInline);

  const inlinedContext = `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`;

  const assessmentRel = relSliceFile(base, mid, completedSliceId, "ASSESSMENT");
  const sliceDirAbs = resolveSlicePath(base, mid, completedSliceId) ?? join(base, relSlicePath(base, mid, completedSliceId));
  const assessmentAbsPath = join(sliceDirAbs, `${completedSliceId}-ASSESSMENT.md`);

  return loadPrompt("reassess-roadmap", {
    milestoneId: mid,
    milestoneTitle: midTitle,
    completedSliceId,
    roadmapPath: roadmapRel,
    completedSliceSummaryPath: summaryRel,
    assessmentPath: assessmentRel,
    assessmentAbsPath,
    inlinedContext,
  });
}

function extractSliceExecutionExcerpt(content: string | null, relPath: string): string {
  if (!content) {
    return [
      "## Slice Plan Excerpt",
      `Slice plan not found at dispatch time. Read \`${relPath}\` before running slice-level verification.`,
    ].join("\n");
  }

  const lines = content.split("\n");
  const goalLine = lines.find(l => l.startsWith("**Goal:**"))?.trim();
  const demoLine = lines.find(l => l.startsWith("**Demo:**"))?.trim();

  const verification = extractMarkdownSection(content, "Verification");
  const observability = extractMarkdownSection(content, "Observability / Diagnostics");

  const parts = ["## Slice Plan Excerpt", `Source: \`${relPath}\``];
  if (goalLine) parts.push(goalLine);
  if (demoLine) parts.push(demoLine);
  if (verification) {
    parts.push("", "### Slice Verification", verification.trim());
  }
  if (observability) {
    parts.push("", "### Slice Observability / Diagnostics", observability.trim());
  }

  return parts.join("\n");
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const match = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  const end = nextHeading?.index ?? rest.length;
  return rest.slice(0, end).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildResumeSection(
  continueContent: string | null,
  legacyContinueContent: string | null,
  continueRelPath: string,
  legacyContinueRelPath: string | null,
): string {
  const resolvedContent = continueContent ?? legacyContinueContent;
  const resolvedRelPath = continueContent ? continueRelPath : legacyContinueRelPath;

  if (!resolvedContent || !resolvedRelPath) {
    return ["## Resume State", "- No continue file present. Start from the top of the task plan."].join("\n");
  }

  const cont = parseContinue(resolvedContent);
  const lines = [
    "## Resume State",
    `Source: \`${resolvedRelPath}\``,
    `- Status: ${cont.frontmatter.status || "in_progress"}`,
  ];

  if (cont.frontmatter.step && cont.frontmatter.totalSteps) {
    lines.push(`- Progress: step ${cont.frontmatter.step} of ${cont.frontmatter.totalSteps}`);
  }
  if (cont.completedWork) lines.push(`- Completed: ${oneLine(cont.completedWork)}`);
  if (cont.remainingWork) lines.push(`- Remaining: ${oneLine(cont.remainingWork)}`);
  if (cont.decisions) lines.push(`- Decisions: ${oneLine(cont.decisions)}`);
  if (cont.nextAction) lines.push(`- Next action: ${oneLine(cont.nextAction)}`);

  return lines.join("\n");
}

async function buildCarryForwardSection(priorSummaryPaths: string[], base: string): Promise<string> {
  if (priorSummaryPaths.length === 0) {
    return ["## Carry-Forward Context", "- No prior task summaries in this slice."].join("\n");
  }

  const items = await Promise.all(priorSummaryPaths.map(async (relPath) => {
    const absPath = join(base, relPath);
    const content = await loadFile(absPath);
    if (!content) return `- \`${relPath}\``;

    const summary = parseSummary(content);
    const provided = summary.frontmatter.provides.slice(0, 2).join("; ");
    const decisions = summary.frontmatter.key_decisions.slice(0, 2).join("; ");
    const patterns = summary.frontmatter.patterns_established.slice(0, 2).join("; ");
    const diagnostics = extractMarkdownSection(content, "Diagnostics");

    const parts = [summary.title || relPath];
    if (summary.oneLiner) parts.push(summary.oneLiner);
    if (provided) parts.push(`provides: ${provided}`);
    if (decisions) parts.push(`decisions: ${decisions}`);
    if (patterns) parts.push(`patterns: ${patterns}`);
    if (diagnostics) parts.push(`diagnostics: ${oneLine(diagnostics)}`);

    return `- \`${relPath}\` — ${parts.join(" | ")}`;
  }));

  return ["## Carry-Forward Context", ...items].join("\n");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function getPriorTaskSummaryPaths(
  mid: string, sid: string, currentTid: string, base: string,
): Promise<string[]> {
  const tDir = resolveTasksDir(base, mid, sid);
  if (!tDir) return [];

  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY");
  const currentNum = parseInt(currentTid.replace(/^T/, ""), 10);
  const sRel = relSlicePath(base, mid, sid);

  return summaryFiles
    .filter(f => {
      const num = parseInt(f.replace(/^T/, ""), 10);
      return num < currentNum;
    })
    .map(f => `${sRel}/tasks/${f}`);
}

// ─── Preconditions ────────────────────────────────────────────────────────────

/**
 * Ensure directories, branches, and other prerequisites exist before
 * dispatching a unit. The LLM should never need to mkdir or git checkout.
 */
function ensurePreconditions(
  unitType: string, unitId: string, base: string, state: GSDState,
): void {
  const parts = unitId.split("/");
  const mid = parts[0]!;

  // Always ensure milestone dir exists
  const mDir = resolveMilestonePath(base, mid);
  if (!mDir) {
    const newDir = join(milestonesDir(base), mid);
    mkdirSync(join(newDir, "slices"), { recursive: true });
  }

  // For slice-level units, ensure slice dir exists
  if (parts.length >= 2) {
    const sid = parts[1]!;

    // Re-resolve milestone path after potential creation
    const mDirResolved = resolveMilestonePath(base, mid);
    if (mDirResolved) {
      const slicesDir = join(mDirResolved, "slices");
      const sDir = resolveDir(slicesDir, sid);
      if (!sDir) {
        // Create slice dir with bare ID
        const newSliceDir = join(slicesDir, sid);
        mkdirSync(join(newSliceDir, "tasks"), { recursive: true });
      } else {
        // Ensure tasks/ subdir exists
        const tasksDir = join(slicesDir, sDir, "tasks");
        if (!existsSync(tasksDir)) {
          mkdirSync(tasksDir, { recursive: true });
        }
      }
    }
  }

  if (["research-slice", "plan-slice", "execute-task", "complete-slice", "replan-slice"].includes(unitType) && parts.length >= 2) {
    const sid = parts[1]!;
    ensureSliceBranch(base, mid, sid);
  }
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

async function emitObservabilityWarnings(
  ctx: ExtensionContext,
  unitType: string,
  unitId: string,
): Promise<void> {
  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  const tid = parts[2];

  if (!mid || !sid) return;

  let issues = [] as Awaited<ReturnType<typeof validatePlanBoundary>>;

  if (unitType === "plan-slice") {
    issues = await validatePlanBoundary(basePath, mid, sid);
  } else if (unitType === "execute-task" && tid) {
    issues = await validateExecuteBoundary(basePath, mid, sid, tid);
  } else if (unitType === "complete-slice") {
    issues = await validateCompleteBoundary(basePath, mid, sid);
  }

  if (issues.length === 0) return;

  ctx.ui.notify(
    `Observability check (${unitType}) found ${issues.length} warning${issues.length === 1 ? "" : "s"}:\n${formatValidationIssues(issues)}`,
    "warning",
  );
}

async function recoverTimedOutUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  unitType: string,
  unitId: string,
  reason: "idle" | "hard",
): Promise<"recovered" | "paused"> {
  if (!currentUnit) return "paused";

  const runtime = readUnitRuntimeRecord(basePath, unitType, unitId);
  const recoveryAttempts = runtime?.recoveryAttempts ?? 0;
  const maxRecoveryAttempts = reason === "idle" ? 2 : 1;

  if (unitType === "execute-task") {
    const status = await inspectExecuteTaskDurability(basePath, unitId);
    if (!status) return "paused";

    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      recovery: status,
    });

    const durableComplete = status.summaryExists && status.taskChecked && status.nextActionAdvanced;
    if (durableComplete) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        phase: "finalized",
        recovery: status,
      });
      ctx.ui.notify(
        `${reason === "idle" ? "Idle" : "Timeout"} recovery: ${unitType} ${unitId} already completed on disk. Continuing auto-mode.`,
        "info",
      );
      await dispatchNextUnit(ctx, pi);
      return "recovered";
    }

    if (recoveryAttempts < maxRecoveryAttempts) {
      const isEscalation = recoveryAttempts > 0;
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        phase: "recovered",
        recovery: status,
        recoveryAttempts: recoveryAttempts + 1,
        lastRecoveryReason: reason,
        lastProgressAt: Date.now(),
        progressCount: (runtime?.progressCount ?? 0) + 1,
        lastProgressKind: reason === "idle" ? "idle-recovery-retry" : "hard-recovery-retry",
      });

      const steeringLines = isEscalation
        ? [
            `**FINAL ${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — last chance before this task is skipped.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Current durability status: ${formatExecuteTaskRecoveryStatus(status)}.`,
            "You MUST finish the durable output NOW, even if incomplete.",
            "Write the task summary with whatever you have accomplished so far.",
            "Mark the task [x] in the plan. Commit your work.",
            "A partial summary is infinitely better than no summary.",
          ]
        : [
            `**${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — do not stop.**`,
            `You are still executing ${unitType} ${unitId}.`,
            `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
            `Current durability status: ${formatExecuteTaskRecoveryStatus(status)}.`,
            "Do not keep exploring.",
            "Immediately finish the required durable output for this unit.",
            "If full completion is impossible, write the partial artifact/state needed for recovery and make the blocker explicit.",
          ];

      pi.sendMessage(
        {
          customType: "gsd-auto-timeout-recovery",
          display: verbose,
          content: steeringLines.join("\n"),
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      ctx.ui.notify(
        `${reason === "idle" ? "Idle" : "Timeout"} recovery: steering ${unitType} ${unitId} to finish durable output (attempt ${recoveryAttempts + 1}/${maxRecoveryAttempts}).`,
        "warning",
      );
      return "recovered";
    }

    // Retries exhausted — write missing durable artifacts and advance.
    const diagnostic = formatExecuteTaskRecoveryStatus(status);
    const [mid, sid, tid] = unitId.split("/");
    const skipped = mid && sid && tid
      ? skipExecuteTask(basePath, mid, sid, tid, status, reason, maxRecoveryAttempts)
      : false;

    if (skipped) {
      writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
        phase: "skipped",
        recovery: status,
        recoveryAttempts: recoveryAttempts + 1,
        lastRecoveryReason: reason,
      });
      ctx.ui.notify(
        `${unitType} ${unitId} skipped after ${maxRecoveryAttempts} recovery attempts (${diagnostic}). Blocker artifacts written. Advancing pipeline.`,
        "warning",
      );
      await dispatchNextUnit(ctx, pi);
      return "recovered";
    }

    // Fallback: couldn't write skip artifacts — pause as before.
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "paused",
      recovery: status,
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery check for ${unitType} ${unitId}: ${diagnostic}`,
      "warning",
    );
    return "paused";
  }

  const expected = diagnoseExpectedArtifact(unitType, unitId, basePath) ?? "required durable artifact";

  // Check if the artifact already exists on disk — agent may have written it
  // without signaling completion.
  const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
  if (artifactPath && existsSync(artifactPath)) {
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "finalized",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery: ${unitType} ${unitId} artifact already exists on disk. Advancing.`,
      "info",
    );
    await dispatchNextUnit(ctx, pi);
    return "recovered";
  }

  if (recoveryAttempts < maxRecoveryAttempts) {
    const isEscalation = recoveryAttempts > 0;
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "recovered",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
      lastProgressAt: Date.now(),
      progressCount: (runtime?.progressCount ?? 0) + 1,
      lastProgressKind: reason === "idle" ? "idle-recovery-retry" : "hard-recovery-retry",
    });

    const steeringLines = isEscalation
      ? [
          `**FINAL ${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — last chance before skip.**`,
          `You are still executing ${unitType} ${unitId}.`,
          `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts} — next failure skips this unit.`,
          `Expected durable output: ${expected}.`,
          "You MUST write the artifact file NOW, even if incomplete.",
          "Write whatever you have — partial research, preliminary findings, best-effort analysis.",
          "A partial artifact is infinitely better than no artifact.",
          "If you are truly blocked, write the file with a BLOCKER section explaining why.",
        ]
      : [
          `**${reason === "idle" ? "IDLE" : "HARD TIMEOUT"} RECOVERY — stay in auto-mode.**`,
          `You are still executing ${unitType} ${unitId}.`,
          `Recovery attempt ${recoveryAttempts + 1} of ${maxRecoveryAttempts}.`,
          `Expected durable output: ${expected}.`,
          "Stop broad exploration.",
          "Write the required artifact now.",
          "If blocked, write the partial artifact and explicitly record the blocker instead of going silent.",
        ];

    pi.sendMessage(
      {
        customType: "gsd-auto-timeout-recovery",
        display: verbose,
        content: steeringLines.join("\n"),
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    ctx.ui.notify(
      `${reason === "idle" ? "Idle" : "Timeout"} recovery: steering ${unitType} ${unitId} to produce ${expected} (attempt ${recoveryAttempts + 1}/${maxRecoveryAttempts}).`,
      "warning",
    );
    return "recovered";
  }

  // Retries exhausted — write a blocker placeholder and advance the pipeline
  // instead of silently stalling.
  const placeholder = writeBlockerPlaceholder(
    unitType, unitId, basePath,
    `${reason} recovery exhausted ${maxRecoveryAttempts} attempts without producing the artifact.`,
  );

  if (placeholder) {
    writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
      phase: "skipped",
      recoveryAttempts: recoveryAttempts + 1,
      lastRecoveryReason: reason,
    });
    ctx.ui.notify(
      `${unitType} ${unitId} skipped after ${maxRecoveryAttempts} recovery attempts. Blocker placeholder written to ${placeholder}. Advancing pipeline.`,
      "warning",
    );
    await dispatchNextUnit(ctx, pi);
    return "recovered";
  }

  // Fallback: couldn't resolve artifact path — pause as before.
  writeUnitRuntimeRecord(basePath, unitType, unitId, currentUnit.startedAt, {
    phase: "paused",
    recoveryAttempts: recoveryAttempts + 1,
    lastRecoveryReason: reason,
  });
  return "paused";
}

/**
 * Write skip artifacts for a stuck execute-task: a blocker task summary and
 * the [x] checkbox in the slice plan. Returns true if artifacts were written.
 */
export function skipExecuteTask(
  base: string, mid: string, sid: string, tid: string,
  status: { summaryExists: boolean; taskChecked: boolean },
  reason: string, maxAttempts: number,
): boolean {
  // Write a blocker task summary if missing.
  if (!status.summaryExists) {
    const tasksDir = resolveTasksDir(base, mid, sid);
    const sDir = resolveSlicePath(base, mid, sid);
    const targetDir = tasksDir ?? (sDir ? join(sDir, "tasks") : null);
    if (!targetDir) return false;
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const summaryPath = join(targetDir, buildTaskFileName(tid, "SUMMARY"));
    const content = [
      `# BLOCKER — task skipped by auto-mode recovery`,
      ``,
      `Task \`${tid}\` in slice \`${sid}\` (milestone \`${mid}\`) failed to complete after ${reason} recovery exhausted ${maxAttempts} attempts.`,
      ``,
      `This placeholder was written by auto-mode so the pipeline can advance.`,
      `Review this task manually and replace this file with a real summary.`,
    ].join("\n");
    writeFileSync(summaryPath, content, "utf-8");
  }

  // Mark [x] in the slice plan if not already checked.
  if (!status.taskChecked) {
    const planAbs = resolveSliceFile(base, mid, sid, "PLAN");
    if (planAbs && existsSync(planAbs)) {
      const planContent = readFileSync(planAbs, "utf-8");
      const escapedTid = tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^(- \\[) \\] (\\*\\*${escapedTid}:)`, "m");
      if (re.test(planContent)) {
        writeFileSync(planAbs, planContent.replace(re, "$1x] $2"), "utf-8");
      }
    }
  }

  return true;
}

/**
 * Detect whether the agent is producing work on disk by checking git for
 * any working-tree changes (staged, unstaged, or untracked). Returns true
 * if there are uncommitted changes — meaning the agent is actively working,
 * even though it hasn't signaled progress through runtime records.
 */
function detectWorkingTreeActivity(cwd: string): boolean {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the expected artifact for a non-execute-task unit to an absolute path.
 * Returns null for unit types that don't produce a single file (execute-task,
 * complete-slice, replan-slice).
 */
export function resolveExpectedArtifactPath(unitType: string, unitId: string, base: string): string | null {
  const parts = unitId.split("/");
  const mid = parts[0]!;
  const sid = parts[1];
  switch (unitType) {
    case "research-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "RESEARCH")) : null;
    }
    case "plan-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "ROADMAP")) : null;
    }
    case "research-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "RESEARCH")) : null;
    }
    case "plan-slice": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "PLAN")) : null;
    }
    case "reassess-roadmap": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "ASSESSMENT")) : null;
    }
    case "run-uat": {
      const dir = resolveSlicePath(base, mid, sid!);
      return dir ? join(dir, buildSliceFileName(sid!, "UAT-RESULT")) : null;
    }
    case "complete-milestone": {
      const dir = resolveMilestonePath(base, mid);
      return dir ? join(dir, buildMilestoneFileName(mid, "SUMMARY")) : null;
    }
    default:
      return null;
  }
}

/**
 * Write a placeholder artifact so the pipeline can advance past a stuck unit.
 * Returns the relative path written, or null if the path couldn't be resolved.
 */
export function writeBlockerPlaceholder(unitType: string, unitId: string, base: string, reason: string): string | null {
  const absPath = resolveExpectedArtifactPath(unitType, unitId, base);
  if (!absPath) return null;
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = [
    `# BLOCKER — auto-mode recovery failed`,
    ``,
    `Unit \`${unitType}\` for \`${unitId}\` failed to produce this artifact after idle recovery exhausted all retries.`,
    ``,
    `**Reason**: ${reason}`,
    ``,
    `This placeholder was written by auto-mode so the pipeline can advance.`,
    `Review and replace this file before relying on downstream artifacts.`,
  ].join("\n");
  writeFileSync(absPath, content, "utf-8");
  return diagnoseExpectedArtifact(unitType, unitId, base);
}

function diagnoseExpectedArtifact(unitType: string, unitId: string, base: string): string | null {
  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  switch (unitType) {
    case "research-milestone":
      return `${relMilestoneFile(base, mid!, "RESEARCH")} (milestone research)`;
    case "plan-milestone":
      return `${relMilestoneFile(base, mid!, "ROADMAP")} (milestone roadmap)`;
    case "research-slice":
      return `${relSliceFile(base, mid!, sid!, "RESEARCH")} (slice research)`;
    case "plan-slice":
      return `${relSliceFile(base, mid!, sid!, "PLAN")} (slice plan)`;
    case "execute-task": {
      const tid = parts[2];
      return `Task ${tid} marked [x] in ${relSliceFile(base, mid!, sid!, "PLAN")} + summary written`;
    }
    case "complete-slice":
      return `Slice ${sid} marked [x] in ${relMilestoneFile(base, mid!, "ROADMAP")} + summary written`;
    case "replan-slice":
      return `${relSliceFile(base, mid!, sid!, "REPLAN")} + updated ${relSliceFile(base, mid!, sid!, "PLAN")}`;
    case "reassess-roadmap":
      return `${relSliceFile(base, mid!, sid!, "ASSESSMENT")} (roadmap reassessment)`;
    case "run-uat":
      return `${relSliceFile(base, mid!, sid!, "UAT-RESULT")} (UAT result)`;
    case "complete-milestone":
      return `${relMilestoneFile(base, mid!, "SUMMARY")} (milestone summary)`;
    default:
      return null;
  }
}
