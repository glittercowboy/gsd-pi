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
import { nativeBatchParseGsdFiles, type BatchParsedFile } from './native-parser-bridge.js';

import { join, resolve } from 'path';
import { existsSync, readdirSync } from 'node:fs';
import { debugCount, debugTime } from './debug-logger.js';
import { extractVerdict } from './verdict-parser.js';

import {
  isDbAvailable,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  getReplanHistory,
  getSlice,
  insertMilestone,
  updateTaskStatus,
  getPendingSliceGateCount,
  type MilestoneRow,
  type SliceRow,
  type TaskRow,
} from './gsd-db.js';

/**
 * A "ghost" milestone directory contains only META.json (and no substantive
 * files like CONTEXT, CONTEXT-DRAFT, ROADMAP, or SUMMARY).  These appear when
 * a milestone is created but never initialised.  Treating them as active causes
 * auto-mode to stall or falsely declare completion.
 */
export function isGhostMilestone(basePath: string, mid: string): boolean {
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
 * Check whether a VALIDATION file's verdict is terminal (pass or needs-attention).
 * A non-terminal verdict (needs-remediation) means validation must re-run
 * after remediation slices are executed.
 */
export function isValidationTerminal(validationContent: string): boolean {
  const v = extractVerdict(validationContent);
  if (!v) return false;
  // 'pass' and 'needs-attention' are always terminal.
  // 'needs-remediation' is treated as terminal to prevent infinite loops
  // when no remediation slices exist in the roadmap (#832). The validation
  // report is preserved on disk for manual review.
  return v === 'pass' || v === 'needs-attention' || v === 'needs-remediation';
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
        if (m.status === "complete" || m.status === "done" || m.status === "parked") continue;
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
      if (summaryFile) continue;
      if (isGhostMilestone(basePath, mid)) continue;
      return mid;
    }
    const roadmap = parseRoadmap(content);
    if (!isMilestoneComplete(roadmap)) {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (!summaryFile) return mid;
    }
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

    // Disk→DB reconciliation (#2631): when the milestones table is empty
    // (e.g. failed initial migration per #2529), the reconciliation code
    // inside deriveStateFromDb is unreachable. Populate from disk here so
    // the DB path activates correctly.
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
      // DB open but empty hierarchy tables — pre-migration project, use filesystem
      result = await _deriveStateImpl(basePath);
      _telemetry.markdownDeriveCount++;
    }
  } else {
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

/**
 * Helper: check if a DB status counts as "done" (handles K002 ambiguity).
 */
function isStatusDone(status: string): boolean {
  return status === 'complete' || status === 'done';
}

/**
 * Derive GSD state from the milestones/slices/tasks DB tables.
 * Flag files (PARKED, VALIDATION, CONTINUE, REPLAN, REPLAN-TRIGGER, CONTEXT-DRAFT)
 * are still checked on the filesystem since they aren't in DB tables.
 * Requirements also stay file-based via parseRequirementCounts().
 *
 * Must produce field-identical GSDState to _deriveStateImpl() for the same project.
 */
export async function deriveStateFromDb(basePath: string): Promise<GSDState> {
  const requirements = parseRequirementCounts(await loadFile(resolveGsdRootFile(basePath, "REQUIREMENTS")));

  let allMilestones = getAllMilestones();

  // Incremental disk→DB sync: milestone directories created outside the DB
  // write path (via /gsd queue, manual mkdir, or complete-milestone writing the
  // next CONTEXT.md) are never inserted by the initial migration guard in
  // auto-start.ts because that guard only runs when gsd.db doesn't exist yet.
  // Reconcile here so deriveStateFromDb never silently misses queued milestones.
  // insertMilestone uses INSERT OR IGNORE, so this is safe to call every time.
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

  // Reconcile: discover milestones that exist on disk but are missing from
  // the DB. This happens when milestones were created before the DB migration
  // or were manually added to the filesystem. Without this, disk-only
  // milestones are invisible after migration (#2416).
  const dbMilestoneIds = new Set(allMilestones.map(m => m.id));
  const diskMilestoneIds = findMilestoneIds(basePath);
  for (const diskId of diskMilestoneIds) {
    if (!dbMilestoneIds.has(diskId)) {
      // Synthesize a minimal MilestoneRow for the disk-only milestone.
      // Title and status will be resolved from disk files in the loop below.
      allMilestones.push({
        id: diskId,
        title: diskId,
        status: 'active',
        depends_on: [] as string[],
        created_at: new Date().toISOString(),
      } as MilestoneRow);
    }
  }
  // Re-sort so milestones follow queue order (same as dispatch guard) (#2556)
  const customOrder = loadQueueOrder(basePath);
  const sortedIds = sortByQueueOrder(allMilestones.map(m => m.id), customOrder);
  const byId = new Map(allMilestones.map(m => [m.id, m]));
  allMilestones.length = 0;
  for (const id of sortedIds) allMilestones.push(byId.get(id)!);

  // Parallel worker isolation: when locked, filter to just the locked milestone
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  const milestones = milestoneLock
    ? allMilestones.filter(m => m.id === milestoneLock)
    : allMilestones;

  if (milestones.length === 0) {
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
      progress: { milestones: { done: 0, total: 0 } },
    };
  }

  // Phase 1: Build completeness set (which milestones count as "done" for dep resolution)
  const completeMilestoneIds = new Set<string>();
  const parkedMilestoneIds = new Set<string>();

  for (const m of milestones) {
    // Check disk for PARKED flag (not stored in DB status reliably — disk is truth for flag files)
    const parkedFile = resolveMilestoneFile(basePath, m.id, "PARKED");
    if (parkedFile || m.status === 'parked') {
      parkedMilestoneIds.add(m.id);
      continue;
    }

    if (isStatusDone(m.status)) {
      completeMilestoneIds.add(m.id);
      continue;
    }

    // Check if milestone has a summary on disk (terminal artifact per #864)
    const summaryFile = resolveMilestoneFile(basePath, m.id, "SUMMARY");
    if (summaryFile) {
      completeMilestoneIds.add(m.id);
      continue;
    }

    // Check roadmap: all slices done means milestone is complete
    const slices = getMilestoneSlices(m.id);
    if (slices.length > 0 && slices.every(s => isStatusDone(s.status))) {
      // All slices done but no summary — still counts as complete for dep resolution
      // if a summary file exists
      // Note: without summary file, the milestone is in validating/completing state, not complete
    }
  }

  // Phase 2: Build registry and find active milestone
  const registry: MilestoneRegistryEntry[] = [];
  let activeMilestone: ActiveRef | null = null;
  let activeMilestoneSlices: SliceRow[] = [];
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;

  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) {
      registry.push({ id: m.id, title: stripMilestonePrefix(m.title) || m.id, status: 'parked' });
      continue;
    }

    // Ghost milestone check: no slices in DB AND no substantive files on disk
    const slices = getMilestoneSlices(m.id);
    if (slices.length === 0 && !isStatusDone(m.status)) {
      // Check disk for ghost detection
      if (isGhostMilestone(basePath, m.id)) continue;
    }

    const summaryFile = resolveMilestoneFile(basePath, m.id, "SUMMARY");

    // Determine if this milestone is complete
    if (completeMilestoneIds.has(m.id) || (summaryFile !== null)) {
      // Get title from DB or summary
      let title = stripMilestonePrefix(m.title) || m.id;
      if (summaryFile && !m.title) {
        const summaryContent = await loadFile(summaryFile);
        if (summaryContent) {
          title = parseSummary(summaryContent).title || m.id;
        }
      }
      registry.push({ id: m.id, title, status: 'complete' });
      completeMilestoneIds.add(m.id); // ensure it's in the set
      continue;
    }

    // Not complete — determine if it should be active
    const allSlicesDone = slices.length > 0 && slices.every(s => isStatusDone(s.status));

    // Get title — prefer DB, fall back to context file extraction
    let title = stripMilestonePrefix(m.title) || m.id;
    if (title === m.id) {
      const contextFile = resolveMilestoneFile(basePath, m.id, "CONTEXT");
      const draftFile = resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
      const contextContent = contextFile ? await loadFile(contextFile) : null;
      const draftContent = draftFile && !contextContent ? await loadFile(draftFile) : null;
      title = extractContextTitle(contextContent || draftContent, m.id);
    }

    if (!activeMilestoneFound) {
      // Check milestone-level dependencies
      const deps = m.depends_on;
      const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));

      if (depsUnmet) {
        registry.push({ id: m.id, title, status: 'pending', dependsOn: deps });
        continue;
      }

      // Handle all-slices-done case (validating/completing)
      if (allSlicesDone) {
        const validationFile = resolveMilestoneFile(basePath, m.id, "VALIDATION");
        const validationContent = validationFile ? await loadFile(validationFile) : null;
        const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;

        if (!validationTerminal || (validationTerminal && !summaryFile)) {
          // Validating or completing — still active
          activeMilestone = { id: m.id, title };
          activeMilestoneSlices = slices;
          activeMilestoneFound = true;
          registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
          continue;
        }
      }

      // Check for context draft (needs-discussion phase)
      const contextFile = resolveMilestoneFile(basePath, m.id, "CONTEXT");
      const draftFile = resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
      if (!contextFile && draftFile) activeMilestoneHasDraft = true;

      activeMilestone = { id: m.id, title };
      activeMilestoneSlices = slices;
      activeMilestoneFound = true;
      registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    } else {
      // After active milestone found — rest are pending
      const deps = m.depends_on;
      registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    }
  }

  const milestoneProgress = {
    done: registry.filter(e => e.status === 'complete').length,
    total: registry.length,
  };

  // ── No active milestone ──────────────────────────────────────────────
  if (!activeMilestone) {
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

    // All milestones complete
    const lastEntry = registry[registry.length - 1];
    const activeReqs = requirements.active ?? 0;
    const completionNote = activeReqs > 0
      ? `All milestones complete. ${activeReqs} active requirement${activeReqs === 1 ? '' : 's'} in REQUIREMENTS.md ${activeReqs === 1 ? 'has' : 'have'} not been mapped to a milestone.`
      : 'All milestones complete.';
    return {
      activeMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
      activeSlice: null, activeTask: null,
      phase: 'complete',
      recentDecisions: [], blockers: [],
      nextAction: completionNote,
      registry, requirements,
      progress: { milestones: milestoneProgress },
    };
  }

  // ── Active milestone has no slices or no roadmap ────────────────────
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

    // Has roadmap file but zero slices in DB — pre-planning (zero-slice roadmap guard)
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [], blockers: [],
      nextAction: `Milestone ${activeMilestone.id} has a roadmap but no slices defined. Add slices to the roadmap.`,
      registry, requirements,
      progress: {
        milestones: milestoneProgress,
        slices: { done: 0, total: 0 },
      },
    };
  }

  // ── All slices done → validating/completing ─────────────────────────
  // Guard: [].every() === true (vacuous truth). Without the length check,
  // an empty slice array causes a premature phase transition to
  // validating-milestone. See: https://github.com/gsd-build/gsd-2/issues/2667
  const allSlicesDone = activeMilestoneSlices.length > 0 && activeMilestoneSlices.every(s => isStatusDone(s.status));
  if (allSlicesDone) {
    const validationFile = resolveMilestoneFile(basePath, activeMilestone.id, "VALIDATION");
    const validationContent = validationFile ? await loadFile(validationFile) : null;
    const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
    const sliceProgress = {
      done: activeMilestoneSlices.length,
      total: activeMilestoneSlices.length,
    };

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

    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'completing-milestone',
      recentDecisions: [], blockers: [],
      nextAction: `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  // ── Find active slice (first incomplete with deps satisfied) ─────────
  const sliceProgress = {
    done: activeMilestoneSlices.filter(s => isStatusDone(s.status)).length,
    total: activeMilestoneSlices.length,
  };

  const doneSliceIds = new Set(
    activeMilestoneSlices.filter(s => isStatusDone(s.status)).map(s => s.id)
  );

  let activeSlice: ActiveRef | null = null;
  let activeSliceRow: SliceRow | null = null;

  for (const s of activeMilestoneSlices) {
    if (isStatusDone(s.status)) continue;
    if (s.depends.every(dep => doneSliceIds.has(dep))) {
      activeSlice = { id: s.id, title: s.title };
      activeSliceRow = s;
      break;
    }
  }

  if (!activeSlice) {
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'blocked',
      recentDecisions: [], blockers: ['No slice eligible — check dependency ordering'],
      nextAction: 'Resolve dependency blockers or plan next slice.',
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  // ── Check for slice plan file on disk ────────────────────────────────
  const planFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "PLAN");
  if (!planFile) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'planning',
      recentDecisions: [], blockers: [],
      nextAction: `Plan slice ${activeSlice.id} (${activeSlice.title}).`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  // ── Get tasks from DB ────────────────────────────────────────────────
  let tasks = getSliceTasks(activeMilestone.id, activeSlice.id);

  // ── Reconcile stale task status (#2514) ──────────────────────────────
  // When a session disconnects after the agent writes SUMMARY + VERIFY
  // artifacts but before postUnitPostVerification updates the DB, tasks
  // remain "pending" in the DB despite being complete on disk. Without
  // reconciliation, deriveState keeps returning the stale task as active,
  // causing the dispatcher to re-dispatch the same completed task forever.
  let reconciled = false;
  for (const t of tasks) {
    if (isStatusDone(t.status)) continue;
    const summaryPath = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, t.id, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) {
      try {
        updateTaskStatus(activeMilestone.id, activeSlice.id, t.id, "complete");
        process.stderr.write(
          `gsd-reconcile: task ${activeMilestone.id}/${activeSlice.id}/${t.id} had SUMMARY on disk but DB status was "${t.status}" — updated to "complete" (#2514)\n`,
        );
        reconciled = true;
      } catch (e) {
        // DB write failed — continue with stale status rather than crash
        process.stderr.write(
          `gsd-reconcile: failed to update task ${t.id}: ${(e as Error).message}\n`,
        );
      }
    }
  }
  // Re-fetch tasks if any were reconciled so downstream logic sees fresh status
  if (reconciled) {
    tasks = getSliceTasks(activeMilestone.id, activeSlice.id);
  }

  const taskProgress = {
    done: tasks.filter(t => isStatusDone(t.status)).length,
    total: tasks.length,
  };

  const activeTaskRow = tasks.find(t => !isStatusDone(t.status));

  if (!activeTaskRow && tasks.length > 0) {
    // All tasks done but slice not marked complete → summarizing
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'summarizing',
      recentDecisions: [], blockers: [],
      nextAction: `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  // Empty plan — no tasks defined yet
  if (!activeTaskRow) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'planning',
      recentDecisions: [], blockers: [],
      nextAction: `Slice ${activeSlice.id} has a plan file but no tasks. Add tasks to the plan.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  const activeTask: ActiveRef = { id: activeTaskRow.id, title: activeTaskRow.title };

  // ── Task plan file check (#909) ─────────────────────────────────────
  const tasksDir = resolveTasksDir(basePath, activeMilestone.id, activeSlice.id);
  if (tasksDir && existsSync(tasksDir) && tasks.length > 0) {
    const allFiles = readdirSync(tasksDir).filter(f => f.endsWith(".md"));
    if (allFiles.length === 0) {
      return {
        activeMilestone, activeSlice, activeTask: null,
        phase: 'planning',
        recentDecisions: [], blockers: [],
        nextAction: `Task plan files missing for ${activeSlice.id}. Run plan-slice to generate task plans.`,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
      };
    }
  }

  // ── Quality gate evaluation check ──────────────────────────────────
  // If slice-scoped gates (Q3/Q4) are still pending, pause before execution
  // so the gate-evaluate dispatch rule can run parallel sub-agents.
  // Slices with zero gate rows (pre-feature or simple) skip straight through.
  const pendingGateCount = getPendingSliceGateCount(activeMilestone.id, activeSlice.id);
  if (pendingGateCount > 0) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'evaluating-gates',
      recentDecisions: [], blockers: [],
      nextAction: `Evaluate ${pendingGateCount} quality gate(s) for ${activeSlice.id} before execution.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  // ── Blocker detection: check completed tasks for blocker_discovered ──
  const completedTasks = tasks.filter(t => isStatusDone(t.status));
  let blockerTaskId: string | null = null;
  for (const ct of completedTasks) {
    if (ct.blocker_discovered) {
      blockerTaskId = ct.id;
      break;
    }
    // Also check disk summary in case DB doesn't have the flag
    const summaryFile = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, ct.id, "SUMMARY");
    if (!summaryFile) continue;
    const summaryContent = await loadFile(summaryFile);
    if (!summaryContent) continue;
    const summary = parseSummary(summaryContent);
    if (summary.frontmatter.blocker_discovered) {
      blockerTaskId = ct.id;
      break;
    }
  }

  if (blockerTaskId) {
    // Loop protection: if replan_history has entries for this slice, a replan
    // was already performed — don't re-enter replanning phase.
    const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
    if (replanHistory.length === 0) {
      return {
        activeMilestone, activeSlice, activeTask,
        phase: 'replanning-slice',
        recentDecisions: [],
        blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
        nextAction: `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
        activeWorkspace: undefined,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
      };
    }
  }

  // ── REPLAN-TRIGGER detection ─────────────────────────────────────────
  if (!blockerTaskId) {
    const sliceRow = getSlice(activeMilestone.id, activeSlice.id);
    if (sliceRow?.replan_triggered_at) {
      // Loop protection: if replan_history has entries, replan was already done
      const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
      if (replanHistory.length === 0) {
        return {
          activeMilestone, activeSlice, activeTask,
          phase: 'replanning-slice',
          recentDecisions: [],
          blockers: ['Triage replan trigger detected — slice replan required'],
          nextAction: `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,
          activeWorkspace: undefined,
          registry, requirements,
          progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
        };
      }
    }
  }

  // ── Check for interrupted work ───────────────────────────────────────
  const sDir = resolveSlicePath(basePath, activeMilestone.id, activeSlice.id);
  const continueFile = sDir ? resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "CONTINUE") : null;
  const hasInterrupted = !!(continueFile && await loadFile(continueFile)) ||
    !!(sDir && await loadFile(join(sDir, "continue.md")));

  return {
    activeMilestone, activeSlice, activeTask,
    phase: 'executing',
    recentDecisions: [], blockers: [],
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
  const milestoneIds = findMilestoneIds(basePath);

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
      if (sf) completeMilestoneIds.add(mid);
      continue;
    }
    const rmap = parseRoadmap(rc);
    roadmapCache.set(mid, rmap);
    if (!isMilestoneComplete(rmap)) {
      // Summary is the terminal artifact — if it exists, the milestone is
      // complete even when roadmap checkboxes weren't ticked (#864).
      const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (sf) completeMilestoneIds.add(mid);
      continue;
    }
    const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
    if (sf) completeMilestoneIds.add(mid);
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
        const summaryTitle = summaryContent
          ? (parseSummary(summaryContent).title || mid)
          : mid;
        registry.push({ id: mid, title: summaryTitle, status: 'complete' });
        completeMilestoneIds.add(mid);
        continue;
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

      if (summaryFile) {
        // Summary exists → milestone is complete regardless of validation state.
        // The summary is the terminal artifact (#864).
        registry.push({ id: mid, title, status: 'complete' });
      } else if (!validationTerminal && !activeMilestoneFound) {
        // No summary and no terminal validation → validating-milestone
        activeMilestone = { id: mid, title };
        activeRoadmap = roadmap;
        activeMilestoneFound = true;
        registry.push({ id: mid, title, status: 'active' });
      } else if (!validationTerminal && activeMilestoneFound) {
        // No summary and no terminal validation, but another milestone is already active
        registry.push({ id: mid, title, status: 'pending' });
      } else if (!activeMilestoneFound) {
        // Terminal validation but no summary → completing-milestone
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
      if (summaryFile) {
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
      activeMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
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
    const sliceProgress = {
      done: activeRoadmap.slices.length,
      total: activeRoadmap.slices.length,
    };

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

  for (const s of activeRoadmap.slices) {
    if (s.done) continue;
    if (s.depends.every(dep => doneSliceIds.has(dep))) {
      activeSlice = { id: s.id, title: s.title };
      break;
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
      process.stderr.write(
        `gsd-reconcile: task ${activeMilestone.id}/${activeSlice.id}/${t.id} has SUMMARY on disk but plan shows incomplete — marking done (#2514)\n`,
      );
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
