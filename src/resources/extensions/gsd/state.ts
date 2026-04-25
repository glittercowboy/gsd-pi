// GSD Extension — State Derivation
// DB-primary state derivation with filesystem fallback for unmigrated projects.
// Pure TypeScript, zero Pi dependencies.

import type {
  GSDState,
  ActiveRef,
  Roadmap,
  RoadmapSliceEntry,
  SlicePlan,
  MilestoneRegistryEntry,
} from './types.js';

import {
  parseRoadmap,
  parsePlan,
} from './parsers-legacy.js';

import {
  parseSummary,
  loadFile,
  parseRequirementCounts,
  parseContextDependsOn,
} from './files.js';

import {
  resolveMilestonePath,
  resolveMilestoneFile,
  resolveSlicePath,
  resolveSliceFile,
  resolveTaskFile,
  resolveTasksDir,
  resolveGsdRootFile,
  gsdRoot,
} from './paths.js';

import { findMilestoneIds } from './milestone-ids.js';
import { loadQueueOrder, sortByQueueOrder } from './queue-order.js';
import { isClosedStatus, isDeferredStatus } from './status-guards.js';
import { nativeBatchParseGsdFiles, type BatchParsedFile } from './native-parser-bridge.js';

import { join, resolve } from 'path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { debugCount, debugTime } from './debug-logger.js';
import { logWarning, logError } from './workflow-logger.js';
import { extractVerdict } from './verdict-parser.js';
import { loadEffectiveGSDPreferences } from './preferences.js';
import { detectPendingEscalation } from './escalation.js';
import { isTerminalMilestoneSummaryContent } from './milestone-summary-classifier.js';

import {
  isDbAvailable,
  wasDbOpenAttempted,
  getAllMilestones,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  getReplanHistory,
  getSlice,
  insertMilestone,
  insertSlice,
  insertTask,
  updateSliceStatus,
  updateTaskStatus,
  getPendingGateCountForTurn,
  autoHealSketchFlags,
  type MilestoneRow,
  type SliceRow,
  type TaskRow,
} from './gsd-db.js';

/**
 * A "ghost" milestone directory contains only META.json (and no substantive
 * files like CONTEXT, CONTEXT-DRAFT, ROADMAP, or SUMMARY).  These appear when
 * a milestone is created but never initialised.  Treating them as active causes
 * auto-mode to stall or falsely declare completion.
 *
 * However, a milestone is NOT a ghost if:
 * - It has a DB row with a meaningful status (queued, active, etc.) — the DB
 *   knows about it even if content files haven't been created yet.
 * - It has a worktree directory — a worktree proves the milestone was
 *   legitimately created and is expected to be populated.
 *
 * Fixes #2921: queued milestones with worktrees were incorrectly classified
 * as ghosts, causing auto-mode to skip them entirely.
 */
export function isGhostMilestone(basePath: string, mid: string): boolean {
  // If the milestone has a DB row, it's usually a known milestone — not a ghost.
  // Exception: a "queued" row with no disk artifacts is a phantom from
  // gsd_milestone_generate_id that was never planned (#3645).
  if (isDbAvailable()) {
    const dbRow = getMilestone(mid);
    if (dbRow) {
      if (dbRow.status === 'queued') {
        const hasContent = resolveMilestoneFile(basePath, mid, "CONTEXT")
          || resolveMilestoneFile(basePath, mid, "ROADMAP")
          || resolveMilestoneFile(basePath, mid, "SUMMARY");
        return !hasContent;
      }
      return false;
    }
  }

  // If a worktree exists for this milestone, it was legitimately created.
  const root = gsdRoot(basePath);
  const wtPath = join(root, 'worktrees', mid);
  if (existsSync(wtPath)) return false;

  // Fall back to content-file check: no substantive files means ghost.
  const context   = resolveMilestoneFile(basePath, mid, "CONTEXT");
  const draft     = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const roadmap   = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const summary   = resolveMilestoneFile(basePath, mid, "SUMMARY");
  return !context && !draft && !roadmap && !summary;
}

// ─── Query Functions ───────────────────────────────────────────────────────

/**
 * Check if all tasks in a slice plan are done.
 */
export function isSliceComplete(plan: SlicePlan): boolean {
  return plan.tasks.length > 0 && plan.tasks.every(t => t.done);
}

/**
 * Check if all slices in a roadmap are done.
 */
export function isMilestoneComplete(roadmap: Roadmap): boolean {
  return roadmap.slices.length > 0 && roadmap.slices.every(s => s.done);
}

/**
 * Check whether a VALIDATION file's verdict is terminal.
 * Any successfully extracted verdict (pass, needs-attention, needs-remediation,
 * fail, etc.) means validation completed. Only return false when no verdict
 * could be parsed — i.e. extractVerdict() returns undefined (#2769).
 */
export function isValidationTerminal(validationContent: string): boolean {
  return extractVerdict(validationContent) != null;
}

async function isTerminalMilestoneSummaryFile(
  path: string,
  loader: (path: string) => Promise<string | null>,
): Promise<boolean> {
  const content = await loader(path);
  return content != null && isTerminalMilestoneSummaryContent(content);
}

// ─── State Derivation ──────────────────────────────────────────────────────

// ── deriveState memoization ─────────────────────────────────────────────────
// Cache the most recent deriveState() result keyed by basePath. Within a single
// dispatch cycle (~100ms window), repeated calls return the cached value instead
// of re-reading the entire .gsd/ tree from disk.

interface StateCache {
  basePath: string;
  result: GSDState;
  timestamp: number;
}

const CACHE_TTL_MS = 100;
let _stateCache: StateCache | null = null;

// ── Telemetry counters for derive-path observability ────────────────────────
let _telemetry = { dbDeriveCount: 0, markdownDeriveCount: 0 };
export function getDeriveTelemetry() { return { ..._telemetry }; }
export function resetDeriveTelemetry() { _telemetry = { dbDeriveCount: 0, markdownDeriveCount: 0 }; }

/**
 * Invalidate the deriveState() cache. Call this whenever planning files on disk
 * may have changed (unit completion, merges, file writes).
 */
export function invalidateStateCache(): void {
  _stateCache = null;
}

/**
 * Returns the ID of the first incomplete milestone, or null if all are complete.
 */
export async function getActiveMilestoneId(basePath: string): Promise<string | null> {
  // Parallel worker isolation
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  if (milestoneLock) {
    const milestoneIds = findMilestoneIds(basePath);
    if (!milestoneIds.includes(milestoneLock)) return null;
    const lockedParked = resolveMilestoneFile(basePath, milestoneLock, "PARKED");
    if (lockedParked) return null;
    return milestoneLock;
  }

  // DB-first: query milestones table for the first non-complete, non-parked milestone
  if (isDbAvailable()) {
    const allMilestones = getAllMilestones();
    if (allMilestones.length > 0) {
      // Respect queue-order.json so /gsd queue reordering is honored (#2556).
      // Without this, the DB path uses lexicographic sort while the dispatch
      // guard uses queue order — causing a deadlock.
      const customOrder = loadQueueOrder(basePath);
      const sortedIds = sortByQueueOrder(allMilestones.map(m => m.id), customOrder);
      const byId = new Map(allMilestones.map(m => [m.id, m]));
      for (const id of sortedIds) {
        const m = byId.get(id)!;
        if (isClosedStatus(m.status) || m.status === "parked") continue;
        return m.id;
      }
      return null;
    }
  }

  // Filesystem fallback for unmigrated projects or empty DB
  const milestoneIds = findMilestoneIds(basePath);
  for (const mid of milestoneIds) {
    const parkedFile = resolveMilestoneFile(basePath, mid, "PARKED");
    if (parkedFile) continue;

    const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const content = roadmapFile ? await loadFile(roadmapFile) : null;
    if (!content) {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, loadFile)) continue;
      if (isGhostMilestone(basePath, mid)) continue;
      return mid;
    }
    const roadmap = parseRoadmap(content);
    const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
    if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, loadFile)) continue;
    if (!isMilestoneComplete(roadmap)) return mid;
    return mid;
  }
  return null;
}

/**
 * Reconstruct GSD state from DB (primary) or filesystem (fallback).
 * STATE.md is a rendered cache of this output.
 *
 * When DB is available, queries milestone/slice/task tables directly.
 * Falls back to filesystem parsing for unmigrated projects or when DB
 * has zero milestones (e.g. first run before migration).
 */
export async function deriveState(basePath: string): Promise<GSDState> {
  // Return cached result if within the TTL window for the same basePath
  if (
    _stateCache &&
    _stateCache.basePath === basePath &&
    Date.now() - _stateCache.timestamp < CACHE_TTL_MS
  ) {
    return _stateCache.result;
  }

  const stopTimer = debugTime("derive-state-impl");
  let result: GSDState;

  // Dual-path: try DB-backed derivation first when hierarchy tables are populated
  if (isDbAvailable()) {
    let dbMilestones = getAllMilestones();

    // Disk→DB reconciliation when DB is empty but disk has milestones (#2631).
    // deriveStateFromDb() does its own reconciliation, but deriveState() skips
    // it entirely when the DB is empty. Sync here so the DB path is used when
    // disk milestones exist but haven't been migrated yet.
    if (dbMilestones.length === 0) {
      const diskIds = findMilestoneIds(basePath);
      let synced = false;
      for (const diskId of diskIds) {
        if (!isGhostMilestone(basePath, diskId)) {
          insertMilestone({ id: diskId, status: 'active' });
          synced = true;
        }
      }
      if (synced) dbMilestones = getAllMilestones();
    }

    if (dbMilestones.length > 0) {
      const stopDbTimer = debugTime("derive-state-db");
      result = await deriveStateFromDb(basePath);
      stopDbTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
      _telemetry.dbDeriveCount++;
    } else {
      // DB open but no milestones on disk either — use filesystem path
      result = await _deriveStateImpl(basePath);
      _telemetry.markdownDeriveCount++;
    }
  } else {
    // Only warn when DB initialization was attempted and failed — not when
    // the DB simply hasn't been opened yet (e.g. during before_agent_start
    // context injection which runs before any tool invocation opens the DB).
    if (wasDbOpenAttempted()) {
      logWarning("state", "DB unavailable — using filesystem state derivation (degraded mode)");
    }
    result = await _deriveStateImpl(basePath);
    _telemetry.markdownDeriveCount++;
  }

  stopTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
  debugCount("deriveStateCalls");
  _stateCache = { basePath, result, timestamp: Date.now() };
  return result;
}

/**
 * Extract milestone title from CONTEXT.md or CONTEXT-DRAFT.md heading.
 * Falls back to the provided fallback (usually the milestone ID).
 */
/**
 * Strip the "M001: " prefix from a milestone title to get the human-readable name.
 * Used by both DB and filesystem paths for consistency.
 */
function stripMilestonePrefix(title: string): string {
  return title.replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, '') || title;
}

function extractContextTitle(content: string | null, fallback: string): string {
  if (!content) return fallback;
  const h1 = content.split('\n').find(line => line.startsWith('# '));
  if (!h1) return fallback;
  // Extract title from "# M005: Platform Foundation & Separation" format
  return stripMilestonePrefix(h1.slice(2).trim()) || fallback;
}

// ─── DB-backed State Derivation ────────────────────────────────────────────

// isStatusDone replaced by isClosedStatus from status-guards.ts (single source of truth).
// Alias kept for backward compatibility within this file.
const isStatusDone = isClosedStatus;

/**
 * Derive GSD state from the milestones/slices/tasks DB tables.
 * Flag files (PARKED, VALIDATION, CONTINUE, REPLAN, REPLAN-TRIGGER, CONTEXT-DRAFT)
 * are still checked on the filesystem since they aren't in DB tables.
 * Requirements also stay file-based via parseRequirementCounts().
 *
 * Must produce field-identical GSDState to _deriveStateImpl() for the same project.
 */
function reconcileDiskToDb(basePath: string): MilestoneRow[] {
  let allMilestones = getAllMilestones();
  const dbIdSet = new Set(allMilestones.map(m => m.id));
  const diskIds = findMilestoneIds(basePath);
  let synced = false;
  for (const diskId of diskIds) {
    if (!dbIdSet.has(diskId) && !isGhostMilestone(basePath, diskId)) {
      insertMilestone({ id: diskId, status: 'active' });
      synced = true;
    }
  }
  if (synced) allMilestones = getAllMilestones();

  for (const mid of diskIds) {
    if (isGhostMilestone(basePath, mid)) continue;
    const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
    if (!roadmapPath) continue;

    const dbSlices = getMilestoneSlices(mid);
    const dbSliceIds = new Set(dbSlices.map(s => s.id));

    let roadmapContent: string;
    try {
      roadmapContent = readFileSync(roadmapPath, "utf-8");
    } catch (err) {
      logWarning("state", "reconcileDiskToDb: roadmap read failed, skipping milestone", {
        mid,
        error: (err as Error).message,
      });
      continue;
    }

    const parsed = parseRoadmap(roadmapContent);
    for (const s of parsed.slices) {
      if (dbSliceIds.has(s.id)) continue;
      const summaryPath = resolveSliceFile(basePath, mid, s.id, "SUMMARY");
      const sliceStatus = (s.done || summaryPath) ? "complete" : "pending";
      insertSlice({
        id: s.id, milestoneId: mid, title: s.title,
        status: sliceStatus, risk: s.risk,
        depends: s.depends, demo: s.demo,
      });
    }

    // Reconcile stale *existing* slice rows (#3599): a slice row may exist in
    // the DB with status "pending" even though disk artifacts (SUMMARY) prove
    // completion — the same class of desync that task-level reconciliation
    // (further below) already handles.  Without this, the dependency resolver
    // builds doneSliceIds from stale DB rows and downstream slices stay blocked
    // forever with "No slice eligible".
    for (const dbSlice of dbSlices) {
      if (isStatusDone(dbSlice.status)) continue;
      const summaryPath = resolveSliceFile(basePath, mid, dbSlice.id, "SUMMARY");
      if (summaryPath) {
        try {
          updateSliceStatus(mid, dbSlice.id, "complete");
          logWarning("reconcile", `slice ${mid}/${dbSlice.id} status reconciled from "${dbSlice.status}" to "complete" (#3599)`, { mid, sid: dbSlice.id });
        } catch (e) {
          logError("reconcile", `failed to update slice ${dbSlice.id}`, { sid: dbSlice.id, error: (e as Error).message });
        }
      }
    }
  }
  return allMilestones;
}

function buildCompletenessSet(basePath: string, milestones: MilestoneRow[]) {
  const completeMilestoneIds = new Set<string>();
  const parkedMilestoneIds = new Set<string>();

  // DB-authoritative: a milestone is only "complete" when its DB row says so.
  // SUMMARY-file presence is NOT a completion signal here — an orphan SUMMARY
  // (crashed complete-milestone turn, partial merge, manual edit) must not
  // flip derived state to complete and cascade into a false auto-merge (#4179).
  for (const m of milestones) {
    const parkedFile = resolveMilestoneFile(basePath, m.id, "PARKED");
    if (parkedFile || m.status === 'parked') {
      parkedMilestoneIds.add(m.id);
      continue;
    }
    if (isStatusDone(m.status)) {
      completeMilestoneIds.add(m.id);
      continue;
    }
  }
  return { completeMilestoneIds, parkedMilestoneIds };
}

async function buildRegistryAndFindActive(
  basePath: string,
  milestones: MilestoneRow[],
  completeMilestoneIds: Set<string>,
  parkedMilestoneIds: Set<string>
) {
  const registry: MilestoneRegistryEntry[] = [];
  let activeMilestone: ActiveRef | null = null;
  let activeMilestoneSlices: SliceRow[] = [];
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;
  let firstDeferredQueuedShell: { id: string; title: string; deps: string[] } | null = null;

  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) {
      registry.push({ id: m.id, title: stripMilestonePrefix(m.title) || m.id, status: 'parked' });
      continue;
    }

    const slices = getMilestoneSlices(m.id);
    if (slices.length === 0 && !isStatusDone(m.status) && m.status !== 'queued') {
      if (isGhostMilestone(basePath, m.id)) continue;
    }

    // DB-authoritative completeness (#4179): only trust completeMilestoneIds,
    // which is itself derived from DB status. SUMMARY-file presence alone must
    // not imply completion. The summary file may still be consulted below as a
    // title source for legitimately-complete milestones whose DB row has no title.
    if (completeMilestoneIds.has(m.id)) {
      let title = stripMilestonePrefix(m.title) || m.id;
      if (!m.title) {
        const summaryFile = resolveMilestoneFile(basePath, m.id, "SUMMARY");
        if (summaryFile) {
          const summaryContent = await loadFile(summaryFile);
          if (summaryContent) {
            title = parseSummary(summaryContent).title || m.id;
          }
        }
      }
      registry.push({ id: m.id, title, status: 'complete' });
      continue;
    }

    const allSlicesDone = slices.length > 0 && slices.every(s => isStatusDone(s.status));

    let title = stripMilestonePrefix(m.title) || m.id;
    if (title === m.id) {
      const contextFile = resolveMilestoneFile(basePath, m.id, "CONTEXT");
      const draftFile = resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
      const contextContent = contextFile ? await loadFile(contextFile) : null;
      const draftContent = draftFile && !contextContent ? await loadFile(draftFile) : null;
      title = extractContextTitle(contextContent || draftContent, m.id);
    }

    if (!activeMilestoneFound) {
      const deps = m.depends_on;
      const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));

      if (depsUnmet) {
        registry.push({ id: m.id, title, status: 'pending', dependsOn: deps });
        continue;
      }

      if (m.status === 'queued' && slices.length === 0) {
        const contextFile = resolveMilestoneFile(basePath, m.id, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
        if (!contextFile && !draftFile) {
          if (!firstDeferredQueuedShell) {
            firstDeferredQueuedShell = { id: m.id, title, deps };
          }
          registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
          continue;
        }
      }

      if (allSlicesDone) {
        const validationFile = resolveMilestoneFile(basePath, m.id, "VALIDATION");
        const validationContent = validationFile ? await loadFile(validationFile) : null;
        const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;

        // DB-authoritative (#4179): completeness is already decided by
        // completeMilestoneIds above. If we reached this branch, the DB says
        // the milestone is NOT complete — so any SUMMARY file on disk is an
        // orphan (crashed complete-milestone, partial merge, manual edit) and
        // must not short-circuit this path. When validation is terminal, fall
        // through to the default active-push below so `complete-milestone` can
        // re-run idempotently.
        if (!validationTerminal) {
          activeMilestone = { id: m.id, title };
          activeMilestoneSlices = slices;
          activeMilestoneFound = true;
          registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
          continue;
        }
      }

      const contextFile = resolveMilestoneFile(basePath, m.id, "CONTEXT");
      const draftFile = resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
      if (!contextFile && draftFile) activeMilestoneHasDraft = true;

      activeMilestone = { id: m.id, title };
      activeMilestoneSlices = slices;
      activeMilestoneFound = true;
      registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    } else {
      const deps = m.depends_on;
      registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    }
  }

  if (!activeMilestoneFound && firstDeferredQueuedShell) {
    const shell = firstDeferredQueuedShell;
    activeMilestone = { id: shell.id, title: shell.title };
    activeMilestoneSlices = [];
    activeMilestoneFound = true;
    const entry = registry.find(e => e.id === shell.id);
    if (entry) entry.status = 'active';
  }

  return { registry, activeMilestone, activeMilestoneSlices, activeMilestoneHasDraft };
}

function handleNoActiveMilestone(
  registry: MilestoneRegistryEntry[],
  requirements: any,
  milestoneProgress: { done: number, total: number }
): GSDState {
  const pendingEntries = registry.filter(e => e.status === 'pending');
  const parkedEntries = registry.filter(e => e.status === 'parked');

  if (pendingEntries.length > 0) {
    const blockerDetails = pendingEntries
      .filter(e => e.dependsOn && e.dependsOn.length > 0)
      .map(e => `${e.id} is waiting on unmet deps: ${e.dependsOn!.join(', ')}`);
    return {
      activeMilestone: null, activeSlice: null, activeTask: null,
      phase: 'blocked',
      recentDecisions: [], blockers: blockerDetails.length > 0
        ? blockerDetails
        : ['All remaining milestones are dep-blocked but no deps listed — check CONTEXT.md files'],
      nextAction: 'Resolve milestone dependencies before proceeding.',
      registry, requirements,
      progress: { milestones: milestoneProgress },
    };
  }

  if (parkedEntries.length > 0) {
    const parkedIds = parkedEntries.map(e => e.id).join(', ');
    return {
      activeMilestone: null, activeSlice: null, activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [], blockers: [],
      nextAction: `All remaining milestones are parked (${parkedIds}). Run /gsd unpark <id> or create a new milestone.`,
      registry, requirements,
      progress: { milestones: milestoneProgress },
    };
  }

  if (registry.length === 0) {
    return {
      activeMilestone: null, activeSlice: null, activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [], blockers: [],
      nextAction: 'No milestones found. Run /gsd to create one.',
      registry: [], requirements,
      progress: { milestones: { done: 0, total: 0 } },
    };
  }

  const lastEntry = registry[registry.length - 1];
  const activeReqs = requirements.active ?? 0;
  const completionNote = activeReqs > 0
    ? `All milestones complete. ${activeReqs} active requirement${activeReqs === 1 ? '' : 's'} in REQUIREMENTS.md ${activeReqs === 1 ? 'has' : 'have'} not been mapped to a milestone.`
    : 'All milestones complete.';
  return {
    activeMilestone: null,
    lastCompletedMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
    activeSlice: null, activeTask: null,
    phase: 'complete',
    recentDecisions: [], blockers: [],
    nextAction: completionNote,
    registry, requirements,
    progress: { milestones: milestoneProgress },
  };
}

async function handleAllSlicesDone(
  basePath: string,
  activeMilestone: ActiveRef,
  registry: MilestoneRegistryEntry[],
  requirements: any,
  milestoneProgress: { done: number, total: number },
  sliceProgress: { done: number, total: number }
): Promise<GSDState> {
  const validationFile = resolveMilestoneFile(basePath, activeMilestone.id, "VALIDATION");
  const validationContent = validationFile ? await loadFile(validationFile) : null;
  const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
  const verdict = validationContent ? extractVerdict(validationContent) : undefined;

  if (!validationTerminal) {
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'validating-milestone',
      recentDecisions: [], blockers: [],
      nextAction: `Validate milestone ${activeMilestone.id} before completion.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  // All roadmap slices are done (enforced by caller) and verdict is
  // needs-remediation — remediation cannot progress without new slices.
  // Return blocked instead of re-dispatching validate-milestone (#4506).
  if (verdict === 'needs-remediation') {
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'blocked',
      recentDecisions: [],
      blockers: [
        `Milestone ${activeMilestone.id} validation verdict is needs-remediation but all slices are complete. ` +
          `Add remediation slices via gsd_reassess_roadmap or override the verdict manually.`,
      ],
      nextAction: `Resolve ${activeMilestone.id} remediation before proceeding.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  return {
    activeMilestone, activeSlice: null, activeTask: null,
    phase: 'completing-milestone',
    recentDecisions: [], blockers: [],
    nextAction: `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
    registry, requirements,
    progress: { milestones: milestoneProgress, slices: sliceProgress },
  };
}

function resolveSliceDependencies(activeMilestoneSlices: SliceRow[]): { activeSlice: ActiveRef | null, activeSliceRow: SliceRow | null } {
  const doneSliceIds = new Set(
    activeMilestoneSlices.filter(s => isStatusDone(s.status)).map(s => s.id)
  );

  const sliceLock = process.env.GSD_SLICE_LOCK;
  if (sliceLock) {
    const lockedSlice = activeMilestoneSlices.find(s => s.id === sliceLock);
    if (lockedSlice) {
      return { activeSlice: { id: lockedSlice.id, title: lockedSlice.title }, activeSliceRow: lockedSlice };
    } else {
      logWarning("state", `GSD_SLICE_LOCK=${sliceLock} not found in active slices — worker has no assigned work`);
      return { activeSlice: null, activeSliceRow: null };
    }
  }

  let bestFallback: SliceRow | null = null;
  let bestFallbackSatisfied = -1;

  for (const s of activeMilestoneSlices) {
    if (isStatusDone(s.status)) continue;
    if (isDeferredStatus(s.status)) continue;
    if (s.depends.every(dep => doneSliceIds.has(dep))) {
      return { activeSlice: { id: s.id, title: s.title }, activeSliceRow: s };
    }
    const satisfied = s.depends.filter(dep => doneSliceIds.has(dep)).length;
    if (satisfied > bestFallbackSatisfied || (satisfied === bestFallbackSatisfied && !bestFallback)) {
      bestFallback = s;
      bestFallbackSatisfied = satisfied;
    }
  }

  if (bestFallback) {
    const unmet = bestFallback.depends.filter(dep => !doneSliceIds.has(dep));
    logWarning(
      "state",
      `No slice has all deps satisfied — falling back to ${bestFallback.id} ` +
        `(${bestFallbackSatisfied}/${bestFallback.depends.length} deps met, ` +
        `unmet: ${unmet.join(", ")})`,
      { mid: activeMilestoneSlices[0]?.milestone_id, sid: bestFallback.id },
    );
    return { activeSlice: { id: bestFallback.id, title: bestFallback.title }, activeSliceRow: bestFallback };
  }

  return { activeSlice: null, activeSliceRow: null };
}

async function reconcileSliceTasks(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  planFile: string
): Promise<TaskRow[]> {
  let tasks = getSliceTasks(milestoneId, sliceId);

  if (tasks.length === 0 && planFile) {
    try {
      const planContent = await loadFile(planFile);
      if (planContent) {
        const diskPlan = parsePlan(planContent);
        if (diskPlan.tasks.length > 0) {
          for (let i = 0; i < diskPlan.tasks.length; i++) {
            const t = diskPlan.tasks[i];
            try {
              insertTask({
                id: t.id,
                sliceId,
                milestoneId,
                title: t.title,
                status: t.done ? 'complete' : 'pending',
                sequence: i + 1,
              });
            } catch (insertErr) {
              logWarning("reconcile", `failed to insert task ${t.id} from plan file: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}`);
            }
          }
          tasks = getSliceTasks(milestoneId, sliceId);
          logWarning("reconcile", `imported ${tasks.length} tasks from plan file for ${milestoneId}/${sliceId} — DB was empty (#3600)`, { mid: milestoneId, sid: sliceId });
        }
      }
    } catch (err) {
      logError("reconcile", `plan-file task import failed for ${milestoneId}/${sliceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let reconciled = false;
  for (const t of tasks) {
    if (isStatusDone(t.status)) continue;
    const summaryPath = resolveTaskFile(basePath, milestoneId, sliceId, t.id, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) {
      try {
        updateTaskStatus(milestoneId, sliceId, t.id, "complete", new Date().toISOString());
        logWarning("reconcile", `task ${milestoneId}/${sliceId}/${t.id} status reconciled from "${t.status}" to "complete" (#2514)`, { mid: milestoneId, sid: sliceId, tid: t.id });
        reconciled = true;
      } catch (e) {
        logError("reconcile", `failed to update task ${t.id}`, { tid: t.id, error: (e as Error).message });
      }
    }
  }
  if (reconciled) {
    tasks = getSliceTasks(milestoneId, sliceId);
  }
  return tasks;
}

async function detectBlockers(basePath: string, milestoneId: string, sliceId: string, tasks: TaskRow[]): Promise<string | null> {
  const completedTasks = tasks.filter(t => isStatusDone(t.status));
  for (const ct of completedTasks) {
    if (ct.blocker_discovered) {
      return ct.id;
    }
    const summaryFile = resolveTaskFile(basePath, milestoneId, sliceId, ct.id, "SUMMARY");
    if (!summaryFile) continue;
    const summaryContent = await loadFile(summaryFile);
    if (!summaryContent) continue;
    const summary = parseSummary(summaryContent);
    if (summary.frontmatter.blocker_discovered) {
      return ct.id;
    }
  }
  return null;
}

function checkReplanTrigger(basePath: string, milestoneId: string, sliceId: string): boolean {
  const sliceRow = getSlice(milestoneId, sliceId);
  const dbTriggered = !!sliceRow?.replan_triggered_at;
  const diskTriggered = !dbTriggered &&
    !!resolveSliceFile(basePath, milestoneId, sliceId, "REPLAN-TRIGGER");
  return dbTriggered || diskTriggered;
}

async function checkInterruptedWork(basePath: string, milestoneId: string, sliceId: string): Promise<boolean> {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  const continueFile = sDir ? resolveSliceFile(basePath, milestoneId, sliceId, "CONTINUE") : null;
  return !!(continueFile && await loadFile(continueFile)) ||
    !!(sDir && await loadFile(join(sDir, "continue.md")));
}

export async function deriveStateFromDb(basePath: string): Promise<GSDState> {
  const requirements = parseRequirementCounts(await loadFile(resolveGsdRootFile(basePath, "REQUIREMENTS")));

  let allMilestones = reconcileDiskToDb(basePath);

  const customOrder = loadQueueOrder(basePath);
  const sortedIds = sortByQueueOrder(allMilestones.map(m => m.id), customOrder);
  const byId = new Map(allMilestones.map(m => [m.id, m]));
  allMilestones.length = 0;
  for (const id of sortedIds) allMilestones.push(byId.get(id)!);

  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  const milestones = milestoneLock
    ? allMilestones.filter(m => m.id === milestoneLock)
    : allMilestones;

  if (milestones.length === 0) {
    return {
      activeMilestone: null, activeSlice: null, activeTask: null,
      phase: 'pre-planning', recentDecisions: [], blockers: [],
      nextAction: 'No milestones found. Run /gsd to create one.',
      registry: [], requirements,
      progress: { milestones: { done: 0, total: 0 } },
    };
  }

  const { completeMilestoneIds, parkedMilestoneIds } = buildCompletenessSet(basePath, milestones);
  
  const registryContext = await buildRegistryAndFindActive(basePath, milestones, completeMilestoneIds, parkedMilestoneIds);
  const { registry, activeMilestone, activeMilestoneSlices, activeMilestoneHasDraft } = registryContext;
  
  const milestoneProgress = {
    done: registry.filter(e => e.status === 'complete').length,
    total: registry.length,
  };

  if (!activeMilestone) {
    return handleNoActiveMilestone(registry, requirements, milestoneProgress);
  }

  const hasRoadmap = resolveMilestoneFile(basePath, activeMilestone.id, "ROADMAP") !== null;

  if (activeMilestoneSlices.length === 0) {
    if (!hasRoadmap) {
      const phase = activeMilestoneHasDraft ? 'needs-discussion' as const : 'pre-planning' as const;
      const nextAction = activeMilestoneHasDraft
        ? `Discuss draft context for milestone ${activeMilestone.id}.`
        : `Plan milestone ${activeMilestone.id}.`;
      return {
        activeMilestone, activeSlice: null, activeTask: null,
        phase, recentDecisions: [], blockers: [],
        nextAction, registry, requirements,
        progress: { milestones: milestoneProgress },
      };
    }

    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'pre-planning', recentDecisions: [], blockers: [],
      nextAction: `Milestone ${activeMilestone.id} has a roadmap but no slices defined. Add slices to the roadmap.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: { done: 0, total: 0 } },
    };
  }

  const allSlicesDone = activeMilestoneSlices.every(s => isStatusDone(s.status));
  const sliceProgress = {
    done: activeMilestoneSlices.filter(s => isStatusDone(s.status)).length,
    total: activeMilestoneSlices.length,
  };

  if (allSlicesDone) {
    return handleAllSlicesDone(basePath, activeMilestone, registry, requirements, milestoneProgress, sliceProgress);
  }

  // ADR-011 auto-heal: if a slice has a PLAN on disk but is still flagged is_sketch=1
  // (e.g. a crash between plan-slice write and the sketch flip), reconcile before
  // running phase derivation so the flag doesn't misroute state.
  autoHealSketchFlags(activeMilestone.id, (sid) =>
    !!resolveSliceFile(basePath, activeMilestone.id, sid, "PLAN"),
  );
  // Re-read slices after auto-heal so downstream reads see fresh is_sketch values.
  const healedSlices = getMilestoneSlices(activeMilestone.id);
  const activeSliceContext = resolveSliceDependencies(healedSlices);
  if (!activeSliceContext.activeSlice) {
    // If locked slice wasn't found, it returns null but logs warning, we need to return 'blocked'
    if (process.env.GSD_SLICE_LOCK) {
      return {
        activeMilestone, activeSlice: null, activeTask: null,
        phase: 'blocked', recentDecisions: [], blockers: [`GSD_SLICE_LOCK=${process.env.GSD_SLICE_LOCK} not found in active milestone slices`],
        nextAction: 'Slice lock references a non-existent slice — check orchestrator dispatch.',
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress },
      };
    }
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'blocked', recentDecisions: [], blockers: ['No slice eligible — check dependency ordering'],
      nextAction: 'Resolve dependency blockers or plan next slice.',
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }
  const { activeSlice, activeSliceRow } = activeSliceContext;

  const planFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "PLAN");
  if (!planFile) {
    // ADR-011: sketch slices with progressive_planning enabled enter the
    // `refining` phase — a refine-slice unit expands the sketch into a full plan
    // before execution. When the flag is off, sketches are indistinguishable
    // from a missing plan and fall through to the normal `planning` phase.
    const progressive = loadEffectiveGSDPreferences()?.preferences?.phases?.progressive_planning === true;
    if (progressive && activeSliceRow?.is_sketch === 1) {
      return {
        activeMilestone, activeSlice, activeTask: null,
        phase: 'refining', recentDecisions: [], blockers: [],
        nextAction: `Refine sketch slice ${activeSlice.id} (${activeSlice.title}) using prior slice context.`,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress },
      };
    }
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'planning', recentDecisions: [], blockers: [],
      nextAction: `Plan slice ${activeSlice.id} (${activeSlice.title}).`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  const tasks = await reconcileSliceTasks(basePath, activeMilestone.id, activeSlice.id, planFile);
  
  const taskProgress = {
    done: tasks.filter(t => isStatusDone(t.status)).length,
    total: tasks.length,
  };

  const activeTaskRow = tasks.find(t => !isStatusDone(t.status));

  if (!activeTaskRow && tasks.length > 0) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'summarizing', recentDecisions: [], blockers: [],
      nextAction: `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  if (!activeTaskRow) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'planning', recentDecisions: [], blockers: [],
      nextAction: `Slice ${activeSlice.id} has a plan file but no tasks. Add tasks to the plan.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  const activeTask: ActiveRef = { id: activeTaskRow.id, title: activeTaskRow.title };

  const tasksDir = resolveTasksDir(basePath, activeMilestone.id, activeSlice.id);
  if (tasksDir && existsSync(tasksDir) && tasks.length > 0) {
    const allFiles = readdirSync(tasksDir).filter(f => f.endsWith(".md"));
    if (allFiles.length === 0) {
      return {
        activeMilestone, activeSlice, activeTask: null,
        phase: 'planning', recentDecisions: [], blockers: [],
        nextAction: `Task plan files missing for ${activeSlice.id}. Run plan-slice to generate task plans.`,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
      };
    }
  }

  // ── Quality gate evaluation check ──────────────────────────────────
  // Pause before execution only when gates owned by the `gate-evaluate`
  // turn (Q3/Q4) are still pending. Q8 is also `scope:"slice"` but is
  // owned by `complete-slice`, so it must NOT block the evaluating-gates
  // phase — otherwise auto-loop stalls forever waiting for a gate that
  // this turn never evaluates. See gate-registry.ts for the ownership map.
  // Slices with zero gate rows (pre-feature or simple) skip straight through.
  const pendingGateCount = getPendingGateCountForTurn(
    activeMilestone.id,
    activeSlice.id,
    "gate-evaluate",
  );
  if (pendingGateCount > 0) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'evaluating-gates', recentDecisions: [], blockers: [],
      nextAction: `Evaluate ${pendingGateCount} quality gate(s) for ${activeSlice.id} before execution.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  const blockerTaskId = await detectBlockers(basePath, activeMilestone.id, activeSlice.id, tasks);
  if (blockerTaskId) {
    const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
    if (replanHistory.length === 0) {
      return {
        activeMilestone, activeSlice, activeTask,
        phase: 'replanning-slice', recentDecisions: [],
        blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
        nextAction: `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
        activeWorkspace: undefined,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
      };
    }
  }

  // ADR-011 Phase 2: pause-on-escalation takes precedence over dispatching the
  // next task. `awaiting_review` tasks (continueWithDefault=true) are NOT
  // surfaced here — they let the loop continue.
  //
  // We do NOT gate this on `phases.mid_execution_escalation` — creation of
  // new escalations is gated at the write site (tools/complete-task.ts:315),
  // but any escalation_pending row already persisted in the DB must be
  // honored even if the user later toggles the flag off. Otherwise those
  // rows would silently orphan, the loop would advance past the paused task,
  // and the user's prior resolution never lands.
  const escalatingTaskId = detectPendingEscalation(tasks, basePath);
  if (escalatingTaskId) {
    return {
      activeMilestone, activeSlice, activeTask,
      phase: 'escalating-task', recentDecisions: [],
      blockers: [`Task ${escalatingTaskId} requires a user decision before the loop can proceed`],
      nextAction: `Run /gsd escalate show ${escalatingTaskId} to review, then /gsd escalate resolve ${escalatingTaskId} <choice> to proceed.`,
      activeWorkspace: undefined,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  if (!blockerTaskId) {
    const isTriggered = checkReplanTrigger(basePath, activeMilestone.id, activeSlice.id);
    if (isTriggered) {
      const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
      if (replanHistory.length === 0) {
        return {
          activeMilestone, activeSlice, activeTask,
          phase: 'replanning-slice', recentDecisions: [],
          blockers: ['Triage replan trigger detected — slice replan required'],
          nextAction: `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,
          activeWorkspace: undefined,
          registry, requirements,
          progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
        };
      }
    }
  }

  const hasInterrupted = await checkInterruptedWork(basePath, activeMilestone.id, activeSlice.id);

  return {
    activeMilestone, activeSlice, activeTask,
    phase: 'executing', recentDecisions: [], blockers: [],
    nextAction: hasInterrupted
      ? `Resume interrupted work on ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}. Read continue.md first.`
      : `Execute ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}.`,
    registry, requirements,
    progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
  };
}


// LEGACY: Filesystem-based state derivation for unmigrated projects.
// DB-backed projects use deriveStateFromDb() above. Target: extract to
// state-legacy.ts when all projects are DB-backed.
export async function _deriveStateImpl(basePath: string): Promise<GSDState> {
  const diskIds = findMilestoneIds(basePath);
  const customOrder = loadQueueOrder(basePath);
  const milestoneIds = sortByQueueOrder(diskIds, customOrder);

  // ── Parallel worker isolation ──────────────────────────────────────────
  // When GSD_MILESTONE_LOCK is set, this process is a parallel worker
  // scoped to a single milestone. Filter the milestone list so this worker
  // only sees its assigned milestone (all others are treated as if they
  // don't exist). This gives each worker complete isolation without
  // modifying any other state derivation logic.
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  if (milestoneLock && milestoneIds.includes(milestoneLock)) {
    milestoneIds.length = 0;
    milestoneIds.push(milestoneLock);
  }

  // ── Batch-parse file cache ──────────────────────────────────────────────
  // When the native Rust parser is available, read every .md file under .gsd/
  // in one call and build an in-memory content map keyed by absolute path.
  // This eliminates O(N) individual fs.readFile calls during traversal.
  const fileContentCache = new Map<string, string>();
  const gsdDir = gsdRoot(basePath);

  // Filesystem fallback: used when deriveStateFromDb() is not available
  // (pre-migration projects). The DB-backed path is preferred when available
  // — see deriveStateFromDb() above.
  const batchFiles = nativeBatchParseGsdFiles(gsdDir);
  if (batchFiles) {
    for (const f of batchFiles) {
      const absPath = resolve(gsdDir, f.path);
      fileContentCache.set(absPath, f.rawContent);
    }
  }

  /**
   * Load file content from batch cache first, falling back to disk read.
   * Resolves the path to absolute before cache lookup.
   */
  async function cachedLoadFile(path: string): Promise<string | null> {
    const abs = resolve(path);
    const cached = fileContentCache.get(abs);
    if (cached !== undefined) return cached;
    return loadFile(path);
  }

  const requirements = parseRequirementCounts(await cachedLoadFile(resolveGsdRootFile(basePath, "REQUIREMENTS")));

  if (milestoneIds.length === 0) {
    return {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [],
      blockers: [],
      nextAction: 'No milestones found. Run /gsd to create one.',
      registry: [],
      requirements,
      progress: {
        milestones: { done: 0, total: 0 },
      },
    };
  }

  // ── Single-pass milestone scan ──────────────────────────────────────────
  // Parse each milestone's roadmap once, caching results. First pass determines
  // completeness for dependency resolution; second pass builds the registry.
  // With the batch cache, all file reads hit memory instead of disk.

  // Phase 1: Build roadmap cache and completeness set
  const roadmapCache = new Map<string, Roadmap>();
  const completeMilestoneIds = new Set<string>();

  // Track parked milestone IDs so Phase 2 can check without re-reading disk
  const parkedMilestoneIds = new Set<string>();

  for (const mid of milestoneIds) {
    // Skip parked milestones — they do NOT count as complete (don't satisfy depends_on)
    // But still parse their roadmap for title extraction in Phase 2.
    const parkedFile = resolveMilestoneFile(basePath, mid, "PARKED");
    if (parkedFile) {
      parkedMilestoneIds.add(mid);
      // Cache roadmap for title extraction (but don't add to completeMilestoneIds)
      const prf = resolveMilestoneFile(basePath, mid, "ROADMAP");
      const prc = prf ? await cachedLoadFile(prf) : null;
      if (prc) roadmapCache.set(mid, parseRoadmap(prc));
      continue;
    }

    const rf = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const rc = rf ? await cachedLoadFile(rf) : null;
    if (!rc) {
      const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (sf && await isTerminalMilestoneSummaryFile(sf, cachedLoadFile)) completeMilestoneIds.add(mid);
      continue;
    }
    const rmap = parseRoadmap(rc);
    roadmapCache.set(mid, rmap);
    if (!isMilestoneComplete(rmap)) {
      // Summary is the terminal artifact — if it exists, the milestone is
      // complete even when roadmap checkboxes weren't ticked (#864).
      const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (sf && await isTerminalMilestoneSummaryFile(sf, cachedLoadFile)) completeMilestoneIds.add(mid);
      continue;
    }
    const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
    if (sf && await isTerminalMilestoneSummaryFile(sf, cachedLoadFile)) completeMilestoneIds.add(mid);
  }

  // Phase 2: Build registry using cached roadmaps (no re-parsing or re-reading)
  const registry: MilestoneRegistryEntry[] = [];
  let activeMilestone: ActiveRef | null = null;
  let activeRoadmap: Roadmap | null = null;
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;

  for (const mid of milestoneIds) {
    // Skip parked milestones — register them as 'parked' and move on
    if (parkedMilestoneIds.has(mid)) {
      const roadmap = roadmapCache.get(mid) ?? null;
      const title = roadmap
        ? stripMilestonePrefix(roadmap.title)
        : mid;
      registry.push({ id: mid, title, status: 'parked' });
      continue;
    }

    const roadmap = roadmapCache.get(mid) ?? null;

    if (!roadmap) {
      // No roadmap — check if a summary exists (completed milestone without roadmap)
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile) {
        const summaryContent = await cachedLoadFile(summaryFile);
        if (summaryContent != null && isTerminalMilestoneSummaryContent(summaryContent)) {
          const summaryTitle = summaryContent
            ? (parseSummary(summaryContent).title || mid)
            : mid;
          registry.push({ id: mid, title: summaryTitle, status: 'complete' });
          completeMilestoneIds.add(mid);
          continue;
        }
      }
      // Ghost milestone (only META.json, no CONTEXT/ROADMAP/SUMMARY) — skip entirely
      if (isGhostMilestone(basePath, mid)) continue;

      // No roadmap and no summary — treat as incomplete/active
      if (!activeMilestoneFound) {
        // Check for CONTEXT-DRAFT.md to distinguish draft-seeded from blank milestones.
        // A draft seed means the milestone has discussion material but no full context yet.
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        if (!contextFile && draftFile) activeMilestoneHasDraft = true;

        // Extract title from CONTEXT.md or CONTEXT-DRAFT.md heading before falling back to mid.
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const title = extractContextTitle(contextContent || draftContent, mid);

        // Check milestone-level dependencies before promoting to active.
        // Without this, a queued milestone with depends_on in its CONTEXT
        // or CONTEXT-DRAFT frontmatter would be promoted to active even when
        // its deps are unmet. Fall back to CONTEXT-DRAFT.md when absent (#1724).
        const deps = parseContextDependsOn(contextContent ?? draftContent);
        const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));
        if (depsUnmet) {
          registry.push({ id: mid, title, status: 'pending', dependsOn: deps });
        } else {
          activeMilestone = { id: mid, title };
          activeMilestoneFound = true;
          registry.push({ id: mid, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
        }
      } else {
        // For milestones after the active one, also try to extract title from context files.
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const title = extractContextTitle(contextContent || draftContent, mid);
        registry.push({ id: mid, title, status: 'pending' });
      }
      continue;
    }

    const title = stripMilestonePrefix(roadmap.title);
    const complete = isMilestoneComplete(roadmap);

    if (complete) {
      // All slices done — check validation and summary state
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      const validationFile = resolveMilestoneFile(basePath, mid, "VALIDATION");
      const validationContent = validationFile ? await cachedLoadFile(validationFile) : null;
      const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
      const verdict = validationContent ? extractVerdict(validationContent) : undefined;
      // needs-remediation is terminal but requires re-validation (#3596)
      const needsRevalidation = !validationTerminal || verdict === 'needs-remediation';

      if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, cachedLoadFile)) {
        // Summary exists → milestone is complete regardless of validation state.
        // The summary is the terminal artifact (#864).
        registry.push({ id: mid, title, status: 'complete' });
      } else if (needsRevalidation && !activeMilestoneFound) {
        // No summary and needs (re-)validation → validating-milestone
        activeMilestone = { id: mid, title };
        activeRoadmap = roadmap;
        activeMilestoneFound = true;
        registry.push({ id: mid, title, status: 'active' });
      } else if (needsRevalidation && activeMilestoneFound) {
        // Needs (re-)validation, but another milestone is already active
        registry.push({ id: mid, title, status: 'pending' });
      } else if (!activeMilestoneFound) {
        // Terminal validation (pass/needs-attention) but no summary → completing-milestone
        activeMilestone = { id: mid, title };
        activeRoadmap = roadmap;
        activeMilestoneFound = true;
        registry.push({ id: mid, title, status: 'active' });
      } else {
        registry.push({ id: mid, title, status: 'complete' });
      }
    } else {
      // Roadmap slices not all checked — but if a summary exists, the milestone
      // is still complete. The summary is the terminal artifact (#864).
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, cachedLoadFile)) {
        registry.push({ id: mid, title, status: 'complete' });
      } else if (!activeMilestoneFound) {
        // Check milestone-level dependencies before promoting to active.
        // Fall back to CONTEXT-DRAFT.md when CONTEXT.md is absent (#1724).
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const deps = parseContextDependsOn(contextContent ?? draftContent);
        const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));
        if (depsUnmet) {
          registry.push({ id: mid, title, status: 'pending', dependsOn: deps });
          // Do NOT set activeMilestoneFound — let the loop continue to the next milestone
        } else {
          activeMilestone = { id: mid, title };
          activeRoadmap = roadmap;
          activeMilestoneFound = true;
          registry.push({ id: mid, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
        }
      } else {
        const contextFile2 = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFileForDeps3 = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextOrDraftContent3 = contextFile2
            ? await cachedLoadFile(contextFile2)
            : (draftFileForDeps3 ? await cachedLoadFile(draftFileForDeps3) : null);
        const deps2 = parseContextDependsOn(contextOrDraftContent3);
        registry.push({ id: mid, title, status: 'pending', ...(deps2.length > 0 ? { dependsOn: deps2 } : {}) });
      }
    }
  }

  const milestoneProgress = {
    done: registry.filter(entry => entry.status === 'complete').length,
    total: registry.length,
  };

  if (!activeMilestone) {
    // Check whether any milestones are pending (dep-blocked) or parked
    const pendingEntries = registry.filter(entry => entry.status === 'pending');
    const parkedEntries = registry.filter(entry => entry.status === 'parked');
    if (pendingEntries.length > 0) {
      // All incomplete milestones are dep-blocked — no progress possible
      const blockerDetails = pendingEntries
        .filter(entry => entry.dependsOn && entry.dependsOn.length > 0)
        .map(entry => `${entry.id} is waiting on unmet deps: ${entry.dependsOn!.join(', ')}`);
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: 'blocked',
        recentDecisions: [],
        blockers: blockerDetails.length > 0
          ? blockerDetails
          : ['All remaining milestones are dep-blocked but no deps listed — check CONTEXT.md files'],
        nextAction: 'Resolve milestone dependencies before proceeding.',
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
        },
      };
    }
    if (parkedEntries.length > 0) {
      // All non-complete milestones are parked — nothing active, but not "all complete"
      const parkedIds = parkedEntries.map(e => e.id).join(', ');
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: 'pre-planning',
        recentDecisions: [],
        blockers: [],
        nextAction: `All remaining milestones are parked (${parkedIds}). Run /gsd unpark <id> or create a new milestone.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
        },
      };
    }
    // All real milestones were ghosts (empty registry) → treat as pre-planning
    if (registry.length === 0) {
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: 'pre-planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'No milestones found. Run /gsd to create one.',
        registry: [],
        requirements,
        progress: {
          milestones: { done: 0, total: 0 },
        },
      };
    }
    // All milestones complete
    const lastEntry = registry[registry.length - 1];
    const activeReqs = requirements.active ?? 0;
    const completionNote = activeReqs > 0
      ? `All milestones complete. ${activeReqs} active requirement${activeReqs === 1 ? '' : 's'} in REQUIREMENTS.md ${activeReqs === 1 ? 'has' : 'have'} not been mapped to a milestone.`
      : 'All milestones complete.';
    return {
      activeMilestone: null,
      lastCompletedMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
      activeSlice: null,
      activeTask: null,
      phase: 'complete',
      recentDecisions: [],
      blockers: [],
      nextAction: completionNote,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
      },
    };
  }

  if (!activeRoadmap) {
    // Active milestone exists but has no roadmap yet.
    // If a CONTEXT-DRAFT.md seed exists, it needs discussion before planning.
    // Otherwise, it's a blank milestone ready for initial planning.
    const phase = activeMilestoneHasDraft ? 'needs-discussion' as const : 'pre-planning' as const;
    const nextAction = activeMilestoneHasDraft
      ? `Discuss draft context for milestone ${activeMilestone.id}.`
      : `Plan milestone ${activeMilestone.id}.`;
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase,
      recentDecisions: [],
      blockers: [],
      nextAction,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
      },
    };
  }

  // ── Zero-slice roadmap guard (#1785) ─────────────────────────────────
  // A stub roadmap (placeholder text, no slice definitions) has a truthy
  // roadmap object but an empty slices array. Without this check the
  // slice-finding loop below finds nothing and returns phase: "blocked".
  // An empty slices array means the roadmap still needs slice definitions,
  // so the correct phase is pre-planning.
  if (activeRoadmap.slices.length === 0) {
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [],
      blockers: [],
      nextAction: `Milestone ${activeMilestone.id} has a roadmap but no slices defined. Add slices to the roadmap.`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: { done: 0, total: 0 },
      },
    };
  }

  // Check if active milestone needs validation or completion (all slices done)
  if (isMilestoneComplete(activeRoadmap)) {
    const validationFile = resolveMilestoneFile(basePath, activeMilestone.id, "VALIDATION");
    const validationContent = validationFile ? await cachedLoadFile(validationFile) : null;
    const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
    const verdict = validationContent ? extractVerdict(validationContent) : undefined;
    const sliceProgress = {
      done: activeRoadmap.slices.length,
      total: activeRoadmap.slices.length,
    };

    // Force re-validation when VALIDATION.md is absent or non-terminal —
    // remediation slices may have completed since the stale validation was
    // written (#3596). But needs-remediation with all slices done is a dead
    // end — return blocked to avoid an infinite dispatch loop (#4506).
    if (!validationTerminal) {
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: 'validating-milestone',
        recentDecisions: [],
        blockers: [],
        nextAction: `Validate milestone ${activeMilestone.id} before completion.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
        },
      };
    }

    if (verdict === 'needs-remediation') {
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: 'blocked',
        recentDecisions: [],
        blockers: [
          `Milestone ${activeMilestone.id} validation verdict is needs-remediation but all slices are complete. ` +
            `Add remediation slices via gsd_reassess_roadmap or override the verdict manually.`,
        ],
        nextAction: `Resolve ${activeMilestone.id} remediation before proceeding.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
        },
      };
    }

    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: 'completing-milestone',
      recentDecisions: [],
      blockers: [],
      nextAction: `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
      },
    };
  }

  const sliceProgress = {
    done: activeRoadmap.slices.filter(s => s.done).length,
    total: activeRoadmap.slices.length,
  };

  // Find the active slice (first incomplete with deps satisfied)
  const doneSliceIds = new Set(activeRoadmap.slices.filter(s => s.done).map(s => s.id));
  let activeSlice: ActiveRef | null = null;

  // ── Slice-level parallel worker isolation ─────────────────────────────
  // When GSD_SLICE_LOCK is set, override activeSlice to only the locked slice.
  const sliceLockLegacy = process.env.GSD_SLICE_LOCK;
  if (sliceLockLegacy) {
    const lockedSlice = activeRoadmap.slices.find(s => s.id === sliceLockLegacy);
    if (lockedSlice) {
      activeSlice = { id: lockedSlice.id, title: lockedSlice.title };
    } else {
      logWarning("state", `GSD_SLICE_LOCK=${sliceLockLegacy} not found in active slices — worker has no assigned work`);
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: 'blocked',
        recentDecisions: [],
        blockers: [`GSD_SLICE_LOCK=${sliceLockLegacy} not found in active milestone slices`],
        nextAction: 'Slice lock references a non-existent slice — check orchestrator dispatch.',
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
        },
      };
    }
  } else {
    let bestFallbackLegacy: { id: string; title: string; depends: string[] } | null = null;
    let bestFallbackLegacySatisfied = -1;

    for (const s of activeRoadmap.slices) {
      if (s.done) continue;
      if (s.depends.every(dep => doneSliceIds.has(dep))) {
        activeSlice = { id: s.id, title: s.title };
        break;
      }
      const satisfied = s.depends.filter(dep => doneSliceIds.has(dep)).length;
      if (satisfied > bestFallbackLegacySatisfied) {
        bestFallbackLegacy = s;
        bestFallbackLegacySatisfied = satisfied;
      }
    }

    if (!activeSlice && bestFallbackLegacy) {
      const unmet = bestFallbackLegacy.depends.filter(dep => !doneSliceIds.has(dep));
      logWarning(
        "state",
        `No slice has all deps satisfied — falling back to ${bestFallbackLegacy.id} ` +
          `(${bestFallbackLegacySatisfied}/${bestFallbackLegacy.depends.length} deps met, ` +
          `unmet: ${unmet.join(", ")})`,
      );
      activeSlice = { id: bestFallbackLegacy.id, title: bestFallbackLegacy.title };
    }
  }

  if (!activeSlice) {
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: 'blocked',
      recentDecisions: [],
      blockers: ['No slice eligible — check dependency ordering'],
      nextAction: 'Resolve dependency blockers or plan next slice.',
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
      },
    };
  }

  // Check if the slice has a plan
  const planFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "PLAN");
  const slicePlanContent = planFile ? await cachedLoadFile(planFile) : null;

  if (!slicePlanContent) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: 'planning',
      recentDecisions: [],
      blockers: [],
      nextAction: `Plan slice ${activeSlice.id} (${activeSlice.title}).`,

      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
      },
    };
  }

  const slicePlan = parsePlan(slicePlanContent);

  // ── Reconcile stale task status for filesystem-based projects (#2514) ──
  // Heading-style tasks (### T01:) are always parsed as done=false by
  // parsePlan because the heading syntax has no checkbox. When the agent
  // writes a SUMMARY file but the plan's heading isn't converted to a
  // checkbox, the task appears incomplete forever — causing infinite
  // re-dispatch. Reconcile by checking SUMMARY files on disk.
  for (const t of slicePlan.tasks) {
    if (t.done) continue;
    const summaryPath = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, t.id, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) {
      t.done = true;
      logWarning("reconcile", `task ${activeMilestone.id}/${activeSlice.id}/${t.id} reconciled via SUMMARY on disk (#2514)`, { mid: activeMilestone.id, sid: activeSlice.id, tid: t.id });
    }
  }

  const taskProgress = {
    done: slicePlan.tasks.filter(t => t.done).length,
    total: slicePlan.tasks.length,
  };
  const activeTaskEntry = slicePlan.tasks.find(t => !t.done);

  if (!activeTaskEntry && slicePlan.tasks.length > 0) {
    // All tasks done but slice not marked complete
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: 'summarizing',
      recentDecisions: [],
      blockers: [],
      nextAction: `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,

      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
        tasks: taskProgress,
      },
    };
  }

  // Empty plan — no tasks defined yet, stay in planning phase
  if (!activeTaskEntry) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: 'planning',
      recentDecisions: [],
      blockers: [],
      nextAction: `Slice ${activeSlice.id} has a plan file but no tasks. Add tasks to the plan.`,

      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
        tasks: taskProgress,
      },
    };
  }

  const activeTask: ActiveRef = {
    id: activeTaskEntry.id,
    title: activeTaskEntry.title,
  };

  // ── Task plan file check (#909) ──────────────────────────────────────
  // The slice plan may reference tasks but per-task plan files may be
  // missing — e.g. when the slice plan was pre-created during roadmapping.
  // If the tasks dir exists but has literally zero files (empty dir from
  // mkdir), fall back to planning so plan-slice generates task plans.
  const tasksDir = resolveTasksDir(basePath, activeMilestone.id, activeSlice.id);
  if (tasksDir && existsSync(tasksDir) && slicePlan.tasks.length > 0) {
    const allFiles = readdirSync(tasksDir).filter(f => f.endsWith(".md"));
    if (allFiles.length === 0) {
      return {
        activeMilestone,
        activeSlice,
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: `Task plan files missing for ${activeSlice.id}. Run plan-slice to generate task plans.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
          tasks: taskProgress,
        },
      };
    }
  }

  // ── Blocker detection: scan completed task summaries ──────────────────
  // If any completed task has blocker_discovered: true and no REPLAN.md
  // exists yet, transition to replanning-slice instead of executing.
  const completedTasks = slicePlan.tasks.filter(t => t.done);
  let blockerTaskId: string | null = null;
  for (const ct of completedTasks) {
    const summaryFile = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, ct.id, "SUMMARY");
    if (!summaryFile) continue;
    const summaryContent = await cachedLoadFile(summaryFile);
    if (!summaryContent) continue;
    const summary = parseSummary(summaryContent);
    if (summary.frontmatter.blocker_discovered) {
      blockerTaskId = ct.id;
      break;
    }
  }

  if (blockerTaskId) {
    // Loop protection: if REPLAN.md already exists, a replan was already
    // performed for this slice — skip further replanning and continue executing.
    const replanFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN");
    if (!replanFile) {
      return {
        activeMilestone,
        activeSlice,
        activeTask,
        phase: 'replanning-slice',
        recentDecisions: [],
        blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
        nextAction: `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
  
        activeWorkspace: undefined,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
          tasks: taskProgress,
        },
      };
    }
    // REPLAN.md exists — loop protection: fall through to normal executing
  }

  // ── REPLAN-TRIGGER detection: triage-initiated replan ──────────────────
  // Manual `/gsd triage` writes REPLAN-TRIGGER.md when a capture is classified
  // as "replan". Detect it here and transition to replanning-slice so the
  // dispatch loop picks it up (instead of silently advancing past it).
  if (!blockerTaskId) {
    const replanTriggerFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN-TRIGGER");
    if (replanTriggerFile) {
      // Same loop protection: if REPLAN.md already exists, a replan was
      // already performed — skip further replanning and continue executing.
      const replanFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN");
      if (!replanFile) {
        return {
          activeMilestone,
          activeSlice,
          activeTask,
          phase: 'replanning-slice',
          recentDecisions: [],
          blockers: ['Triage replan trigger detected — slice replan required'],
          nextAction: `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,

          activeWorkspace: undefined,
          registry,
          requirements,
          progress: {
            milestones: milestoneProgress,
            slices: sliceProgress,
            tasks: taskProgress,
          },
        };
      }
    }
  }

  // Check for interrupted work
  const sDir = resolveSlicePath(basePath, activeMilestone.id, activeSlice.id);
  const continueFile = sDir ? resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "CONTINUE") : null;
  // Also check legacy continue.md
  const hasInterrupted = !!(continueFile && await cachedLoadFile(continueFile)) ||
    !!(sDir && await cachedLoadFile(join(sDir, "continue.md")));

  return {
    activeMilestone,
    activeSlice,
    activeTask,
    phase: 'executing',
    recentDecisions: [],
    blockers: [],
    nextAction: hasInterrupted
      ? `Resume interrupted work on ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}. Read continue.md first.`
      : `Execute ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}.`,
    registry,
    requirements,
    progress: {
      milestones: milestoneProgress,
      slices: sliceProgress,
      tasks: taskProgress,
    },
  };
}
