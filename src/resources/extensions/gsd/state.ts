// GSD Extension — State Derivation
// Reads roadmap + plan files to determine current position.
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

import { milestoneIdSort, findMilestoneIds } from './milestone-ids.js';
import { nativeBatchParseGsdFiles, type BatchParsedFile } from './native-parser-bridge.js';

import { join, resolve } from 'path';
import { existsSync, readdirSync } from 'node:fs';
import { debugCount, debugTime } from './debug-logger.js';

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
  const match = validationContent.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return false;
  const verdict = match[1].match(/verdict:\s*(\S+)/);
  if (!verdict) return false;
  const v = verdict[1] === 'passed' ? 'pass' : verdict[1];
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
  const milestoneIds = findMilestoneIds(basePath);
  // Parallel worker isolation
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  if (milestoneLock) {
    if (!milestoneIds.includes(milestoneLock)) return null;
    // Locked milestone that is parked should not be active
    const lockedParked = resolveMilestoneFile(basePath, milestoneLock, "PARKED");
    if (lockedParked) return null;
    return milestoneLock;
  }
  for (const mid of milestoneIds) {
    // Skip parked milestones — they are not eligible for active status
    const parkedFile = resolveMilestoneFile(basePath, mid, "PARKED");
    if (parkedFile) continue;

    const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const content = roadmapFile ? await loadFile(roadmapFile) : null;
    if (!content) {
      // No roadmap — but if a summary exists, the milestone is already complete
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile) continue; // completed milestone, skip
      return mid; // No roadmap and no summary — milestone is incomplete
      // Note: draft-awareness (CONTEXT-DRAFT.md) is handled in deriveState(), not here.
      // A draft milestone is still "active" — this function only determines which milestone is current.
    }
    const roadmap = parseRoadmap(content);
    if (!isMilestoneComplete(roadmap)) {
      // Summary is the terminal artifact — if it exists, the milestone is
      // complete even when roadmap checkboxes weren't ticked (#864).
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (!summaryFile) return mid;
    }
  }
  return null;
}

/**
 * Reconstruct GSD state from files on disk.
 * This is the source of truth — STATE.md is just a cache of this output.
 *
 * Uses native batch parsing when available: a single Rust call reads and parses
 * every .md file under .gsd/, populating an in-memory cache that replaces all
 * individual loadFile() calls during milestone/slice/task traversal.
 * Falls back to sequential JS file reads when the native module is absent.
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
  const result = await _deriveStateImpl(basePath);
  stopTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
  debugCount("deriveStateCalls");
  _stateCache = { basePath, result, timestamp: Date.now() };
  return result;
}

/**
 * Extract milestone title from CONTEXT.md or CONTEXT-DRAFT.md heading.
 * Falls back to the provided fallback (usually the milestone ID).
 */
function extractContextTitle(content: string | null, fallback: string): string {
  if (!content) return fallback;
  const h1 = content.split('\n').find(line => line.startsWith('# '));
  if (!h1) return fallback;
  // Extract title from "# M005: Platform Foundation & Separation" format
  return h1.slice(2).trim().replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, '') || fallback;
}

async function _deriveStateImpl(basePath: string): Promise<GSDState> {
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

  // NOTE: We intentionally do NOT load from the SQLite DB here (#759).
  // The DB's artifacts table is populated once during migrateFromMarkdown
  // and is never updated when files change on disk (e.g. roadmap [x] updates,
  // plan checkbox changes). Using stale DB content causes deriveState to
  // return incorrect phase/slice state, leading to infinite skip loops.
  // The native Rust batch parser is fast enough for state derivation.
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
        ? roadmap.title.replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, '')
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
        // frontmatter would be promoted to active even when its deps are unmet
        // (the dep check only existed in the has-roadmap path previously).
        const deps = parseContextDependsOn(contextContent);
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

    const title = roadmap.title.replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, '');
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
        // Check milestone-level dependencies before promoting to active
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const deps = parseContextDependsOn(contextContent);
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
        const contextContent2 = contextFile2 ? await cachedLoadFile(contextFile2) : null;
        const deps2 = parseContextDependsOn(contextContent2);
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
    // All milestones complete
    const lastEntry = registry[registry.length - 1];
    return {
      activeMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
      activeSlice: null,
      activeTask: null,
      phase: 'complete',
      recentDecisions: [],
      blockers: [],
      nextAction: 'All milestones complete.',
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
