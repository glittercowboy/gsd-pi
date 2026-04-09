import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { logWarning, logError } from "./workflow-logger.js";
import { readEvents, findForkPoint, getSessionId } from "./workflow-events.js";
import type { WorkflowEvent } from "./workflow-events.js";
import {
  transaction,
  updateTaskStatus,
  updateSliceStatus,
  updateMilestoneStatus,
  getSliceTasks,
  insertMilestone,
  _getAdapter,
  getMilestoneSlices,
  insertVerificationEvidence,
  upsertDecision,
  openDatabase,
  setTaskBlockerDiscovered,
} from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { invalidateStateCache } from "./state.js";
import { clearPathCache } from "./paths.js";
import { clearParseCache } from "./files.js";
import { writeManifest } from "./workflow-manifest.js";
import { atomicWriteSync } from "./atomic-write.js";
import { acquireSyncLock, releaseSyncLock } from "./sync-lock.js";

// ─── Replay Helpers ──────────────────────────────────────────────────────────

/**
 * Replay a complete_slice event with task validation.
 *
 * #2945 Bug 2: The original replay blindly called updateSliceStatus("done")
 * without checking whether all tasks in the slice are actually complete.
 * During API overload or partial execution, a complete_slice event could
 * be logged even when tasks were skipped, causing the milestone completion
 * guard to see the slice as "done" and allow premature milestone completion.
 *
 * This function validates that every task in the slice has a closed status
 * before marking the slice as done. If any task is still pending, the slice
 * status is left unchanged.
 */
export function replaySliceComplete(milestoneId: string, sliceId: string, ts: string): void {
  const tasks = getSliceTasks(milestoneId, sliceId);
  // If there are tasks and any are not closed, skip the status update
  if (tasks.length > 0) {
    const incompleteTasks = tasks.filter(t => !isClosedStatus(t.status));
    if (incompleteTasks.length > 0) {
      process.stderr.write(
        `[gsd] reconcile: skipping complete_slice replay for ${sliceId} — ` +
        `${incompleteTasks.length} task(s) still pending\n`,
      );
      return;
    }
  }
  updateSliceStatus(milestoneId, sliceId, "done", ts);
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ConflictEntry {
  entityType: string;
  entityId: string;
  mainSideEvents: WorkflowEvent[];
  worktreeSideEvents: WorkflowEvent[];
}

export interface ReconcileResult {
  autoMerged: number;
  conflicts: ConflictEntry[];
}

// ─── replayEvents ─────────────────────────────────────────────────────────────

/**
 * Replay a list of WorkflowEvents by dispatching each to the appropriate
 * gsd-db function.  This replaces the old engine.replayAll() pattern with
 * direct DB calls.
 */
function replayEvents(events: WorkflowEvent[]): void {
  transaction(() => {
  for (const event of events) {
    const p = event.params;
    // Normalize cmd format: completion tools write hyphens ("complete-task"),
    // legacy logs use underscores ("complete_task"). Accept both formats.
    // Type guard: malformed event lines with non-string cmd are skipped.
    if (typeof event.cmd !== "string") {
      logWarning("reconcile", `Event with non-string cmd skipped: ${JSON.stringify(event.cmd)}`);
      continue;
    }
    const cmd = event.cmd.replace(/-/g, "_");
    switch (cmd) {
      case "complete_task": {
        const milestoneId = p["milestoneId"] as string;
        const sliceId = p["sliceId"] as string;
        const taskId = p["taskId"] as string;
        updateTaskStatus(milestoneId, sliceId, taskId, "done", event.ts);
        break;
      }
      case "start_task": {
        const milestoneId = p["milestoneId"] as string;
        const sliceId = p["sliceId"] as string;
        const taskId = p["taskId"] as string;
        updateTaskStatus(milestoneId, sliceId, taskId, "in-progress", event.ts);
        break;
      }
      case "report_blocker": {
        const milestoneId = p["milestoneId"] as string;
        const sliceId = p["sliceId"] as string;
        const taskId = p["taskId"] as string;
        updateTaskStatus(milestoneId, sliceId, taskId, "blocked");
        setTaskBlockerDiscovered(milestoneId, sliceId, taskId, true);
        break;
      }
      case "record_verification": {
        const milestoneId = p["milestoneId"] as string;
        const sliceId = p["sliceId"] as string;
        const taskId = p["taskId"] as string;
        insertVerificationEvidence({
          taskId,
          sliceId,
          milestoneId,
          command: (p["command"] as string) ?? "",
          exitCode: (p["exitCode"] as number) ?? 0,
          verdict: (p["verdict"] as string) ?? "",
          durationMs: (p["durationMs"] as number) ?? 0,
        });
        break;
      }
      case "complete_slice": {
        const milestoneId = p["milestoneId"] as string;
        const sliceId = p["sliceId"] as string;
        // #2945 Bug 2: validate tasks before marking slice done
        replaySliceComplete(milestoneId, sliceId, event.ts);
        break;
      }
      case "complete_milestone": {
        const milestoneId = p["milestoneId"] as string;
        if (!milestoneId) break;
        // Invariant check: only mark complete if all slices are closed.
        // Without this guard, a reordered/partial event stream could close
        // a milestone while work is still incomplete.
        const mSlices = getMilestoneSlices(milestoneId);
        const allClosed = mSlices.length === 0 || mSlices.every(s => isClosedStatus(s.status));
        if (allClosed) {
          updateMilestoneStatus(milestoneId, "complete", event.ts);
        } else {
          logWarning("reconcile", `Skipping complete_milestone replay for ${milestoneId}: not all slices are closed`);
        }
        break;
      }
      case "plan_milestone": {
        // Replay milestone creation — uses INSERT OR IGNORE (gsd-db's insertMilestone is safe)
        const mId = p["milestoneId"] as string;
        if (mId) {
          insertMilestone({ id: mId, title: (p["title"] as string) ?? mId });
        }
        break;
      }
      case "plan_slice": {
        // Replay slice creation — strict INSERT OR IGNORE to avoid overwriting
        // progressed status. insertSlice() uses ON CONFLICT DO UPDATE which
        // could downgrade a completed slice back to pending.
        const milestoneId = p["milestoneId"] as string;
        const sliceId = p["sliceId"] as string;
        if (milestoneId && sliceId) {
          const adapter = _getAdapter();
          if (adapter) {
            adapter.prepare(
              `INSERT OR IGNORE INTO slices (milestone_id, id, title, status, created_at)
               VALUES (:mid, :sid, :title, 'pending', :ts)`,
            ).run({ ":mid": milestoneId, ":sid": sliceId, ":title": (p["title"] as string) ?? sliceId, ":ts": event.ts });
          }
        }
        break;
      }
      case "plan_task": {
        // Replay task creation — strict INSERT OR IGNORE to avoid overwriting
        // progressed status. insertTask() uses ON CONFLICT DO UPDATE which
        // could downgrade a done/in-progress task back to pending.
        const milestoneId = p["milestoneId"] as string;
        const sliceId = p["sliceId"] as string;
        const taskId = p["taskId"] as string;
        if (milestoneId && sliceId && taskId) {
          const adapter = _getAdapter();
          if (adapter) {
            adapter.prepare(
              `INSERT OR IGNORE INTO tasks (milestone_id, slice_id, id, title, status, created_at)
               VALUES (:mid, :sid, :tid, :title, 'pending', :ts)`,
            ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId, ":title": (p["title"] as string) ?? taskId, ":ts": event.ts });
          }
        }
        break;
      }
      case "replan_slice": {
        // Informational — replan events don't mutate DB during replay
        break;
      }
      case "save_decision": {
        upsertDecision({
          id: (p["id"] as string) ?? `${p["scope"]}:${p["decision"]}`,
          when_context: (p["when_context"] as string) ?? (p["whenContext"] as string) ?? "",
          scope: (p["scope"] as string) ?? "",
          decision: (p["decision"] as string) ?? "",
          choice: (p["choice"] as string) ?? "",
          rationale: (p["rationale"] as string) ?? "",
          revisable: (p["revisable"] as string) ?? "yes",
          made_by: ((p["made_by"] as string) ?? (p["madeBy"] as string) ?? "agent") as "agent",
          superseded_by: (p["superseded_by"] as string) ?? (p["supersededBy"] as string) ?? null,
        });
        break;
      }
      default:
        logWarning("reconcile", `Unknown event cmd during replay: "${event.cmd}" — skipped`);
        break;
    }
  }
  }); // end transaction
}

// ─── extractEntityKey ─────────────────────────────────────────────────────────

/**
 * Map a WorkflowEvent command to its affected entity type and ID.
 * Returns null for commands that don't touch a named entity
 * (e.g. unknown or future cmds).
 */
export function extractEntityKey(
  event: WorkflowEvent,
): { type: string; id: string } | null {
  const p = event.params;
  // Normalize cmd format: accept both hyphens and underscores
  if (typeof event.cmd !== "string") return null;
  const cmd = event.cmd.replace(/-/g, "_");

  switch (cmd) {
    case "complete_task":
    case "start_task":
    case "report_blocker":
    case "record_verification":
    case "plan_task":
      return typeof p["taskId"] === "string"
        ? { type: "task", id: p["taskId"] }
        : null;

    case "complete_slice":
    case "replan_slice":
      return typeof p["sliceId"] === "string"
        ? { type: "slice", id: p["sliceId"] }
        : null;

    case "plan_slice":
      return typeof p["sliceId"] === "string"
        ? { type: "slice_plan", id: p["sliceId"] }
        : null;

    case "complete_milestone":
    case "plan_milestone":
      return typeof p["milestoneId"] === "string"
        ? { type: "milestone", id: p["milestoneId"] }
        : null;

    case "save_decision":
      if (typeof p["scope"] === "string" && typeof p["decision"] === "string") {
        return { type: "decision", id: `${p["scope"]}:${p["decision"]}` };
      }
      return null;

    default:
      return null;
  }
}

// ─── detectConflicts ──────────────────────────────────────────────────────────

/**
 * Compare two sets of diverged events. Returns conflict entries for any
 * entity touched by both sides.
 *
 * Entity-level granularity: if both sides touched task T01 (with any cmd),
 * that is one conflict regardless of field-level differences.
 */
export function detectConflicts(
  mainDiverged: WorkflowEvent[],
  wtDiverged: WorkflowEvent[],
): ConflictEntry[] {
  // Group each side's events by entity key
  const mainByEntity = new Map<string, WorkflowEvent[]>();
  for (const event of mainDiverged) {
    const key = extractEntityKey(event);
    if (!key) continue;
    const bucket = mainByEntity.get(`${key.type}:${key.id}`) ?? [];
    bucket.push(event);
    mainByEntity.set(`${key.type}:${key.id}`, bucket);
  }

  const wtByEntity = new Map<string, WorkflowEvent[]>();
  for (const event of wtDiverged) {
    const key = extractEntityKey(event);
    if (!key) continue;
    const bucket = wtByEntity.get(`${key.type}:${key.id}`) ?? [];
    bucket.push(event);
    wtByEntity.set(`${key.type}:${key.id}`, bucket);
  }

  // Find entities touched by both sides
  const conflicts: ConflictEntry[] = [];
  for (const [entityKey, mainEvents] of mainByEntity) {
    const wtEvents = wtByEntity.get(entityKey);
    if (!wtEvents) continue;

    const colonIdx = entityKey.indexOf(":");
    const entityType = entityKey.slice(0, colonIdx);
    const entityId = entityKey.slice(colonIdx + 1);

    conflicts.push({
      entityType,
      entityId,
      mainSideEvents: mainEvents,
      worktreeSideEvents: wtEvents,
    });
  }

  return conflicts;
}

function rewriteDivergedEventsForEntity(
  divergedEvents: WorkflowEvent[],
  entityType: string,
  entityId: string,
  replacementEvents: WorkflowEvent[],
): WorkflowEvent[] {
  const rewritten: WorkflowEvent[] = [];
  let inserted = false;

  for (const event of divergedEvents) {
    const key = extractEntityKey(event);
    if (key?.type === entityType && key.id === entityId) {
      if (!inserted) {
        rewritten.push(...replacementEvents);
        inserted = true;
      }
      continue;
    }
    rewritten.push(event);
  }

  if (!inserted) {
    rewritten.push(...replacementEvents);
  }

  return rewritten;
}

function writeEventLog(basePath: string, events: WorkflowEvent[]): void {
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  const content = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
  atomicWriteSync(join(dir, "event-log.jsonl"), content);
}

// ─── writeConflictsFile ───────────────────────────────────────────────────────

/**
 * Write a human-readable CONFLICTS.md to basePath/.gsd/CONFLICTS.md.
 * Lists each conflict with both sides' event payloads and resolution instructions.
 */
export function writeConflictsFile(
  basePath: string,
  conflicts: ConflictEntry[],
  worktreePath: string,
): void {
  const timestamp = new Date().toISOString();
  const lines: string[] = [
    `# Merge Conflicts — ${timestamp}`,
    "",
    `Conflicts detected merging worktree \`${worktreePath}\` into \`${basePath}\`.`,
    `Run \`gsd resolve-conflict\` to resolve each conflict.`,
    "",
  ];

  conflicts.forEach((conflict, idx) => {
    lines.push(`## Conflict ${idx + 1}: ${conflict.entityType} ${conflict.entityId}`);
    lines.push("");
    lines.push("**Main side events:**");
    for (const event of conflict.mainSideEvents) {
      lines.push(`- ${event.cmd} at ${event.ts} (hash: ${event.hash})`);
      lines.push(`  params: ${JSON.stringify(event.params)}`);
    }
    lines.push("");
    lines.push("**Worktree side events:**");
    for (const event of conflict.worktreeSideEvents) {
      lines.push(`- ${event.cmd} at ${event.ts} (hash: ${event.hash})`);
      lines.push(`  params: ${JSON.stringify(event.params)}`);
    }
    lines.push("");
    lines.push(`**Resolve with:** \`gsd resolve-conflict --entity ${conflict.entityType}:${conflict.entityId} --pick [main|worktree]\``);
    lines.push("");
  });

  const content = lines.join("\n");
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, "CONFLICTS.md"), content);
}

// ─── reconcileWorktreeLogs ────────────────────────────────────────────────────

/**
 * Event-log-based reconciliation algorithm:
 *
 * 1. Read both event logs
 * 2. Find fork point (last common event by hash)
 * 3. Slice diverged sets from each side
 * 4. If no divergence on either side → return autoMerged: 0, conflicts: []
 * 5. detectConflicts() — if any, writeConflictsFile + return early (D-04 all-or-nothing)
 * 6. If clean: sort merged = mainDiverged + wtDiverged by timestamp, replayAll
 * 7. Write merged event log (base + merged in timestamp order)
 * 8. writeManifest
 * 9. Return { autoMerged: merged.length, conflicts: [] }
 */
export function reconcileWorktreeLogs(
  mainBasePath: string,
  worktreeBasePath: string,
): ReconcileResult {
  // Acquire advisory lock to prevent concurrent reconcile + append races
  const lock = acquireSyncLock(mainBasePath);
  if (!lock.acquired) {
    logWarning("reconcile", "could not acquire sync lock — another reconciliation may be in progress");
    return { autoMerged: 0, conflicts: [] };
  }

  try {
    return _reconcileWorktreeLogsInner(mainBasePath, worktreeBasePath);
  } finally {
    releaseSyncLock(mainBasePath);
  }
}

function _reconcileWorktreeLogsInner(
  mainBasePath: string,
  worktreeBasePath: string,
): ReconcileResult {
  // Step 1: Read both logs
  const mainLogPath = join(mainBasePath, ".gsd", "event-log.jsonl");
  const wtLogPath = join(worktreeBasePath, ".gsd", "event-log.jsonl");

  const mainEvents = readEvents(mainLogPath);
  const wtEvents = readEvents(wtLogPath);

  // Step 2: Find fork point
  const forkPoint = findForkPoint(mainEvents, wtEvents);

  // Step 3: Slice diverged sets
  const mainDiverged = mainEvents.slice(forkPoint + 1);
  const wtDiverged = wtEvents.slice(forkPoint + 1);

  // Step 4: No divergence on either side
  if (mainDiverged.length === 0 && wtDiverged.length === 0) {
    return { autoMerged: 0, conflicts: [] };
  }

  // Step 5: Detect conflicts (entity-level)
  const conflicts = detectConflicts(mainDiverged, wtDiverged);
  if (conflicts.length > 0) {
    // D-04: atomic all-or-nothing — block entire merge
    writeConflictsFile(mainBasePath, conflicts, worktreeBasePath);
    const conflictSummary = conflicts.slice(0, 3).map(c => `${c.entityType}:${c.entityId}`).join(", ");
    const truncated = conflicts.length > 3 ? `... and ${conflicts.length - 3} more` : "";
    logError("reconcile", `${conflicts.length} conflict(s) detected on ${conflictSummary}${truncated}. Details: .gsd/CONFLICTS.md`, { count: String(conflicts.length), path: join(mainBasePath, ".gsd", "CONFLICTS.md") });
    return { autoMerged: 0, conflicts };
  }

  // Step 6: Clean merge — stable sort by timestamp (index-based tiebreaker)
  const indexed = [...mainDiverged, ...wtDiverged].map((e, i) => ({ e, i }));
  indexed.sort((a, b) => a.e.ts.localeCompare(b.e.ts) || a.i - b.i);
  const merged = indexed.map(({ e }) => e);

  // Step 7: Write merged event log FIRST (so crash recovery can re-derive DB state)
  // Guard: detect concurrent appendEvent calls between our read (step 1) and
  // this rewrite. If the log grew, re-read and retry to avoid dropping events.
  const preWriteEvents = readEvents(mainLogPath);
  if (preWriteEvents.length > mainEvents.length) {
    logWarning("reconcile", `Event log grew during reconcile (${mainEvents.length} → ${preWriteEvents.length}), retrying with fresh read`);
    return _reconcileWorktreeLogsInner(mainBasePath, worktreeBasePath);
  }

  const baseEvents = mainEvents.slice(0, forkPoint + 1);
  const mergedLog = baseEvents.concat(merged);
  const logContent = mergedLog.map((e) => JSON.stringify(e)).join("\n") + (mergedLog.length > 0 ? "\n" : "");
  mkdirSync(join(mainBasePath, ".gsd"), { recursive: true });
  atomicWriteSync(join(mainBasePath, ".gsd", "event-log.jsonl"), logContent);

  // Step 8: Replay into DB (wrapped in a transaction by replayEvents)
  openDatabase(join(mainBasePath, ".gsd", "gsd.db"));
  replayEvents(merged);

  // Step 9: Write manifest
  try {
    writeManifest(mainBasePath);
  } catch (err) {
    logWarning("reconcile", "manifest write failed (non-fatal)", { error: (err as Error).message });
  }

  // Step 10: Invalidate caches so deriveState() sees post-reconcile DB state.
  // Use targeted invalidation (not invalidateAllCaches) to avoid wiping artifacts table.
  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  return { autoMerged: merged.length, conflicts: [] };
}

// ─── Conflict Resolution (D-06) ─────────────────────────────────────────────

/**
 * Parse CONFLICTS.md and return structured ConflictEntry[].
 * Returns empty array when CONFLICTS.md does not exist.
 *
 * Parses the format written by writeConflictsFile:
 *   ## Conflict N: {entityType} {entityId}
 *   **Main side events:**
 *   - {cmd} at {ts} (hash: {hash})
 *     params: {JSON}
 *   **Worktree side events:**
 *   - {cmd} at {ts} (hash: {hash})
 *     params: {JSON}
 */
export function listConflicts(basePath: string): ConflictEntry[] {
  const conflictsPath = join(basePath, ".gsd", "CONFLICTS.md");
  if (!existsSync(conflictsPath)) return [];

  const content = readFileSync(conflictsPath, "utf-8");
  const conflicts: ConflictEntry[] = [];

  // Split into per-conflict sections on "## Conflict N:" headings
  const sections = content.split(/^## Conflict \d+:/m).slice(1);

  for (const section of sections) {
    // Extract entity type and id from first line: " {entityType} {entityId}"
    const headingMatch = section.match(/^\s+(\S+)\s+(\S+)/);
    if (!headingMatch) continue;
    const entityType = headingMatch[1]!;
    const entityId = headingMatch[2]!;

    // Split into main/worktree blocks
    const mainMatch = section.split("**Main side events:**")[1];
    const wtMatch = mainMatch?.split("**Worktree side events:**");

    const mainBlock = wtMatch?.[0] ?? "";
    const wtBlock = wtMatch?.[1] ?? "";

    const mainSideEvents = parseEventBlock(mainBlock);
    const worktreeSideEvents = parseEventBlock(wtBlock);

    conflicts.push({ entityType, entityId, mainSideEvents, worktreeSideEvents });
  }

  return conflicts;
}

/**
 * Parse a block of event lines from CONFLICTS.md into WorkflowEvent[].
 * Each event spans two lines:
 *   - {cmd} at {ts} (hash: {hash})
 *     params: {JSON}
 */
function parseEventBlock(block: string): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  // Find lines starting with "- " (event lines)
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line.startsWith("- ")) {
      // Parse: - {cmd} at {ts} (hash: {hash})
      const eventMatch = line.match(/^-\s+(\S+)\s+at\s+(\S+)\s+\(hash:\s+(\S+)\)$/);
      if (eventMatch) {
        const cmd = eventMatch[1]!;
        const ts = eventMatch[2]!;
        const hash = eventMatch[3]!;

        // Next line: "  params: {JSON}"
        let params: Record<string, unknown> = {};
        const nextLine = lines[i + 1];
        if (nextLine) {
          const paramsMatch = nextLine.trim().match(/^params:\s+(.+)$/);
          if (paramsMatch) {
            try {
              params = JSON.parse(paramsMatch[1]!) as Record<string, unknown>;
            } catch (e) {
              logWarning("reconcile", `tool call params parse failed: ${(e as Error).message}`);
            }
            i++; // consume params line
          }
        }

        events.push({ cmd, params, ts, hash, actor: "agent", session_id: getSessionId() });
      }
    }
    i++;
  }
  return events;
}

/**
 * Resolve a single conflict by picking one side's events.
 * Replays the picked events through the DB helpers, rewrites the chosen side's
 * event log so the conflict is durable, and updates or removes CONFLICTS.md.
 *
 * When the last conflict is resolved, non-conflicting events from both sides
 * are also replayed (they were blocked by the all-or-nothing D-04 rule).
 */
export function resolveConflict(
  basePath: string,
  worktreeBasePath: string,
  entityKey: string,  // e.g. "task:T01"
  pick: "main" | "worktree",
): void {
  const conflicts = listConflicts(basePath);
  const colonIdx = entityKey.indexOf(":");
  const entityType = entityKey.slice(0, colonIdx);
  const entityId = entityKey.slice(colonIdx + 1);

  const idx = conflicts.findIndex((c) => c.entityType === entityType && c.entityId === entityId);
  if (idx === -1) throw new Error(`No conflict found for entity ${entityKey}`);

  const conflict = conflicts[idx]!;
  const eventsToReplay = pick === "main" ? conflict.mainSideEvents : conflict.worktreeSideEvents;

  const mainLogPath = join(basePath, ".gsd", "event-log.jsonl");
  const wtLogPath = join(worktreeBasePath, ".gsd", "event-log.jsonl");
  const mainEvents = readEvents(mainLogPath);
  const wtEvents = readEvents(wtLogPath);
  const forkPoint = findForkPoint(mainEvents, wtEvents);
  const mainBaseEvents = mainEvents.slice(0, forkPoint + 1);
  const wtBaseEvents = wtEvents.slice(0, forkPoint + 1);
  const mainDiverged = mainEvents.slice(forkPoint + 1);
  const wtDiverged = wtEvents.slice(forkPoint + 1);

  const rewrittenTargetEvents = pick === "main"
    ? rewriteDivergedEventsForEntity(wtDiverged, entityType, entityId, eventsToReplay)
    : rewriteDivergedEventsForEntity(mainDiverged, entityType, entityId, eventsToReplay);

  const targetBasePath = pick === "main" ? worktreeBasePath : basePath;
  const targetBaseEvents = pick === "main" ? wtBaseEvents : mainBaseEvents;
  writeEventLog(targetBasePath, targetBaseEvents.concat(rewrittenTargetEvents));

  // Replay resolved events through the DB (updates DB state)
  openDatabase(join(basePath, ".gsd", "gsd.db"));
  replayEvents(eventsToReplay);
  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  // Remove resolved conflict from list
  conflicts.splice(idx, 1);

  if (conflicts.length === 0) {
    // All conflicts resolved — remove CONFLICTS.md and re-run reconciliation
    // to pick up non-conflicting events that were blocked by D-04 all-or-nothing.
    removeConflictsFile(basePath);
    if (worktreeBasePath) {
      reconcileWorktreeLogs(basePath, worktreeBasePath);
    }
  } else {
    // Re-write CONFLICTS.md with remaining conflicts
    writeConflictsFile(basePath, conflicts, worktreeBasePath);
  }
}

/**
 * Remove CONFLICTS.md — called when all conflicts are resolved.
 * No-op if CONFLICTS.md does not exist.
 */
export function removeConflictsFile(basePath: string): void {
  const conflictsPath = join(basePath, ".gsd", "CONFLICTS.md");
  if (existsSync(conflictsPath)) {
    unlinkSync(conflictsPath);
  }
}
