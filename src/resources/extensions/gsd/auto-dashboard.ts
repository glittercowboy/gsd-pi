/**
 * Auto-mode Dashboard — progress widget rendering, elapsed time formatting,
 * unit description helpers, and slice progress caching.
 *
 * Pure functions that accept specific parameters — no module-level globals
 * or AutoContext dependency. State accessors are passed as callbacks.
 */

import type {
  ExtensionContext,
  ExtensionCommandContext,
  SessionMessageEntry,
  ReadonlyFooterDataProvider,
  Theme,
} from "@gsd/pi-coding-agent";
import type { GSDState } from "./types.js";
import { getCurrentBranch } from "./worktree.js";
import { getActiveHook } from "./post-unit-hooks.js";
import { getLedger, getProjectTotals } from "./metrics.js";
import { getErrorMessage } from "./error-utils.js";
import { nativeIsRepo } from "./native-git-bridge.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
} from "./paths.js";
import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { makeUI } from "../shared/tui.js";
import { GLYPH, INDENT } from "../shared/mod.js";
import { computeProgressScore } from "./progress-score.js";
import { getActiveWorktreeName } from "./worktree-command.js";
import {
  getGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  parsePreferencesMarkdown,
} from "./preferences.js";
import { resolveServiceTierIcon, getEffectiveServiceTier } from "./service-tier.js";
import { parseUnitId } from "./unit-id.js";
import {
  formatRtkSavingsLabel,
  getRtkSessionSavings,
  type RtkSessionSavings,
} from "../shared/rtk-session-stats.js";
import { logWarning } from "./workflow-logger.js";
import { formattedShortcutPair } from "./shortcut-defs.js";

// ─── UAT Slice Extraction ─────────────────────────────────────────────────────

/**
 * Extract the target slice ID from a run-uat unit ID (e.g. "M001/S01" → "S01").
 * Returns null if the format doesn't match.
 */
export function extractUatSliceId(unitId: string): string | null {
  const { slice } = parseUnitId(unitId);
  if (slice?.startsWith("S")) return slice;
  return null;
}

// ─── Dashboard Data ───────────────────────────────────────────────────────────

/** Dashboard data for the overlay */
export interface AutoDashboardData {
  active: boolean;
  paused: boolean;
  stepMode: boolean;
  startTime: number;
  elapsed: number;
  currentUnit: { type: string; id: string; startedAt: number } | null;
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
  /** RTK token savings for the current session, or null when unavailable. */
  rtkSavings?: RtkSessionSavings | null;
  /** Whether RTK is enabled via experimental.rtk preference. False when not opted in. */
  rtkEnabled?: boolean;
  /** Cross-process: another auto-mode session detected via auto.lock (PID, startedAt) */
  remoteSession?: { pid: number; startedAt: string; unitType: string; unitId: string };
}

// ─── Unit Description Helpers ─────────────────────────────────────────────────

export function unitVerb(unitType: string): string {
  if (unitType.startsWith("hook/")) return `hook: ${unitType.slice(5)}`;
  switch (unitType) {
    case "discuss-milestone":
    case "discuss-slice": return "discussing";
    case "research-milestone":
    case "research-slice": return "researching";
    case "plan-milestone":
    case "plan-slice": return "planning";
    case "refine-slice": return "refining";
    case "execute-task": return "executing";
    case "complete-slice": return "completing";
    case "replan-slice": return "replanning";
    case "rewrite-docs": return "rewriting";
    case "reassess-roadmap": return "reassessing";
    case "run-uat": return "running UAT";
    case "custom-step": return "executing workflow step";
    default: return unitType;
  }
}

export function unitPhaseLabel(unitType: string): string {
  if (unitType.startsWith("hook/")) return "HOOK";
  switch (unitType) {
    case "discuss-milestone":
    case "discuss-slice": return "DISCUSS";
    case "research-milestone": return "RESEARCH";
    case "research-slice": return "RESEARCH";
    case "plan-milestone": return "PLAN";
    case "plan-slice": return "PLAN";
    case "refine-slice": return "REFINE";
    case "execute-task": return "EXECUTE";
    case "complete-slice": return "COMPLETE";
    case "replan-slice": return "REPLAN";
    case "rewrite-docs": return "REWRITE";
    case "reassess-roadmap": return "REASSESS";
    case "run-uat": return "UAT";
    case "custom-step": return "WORKFLOW";
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
    case "discuss-milestone": return "research or plan milestone";
    case "discuss-slice": return "plan slice";
    case "research-milestone": return "plan milestone roadmap";
    case "plan-milestone": return "plan or execute first slice";
    case "research-slice": return `plan ${sid}`;
    case "plan-slice": return "execute first task";
    case "refine-slice": return "execute first task";
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
    case "evaluating-gates":
      return { label: `Evaluate gates for ${sid}: ${sTitle}`, description: "Parallel quality gate assessment before execution." };
    default:
      return { label: "Continue", description: "Execute the next step." };
  }
}

// ─── Elapsed Time Formatting ──────────────────────────────────────────────────

/** Format elapsed time since auto-mode started */
export function formatAutoElapsed(autoStartTime: number): string {
  if (!autoStartTime || autoStartTime <= 0 || !Number.isFinite(autoStartTime)) return "";
  const ms = Date.now() - autoStartTime;
  if (ms < 0 || ms > 30 * 24 * 3600_000) return ""; // negative or >30 days = invalid
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
    // Normalize slices: prefer DB, fall back to parser
    type NormSlice = { id: string; done: boolean; title: string };
    let normSlices: NormSlice[];
    if (isDbAvailable()) {
      normSlices = getMilestoneSlices(mid).map(s => ({ id: s.id, done: s.status === "complete", title: s.title }));
    } else {
      normSlices = [];
    }

    let activeSliceTasks: { done: number; total: number } | null = null;
    let taskDetails: CachedTaskDetail[] | null = null;
    if (activeSid) {
      try {
        if (isDbAvailable()) {
          const dbTasks = getSliceTasks(mid, activeSid);
          if (dbTasks.length > 0) {
            activeSliceTasks = {
              done: dbTasks.filter(t => t.status === "complete" || t.status === "done").length,
              total: dbTasks.length,
            };
            taskDetails = dbTasks.map(t => ({ id: t.id, title: t.title, done: t.status === "complete" || t.status === "done" }));
          }
        }
      } catch (err) {
        // Non-fatal — just omit task count
        logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    cachedSliceProgress = {
      done: normSlices.filter(s => s.done).length,
      total: normSlices.length,
      milestoneId: mid,
      activeSliceTasks,
      taskDetails,
    };
  } catch (err) {
    // Non-fatal — widget just won't show progress bar
    logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function getRoadmapSlicesSync(): { done: number; total: number; activeSliceTasks: { done: number; total: number } | null; taskDetails: CachedTaskDetail[] | null } | null {
  return cachedSliceProgress;
}

export function clearSliceProgressCache(): void {
  cachedSliceProgress = null;
}

// ─── Last Commit Cache ────────────────────────────────────────────────────────

/** Cached last commit info — refreshed on the 15s timer, not every render */
let cachedLastCommit: { timeAgo: string; message: string } | null = null;
let lastCommitFetchedAt = 0;

function refreshLastCommit(basePath: string): void {
  try {
    if (!nativeIsRepo(basePath)) {
      cachedLastCommit = null;
      return;
    }
    const raw = execFileSync("git", ["log", "-1", "--format=%cr|%s"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    const sep = raw.indexOf("|");
    if (sep > 0) {
      cachedLastCommit = {
        timeAgo: raw.slice(0, sep).replace(/ ago$/, ""),
        message: raw.slice(sep + 1),
      };
    }
  } catch (err) {
    // Non-fatal — just skip last commit display
    cachedLastCommit = null;
    logWarning("dashboard", `operation failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lastCommitFetchedAt = Date.now();
  }
}

function getLastCommit(basePath: string): { timeAgo: string; message: string } | null {
  // Refresh at most every 15 seconds
  if (Date.now() - lastCommitFetchedAt > 15_000) {
    refreshLastCommit(basePath);
  }
  return cachedLastCommit;
}

export function _resetLastCommitCacheForTests(): void {
  cachedLastCommit = null;
  lastCommitFetchedAt = 0;
}

export function _refreshLastCommitForTests(basePath: string): void {
  refreshLastCommit(basePath);
}

export function _getLastCommitForTests(basePath: string): { timeAgo: string; message: string } | null {
  return getLastCommit(basePath);
}

export function _getLastCommitFetchedAtForTests(): number {
  return lastCommitFetchedAt;
}

// ─── Footer Factory ───────────────────────────────────────────────────────────

/**
 * Footer factory used by auto-mode.
 * Keep footer minimal but preserve extension status context from setStatus().
 */
function sanitizeFooterStatus(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const hideFooter = (_tui: unknown, theme: Theme, footerData: ReadonlyFooterDataProvider) => ({
  render(width: number): string[] {
    const extensionStatuses = footerData.getExtensionStatuses();
    if (extensionStatuses.size === 0) return [];
    const statusLine = Array.from(extensionStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeFooterStatus(text))
      .join(" ");
    return [truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "..."))];
  },
  invalidate() {},
  dispose() {},
});

// ─── Widget Display Mode ──────────────────────────────────────────────────────

/** Widget display modes: full → small → min → off → full */
export type WidgetMode = "full" | "small" | "min" | "off";
const WIDGET_MODES: WidgetMode[] = ["full", "small", "min", "off"];
let widgetMode: WidgetMode = "full";
let widgetModeInitialized = false;
let widgetModePreferencePath: string | null = null;

function safeReadTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function readWidgetModeFromFile(path: string): WidgetMode | undefined {
  const raw = safeReadTextFile(path);
  if (!raw) return undefined;
  const prefs = parsePreferencesMarkdown(raw);
  const saved = prefs?.widget_mode;
  if (saved && WIDGET_MODES.includes(saved as WidgetMode)) {
    return saved as WidgetMode;
  }
  return undefined;
}

function resolveWidgetModePreferencePath(
  projectPath = getProjectGSDPreferencesPath(),
  globalPath = getGlobalGSDPreferencesPath(),
): string {
  if (readWidgetModeFromFile(projectPath)) {
    return projectPath;
  }

  if (readWidgetModeFromFile(globalPath)) {
    return globalPath;
  }

  if (safeReadTextFile(projectPath) !== null) return projectPath;
  if (safeReadTextFile(globalPath) !== null) return globalPath;
  return getGlobalGSDPreferencesPath();
}

/** Load widget mode from preferences (once). */
function ensureWidgetModeLoaded(projectPath?: string, globalPath?: string): void {
  if (widgetModeInitialized) return;
  widgetModeInitialized = true;
  try {
    const resolvedProjectPath = projectPath ?? getProjectGSDPreferencesPath();
    const resolvedGlobalPath = globalPath ?? getGlobalGSDPreferencesPath();
    const saved = readWidgetModeFromFile(resolvedProjectPath) ?? readWidgetModeFromFile(resolvedGlobalPath);
    if (saved && WIDGET_MODES.includes(saved as WidgetMode)) {
      widgetMode = saved as WidgetMode;
    }
    widgetModePreferencePath = resolveWidgetModePreferencePath(resolvedProjectPath, resolvedGlobalPath);
  } catch (err) { /* non-fatal — use default */
    logWarning("dashboard", `operation failed: ${getErrorMessage(err)}`);
    widgetModePreferencePath = getGlobalGSDPreferencesPath();
  }
}

/**
 * Persist widget mode to the preference file that owns the effective value.
 * Project-scoped widget_mode wins over global; if neither scope defines it,
 * we prefer an existing project preferences file and otherwise fall back to
 * the global preferences file.
 */
function persistWidgetMode(
  mode: WidgetMode,
  prefsPath = widgetModePreferencePath ?? resolveWidgetModePreferencePath(),
): void {
  try {
    let content = "";
    if (existsSync(prefsPath)) {
      content = readFileSync(prefsPath, "utf-8");
    }
    const line = `widget_mode: ${mode}`;
    const re = /^widget_mode:\s*\S+/m;
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content = content.trimEnd() + "\n" + line + "\n";
    }
    writeFileSync(prefsPath, content, "utf-8");
  } catch (err) { /* non-fatal — mode still set in memory */
    logWarning("dashboard", `file write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Cycle to the next widget mode. Returns the new mode. */
export function cycleWidgetMode(projectPath?: string, globalPath?: string): WidgetMode {
  ensureWidgetModeLoaded(projectPath, globalPath);
  const idx = WIDGET_MODES.indexOf(widgetMode);
  widgetMode = WIDGET_MODES[(idx + 1) % WIDGET_MODES.length];
  persistWidgetMode(widgetMode, widgetModePreferencePath ?? resolveWidgetModePreferencePath(projectPath, globalPath));
  return widgetMode;
}

/** Set widget mode directly. */
export function setWidgetMode(mode: WidgetMode, projectPath?: string, globalPath?: string): void {
  ensureWidgetModeLoaded(projectPath, globalPath);
  widgetMode = mode;
  persistWidgetMode(widgetMode, widgetModePreferencePath ?? resolveWidgetModePreferencePath(projectPath, globalPath));
}

/** Get current widget mode. */
export function getWidgetMode(projectPath?: string, globalPath?: string): WidgetMode {
  ensureWidgetModeLoaded(projectPath, globalPath);
  return widgetMode;
}

/** Test-only reset for widget mode caching. */
export function _resetWidgetModeForTests(): void {
  widgetMode = "full";
  widgetModeInitialized = false;
  widgetModePreferencePath = null;
}

// ─── Progress Widget ──────────────────────────────────────────────────────────

/** State accessors passed to updateProgressWidget to avoid direct global access */
export interface WidgetStateAccessors {
  getAutoStartTime(): number;
  isStepMode(): boolean;
  getCmdCtx(): ExtensionCommandContext | null;
  getBasePath(): string;
  isVerbose(): boolean;
  /** True while newSession() is in-flight — render must not access session state. */
  isSessionSwitching(): boolean;
  /** Fully-qualified dispatched model ID (provider/id) set after model selection + hook overrides (#2899). */
  getCurrentDispatchedModelId(): string | null;
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
  const isHook = unitType.startsWith("hook/");

  // When run-uat is executing for a just-completed slice (e.g. S01),
  // deriveState() has already advanced activeSlice to the next one (S02).
  // Override the displayed slice to match the UAT target from the unit ID.
  const uatTargetSliceId = unitType === "run-uat" ? extractUatSliceId(unitId) : null;
  const slice = uatTargetSliceId
    ? { id: uatTargetSliceId, title: state.activeSlice?.title ?? "" }
    : state.activeSlice;
  const task = state.activeTask;

  // Cache git branch at widget creation time (not per render)
  let cachedBranch: string | null = null;
  try { cachedBranch = getCurrentBranch(accessors.getBasePath()); } catch (err) { /* not in git repo */
    logWarning("dashboard", `git branch detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Cache short pwd (last 2 path segments only) + worktree/branch info
  let widgetPwd: string;
  {
    let fullPwd = process.cwd();
    const widgetHome = process.env.HOME || process.env.USERPROFILE;
    if (widgetHome && fullPwd.startsWith(widgetHome)) {
      fullPwd = `~${fullPwd.slice(widgetHome.length)}`;
    }
    const parts = fullPwd.split("/");
    widgetPwd = parts.length > 2 ? parts.slice(-2).join("/") : fullPwd;
  }
  const worktreeName = getActiveWorktreeName();
  if (worktreeName && cachedBranch) {
    widgetPwd = `${widgetPwd} (\u2387 ${cachedBranch})`;
  } else if (cachedBranch) {
    widgetPwd = `${widgetPwd} (${cachedBranch})`;
  }

  // Pre-fetch last commit for display
  refreshLastCommit(accessors.getBasePath());

  // Cache the effective service tier at widget creation time (reads preferences)
  const effectiveServiceTier = getEffectiveServiceTier();

  ctx.ui.setWidget("gsd-progress", (tui, theme) => {
    let pulseBright = true;
    let cachedLines: string[] | undefined;
    let cachedWidth: number | undefined;
    let cachedRtkLabel: string | null | undefined;

    const refreshRtkLabel = (): void => {
      try {
        const sessionId = ctx.sessionManager.getSessionId();
        const savings = sessionId ? getRtkSessionSavings(accessors.getBasePath(), sessionId) : null;
        cachedRtkLabel = formatRtkSavingsLabel(savings);
      } catch (err) {
        logWarning("dashboard", `RTK savings lookup failed: ${err instanceof Error ? (err as Error).message : String(err)}`);
        cachedRtkLabel = null;
      }
    };

    refreshRtkLabel();

    const pulseTimer = setInterval(() => {
      pulseBright = !pulseBright;
      cachedLines = undefined;
      tui.requestRender();
    }, 800);

    // Refresh progress cache from disk every 15s so the widget reflects
    // task/slice completion mid-unit. Without this, the progress bar only
    // updates at dispatch time, appearing frozen during long-running units.
    // 15s (vs 5s) reduces synchronous file I/O on the hot path.
    const progressRefreshTimer = setInterval(() => {
      try {
        if (mid) {
          updateSliceProgressCache(accessors.getBasePath(), mid.id, slice?.id);
        }
        refreshRtkLabel();
        cachedLines = undefined;
      } catch (err) { /* non-fatal */
        logWarning("dashboard", `DB status update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 15_000);

    return {
      render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;

        // While newSession() is in-flight, session state is mid-mutation.
        // Accessing cmdCtx.sessionManager or cmdCtx.getContextUsage() can
        // block the render loop and freeze the TUI. Return the last cached
        // frame (or an empty frame on first render) until the switch settles.
        if (accessors.isSessionSwitching()) {
          return cachedLines ?? [];
        }

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

        // Health indicator in header
        const score = computeProgressScore();
        const healthColor = score.level === "green" ? "success"
          : score.level === "yellow" ? "warning"
            : "error";
        const healthIcon = score.level === "green" ? GLYPH.statusActive
          : score.level === "yellow" ? "!"
            : "x";
        const healthStr = `  ${theme.fg(healthColor, healthIcon)} ${theme.fg(healthColor, score.summary)}`;

        const headerLeft = `${pad}${dot} ${theme.fg("accent", theme.bold("GSD"))}  ${theme.fg("success", modeTag)}${healthStr}`;

        // ETA in header right, after elapsed
        const eta = estimateTimeRemaining();
        const etaShort = eta ? eta.replace(" remaining", " left") : null;
        const headerRight = elapsed
          ? (etaShort
            ? `${theme.fg("dim", elapsed)} ${theme.fg("dim", "·")} ${theme.fg("dim", etaShort)}`
            : theme.fg("dim", elapsed))
          : "";
        lines.push(rightAlign(headerLeft, headerRight, width));

        // Show health signal details when degraded (yellow/red)
        if (score.level !== "green" && score.signals.length > 0 && widgetMode !== "min") {
          // Show up to 3 most relevant signals in compact form
          const topSignals = score.signals
            .filter(s => s.kind === "negative")
            .slice(0, 3);
          if (topSignals.length > 0) {
            const signalStr = topSignals
              .map(s => theme.fg("dim", s.label))
              .join(theme.fg("dim", " · "));
            lines.push(`${pad}  ${signalStr}`);
          }
        }

        // ── Gather stats (needed by multiple modes) ─────────────────────
        const cmdCtx = accessors.getCmdCtx();
        let totalInput = 0;
        let totalCacheRead = 0;
        if (cmdCtx) {
          for (const entry of cmdCtx.sessionManager.getEntries()) {
            if (entry.type === "message") {
              const msgEntry = entry as SessionMessageEntry;
              if (msgEntry.message?.role === "assistant") {
                const u = (msgEntry.message as any).usage;
                if (u) {
                  totalInput += u.input || 0;
                  totalCacheRead += u.cacheRead || 0;
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

        // Model display — prefer dispatched model ID (set after selectAndApplyModel
        // + hook overrides) over cmdCtx?.model which can be stale (#2899).
        const dispatchedModelId = accessors.getCurrentDispatchedModelId();
        const modelId = dispatchedModelId
          ? dispatchedModelId.split("/").slice(1).join("/") || dispatchedModelId
          : (cmdCtx?.model?.id ?? "");
        const modelProvider = dispatchedModelId
          ? dispatchedModelId.split("/")[0] || ""
          : (cmdCtx?.model?.provider ?? "");
        const tierIcon = resolveServiceTierIcon(effectiveServiceTier, modelId);
        const modelDisplay = (modelProvider && modelId
          ? `${modelProvider}/${modelId}`
          : modelId) + (tierIcon ? ` ${tierIcon}` : "");

        // ── Mode: off — return empty ──────────────────────────────────
        if (widgetMode === "off") {
          cachedLines = [];
          cachedWidth = width;
          return [];
        }

        // ── Mode: min — header line only ──────────────────────────────
        if (widgetMode === "min") {
          lines.push(...ui.bar());
          cachedLines = lines;
          cachedWidth = width;
          return lines;
        }

        // ── Mode: small — header + progress bar + compact stats ───────
        if (widgetMode === "small") {
          lines.push("");

          // Action line
          const target = task ? `${task.id}: ${task.title}` : unitId;
          const actionLeft = `${pad}${theme.fg("accent", "▸")} ${theme.fg("accent", verb)}  ${theme.fg("text", target)}`;
          lines.push(rightAlign(actionLeft, theme.fg("dim", phaseLabel), width));

          // Progress bar
          const roadmapSlices = mid ? getRoadmapSlicesSync() : null;
          if (roadmapSlices) {
            const { done, total, activeSliceTasks } = roadmapSlices;
            const barWidth = Math.max(6, Math.min(18, Math.floor(width * 0.25)));
            const pct = total > 0 ? done / total : 0;
            const filled = Math.round(pct * barWidth);
            const bar = theme.fg("success", "━".repeat(filled))
              + theme.fg("dim", "─".repeat(barWidth - filled));
            let meta = `${theme.fg("text", `${done}`)}${theme.fg("dim", `/${total} slices`)}`;
            if (activeSliceTasks && activeSliceTasks.total > 0) {
              const tn = Math.min(activeSliceTasks.done + 1, activeSliceTasks.total);
              meta += `${theme.fg("dim", " · task ")}${theme.fg("accent", `${tn}`)}${theme.fg("dim", `/${activeSliceTasks.total}`)}`;
            }
            lines.push(`${pad}${bar} ${meta}`);
          }

          // Compact stats: cost + context only
          const smallStats: string[] = [];
          if (cumulativeCost) smallStats.push(theme.fg("warning", `$${cumulativeCost.toFixed(2)}`));
          const cxDisplay = `${cxPct}%ctx`;
          if (cxPctVal > 90) smallStats.push(theme.fg("error", cxDisplay));
          else if (cxPctVal > 70) smallStats.push(theme.fg("warning", cxDisplay));
          else smallStats.push(theme.fg("dim", cxDisplay));
          if (smallStats.length > 0) {
            lines.push(rightAlign("", smallStats.join(theme.fg("dim", "  ")), width));
          }

          lines.push(...ui.bar());
          cachedLines = lines;
          cachedWidth = width;
          return lines;
        }

        // ── Mode: full — complete two-column layout ───────────────────
        lines.push("");

        // Context section: milestone + slice + model
        const hasContext = !!(mid || (slice && unitType !== "research-milestone" && unitType !== "plan-milestone"));
        if (mid) {
          const modelTag = modelDisplay ? theme.fg("muted", `  ${modelDisplay}`) : "";
          lines.push(truncateToWidth(`${pad}${theme.fg("dim", mid.title)}${modelTag}`, width, "…"));
        }
        if (slice && unitType !== "research-milestone" && unitType !== "plan-milestone") {
          lines.push(truncateToWidth(
            `${pad}${theme.fg("text", theme.bold(`${slice.id}: ${slice.title}`))}`,
            width, "…",
          ));
        }
        if (hasContext) lines.push("");

        const target = task ? `${task.id}: ${task.title}` : unitId;
        const actionLeft = `${pad}${theme.fg("accent", "▸")} ${theme.fg("accent", verb)}  ${theme.fg("text", target)}`;
        const tierTag = tierBadge ? theme.fg("dim", `[${tierBadge}] `) : "";
        const phaseBadge = `${tierTag}${theme.fg("dim", phaseLabel)}`;
        lines.push(rightAlign(actionLeft, phaseBadge, width));

        lines.push("");

        // Two-column body
        const minTwoColWidth = 76;
        const roadmapSlices = mid ? getRoadmapSlicesSync() : null;
        const taskDetailsCol = roadmapSlices?.taskDetails ?? null;
        const useTwoCol = width >= minTwoColWidth && taskDetailsCol !== null && taskDetailsCol.length > 0;
        const leftColWidth = useTwoCol
          ? Math.floor(width * (width >= 100 ? 0.45 : 0.50))
          : width;

        const leftLines: string[] = [];

        if (roadmapSlices) {
          const { done, total, activeSliceTasks } = roadmapSlices;
          const barWidth = Math.max(6, Math.min(18, Math.floor(leftColWidth * 0.4)));
          const pct = total > 0 ? done / total : 0;
          const filled = Math.round(pct * barWidth);
          const bar = theme.fg("success", "━".repeat(filled))
            + theme.fg("dim", "─".repeat(barWidth - filled));

          let meta = `${theme.fg("text", `${done}`)}${theme.fg("dim", `/${total} slices`)}`;
          if (activeSliceTasks && activeSliceTasks.total > 0) {
            const taskNum = isHook
              ? Math.max(activeSliceTasks.done, 1)
              : Math.min(activeSliceTasks.done + 1, activeSliceTasks.total);
            meta += `${theme.fg("dim", " · task ")}${theme.fg("accent", `${taskNum}`)}${theme.fg("dim", `/${activeSliceTasks.total}`)}`;
          }
          leftLines.push(`${pad}${bar} ${meta}`);
        }

        // Build right column: task checklist
        const rightLines: string[] = [];
        const maxVisibleTasks = 8;

        // Max visible chars for task title text (before ANSI theming)
        const maxTaskTitleLen = 45;
        function truncTitle(s: string): string {
          return s.length > maxTaskTitleLen ? s.slice(0, maxTaskTitleLen - 1) + "…" : s;
        }

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
          const short = truncTitle(t.title);
          const title = isCurrent
            ? theme.fg("text", short)
            : t.done
              ? theme.fg("muted", short)
              : theme.fg("text", short);
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
          for (const t of taskDetailsCol.slice(0, maxVisibleTasks)) {
            leftLines.push(`${pad}${formatTaskLine(t, !!(task && t.id === task.id))}`);
          }
        }

        // Compose columns
        if (useTwoCol) {
          const maxRows = Math.max(leftLines.length, rightLines.length);
          if (maxRows > 0) {
            lines.push("");
            for (let i = 0; i < maxRows; i++) {
              const left = padToWidth(truncateToWidth(leftLines[i] ?? "", leftColWidth, "…"), leftColWidth);
              const right = rightLines[i] ?? "";
              lines.push(`${left}${right}`);
            }
          }
        } else {
          if (leftLines.length > 0) {
            lines.push("");
            for (const l of leftLines) lines.push(truncateToWidth(l, width, "…"));
          }
        }

        // ── Footer: simplified stats + pwd + last commit + hints ────────
        lines.push("");
        {
          const sp: string[] = [];
          if (totalCacheRead + totalInput > 0) {
            const hitRate = Math.round((totalCacheRead / (totalCacheRead + totalInput)) * 100);
            const hitColor = hitRate >= 70 ? "success" : hitRate >= 40 ? "warning" : "error";
            sp.push(theme.fg(hitColor, `${hitRate}%hit`));
          }
          if (cumulativeCost) sp.push(theme.fg("warning", `$${cumulativeCost.toFixed(2)}`));

          const CX_BAR_WIDTH = 8;
          const cxBarFilled = Math.min(
            CX_BAR_WIDTH,
            Math.max(0, Math.round((cxPctVal / 100) * CX_BAR_WIDTH)),
          );
          const cxBarColor: "error" | "warning" | "success" =
            cxPctVal > 90 ? "error" : cxPctVal > 70 ? "warning" : "success";
          const cxBar =
            theme.fg(cxBarColor, "━".repeat(cxBarFilled)) +
            theme.fg("dim", "─".repeat(CX_BAR_WIDTH - cxBarFilled));
          const cxPctText = `${cxPct}%/${formatWidgetTokens(cxWindow)}`;
          const cxColorized =
            cxPctVal > 90
              ? theme.fg("error", cxPctText)
              : cxPctVal > 70
                ? theme.fg("warning", cxPctText)
                : cxPctText;
          sp.push(`${cxBar} ${cxColorized}`);

          const statsLine = sp.map(p => p.includes("\x1b[") ? p : theme.fg("dim", p))
            .join(theme.fg("dim", "  "));
          if (statsLine) {
            lines.push(rightAlign("", statsLine, width));
          }
          if (cachedRtkLabel) {
            lines.push(rightAlign("", theme.fg("dim", cachedRtkLabel), width));
          }
        }
        // Last commit info
        const lastCommit = getLastCommit(accessors.getBasePath());
        const maxCommitLen = 65;
        const commitMsg = lastCommit
          ? lastCommit.message.length > maxCommitLen
            ? lastCommit.message.slice(0, maxCommitLen - 1) + "…"
            : lastCommit.message
          : "";
        // Hints line
        const hintParts: string[] = [];
        hintParts.push("esc pause");
        hintParts.push(`${formattedShortcutPair("dashboard")} dashboard`);
        hintParts.push(`${formattedShortcutPair("parallel")} parallel`);
        const hintStr = theme.fg("dim", hintParts.join(" | "));
        const commitStr = lastCommit
          ? theme.fg("dim", `${lastCommit.timeAgo} ago: ${commitMsg}`)
          : "";
        const locationStr = theme.fg("dim", widgetPwd);
        if (commitStr) {
          lines.push(rightAlign(`${pad}${locationStr} · ${commitStr}`, hintStr, width));
        } else {
          lines.push(rightAlign(`${pad}${locationStr}`, hintStr, width));
        }

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
  return truncateToWidth(left + " ".repeat(gap) + right, width, "…");
}

/** Pad a string with trailing spaces to fill exactly `colWidth` (ANSI-aware). */
function padToWidth(s: string, colWidth: number): string {
  const vis = visibleWidth(s);
  if (vis >= colWidth) return truncateToWidth(s, colWidth, "…");
  return s + " ".repeat(colWidth - vis);
}
