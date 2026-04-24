/**
 * GSD Forensics — Post-mortem investigation of auto-mode failures
 *
 * Programmatically scans activity logs, metrics, crash locks, and doctor
 * diagnostics for anomalies, then hands a structured report to the LLM
 * for interactive investigation.
 *
 * Entry point: handleForensics() called from commands.ts
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { extractTrace, type ExecutionTrace } from "./session-forensics.js";
import { nativeParseJsonlTail } from "./native-parser-bridge.js";
import { MAX_JSONL_BYTES, parseJSONL } from "./jsonl-utils.js";
import {
  loadLedgerFromDisk, getAverageCostPerUnitType, getProjectTotals,
  formatCost, formatTokenCount, type UnitMetrics, type MetricsLedger,
} from "./metrics.js";
import { readCrashLock, isLockProcessAlive, formatCrashInfo, type LockData } from "./crash-recovery.js";
import { runGSDDoctor, formatDoctorIssuesForPrompt, type DoctorIssue } from "./doctor.js";
import { verifyExpectedArtifact } from "./auto-recovery.js";
import { deriveState } from "./state.js";
import { isAutoActive } from "./auto.js";
import { loadPrompt } from "./prompt-loader.js";
import { gsdRoot } from "./paths.js";
import { isDbAvailable, getAllMilestones, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { formatDuration } from "../shared/format-utils.js";
import { getAutoWorktreePath } from "./auto-worktree.js";
import { loadEffectiveGSDPreferences, loadGlobalGSDPreferences, getGlobalGSDPreferencesPath } from "./preferences.js";
import { showNextAction } from "../shared/tui.js";
import { ensurePreferencesFile, serializePreferencesToFrontmatter } from "./commands-prefs-wizard.js";
import { summarizeWorktreeTelemetry, percentile, type WorktreeTelemetrySummary } from "./worktree-telemetry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ForensicAnomaly {
  type: "stuck-loop" | "cost-spike" | "timeout" | "missing-artifact" | "crash" | "doctor-issue" | "error-trace" | "journal-stuck" | "journal-guard-block" | "journal-rapid-iterations" | "journal-worktree-failure" | "worktree-orphan" | "worktree-unmerged-exit";
  severity: "info" | "warning" | "error";
  unitType?: string;
  unitId?: string;
  summary: string;
  details: string;
}

interface UnitTrace {
  file: string;
  unitType: string;
  unitId: string;
  seq: number;
  trace: ExecutionTrace;
  mtime: number;
}

/** Summary of .gsd/activity/ directory metadata. */
interface ActivityLogMeta {
  fileCount: number;
  totalSizeBytes: number;
  oldestFile: string | null;
  newestFile: string | null;
}

/**
 * Summary of .gsd/journal/ data for forensic investigation.
 *
 * To avoid loading huge journal histories into memory, only the most recent
 * daily files are fully parsed. Older files are line-counted for totals.
 * Event counts and flow IDs reflect only recent files.
 */
interface JournalSummary {
  /** Total journal entries across all files (recent parsed + older line-counted) */
  totalEntries: number;
  /** Distinct flow IDs from recent files (each = one auto-mode iteration) */
  flowCount: number;
  /** Event counts by type (from recent files only) */
  eventCounts: Record<string, number>;
  /** Most recent journal entries (last 20) for context */
  recentEvents: { ts: string; flowId: string; eventType: string; rule?: string; unitId?: string }[];
  /** Date range of journal data */
  oldestEntry: string | null;
  newestEntry: string | null;
  /** Daily file count */
  fileCount: number;
}

interface DbCompletionCounts {
  milestones: number;
  milestonesTotal: number;
  slices: number;
  slicesTotal: number;
  tasks: number;
  tasksTotal: number;
}

interface ForensicReport {
  gsdVersion: string;
  timestamp: string;
  basePath: string;
  activeMilestone: string | null;
  activeSlice: string | null;
  activeWorktree: string | null;
  unitTraces: UnitTrace[];
  metrics: MetricsLedger | null;
  completedKeys: string[];
  dbCompletionCounts: DbCompletionCounts | null;
  crashLock: LockData | null;
  doctorIssues: DoctorIssue[];
  anomalies: ForensicAnomaly[];
  recentUnits: { type: string; id: string; cost: number; duration: number; model: string; finishedAt: number }[];
  journalSummary: JournalSummary | null;
  activityLogMeta: ActivityLogMeta | null;
  /** #4764 — worktree lifespan / divergence telemetry aggregates. */
  worktreeTelemetry: WorktreeTelemetrySummary | null;
}

// ─── Duplicate Detection ──────────────────────────────────────────────────────

const DEDUP_PROMPT_SECTION = `
## Pre-Investigation: Duplicate Check (REQUIRED)

Before reading GSD source code or performing deep analysis, you MUST search for existing issues and PRs that may already address this bug. This avoids wasting tokens on already-fixed bugs.

### Search Steps

Use keywords from the user's problem description and the anomaly summaries in the forensic report above.

1. **Search closed issues** for similar keywords:
   \`\`\`
   gh issue list --repo gsd-build/gsd-2 --state closed --search "<keywords from root cause>" --limit 20
   \`\`\`

2. **Search open PRs** that might contain the fix:
   \`\`\`
   gh pr list --repo gsd-build/gsd-2 --state open --search "<keywords>" --limit 10
   \`\`\`

3. **Search merged PRs** that may have already fixed this:
   \`\`\`
   gh pr list --repo gsd-build/gsd-2 --state merged --search "<keywords>" --limit 10
   \`\`\`

### Analysis

For each result, compare it against the user's reported symptoms and the forensic anomalies:
- Does the issue describe the same code path or file?
- Does the PR modify the area related to the reported symptoms?
- Is the symptom description semantically similar even if keywords differ?

### Decision Gate

- **Merged PR clearly fixes the described symptom** → Report "Already fixed by PR #X" with brief explanation. Skip full investigation.
- **Open issue matches** → Report "Existing issue #Y covers this." Offer to add forensic evidence. Skip full investigation unless user asks for deeper analysis.
- **No matches** → Proceed to full investigation below.
`;

async function writeForensicsDedupPref(ctx: ExtensionCommandContext, enabled: boolean): Promise<void> {
  const prefsPath = getGlobalGSDPreferencesPath();
  await ensurePreferencesFile(prefsPath, ctx, "global");
  const existing = loadGlobalGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : {};
  prefs.version = prefs.version || 1;
  prefs.forensics_dedup = enabled;

  const frontmatter = serializePreferencesToFrontmatter(prefs);
  const raw = existsSync(prefsPath) ? readFileSync(prefsPath, "utf-8") : "";
  let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  const start = raw.startsWith("---\n") ? 4 : raw.startsWith("---\r\n") ? 5 : -1;
  if (start !== -1) {
    const closingIdx = raw.indexOf("\n---", start);
    if (closingIdx !== -1) {
      const after = raw.slice(closingIdx + 4);
      if (after.trim()) body = after;
    }
  }

  writeFileSync(prefsPath, `---\n${frontmatter}---${body}`, "utf-8");
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

export async function handleForensics(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (isAutoActive()) {
    ctx.ui.notify("Cannot run forensics while auto-mode is active. Stop auto-mode first.", "error");
    return;
  }

  const basePath = process.cwd();
  const root = gsdRoot(basePath);
  if (!existsSync(root)) {
    ctx.ui.notify("No GSD state found. Run /gsd auto first.", "warning");
    return;
  }

  let problemDescription = args.trim();
  if (!problemDescription) {
    problemDescription = await ctx.ui.input(
      "Describe what went wrong:",
      "e.g. auto-mode got stuck on task T03",
    ) ?? "";
  }
  if (!problemDescription?.trim()) {
    ctx.ui.notify("Problem description required for forensic analysis.", "warning");
    return;
  }

  // ─── Duplicate detection opt-in ─────────────────────────────────────────────
  const effectivePrefs = loadEffectiveGSDPreferences()?.preferences;
  let dedupEnabled = effectivePrefs?.forensics_dedup === true;

  if (effectivePrefs?.forensics_dedup === undefined) {
    const choice = await showNextAction(ctx, {
      title: "Duplicate detection available",
      summary: ["Before filing a GitHub issue, forensics can search existing issues and PRs to avoid duplicates.", "This uses additional AI tokens for analysis."],
      actions: [
        { id: "enable", label: "Enable duplicate detection", description: "Search issues/PRs before filing (recommended)", recommended: true },
        { id: "skip", label: "Skip for now", description: "File without checking for duplicates" },
      ],
      notYetMessage: "You can enable this later via preferences (forensics_dedup: true).",
    });

    if (choice === "enable") {
      await writeForensicsDedupPref(ctx, true);
      dedupEnabled = true;
    }
  }

  const dedupSection = dedupEnabled ? DEDUP_PROMPT_SECTION : "";

  ctx.ui.notify("Building forensic report...", "info");

  const report = await buildForensicReport(basePath);
  const savedPath = saveForensicReport(basePath, report, problemDescription);

  // Derive GSD source dir for prompt — fall back to ~/.gsd/agent/extensions/gsd/
  // when import.meta.url resolves to the npm-global install path (Windows).
  let gsdSourceDir = dirname(fileURLToPath(import.meta.url));
  if (!existsSync(join(gsdSourceDir, "prompts"))) {
    const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
    const fallback = join(gsdHome, "agent", "extensions", "gsd");
    if (existsSync(join(fallback, "prompts"))) gsdSourceDir = fallback;
  }

  const forensicData = formatReportForPrompt(report);
  const content = loadPrompt("forensics", {
    problemDescription,
    forensicData,
    gsdSourceDir,
    dedupSection,
  });

  ctx.ui.notify(`Forensic report saved: ${relative(basePath, savedPath)}`, "info");

  pi.sendMessage(
    { customType: "gsd-forensics", content, display: false },
    { triggerTurn: true },
  );

  // Persist forensics context so follow-up turns can re-inject it (#2941)
  writeForensicsMarker(basePath, savedPath, content);
}

// ─── Report Builder ───────────────────────────────────────────────────────────

export async function buildForensicReport(basePath: string): Promise<ForensicReport> {
  const anomalies: ForensicAnomaly[] = [];

  // 1. Derive current state
  let activeMilestone: string | null = null;
  let activeSlice: string | null = null;
  try {
    const state = await deriveState(basePath);
    activeMilestone = state.activeMilestone?.id ?? null;
    activeSlice = state.activeSlice?.id ?? null;
  } catch { /* state derivation failure is non-fatal */ }

  // 1b. Check for active auto-worktree
  const activeWorktree = activeMilestone ? getAutoWorktreePath(basePath, activeMilestone) : null;

  // 2. Scan activity logs (last 5) — worktree-aware
  const unitTraces = scanActivityLogs(basePath, activeMilestone);

  // 3. Load metrics
  const metrics = loadLedgerFromDisk(basePath);

  // 4. Load completed keys (legacy) and DB completion counts
  const completedKeys = loadCompletedKeys(basePath);
  const dbCompletionCounts = getDbCompletionCounts();

  // 5. Check crash lock
  const crashLock = readCrashLock(basePath);

  // 6. Run doctor
  let doctorIssues: DoctorIssue[] = [];
  try {
    const report = await runGSDDoctor(basePath, { scope: undefined });
    doctorIssues = report.issues;
  } catch { /* doctor failure is non-fatal */ }

  // 7. Build recent units from metrics
  const recentUnits: ForensicReport["recentUnits"] = [];
  if (metrics?.units) {
    const sorted = [...metrics.units].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10);
    for (const u of sorted) {
      recentUnits.push({
        type: u.type,
        id: u.id,
        cost: u.cost,
        duration: u.finishedAt - u.startedAt,
        model: u.model,
        finishedAt: u.finishedAt,
      });
    }
  }

  // 8. GSD version — use GSD_VERSION env var set by the loader at startup.
  // Extensions run from ~/.gsd/agent/extensions/gsd/ at runtime, so path-traversal
  // from import.meta.url would resolve to ~/package.json (wrong on every system).
  const gsdVersion = process.env.GSD_VERSION || "unknown";

  // 9. Scan journal for flow timeline and structured events
  const journalSummary = scanJournalForForensics(basePath);

  // 10. Gather activity log directory metadata
  const activityLogMeta = gatherActivityLogMeta(basePath, activeMilestone);

  // 11. Run anomaly detectors
  if (metrics?.units) detectStuckLoops(metrics.units, anomalies);
  if (metrics?.units) detectCostSpikes(metrics.units, anomalies);
  detectTimeouts(unitTraces, anomalies);
  detectMissingArtifacts(completedKeys, basePath, activeMilestone, anomalies);
  detectCrash(crashLock, anomalies);
  detectDoctorIssues(doctorIssues, anomalies);
  detectErrorTraces(unitTraces, anomalies);

  // 11b. #4764 — worktree lifecycle telemetry
  let worktreeTelemetry: WorktreeTelemetrySummary | null = null;
  try {
    worktreeTelemetry = summarizeWorktreeTelemetry(basePath);
    detectWorktreeOrphans(worktreeTelemetry, anomalies);
  } catch {
    // Telemetry is best-effort — do not let an aggregator failure block the
    // rest of the forensic report.
  }
  detectJournalAnomalies(journalSummary, anomalies);

  return {
    gsdVersion,
    timestamp: new Date().toISOString(),
    basePath,
    activeMilestone,
    activeSlice,
    activeWorktree: activeWorktree ? relative(basePath, activeWorktree) : null,
    unitTraces,
    metrics,
    completedKeys,
    dbCompletionCounts,
    crashLock,
    doctorIssues,
    anomalies,
    recentUnits,
    journalSummary,
    activityLogMeta,
    worktreeTelemetry,
  };
}

// ─── Activity Log Scanner ─────────────────────────────────────────────────────

const ACTIVITY_FILENAME_RE = /^(\d+)-(.+?)-(.+)\.jsonl$/;

/** Threshold below which iteration cadence is considered rapid (thrashing). */
const RAPID_ITERATION_THRESHOLD_MS = 5000;

function scanActivityLogs(basePath: string, activeMilestone?: string | null): UnitTrace[] {
  const activityDirs = resolveActivityDirs(basePath, activeMilestone);
  const allTraces: UnitTrace[] = [];

  for (const activityDir of activityDirs) {
    if (!existsSync(activityDir)) continue;

    const files = readdirSync(activityDir).filter(f => f.endsWith(".jsonl")).sort();
    const lastFiles = files.slice(-5);

    for (const file of lastFiles) {
      const match = ACTIVITY_FILENAME_RE.exec(file);
      if (!match) continue;

      const seq = parseInt(match[1]!, 10);
      const unitType = match[2]!;
      const unitId = match[3]!;
      const filePath = join(activityDir, file);

      let entries: unknown[] = [];
      const nativeResult = nativeParseJsonlTail(filePath, MAX_JSONL_BYTES);
      if (nativeResult) {
        entries = nativeResult.entries;
      } else {
        try {
          const raw = readFileSync(filePath, "utf-8");
          entries = parseJSONL(raw);
        } catch { continue; }
      }

      const trace = extractTrace(entries);
      const stat = statSync(filePath, { throwIfNoEntry: false });

      allTraces.push({
        file: activityDirs.length > 1 ? `[${relative(basePath, activityDir)}] ${file}` : file,
        unitType,
        unitId,
        seq,
        trace,
        mtime: stat?.mtimeMs ?? 0,
      });
    }
  }

  // Sort by mtime descending so the most recent traces (regardless of source) come first
  return allTraces.sort((a, b) => b.mtime - a.mtime).slice(0, 5);
}

/**
 * Resolve activity directories to scan for forensics.
 * If an active auto-worktree exists for the milestone, its activity dir
 * is included first (preferred) so stale root logs don't mask worktree progress.
 */
function resolveActivityDirs(basePath: string, activeMilestone?: string | null): string[] {
  const dirs: string[] = [];

  // Check for active auto-worktree activity logs
  if (activeMilestone) {
    const wtPath = getAutoWorktreePath(basePath, activeMilestone);
    if (wtPath) {
      const wtActivityDir = join(gsdRoot(wtPath), "activity");
      if (existsSync(wtActivityDir)) {
        dirs.push(wtActivityDir);
      }
    }
  }

  // Always include root activity logs
  const rootActivityDir = join(gsdRoot(basePath), "activity");
  dirs.push(rootActivityDir);

  return dirs;
}

// ─── Journal Scanner ──────────────────────────────────────────────────────────

/**
 * Max recent journal files to fully parse for event counts and recent events.
 * Older files are line-counted only to avoid loading huge amounts of data.
 */
const MAX_JOURNAL_RECENT_FILES = 3;

/** Max recent events to extract for the forensic report timeline. */
const MAX_JOURNAL_RECENT_EVENTS = 20;

/**
 * Intelligently scan journal files for forensic summary.
 *
 * Journal files can be huge (thousands of JSONL entries over weeks of auto-mode).
 * Instead of loading all entries into memory:
 * - Only fully parse the most recent N daily files (event counts, flow tracking)
 * - Line-count older files for approximate totals (no JSON parsing)
 * - Extract only the last 20 events for the timeline
 */
function scanJournalForForensics(basePath: string): JournalSummary | null {
  try {
    const journalDir = join(gsdRoot(basePath), "journal");
    if (!existsSync(journalDir)) return null;

    const files = readdirSync(journalDir).filter(f => f.endsWith(".jsonl")).sort();
    if (files.length === 0) return null;

    // Split into recent (fully parsed) and older (line-counted only)
    const recentFiles = files.slice(-MAX_JOURNAL_RECENT_FILES);
    const olderFiles = files.slice(0, -MAX_JOURNAL_RECENT_FILES);

    // Line-count older files without parsing — avoids loading megabytes of JSON
    let olderEntryCount = 0;
    let oldestEntry: string | null = null;
    for (const file of olderFiles) {
      try {
        const raw = readFileSync(join(journalDir, file), "utf-8");
        const lines = raw.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          olderEntryCount++;
          // Extract only the timestamp from the first non-empty line of the oldest file
          if (!oldestEntry) {
            try {
              const parsed = JSON.parse(line) as { ts?: string };
              if (parsed.ts) oldestEntry = parsed.ts;
            } catch { /* skip malformed */ }
          }
        }
      } catch { /* skip unreadable files */ }
    }

    // Fully parse recent files for event counts and timeline
    const eventCounts: Record<string, number> = {};
    const flowIds = new Set<string>();
    const recentParsedEntries: { ts: string; flowId: string; eventType: string; rule?: string; unitId?: string }[] = [];
    let recentEntryCount = 0;

    for (const file of recentFiles) {
      try {
        const raw = readFileSync(join(journalDir, file), "utf-8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as { ts: string; flowId: string; eventType: string; rule?: string; data?: Record<string, unknown> };
            recentEntryCount++;
            eventCounts[entry.eventType] = (eventCounts[entry.eventType] ?? 0) + 1;
            flowIds.add(entry.flowId);

            if (!oldestEntry) oldestEntry = entry.ts;

            // Keep a rolling window of last N events — avoids accumulating unbounded arrays
            recentParsedEntries.push({
              ts: entry.ts,
              flowId: entry.flowId,
              eventType: entry.eventType,
              rule: entry.rule,
              unitId: entry.data?.unitId as string | undefined,
            });
            if (recentParsedEntries.length > MAX_JOURNAL_RECENT_EVENTS) {
              recentParsedEntries.shift();
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    const totalEntries = olderEntryCount + recentEntryCount;
    if (totalEntries === 0) return null;

    const newestEntry = recentParsedEntries.length > 0
      ? recentParsedEntries[recentParsedEntries.length - 1]!.ts
      : null;

    return {
      totalEntries,
      flowCount: flowIds.size,
      eventCounts,
      recentEvents: recentParsedEntries,
      oldestEntry,
      newestEntry,
      fileCount: files.length,
    };
  } catch {
    return null;
  }
}

// ─── Activity Log Metadata ────────────────────────────────────────────────────

function gatherActivityLogMeta(basePath: string, activeMilestone?: string | null): ActivityLogMeta | null {
  try {
    const activityDirs = resolveActivityDirs(basePath, activeMilestone);
    let fileCount = 0;
    let totalSizeBytes = 0;
    let oldestFile: string | null = null;
    let newestFile: string | null = null;
    let oldestMtime = Infinity;
    let newestMtime = 0;

    for (const activityDir of activityDirs) {
      if (!existsSync(activityDir)) continue;
      const files = readdirSync(activityDir).filter(f => f.endsWith(".jsonl"));
      for (const file of files) {
        const filePath = join(activityDir, file);
        const stat = statSync(filePath, { throwIfNoEntry: false });
        if (!stat) continue;
        fileCount++;
        totalSizeBytes += stat.size;
        if (stat.mtimeMs < oldestMtime) {
          oldestMtime = stat.mtimeMs;
          oldestFile = file;
        }
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = file;
        }
      }
    }

    if (fileCount === 0) return null;
    return { fileCount, totalSizeBytes, oldestFile, newestFile };
  } catch {
    return null;
  }
}

// ─── Completed Keys Helpers ───────────────────────────────────────────────────

/**
 * Parse a completed-unit key into { unitType, unitId }.
 *
 * Most unit types are a single segment ("execute-task", "complete-slice", …)
 * so the key format is simply "unitType/unitId". Hook units are the exception:
 * their type is compound ("hook/<hookName>"), making the key look like
 * "hook/telegram-progress/M007/S01". Splitting naïvely on the first slash
 * yields unitType="hook" which bypasses verifyExpectedArtifact()'s
 * startsWith("hook/") guard and produces false-positive missing-artifact
 * errors (#2826).
 *
 * Returns null for malformed keys (no slash, or hook/ with no second slash).
 */
export function splitCompletedKey(key: string): { unitType: string; unitId: string } | null {
  if (key.startsWith("hook/")) {
    const secondSlash = key.indexOf("/", 5); // skip past "hook/"
    if (secondSlash === -1) return null;      // malformed — "hook/" with no hook name
    return { unitType: key.slice(0, secondSlash), unitId: key.slice(secondSlash + 1) };
  }
  const slashIdx = key.indexOf("/");
  if (slashIdx === -1) return null;
  return { unitType: key.slice(0, slashIdx), unitId: key.slice(slashIdx + 1) };
}

function loadCompletedKeys(basePath: string): string[] {
  const file = join(gsdRoot(basePath), "completed-units.json");
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch { /* non-fatal */ }
  return [];
}

// ─── DB Completion Counts ────────────────────────────────────────────────────

function getDbCompletionCounts(): DbCompletionCounts | null {
  if (!isDbAvailable()) return null;

  const milestones = getAllMilestones();
  let completedMilestones = 0;
  let totalSlices = 0;
  let completedSlices = 0;
  let totalTasks = 0;
  let completedTasks = 0;

  for (const m of milestones) {
    if (isClosedStatus(m.status)) completedMilestones++;

    const slices = getMilestoneSlices(m.id);
    for (const s of slices) {
      totalSlices++;
      if (isClosedStatus(s.status)) completedSlices++;

      const tasks = getSliceTasks(m.id, s.id);
      for (const t of tasks) {
        totalTasks++;
        if (isClosedStatus(t.status)) completedTasks++;
      }
    }
  }

  return {
    milestones: completedMilestones,
    milestonesTotal: milestones.length,
    slices: completedSlices,
    slicesTotal: totalSlices,
    tasks: completedTasks,
    tasksTotal: totalTasks,
  };
}

// ─── Anomaly Detectors ───────────────────────────────────────────────────────

/**
 * Detect units that were dispatched multiple times (stuck in a loop).
 *
 * Counts distinct dispatches by grouping on (type, id, startedAt) first to
 * collapse idle-watchdog duplicate snapshots (#1943), then counts unique
 * startedAt values per type/id to determine actual dispatch count.
 *
 * Exported for testability.
 */
export function detectStuckLoops(units: UnitMetrics[], anomalies: ForensicAnomaly[]): void {
  // First, collect unique startedAt values per type/id key, bucketed by
  // autoSessionKey when available so cross-session recovery does not look
  // like a within-session stuck loop.
  const dispatchMap = new Map<string, Map<string, Set<number>>>();
  for (const u of units) {
    const key = `${u.type}/${u.id}`;
    let sessionBuckets = dispatchMap.get(key);
    if (!sessionBuckets) {
      sessionBuckets = new Map();
      dispatchMap.set(key, sessionBuckets);
    }

    const sessionKey = u.autoSessionKey ?? "__legacy__";
    let starts = sessionBuckets.get(sessionKey);
    if (!starts) {
      starts = new Set();
      sessionBuckets.set(sessionKey, starts);
    }
    starts.add(u.startedAt);
  }

  for (const [key, sessionBuckets] of dispatchMap) {
    const hasSessionAwareData = Array.from(sessionBuckets.keys()).some((sessionKey) => sessionKey !== "__legacy__");
    const count = hasSessionAwareData
      ? Math.max(...Array.from(sessionBuckets.values(), (starts) => starts.size))
      : (sessionBuckets.get("__legacy__")?.size ?? 0);

    if (count > 1) {
      const [unitType, ...idParts] = key.split("/");
      anomalies.push({
        type: "stuck-loop",
        severity: count >= 3 ? "error" : "warning",
        unitType,
        unitId: idParts.join("/"),
        summary: `Unit ${key} was dispatched ${count} times`,
        details: hasSessionAwareData
          ? `Repeated dispatch within the same auto session suggests the unit completed but its artifacts were not verified, or the state machine kept returning it. Cross-session recovery runs are ignored.`
          : `Repeated dispatch suggests the unit completed but its artifacts weren't verified, or the state machine kept returning it.`,
      });
    }
  }
}

function detectCostSpikes(units: UnitMetrics[], anomalies: ForensicAnomaly[]): void {
  const avgMap = getAverageCostPerUnitType(units);
  for (const u of units) {
    const avg = avgMap.get(u.type);
    if (avg && avg > 0 && u.cost > avg * 3) {
      anomalies.push({
        type: "cost-spike",
        severity: "warning",
        unitType: u.type,
        unitId: u.id,
        summary: `${formatCost(u.cost)} vs ${formatCost(avg)} average for ${u.type}`,
        details: `Unit ${u.type}/${u.id} cost ${(u.cost / avg).toFixed(1)}x the average. May indicate excessive retries or large context.`,
      });
    }
  }
}

function detectTimeouts(traces: UnitTrace[], anomalies: ForensicAnomaly[]): void {
  for (const ut of traces) {
    // Check for timeout-recovery custom messages in tool calls
    const hasTimeout = ut.trace.toolCalls.some(tc =>
      tc.name === "sendmessage" &&
      JSON.stringify(tc.input).includes("gsd-auto-timeout-recovery"),
    );
    // Check for timeout keywords in last reasoning
    const reasoningTimeout = ut.trace.lastReasoning &&
      /(?:idle.?timeout|hard.?timeout|timeout.?recovery)/i.test(ut.trace.lastReasoning);

    if (hasTimeout || reasoningTimeout) {
      anomalies.push({
        type: "timeout",
        severity: "warning",
        unitType: ut.unitType,
        unitId: ut.unitId,
        summary: `Timeout detected in ${ut.unitType}/${ut.unitId}`,
        details: `Activity log ${ut.file} contains timeout recovery patterns. The unit may have stalled.`,
      });
    }
  }
}

function detectMissingArtifacts(completedKeys: string[], basePath: string, activeMilestone: string | null, anomalies: ForensicAnomaly[]): void {
  // Also check the worktree path for artifacts — they may exist there but not at root
  const wtBasePath = activeMilestone ? getAutoWorktreePath(basePath, activeMilestone) : null;

  for (const key of completedKeys) {
    const parsed = splitCompletedKey(key);
    if (!parsed) continue;
    const { unitType, unitId } = parsed;

    const rootHasArtifact = verifyExpectedArtifact(unitType, unitId, basePath);
    const wtHasArtifact = wtBasePath ? verifyExpectedArtifact(unitType, unitId, wtBasePath) : false;

    if (!rootHasArtifact && !wtHasArtifact) {
      anomalies.push({
        type: "missing-artifact",
        severity: "error",
        unitType,
        unitId,
        summary: `Completed key ${key} but artifact missing or invalid`,
        details: `The unit is recorded as completed but verifyExpectedArtifact() returns false at both project root and worktree. The completion state is stale.`,
      });
    }
  }
}

/**
 * #4764 — surface worktree lifecycle and orphan signals in the forensic report.
 *
 * Consumes only the aggregated summary (not raw journal events) to respect
 * the forensics memory-bloat guard in forensics-journal.test.ts — per-event
 * detail stays in the journal itself where the LLM can query it on demand.
 */
function detectWorktreeOrphans(
  summary: WorktreeTelemetrySummary,
  anomalies: ForensicAnomaly[],
): void {
  // 1. Orphan aggregate — severity depends on reason. In-progress orphans are
  // the #4761 consumer-side signal (live work sitting on an unmerged branch).
  for (const [reason, count] of Object.entries(summary.orphansByReason)) {
    if (count <= 0) continue;
    const severity: ForensicAnomaly["severity"] =
      reason === "in-progress-unmerged" ? "warning" : "info";
    anomalies.push({
      type: "worktree-orphan",
      severity,
      summary: `${count} worktree orphan(s) detected (${reason})`,
      details:
        reason === "in-progress-unmerged"
          ? "Auto-mode exited without completing a milestone; live work sits on an unmerged milestone branch. Run `/gsd auto` to resume, or merge manually."
          : reason === "complete-unmerged"
            ? "A completed milestone's branch was never merged back to main. Run `/gsd health --fix` to resolve."
            : `Reason: ${reason}.`,
    });
  }

  // 2. Auto-exit producer signal — #4761's upstream cause.
  if (summary.exitsWithUnmergedWork > 0) {
    const reasonBreakdown = Object.entries(summary.exitsByReason)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `${r}=${n}`)
      .join(", ");
    anomalies.push({
      type: "worktree-unmerged-exit",
      severity: "warning",
      summary: `${summary.exitsWithUnmergedWork} auto-exit(s) left milestone work unmerged`,
      details: `Exit reasons: ${reasonBreakdown || "(none)"} · Producer-side signal for #4761-class orphans. Inspect .gsd/journal/*.jsonl with eventType:"auto-exit" for per-exit detail.`,
    });
  }
}

function detectCrash(crashLock: LockData | null, anomalies: ForensicAnomaly[]): void {
  if (!crashLock) return;
  if (isLockProcessAlive(crashLock)) return; // Process still running, not a crash

  anomalies.push({
    type: "crash",
    severity: "error",
    unitType: crashLock.unitType,
    unitId: crashLock.unitId,
    summary: `Stale crash lock: PID ${crashLock.pid} is dead`,
    details: formatCrashInfo(crashLock),
  });
}

function detectDoctorIssues(issues: DoctorIssue[], anomalies: ForensicAnomaly[]): void {
  for (const issue of issues) {
    if (issue.severity === "error") {
      anomalies.push({
        type: "doctor-issue",
        severity: "error",
        summary: `Doctor: ${issue.message}`,
        details: `Code: ${issue.code}, Scope: ${issue.scope}, Unit: ${issue.unitId}${issue.file ? `, File: ${issue.file}` : ""}`,
      });
    }
  }
}

function detectErrorTraces(traces: UnitTrace[], anomalies: ForensicAnomaly[]): void {
  for (const ut of traces) {
    if (ut.trace.errors.length > 0) {
      anomalies.push({
        type: "error-trace",
        severity: "warning",
        unitType: ut.unitType,
        unitId: ut.unitId,
        summary: `${ut.trace.errors.length} error(s) in ${ut.unitType}/${ut.unitId}`,
        details: ut.trace.errors.slice(0, 3).join("\n"),
      });
    }
  }
}

function detectJournalAnomalies(journal: JournalSummary | null, anomalies: ForensicAnomaly[]): void {
  if (!journal) return;

  // Detect stuck-detected events from the journal
  const stuckCount = journal.eventCounts["stuck-detected"] ?? 0;
  if (stuckCount > 0) {
    anomalies.push({
      type: "journal-stuck",
      severity: stuckCount >= 3 ? "error" : "warning",
      summary: `Journal recorded ${stuckCount} stuck-detected event(s)`,
      details: `The auto-mode loop detected it was stuck ${stuckCount} time(s). Check journal events for flow IDs and causal chains to trace the root cause.`,
    });
  }

  // Detect guard-block events (dispatch was blocked by a guard)
  const guardCount = journal.eventCounts["guard-block"] ?? 0;
  if (guardCount > 0) {
    anomalies.push({
      type: "journal-guard-block",
      severity: guardCount >= 5 ? "warning" : "info",
      summary: `Journal recorded ${guardCount} guard-block event(s)`,
      details: `Dispatch was blocked by a guard condition ${guardCount} time(s). This may indicate a persistent blocking condition preventing progress.`,
    });
  }

  // Detect rapid iterations (many flows in short time = likely thrashing)
  if (journal.flowCount > 0 && journal.oldestEntry && journal.newestEntry) {
    const oldest = new Date(journal.oldestEntry).getTime();
    const newest = new Date(journal.newestEntry).getTime();
    const spanMs = newest - oldest;
    if (spanMs > 0 && journal.flowCount > 10) {
      const avgMs = spanMs / journal.flowCount;
      if (avgMs < RAPID_ITERATION_THRESHOLD_MS) {
        anomalies.push({
          type: "journal-rapid-iterations",
          severity: "warning",
          summary: `${journal.flowCount} iterations in ${formatDuration(spanMs)} (avg ${formatDuration(avgMs)}/iteration)`,
          details: `Unusually rapid iteration cadence suggests the loop may be thrashing without making progress. Review recent journal events for dispatch-stop or terminal events.`,
        });
      }
    }
  }

  // Detect worktree failures from journal events
  const wtCreateFailed = journal.eventCounts["worktree-create-failed"] ?? 0;
  const wtMergeFailed = journal.eventCounts["worktree-merge-failed"] ?? 0;
  const wtFailures = wtCreateFailed + wtMergeFailed;
  if (wtFailures > 0) {
    const parts: string[] = [];
    if (wtCreateFailed > 0) parts.push(`${wtCreateFailed} create failure(s)`);
    if (wtMergeFailed > 0) parts.push(`${wtMergeFailed} merge failure(s)`);
    anomalies.push({
      type: "journal-worktree-failure",
      severity: "warning",
      summary: `Worktree failures: ${parts.join(", ")}`,
      details: `Journal recorded worktree operation failures. These may indicate git state corruption or conflicting branches.`,
    });
  }
}

// ─── Report Persistence ───────────────────────────────────────────────────────

function saveForensicReport(basePath: string, report: ForensicReport, problemDescription: string): string {
  const dir = join(gsdRoot(basePath), "forensics");
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  const filePath = join(dir, `report-${ts}.md`);

  const redact = (s: string) => redactForGitHub(s, basePath);

  const sections: string[] = [
    `# GSD Forensic Report`,
    ``,
    `**Generated:** ${report.timestamp}`,
    `**GSD Version:** ${report.gsdVersion}`,
    `**Active Milestone:** ${report.activeMilestone ?? "none"}`,
    `**Active Slice:** ${report.activeSlice ?? "none"}`,
    `**Active Worktree:** ${report.activeWorktree ?? "none"}`,
    ``,
    `## Problem Description`,
    ``,
    problemDescription,
    ``,
  ];

  // Anomalies
  if (report.anomalies.length > 0) {
    sections.push(`## Anomalies Detected (${report.anomalies.length})`, ``);
    for (const a of report.anomalies) {
      sections.push(`### [${a.severity.toUpperCase()}] ${a.type}: ${a.summary}`);
      if (a.unitType) sections.push(`- Unit: ${a.unitType}/${a.unitId ?? ""}`);
      sections.push(`- ${redact(a.details)}`, ``);
    }
  } else {
    sections.push(`## Anomalies`, ``, `No anomalies detected.`, ``);
  }

  // Recent units
  if (report.recentUnits.length > 0) {
    sections.push(`## Recent Units`, ``);
    sections.push(`| Type | ID | Cost | Duration | Model |`);
    sections.push(`|------|-----|------|----------|-------|`);
    for (const u of report.recentUnits) {
      sections.push(`| ${u.type} | ${u.id} | ${formatCost(u.cost)} | ${formatDuration(u.duration)} | ${u.model} |`);
    }
    sections.push(``);
  }

  // Unit traces
  if (report.unitTraces.length > 0) {
    sections.push(`## Activity Log Traces (last ${report.unitTraces.length})`, ``);
    for (const ut of report.unitTraces) {
      sections.push(`### ${ut.unitType}/${ut.unitId} (seq ${ut.seq})`);
      sections.push(`- Tool calls: ${ut.trace.toolCallCount}`);
      sections.push(`- Files written: ${ut.trace.filesWritten.length}`);
      sections.push(`- Errors: ${ut.trace.errors.length}`);
      if (ut.trace.lastReasoning) {
        sections.push(`- Last reasoning: ${redact(ut.trace.lastReasoning.slice(0, 200))}`);
      }
      sections.push(``);
    }
  }

  // Doctor issues
  if (report.doctorIssues.length > 0) {
    sections.push(`## Doctor Issues`, ``);
    sections.push(formatDoctorIssuesForPrompt(report.doctorIssues), ``);
  }

  // Crash lock
  if (report.crashLock) {
    sections.push(`## Crash Lock`, ``);
    sections.push(redact(formatCrashInfo(report.crashLock)), ``);
  }

  // Activity log metadata
  if (report.activityLogMeta) {
    const meta = report.activityLogMeta;
    sections.push(`## Activity Log Metadata`, ``);
    sections.push(`- Files: ${meta.fileCount}`);
    sections.push(`- Total size: ${(meta.totalSizeBytes / 1024).toFixed(1)} KB`);
    if (meta.oldestFile) sections.push(`- Oldest: ${meta.oldestFile}`);
    if (meta.newestFile) sections.push(`- Newest: ${meta.newestFile}`);
    sections.push(``);
  }

  // #4764 — Worktree telemetry summary
  if (report.worktreeTelemetry) {
    const t = report.worktreeTelemetry;
    const p50 = percentile(t.mergeDurationsMs, 0.5);
    const p95 = percentile(t.mergeDurationsMs, 0.95);
    sections.push(`## Worktree Telemetry`, ``);
    sections.push(`- Worktrees created: ${t.worktreesCreated}`);
    sections.push(`- Worktrees merged: ${t.worktreesMerged}`);
    sections.push(`- Orphans detected: ${t.orphansDetected}`);
    if (t.orphansDetected > 0) {
      const breakdown = Object.entries(t.orphansByReason)
        .map(([r, n]) => `${r}=${n}`).join(", ");
      sections.push(`  - By reason: ${breakdown}`);
    }
    sections.push(`- Merge conflicts: ${t.mergeConflicts}`);
    if (t.mergeDurationsMs.length > 0) {
      sections.push(`- Merge duration p50 / p95: ${p50 ?? "-"} / ${p95 ?? "-"} ms (n=${t.mergeDurationsMs.length})`);
    }
    sections.push(`- Auto-exits leaving unmerged work: ${t.exitsWithUnmergedWork}`);
    if (Object.keys(t.exitsByReason).length > 0) {
      const breakdown = Object.entries(t.exitsByReason)
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r}=${n}`).join(", ");
      sections.push(`  - Exit reasons: ${breakdown}`);
    }
    sections.push(`- Canonical-root redirects (#4761 fix fired): ${t.canonicalRedirects}`);
    // #4765 slice-cadence counters
    if (t.slicesMerged + t.sliceMergeConflicts + t.milestoneResquashes > 0) {
      sections.push(`- Slices merged: ${t.slicesMerged} · Slice merge conflicts: ${t.sliceMergeConflicts}`);
      sections.push(`- Milestone re-squashes: ${t.milestoneResquashes}`);
    }
    sections.push(``);
  }

  // Journal summary
  if (report.journalSummary) {
    const js = report.journalSummary;
    sections.push(`## Journal Summary`, ``);
    sections.push(`- Total entries: ${js.totalEntries}`);
    sections.push(`- Distinct flows (iterations): ${js.flowCount}`);
    sections.push(`- Daily files: ${js.fileCount}`);
    if (js.oldestEntry) sections.push(`- Date range: ${js.oldestEntry} — ${js.newestEntry}`);
    sections.push(``);
    sections.push(`### Event Type Distribution`, ``);
    sections.push(`| Event Type | Count |`);
    sections.push(`|------------|-------|`);
    for (const [evType, count] of Object.entries(js.eventCounts).sort((a, b) => b[1] - a[1])) {
      sections.push(`| ${evType} | ${count} |`);
    }
    sections.push(``);
    if (js.recentEvents.length > 0) {
      sections.push(`### Recent Journal Events (last ${js.recentEvents.length})`, ``);
      for (const ev of js.recentEvents) {
        const parts = [`${ev.ts} [${ev.eventType}] flow=${ev.flowId.slice(0, 8)}`];
        if (ev.rule) parts.push(`rule=${ev.rule}`);
        if (ev.unitId) parts.push(`unit=${ev.unitId}`);
        sections.push(`- ${parts.join(" ")}`);
      }
      sections.push(``);
    }
  }

  writeFileSync(filePath, sections.join("\n"), "utf-8");
  return filePath;
}

// ─── Forensics Session Marker ────────────────────────────────────────────────

export interface ForensicsMarker {
  reportPath: string;
  promptContent: string;
  createdAt: string;
}

/**
 * Write a marker file so that buildBeforeAgentStartResult() can re-inject
 * the forensics prompt on follow-up turns.  (#2941)
 */
export function writeForensicsMarker(basePath: string, reportPath: string, promptContent: string): void {
  const dir = join(gsdRoot(basePath), "runtime");
  mkdirSync(dir, { recursive: true });
  const marker: ForensicsMarker = {
    reportPath,
    promptContent,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "active-forensics.json"), JSON.stringify(marker), "utf-8");
}

/**
 * Read the active forensics marker, or null if none exists.
 */
export function readForensicsMarker(basePath: string): ForensicsMarker | null {
  const markerPath = join(gsdRoot(basePath), "runtime", "active-forensics.json");
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf-8")) as ForensicsMarker;
  } catch {
    return null;
  }
}

// ─── Prompt Formatter ─────────────────────────────────────────────────────────

function formatReportForPrompt(report: ForensicReport): string {
  const MAX_BYTES = 30 * 1024;
  const sections: string[] = [];

  // Anomalies (most important, first)
  sections.push(`### Anomalies (${report.anomalies.length})`);
  if (report.anomalies.length === 0) {
    sections.push("No anomalies detected.");
  } else {
    for (const a of report.anomalies) {
      sections.push(`- **[${a.severity.toUpperCase()}] ${a.type}**: ${a.summary}`);
      if (a.details) sections.push(`  ${a.details.slice(0, 300)}`);
    }
  }
  sections.push("");

  // Recent unit history
  if (report.recentUnits.length > 0) {
    sections.push(`### Recent Units (last ${report.recentUnits.length})`);
    sections.push("| Type | ID | Cost | Duration | Model |");
    sections.push("|------|-----|------|----------|-------|");
    for (const u of report.recentUnits) {
      sections.push(`| ${u.type} | ${u.id} | ${formatCost(u.cost)} | ${formatDuration(u.duration)} | ${u.model} |`);
    }
    sections.push("");
  }

  // Trace summaries (last 3)
  const recentTraces = report.unitTraces.slice(0, 3);
  if (recentTraces.length > 0) {
    sections.push(`### Activity Log Traces (last ${recentTraces.length})`);
    for (const ut of recentTraces) {
      sections.push(`**${ut.unitType}/${ut.unitId}** (seq ${ut.seq})`);
      sections.push(`- Tool calls: ${ut.trace.toolCallCount}, Errors: ${ut.trace.errors.length}`);
      if (ut.trace.filesWritten.length > 0) {
        sections.push(`- Files written: ${ut.trace.filesWritten.slice(0, 5).join(", ")}`);
      }
      if (ut.trace.errors.length > 0) {
        sections.push(`- Errors: ${ut.trace.errors.slice(0, 2).map(e => e.slice(0, 200)).join("; ")}`);
      }
      if (ut.trace.lastReasoning) {
        sections.push(`- Last reasoning: "${ut.trace.lastReasoning.slice(0, 300)}"`);
      }
      sections.push("");
    }
  }

  // Doctor issues (error severity only)
  const errorIssues = report.doctorIssues.filter(i => i.severity === "error");
  if (errorIssues.length > 0) {
    sections.push(`### Doctor Issues (${errorIssues.length} errors)`);
    sections.push(formatDoctorIssuesForPrompt(errorIssues));
    sections.push("");
  }

  // Crash lock
  if (report.crashLock) {
    sections.push("### Crash Lock");
    sections.push(formatCrashInfo(report.crashLock));
    const alive = isLockProcessAlive(report.crashLock);
    sections.push(`Process alive: ${alive}`);
    sections.push("");
  }

  // Metrics summary
  if (report.metrics?.units) {
    const totals = getProjectTotals(report.metrics.units);
    sections.push("### Metrics Summary");
    sections.push(`- Total units: ${totals.units}`);
    sections.push(`- Total cost: ${formatCost(totals.cost)}`);
    sections.push(`- Total tokens: ${formatTokenCount(totals.tokens.total)}`);
    sections.push(`- Total duration: ${formatDuration(totals.duration)}`);
    sections.push("");
  }

  // #4764 — worktree telemetry (compact prompt form)
  if (report.worktreeTelemetry) {
    const t = report.worktreeTelemetry;
    const hasSignal =
      t.worktreesCreated + t.worktreesMerged + t.orphansDetected +
      t.exitsWithUnmergedWork + t.canonicalRedirects +
      t.slicesMerged + t.milestoneResquashes > 0;
    if (hasSignal) {
      sections.push("### Worktree Telemetry");
      sections.push(`- Created: ${t.worktreesCreated} · Merged: ${t.worktreesMerged} · Conflicts: ${t.mergeConflicts}`);
      sections.push(`- Orphans: ${t.orphansDetected} · Unmerged exits: ${t.exitsWithUnmergedWork} · Redirects (#4761): ${t.canonicalRedirects}`);
      if (t.orphansDetected > 0) {
        const breakdown = Object.entries(t.orphansByReason)
          .map(([r, n]) => `${r}=${n}`).join(", ");
        sections.push(`- Orphan reasons: ${breakdown}`);
      }
      // #4765 — slice-cadence counters (only shown when the feature was exercised)
      if (t.slicesMerged + t.sliceMergeConflicts + t.milestoneResquashes > 0) {
        sections.push(`- Slices merged: ${t.slicesMerged} · Slice conflicts: ${t.sliceMergeConflicts} · Re-squashes: ${t.milestoneResquashes}`);
      }
      sections.push("");
    }
  }

  // Activity log metadata
  if (report.activityLogMeta) {
    const meta = report.activityLogMeta;
    sections.push("### Activity Log Overview");
    sections.push(`- Files: ${meta.fileCount}, Total size: ${(meta.totalSizeBytes / 1024).toFixed(1)} KB`);
    if (meta.oldestFile) sections.push(`- Oldest: ${meta.oldestFile}`);
    if (meta.newestFile) sections.push(`- Newest: ${meta.newestFile}`);
    sections.push("");
  }

  // Journal summary — structured event timeline
  if (report.journalSummary) {
    const js = report.journalSummary;
    sections.push("### Journal Summary (Iteration Event Log)");
    sections.push(`- Total entries: ${js.totalEntries}, Distinct flows: ${js.flowCount}, Daily files: ${js.fileCount}`);
    if (js.oldestEntry) sections.push(`- Date range: ${js.oldestEntry} — ${js.newestEntry}`);

    // Event type distribution (compact)
    const eventPairs = Object.entries(js.eventCounts).sort((a, b) => b[1] - a[1]);
    sections.push(`- Events: ${eventPairs.map(([t, c]) => `${t}(${c})`).join(", ")}`);

    // Recent events timeline (for tracing what just happened)
    if (js.recentEvents.length > 0) {
      sections.push("");
      sections.push(`**Recent Journal Events (last ${js.recentEvents.length}):**`);
      for (const ev of js.recentEvents) {
        const parts = [`${ev.ts} [${ev.eventType}] flow=${ev.flowId.slice(0, 8)}`];
        if (ev.rule) parts.push(`rule=${ev.rule}`);
        if (ev.unitId) parts.push(`unit=${ev.unitId}`);
        sections.push(`- ${parts.join(" ")}`);
      }
    }
    sections.push("");
  }

  // Completion status — prefer DB counts, fall back to legacy completed-units.json
  if (report.dbCompletionCounts) {
    const c = report.dbCompletionCounts;
    sections.push(`### Completion Status (from DB)`);
    sections.push(`- ${c.milestones}/${c.milestonesTotal} milestones complete`);
    sections.push(`- ${c.slices}/${c.slicesTotal} slices complete`);
    sections.push(`- ${c.tasks}/${c.tasksTotal} tasks complete`);
  } else {
    sections.push(`### Completed Keys: ${report.completedKeys.length}`);
  }
  sections.push(`### GSD Version: ${report.gsdVersion}`);
  sections.push(`### Active Milestone: ${report.activeMilestone ?? "none"}`);
  sections.push(`### Active Slice: ${report.activeSlice ?? "none"}`);
  if (report.activeWorktree) {
    sections.push(`### Active Worktree: ${report.activeWorktree}`);
    sections.push(`Note: Activity logs were scanned from both the worktree and the project root. Worktree logs take priority.`);
  }

  let result = sections.join("\n");
  if (result.length > MAX_BYTES) {
    result = result.slice(0, MAX_BYTES) + "\n\n[... truncated at 30KB ...]";
  }
  return result;
}

// ─── Redaction ────────────────────────────────────────────────────────────────

function redactForGitHub(text: string, basePath: string): string {
  let result = text;

  // Replace absolute paths
  result = result.replaceAll(basePath, ".");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home) result = result.replaceAll(home, "~");

  // Strip API key patterns
  result = result.replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-***");
  result = result.replace(/Bearer\s+\S+/g, "Bearer ***");

  // Strip env var assignments
  result = result.replace(/[A-Z_]{2,}=\S+/g, (match) => {
    const eq = match.indexOf("=");
    return match.slice(0, eq + 1) + "***";
  });

  // Truncate long lines
  result = result.split("\n").map(line =>
    line.length > 500 ? line.slice(0, 497) + "..." : line,
  ).join("\n");

  return result;
}
