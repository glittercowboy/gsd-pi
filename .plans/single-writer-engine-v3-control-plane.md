# Single-Writer Engine v3: Agent Control Plane
# Plan: State machine guards + actor causation + reversibility
# Created: 2026-03-25

---

## Background

v2 gave the engine **write discipline** — agents can't corrupt STATE.md directly,
every mutation goes through the DB, event log is append-only.

What v2 did NOT give us: **behavioral control**.  Agents can still:
- Complete a task twice (silent overwrite)
- Complete a slice with open tasks (if they bypass the slice status check)
- Complete a milestone in any status
- Re-plan already-completed slices/tasks
- Call any tool on any unit regardless of ownership
- Leave no trace of *who* did what or *why*

This plan bundles three work streams that close those gaps together, since they
share infrastructure (WorkflowEvent schema, DB query surface, handler preconditions).

---

## Work Streams

### Stream 1 — State Machine Guards (P0)
Add precondition checks to all 8 tool handlers so invalid transitions return an
error instead of silently succeeding.

### Stream 2 — Actor Identity + Persistent Audit Log (P1)
Extend `WorkflowEvent` with `actor_name` and `trigger_reason`. Flush the
in-process `workflow-logger` buffer to a persistent `.gsd/audit-log.jsonl`
after every tool invocation, so "who did what and why" is durable.

### Stream 3 — Reversibility + Unit Ownership (P2)
Add `gsd_task_reopen` and `gsd_slice_reopen` tools. Add a unit-ownership
validation layer so an agent can only complete/reopen units it explicitly claimed.

---

## Detailed Task Breakdown

---

### Stream 1: State Machine Guards

#### S1-T1: Add `getTask`, `getSlice`, `getMilestone` existence helpers to `gsd-db.ts`

**Files:** `src/resources/extensions/gsd/gsd-db.ts`

These are read-only DB helpers to confirm an entity exists and return its current
`status` field before any mutation. Each returns `null` if not found.

```ts
getTask(taskId: string, sliceId: string): { status: string } | null
getSlice(sliceId: string, milestoneId: string): { status: string } | null
getMilestoneById(milestoneId: string): { status: string } | null
```

Note: `getSlice` may already exist — check before adding a duplicate. The audit
report references it in `complete-slice.ts` line 207 but only to list tasks.
Need a version that returns the slice row itself.

---

#### S1-T2: Guard `complete-task.ts` — enforce valid transitions

**File:** `src/resources/extensions/gsd/tools/complete-task.ts`

Preconditions to add (before the transaction block):
1. `getMilestoneById(milestoneId)` → must exist, must NOT be `"complete"` or `"done"`
2. `getSlice(sliceId, milestoneId)` → must exist, must be `"pending"` or `"in_progress"`
3. `getTask(taskId, sliceId)` → if exists, status must be `"pending"` (not already `"complete"`)

On failure: return `{ error: "<reason>" }` — do NOT throw.

---

#### S1-T3: Guard `complete-slice.ts` — enforce valid transitions

**File:** `src/resources/extensions/gsd/tools/complete-slice.ts`

Preconditions to add:
1. `getSlice(sliceId, milestoneId)` → must exist, status must be `"pending"` or `"in_progress"` (not already `"complete"`)
2. `getMilestoneById(milestoneId)` → must exist, must NOT be `"complete"`
3. All tasks in slice must be `"complete"` (already enforced — keep it, add explicit slice-status check before this)

---

#### S1-T4: Guard `complete-milestone.ts` — enforce valid transitions

**File:** `src/resources/extensions/gsd/tools/complete-milestone.ts`

Preconditions to add:
1. `getMilestoneById(milestoneId)` → must exist, status must be `"active"` (not already `"complete"`)
2. Keep existing all-slices-complete check
3. Add deep check: all tasks across all slices must also be `"complete"` (not just slice status)

---

#### S1-T5: Guard `plan-task.ts` — block re-planning completed tasks

**File:** `src/resources/extensions/gsd/tools/plan-task.ts`

Preconditions to add:
1. `getSlice(sliceId, milestoneId)` → must exist, status must NOT be `"complete"` (already blocks planning on a closed slice)
2. If task exists (`getTask`), status must be `"pending"` — block re-planning a `"complete"` task

---

#### S1-T6: Guard `plan-slice.ts` — block re-planning completed slices

**File:** `src/resources/extensions/gsd/tools/plan-slice.ts`

Preconditions to add:
1. `getSlice(sliceId, milestoneId)` → if exists, status must NOT be `"complete"`
2. `getMilestoneById(milestoneId)` → must exist, status must NOT be `"complete"`

---

#### S1-T7: Guard `plan-milestone.ts` — block re-planning completed milestones

**File:** `src/resources/extensions/gsd/tools/plan-milestone.ts`

Preconditions to add:
1. If milestone exists (`getMilestoneById`), status must NOT be `"complete"`
2. Validate `depends_on` array: each referenced milestoneId must exist and be `"complete"` before this milestone can be planned

---

#### S1-T8: Guard `reassess-roadmap.ts` — verify completedSliceId is actually complete

**File:** `src/resources/extensions/gsd/tools/reassess-roadmap.ts`

Gap: `completedSliceId` is accepted without confirming it is actually `"complete"` status.
Also: no check that milestone is still `"active"` (could reassess after milestone is done).

Preconditions to add:
1. `getSlice(completedSliceId, milestoneId)` → status must be `"complete"`
2. `getMilestoneById(milestoneId)` → status must be `"active"`

---

#### S1-T9: Guard `replan-slice.ts` — verify blockerTaskId exists and is complete

**File:** `src/resources/extensions/gsd/tools/replan-slice.ts`

Gaps:
- `blockerTaskId` is accepted without verifying it exists or is `"complete"`
- No check that slice is still `"in_progress"` (could replan after slice is complete)

Preconditions to add:
1. `getSlice(sliceId, milestoneId)` → status must be `"in_progress"` or `"pending"`, NOT `"complete"`
2. `getTask(blockerTaskId, sliceId)` → must exist, status must be `"complete"`

---

### Stream 2: Actor Identity + Persistent Audit Log

#### S2-T1: Extend `WorkflowEvent` with actor identity and causation fields

**File:** `src/resources/extensions/gsd/workflow-events.ts`

Extend the `WorkflowEvent` interface:
```ts
export interface WorkflowEvent {
  cmd: string;
  params: Record<string, unknown>;
  ts: string;
  hash: string;
  actor: "agent" | "system";
  actor_name?: string;       // ADD: e.g. "executor-agent-01", "gsd-orchestrator"
  trigger_reason?: string;   // ADD: e.g. "plan-phase complete", "user invoked gsd_complete_task"
  session_id?: string;       // ADD: process.env.GSD_SESSION_ID if set
}
```

Update `appendEvent` to accept and persist these new optional fields.
Hash computation must remain stable (still hashes only `cmd + params`, not the new fields)
so fork detection isn't broken.

---

#### S2-T2: Update all 8 tool handlers to pass actor identity to `appendEvent`

**Files:** All 8 handlers in `src/resources/extensions/gsd/tools/`

Each handler receives its inputs. Add a convention where params can include:
- `actor_name` (optional string) — caller passes their agent identity
- `trigger_reason` (optional string) — caller passes why this action was triggered

If not provided, default to `actor_name: "agent"`, `trigger_reason: undefined`.

Handlers pass these through to `appendEvent`.

The tool schemas (in the MCP tool definitions) should expose `actor_name` and
`trigger_reason` as optional string params so agents can self-identify.

---

#### S2-T3: Persist `workflow-logger` to `.gsd/audit-log.jsonl`

**File:** `src/resources/extensions/gsd/workflow-logger.ts`

Current behavior: `_buffer` is in-process memory, drained per-unit and dropped.
This means errors/warnings disappear across context resets.

Change: After `_push()` writes to the in-process buffer, also append the entry
to `.gsd/audit-log.jsonl` (using `appendFileSync`). This requires the basePath
to be available — either pass it as a module-level setter (`setLogBasePath(path)`)
called at engine init, or accept it as a param on `logWarning`/`logError`.

The audit log format should match `LogEntry` serialized as JSON + newline,
consistent with `event-log.jsonl`.

---

#### S2-T4: Add `readAuditLog` helper to `workflow-logger.ts`

**File:** `src/resources/extensions/gsd/workflow-logger.ts`

Expose a read function so the auto-loop and diagnostics can surface persistent
audit entries without replaying the event log:

```ts
export function readAuditLog(basePath: string): LogEntry[]
```

---

### Stream 3: Reversibility + Unit Ownership

#### S3-T1: Add `updateTaskStatus` and `updateSliceStatus` DB helpers

**File:** `src/resources/extensions/gsd/gsd-db.ts`

If they don't already exist (check first):
```ts
updateTaskStatus(taskId: string, sliceId: string, status: string): void
updateSliceStatus(sliceId: string, milestoneId: string, status: string): void
```

These are the write primitives needed by reopen tools.

---

#### S3-T2: Implement `gsd_task_reopen` tool handler

**New file:** `src/resources/extensions/gsd/tools/reopen-task.ts`

Logic:
1. Validate `taskId`, `sliceId`, `milestoneId` are non-empty strings
2. `getTask(taskId, sliceId)` → must exist, status must be `"complete"` (can't reopen what isn't closed)
3. `getSlice(sliceId, milestoneId)` → must exist, status must NOT be `"complete"` (can't reopen a task inside a closed slice — too late)
4. `getMilestoneById(milestoneId)` → must exist, status must NOT be `"complete"`
5. In a transaction: `updateTaskStatus(taskId, sliceId, "pending")`
6. Append event: `cmd: "reopen_task"`, include `actor_name`, `trigger_reason`
7. Invalidate state cache + render projections

---

#### S3-T3: Implement `gsd_slice_reopen` tool handler

**New file:** `src/resources/extensions/gsd/tools/reopen-slice.ts`

Logic:
1. Validate `sliceId`, `milestoneId`
2. `getSlice(sliceId, milestoneId)` → must exist, status must be `"complete"`
3. `getMilestoneById(milestoneId)` → must NOT be `"complete"`
4. In a transaction: `updateSliceStatus(sliceId, milestoneId, "in_progress")` + set all tasks back to `"pending"`
5. Append event: `cmd: "reopen_slice"`
6. Invalidate state cache + render projections

---

#### S3-T4: Add unit ownership claim/check mechanism

**New file:** `src/resources/extensions/gsd/unit-ownership.ts`

Lightweight JSON file at `.gsd/unit-claims.json` mapping unit IDs to agent names:
```json
{
  "M01/S01/T01": { "agent": "executor-01", "claimed_at": "2026-03-25T..." },
  "M01/S01":     { "agent": "executor-01", "claimed_at": "2026-03-25T..." }
}
```

Functions:
```ts
claimUnit(basePath, unitKey, agentName): void   // atomic write
releaseUnit(basePath, unitKey): void
getOwner(basePath, unitKey): string | null
```

`unitKey` format: `"<milestoneId>/<sliceId>/<taskId>"` for tasks, `"<milestoneId>/<sliceId>"` for slices.

---

#### S3-T5: Wire ownership check into `complete-task` and `complete-slice`

**Files:** `complete-task.ts`, `complete-slice.ts`

If `actor_name` is provided AND `.gsd/unit-claims.json` exists AND the unit is claimed:
- Verify `actor_name` matches the registered owner
- If mismatch: return `{ error: "Unit <key> is owned by <owner>, not <actor>" }`
- If no claim file / unit is unclaimed: allow the operation (opt-in ownership)

Ownership is enforced only when claims are present, keeping the feature opt-in.

---

## Files Changed Summary

| File | Change Type |
|------|-------------|
| `gsd-db.ts` | Add `getTask`, `getMilestoneById` existence helpers; add `updateTaskStatus`, `updateSliceStatus` |
| `workflow-events.ts` | Extend `WorkflowEvent` with `actor_name`, `trigger_reason`, `session_id` |
| `workflow-logger.ts` | Add persistent flush to `.gsd/audit-log.jsonl`; add `setLogBasePath`; add `readAuditLog` |
| `tools/complete-task.ts` | State machine guards + ownership check + actor passthrough |
| `tools/complete-slice.ts` | State machine guards + ownership check + actor passthrough |
| `tools/complete-milestone.ts` | State machine guards + deep task check |
| `tools/plan-task.ts` | Block re-planning complete tasks |
| `tools/plan-slice.ts` | Block re-planning complete slices |
| `tools/plan-milestone.ts` | Block re-planning complete milestones + depends_on validation |
| `tools/reassess-roadmap.ts` | Verify completedSliceId status + milestone status check |
| `tools/replan-slice.ts` | Verify blockerTaskId exists + slice status check |
| `tools/reopen-task.ts` | NEW — gsd_task_reopen handler |
| `tools/reopen-slice.ts` | NEW — gsd_slice_reopen handler |
| `unit-ownership.ts` | NEW — claim/release/check ownership |

---

## Execution Order (Dependencies)

```
S1-T1 (DB helpers)
  └── S1-T2 (complete-task guards)
  └── S1-T3 (complete-slice guards)
  └── S1-T4 (complete-milestone guards)
  └── S1-T5 (plan-task guards)
  └── S1-T6 (plan-slice guards)
  └── S1-T7 (plan-milestone guards)
  └── S1-T8 (reassess-roadmap guards)
  └── S1-T9 (replan-slice guards)
  └── S3-T1 (updateTask/SliceStatus helpers) ── S3-T2, S3-T3

S2-T1 (WorkflowEvent schema)
  └── S2-T2 (handler actor passthrough)

S2-T3 (audit-log flush)
  └── S2-T4 (readAuditLog)

S3-T4 (unit-ownership.ts)
  └── S3-T5 (wire into complete-task/slice)
```

Parallelizable:
- All of Stream 1 (S1-T2 through S1-T9) can run in parallel once S1-T1 is done
- Stream 2 and Stream 3 are fully independent of Stream 1

---

## What Success Looks Like

After this phase:

1. **Double-complete** → returns `{ error: "Task T01 is already complete" }` instead of silently overwriting
2. **Complete slice with open tasks** → still blocked (was already caught), plus slice status guard added
3. **Re-plan closed work** → returns `{ error: "Cannot re-plan: slice S01 is already complete" }`
4. **Wrong agent completes task** → returns `{ error: "Unit M01/S01/T01 is owned by executor-01, not executor-02" }`
5. **Post-mortem** → `.gsd/audit-log.jsonl` has full trace with actor_name + trigger_reason across context resets
6. **Oops recovery** → `gsd_task_reopen` / `gsd_slice_reopen` without manual SQL surgery
7. **depends_on enforcement** → cannot plan M02 if M01 is not yet complete

---

## Decisions

1. **Ownership: opt-in** — enforced only when `.gsd/unit-claims.json` exists. Zero breaking change for existing workflows; teams adopt incrementally.

2. **Slice reopen: reset all tasks to `"pending"`** — simpler invariant. If you're reopening a slice, you're re-doing the work. Partial resets create ambiguous state.

3. **`trigger_reason`: caller-provided** — agents know *why* they acted; the engine can only know *what* was called. Default to `undefined` if not passed.

4. **Session ID: engine-generated** — UUID generated once at engine startup, stored in module state in `workflow-events.ts`. No reliance on agents setting env vars correctly.

5. **Idempotency: fix in this phase** — convert `insertAssessment` and `insertReplanHistory` to upserts (keyed on `milestoneId+sliceId` and `milestoneId+sliceId+ts` respectively). Accumulating duplicate records on retry is a bug, not a feature.

### Additional task from decision 5:
#### S1-T10: Convert `insertAssessment` and `insertReplanHistory` to upserts

**File:** `src/resources/extensions/gsd/gsd-db.ts`

- `insertAssessment`: upsert keyed on `(milestone_id, completed_slice_id)` — one assessment per completed slice per milestone
- `insertReplanHistory`: upsert keyed on `(milestone_id, slice_id, blocker_task_id)` — one replan record per blocker per slice
