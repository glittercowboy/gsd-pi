// GSD-2 State Machine Bug Findings
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

# GSD2 State Machine — Bug Findings (Full Trace)

> Generated: 2026-03-21 via 4-agent parallel codebase trace.
> Scope: /steer flow · error recovery · auto-doc fixes · worktree buildup/teardown
> Total: 27 bugs (3 Critical / 6 High / 9 Medium / 9 Low)

---

## AGENT 1 — Loop, Dispatch & /steer Flow

### CRITICAL

**C3. /STEER Worktree State Desynchronization**
- **File:** `commands-handlers.ts:219`
- `handleSteer` uses `process.cwd()` to compute basePath. In a worktree session, CWD is the worktree but `s.basePath` (what dispatch rules read from) may be the project root. Override lands in the wrong `.gsd/OVERRIDES.md` and is silently ignored by the rewrite-docs dispatch rule.

### HIGH

**H1. /steer does not interrupt current unit**
- **File:** `commands-handlers.ts:227-242`
- `triggerTurn=true` queues a message for after `agent_end`. The running LLM never sees the override. Message at line 231 says "finish your current work respecting this override" but the agent has no awareness of it. Rewrite-docs is cleanup after-the-fact, not real-time steering.

**H2. Reactive-execute graph snapshot goes stale after /steer**
- **File:** `auto-dispatch.ts:344-434`
- Reactive state snapshot (line 404) captures task dependencies before rewrite-docs runs. If a steer triggers a rewrite that modifies PLAN files, the next reactive batch dispatches against the stale dependency graph. May violate dependencies.

**H2b. Sidecar queue bypasses `MAX_REWRITE_ATTEMPTS` circuit breaker**
- **File:** `auto/loop.ts:77-87, 129-144`
- When sidecar items are queued (hooks/triage/quick-tasks), the loop skips dispatch rules entirely. `rewriteAttemptCount` only increments inside the dispatch function. Frequent sidecar items can freeze the counter indefinitely.

### MEDIUM

**H5 (partial). Session lock heartbeat gap**
- **File:** `auto/loop.ts:89-107`
- Lock validated at loop top, but heartbeat only updates in `runFinalize`. Long `runPreDispatch` operations (state derivation, worktree sync) can run for minutes with no heartbeat. Concurrent instance may steal lock.

**M5. Overrides leak between milestones**
- **File:** `auto-dispatch.ts:94`
- rewrite-docs rule loads all active overrides without filtering by `currentMilestoneId`. M001 steer can affect M002 if OVERRIDES.md is not cleared.

**M6. `resolveAllOverrides` not called on `stopAuto`**
- **File:** `auto.ts:565`
- Accumulated overrides persist in OVERRIDES.md when auto-mode stops. On resume, same overrides re-apply unintentionally.

### LOW

**L4. Concurrent `/gsd dispatch` during auto-mode**
- **File:** `auto-direct-dispatch.ts:31`
- `dispatchDirectPhase` creates a new session without checking session lock. If auto-mode is active, two sessions overlap, both dispatching against the same state.

**L5. Bootstrap consecutive-complete guard off-by-one**
- **File:** `auto-start.ts:355`
- Guard is `> 2` (breaks after 3 complete bootstraps) but intent is `>= 2` (break after 2).

**L2. No timeout on `appendOverride`**
- **File:** `commands-handlers.ts:225`
- Async write with no timeout. If filesystem is slow/hung, `handleSteer` hangs indefinitely.

**L3. Reactive batch suffix fragile string encoding**
- **File:** `auto-dispatch.ts:413-419`
- `unitId = M001/S01/reactive+T02,T03` — comma-delimited string. No escaping, no validation. Task IDs with commas would break parsing.

---

## AGENT 2 — Error Recovery, Timeout & Crash Recovery

### CRITICAL

**C2. Artifact verification retries are unlimited**
- **File:** `auto-post-unit.ts:376-388`
- `verificationRetryCount` increments without a cap. Spec: 3 retries → write blocker and advance. Actual: infinite retries until context window exhaustion. No blocker placeholder is ever written.

### HIGH

**H5. Cache invalidation on 2nd loop error should be 1st**
- **File:** `auto/loop.ts:204-210`
- First stale-state error retries with same stale state. Second error → caches invalidated. One iteration wasted. Should invalidate on first error.

**H4. Crash recovery does not read pi session JSONL**
- **File:** `crash-recovery.ts:27-28`
- `sessionFile` path is stored in the lock but no code reads it back. `s.pendingCrashRecovery` contains only completed unit list, not actual tool call history or agent state at crash time. Recovery is context-poor.

### MEDIUM

**M1 (spec violation). Stuck detection blind spot for verification retries**
- **File:** `auto/phases.ts:510-519`
- `recentUnits` window is only updated when `pendingVerificationRetry` is NOT set. A unit that fails verification 10+ times consecutively is invisible to stuck detection.

**M2. Stuck recovery attempts not persisted**
- **File:** `auto/loop.ts:47`
- `loopState` (including `stuckRecoveryAttempts`) is re-created fresh on each `autoLoop()` call. Stuck unit can trigger Level 1 recovery indefinitely across crash/resume cycles.

**M3. Timeout blocker overwrites existing partial summaries**
- **File:** `auto-recovery.ts:520`
- `writeFileSync(summaryPath, content)` silently overwrites. If agent wrote a partial summary before timing out, it's destroyed by the blocker placeholder.

**L9 (partial). Self-heal only handles `complete-slice`**
- **File:** `auto-recovery.ts:662-729`
- `selfHealRuntimeRecords()` only special-cases `complete-slice`. Stuck patterns for `execute-task` (summary exists but unchecked) and `plan-slice` (plan exists but no task plans) are not self-healed.

**M9. `hasImplementationArtifacts()` fail-open on git error**
- **File:** `auto-recovery.ts:409-414`
- Git diff failure returns `true` (assumes artifacts exist). A milestone that only wrote `.gsd/` files passes this check if git errors, allowing `complete-milestone` to proceed without real implementation artifacts.

### LOW

**L8. `STUCK_WINDOW_SIZE` constant possibly undefined**
- **File:** `auto/phases.ts:525`
- Referenced in window trim logic. Could not confirm definition site. If undefined, causes ReferenceError at runtime.

**L9. Post-unit hook state reset is non-atomic**
- **File:** `auto-post-unit.ts:463-517`
- Retry state reset (uncheck → delete summary → remove from completedUnits → delete artifact → invalidate cache) is not atomic. Crash between steps 3 and 4 leaves stale retry artifact.

---

## AGENT 3 — Post-Unit Pipeline, Auto-Doc Fixes & rewrite-docs

### SEVERE

**M4. `rewriteAttemptCount` not persisted — lost on pause**
- **File:** `auto-dispatch.ts:104`
- Counter is in-memory only. After pause/resume or crash, counter resets to 0, potentially restarting infinite rewrite loops.

### HIGH

**H6. Duplicate `resolveAllOverrides()` — no coordination**
- **File:** `auto-dispatch.ts:99-100` + `auto-post-unit.ts:288`
- Called from two separate places without idempotency guard. If the second call fails silently, override resolution state is inconsistent.

**Ordering: Worktree sync happens before rewrite-docs completion**
- **File:** `auto-post-unit.ts:276-294`
- Step 10 (`syncStateToProjectRoot`) runs before step 11 (rewrite-docs completion). Override resolution changes aren't included in the sync. If session pauses after sync but before completion is marked, state diverges.

**Sidecar artifact verification silently skipped**
- **File:** `auto/phases.ts:1201-1210`
- Triage-captures failures are not escalated. Missing artifacts after triage are never reported to user. Triage completion state left incomplete.

### MEDIUM

**M8. Memory extraction fire-and-forget**
- **File:** `auto-unit-closeout.ts:40-42`
- `extractMemoriesFromUnit()` promise never awaited. Mutex guard silently drops second extraction if first is still running. No queue, no retry, no error logging.

**Incomplete rewrite-docs prompt context**
- **File:** `auto-prompts.ts:1584-1649`
- Prompt for milestone-level rewrite is missing slice summaries. Agent lacks full context for correct scope determination.

---

## AGENT 4 — Worktree Buildup, Teardown & State Sync

### CRITICAL

**C1. Missing `syncWorktreeStateBack()` in `mergeMilestoneToMain()`**
- **File:** `auto-worktree.ts:960-1277`
- The entire teardown sequence inside `mergeMilestoneToMain()` skips `syncWorktreeStateBack()`. The call exists only in the caller (`worktree-resolver.ts:327`), so any direct call to `mergeMilestoneToMain()` silently loses all milestones/ content.
- Causes the known M007 artifact loss: M007 files created during M006 execution are in the worktree but never synced back before the worktree is deleted.

### HIGH

**C1 (secondary). `clearProjectRootStateFiles()` scope is only current milestone**
- **File:** `auto-worktree.ts:70-120`
- Only removes untracked files in `milestones/{currentMilestoneId}/`. Cross-milestone artifacts (e.g., M007/ created during M006 work) are never cleared from project root, compounding the sync gap.

### MEDIUM

**M7. `reconcilePlanCheckboxes()` edge cases on re-attach**
- **File:** `auto-worktree.ts:536-613`
- Skips files that don't exist in both locations (`existsSync(dstFile) continue`). Regex-based checkbox merge can match checkboxes inside code blocks. Causes recovery loops on re-attach after crash.

### LOW

**L7. Cache not invalidated on merge error path**
- **File:** `worktree-resolver.ts:389-414`
- Exception during merge chdirs back to project root but does not call `invalidateAllCaches()`. Stale state reads possible until next explicit invalidation.

---

## Recovery Ladder Compliance Matrix

| Failure | Spec | Implementation | Status |
|---------|------|-----------------|--------|
| Artifact missing (any unit) | 3 retries → blocker | Unlimited retries | ❌ BROKEN |
| Verification gate fail (execute-task) | 2 auto-fix → pause | Partial via artifact verify | ⚠️ PARTIAL |
| Idle timeout (15min) | 2 steering → blocker | 2 recovery → pause/blocker | ✅ OK |
| Hard timeout (30min) | 1 steering → blocker | 1 recovery → pause/blocker | ✅ OK |
| Loop error (consecutive) | 3 attempts → hard stop | 3 iterations → hard stop | ✅ OK |
| Cache stale (2nd loop error) | invalidateAllCaches → retry → hard stop | Invalidates on 2nd (should be 1st) | ⚠️ TIMING |
| .gsd/ merge conflict | Auto-resolve worktree wins | Implemented | ✅ OK |
| Code merge conflict | MergeConflictError → preserve | Implemented | ✅ OK |
| Stale dispatched record (>1h) | selfHealRuntimeRecords | Only handles complete-slice | ⚠️ PARTIAL |
