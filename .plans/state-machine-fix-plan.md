// GSD-2 State Machine Fix Plan
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

# GSD2 State Machine — Deep Dive Fix Plan

> Generated: 2026-03-21 via parallel agent trace of the full GSD2 codebase.
> Source spec: `.planning/gsd2-state-machine-deep-dive.md`
> Total bugs found: 27 (3 Critical / 6 High / 9 Medium / 9 Low)

---

## WAVE 1 — Critical (Fix First)

### C1. Missing `syncWorktreeStateBack()` in `mergeMilestoneToMain()`
- **File:** `src/resources/extensions/gsd/auto-worktree.ts:960-1277`
- **Root Cause:** Teardown sequence omits `syncWorktreeStateBack()` inside `mergeMilestoneToMain()`. The call exists only in the caller (`worktree-resolver.ts:327`), making it fragile — any path that calls `mergeMilestoneToMain()` directly silently skips the sync. This is the cause of the known M007 artifact loss bug.
- **Fix:** Insert `await syncWorktreeStateBack(worktreeCwd, originalBasePath_)` between `reconcileWorktreeDb()` (line ~976) and `clearProjectRootStateFiles()` (line ~1004).
- **Tests:** Add integration test: complete M006, verify M007 artifacts survive teardown.

### C2. Artifact verification retries have no maximum — infinite loop risk
- **File:** `src/resources/extensions/gsd/auto-post-unit.ts:376-388`
- **Root Cause:** `verificationRetryCount` increments with no cap. Spec says 3 retries → write blocker. Code has zero limit.
- **Fix:**
  ```typescript
  if (attempt > 2) {
    // Write blocker placeholder and advance instead of retrying
    await writeBlockerPlaceholder(unitType, unitId, basePath);
    s.verificationRetryCount.delete(retryKey);
    return "continue";
  }
  ```
- **Tests:** Unit test where artifact is never written — verify it writes blocker and advances after attempt 3.

### C3. `/steer` writes override to `process.cwd()` instead of `s.basePath`
- **File:** `src/resources/extensions/gsd/commands-handlers.ts:219`
- **Root Cause:** `handleSteer` uses `process.cwd()` to resolve the `.gsd/` path. During worktree execution, CWD may differ from the active session's `basePath`, causing the override to land in the wrong `.gsd/OVERRIDES.md` — invisible to the dispatch rule.
- **Fix:** Pass `s.basePath` to `handleSteer` and use it instead of `process.cwd()`.
- **Tests:** Test steer while in worktree — verify override appears in the worktree's `.gsd/OVERRIDES.md` and is picked up by next dispatch.

---

## WAVE 2 — High

### H1. `/steer` does not interrupt the current unit
- **File:** `src/resources/extensions/gsd/commands-handlers.ts:227-242`
- **Root Cause:** Steer message is queued after `agent_end`. Current unit never sees the override. UI misleadingly says "finish your current work respecting this override."
- **Fix (Option A — preferred):** Update UI message to clearly state steer affects NEXT unit only.
- **Fix (Option B — harder):** Implement cancellation token to interrupt running unit and restart with override context injected.
- **Priority:** Option A is a one-line UX fix and prevents confusion. Option B is a larger refactor.

### H2. Sidecar queue bypasses rewrite-docs circuit breaker
- **File:** `src/resources/extensions/gsd/auto/loop.ts:77-87, 129-144` + `auto-dispatch.ts:104`
- **Root Cause:** When sidecar items (hook/triage/quick-task) are present, dispatch rules are skipped entirely. `rewriteAttemptCount` only increments inside dispatch — sidecar items freeze the counter, preventing `MAX_REWRITE_ATTEMPTS` enforcement.
- **Fix:** Track rewrite attempt count outside dispatch rule evaluation, in a persistent session field, not inside the dispatch function.

### H3. Reactive-execute graph snapshot goes stale after `/steer`
- **File:** `src/resources/extensions/gsd/auto-dispatch.ts:344-434`
- **Root Cause:** Reactive state snapshot is saved before rewrite-docs runs. If steer triggers a rewrite that modifies task dependencies, the next reactive batch dispatches using the stale graph.
- **Fix:** Clear reactive state snapshot when an override is registered (`appendOverride`), forcing graph rebuild on next reactive-execute dispatch.

### H4. Crash recovery does not reconstruct pi session context
- **File:** `src/resources/extensions/gsd/crash-recovery.ts:27-28`
- **Root Cause:** `sessionFile` path is stored in the lock but never read back. Recovery prompt only has "units completed before crash" — no tool call history or agent state.
- **Fix:** Read the pi session JSONL at `sessionFile`, extract last N tool calls and responses, include in `s.pendingCrashRecovery` prompt.

### H5. Cache invalidation happens on 2nd loop error instead of 1st
- **File:** `src/resources/extensions/gsd/auto/loop.ts:204-210`
- **Root Cause:** `consecutiveErrors === 2` check runs `invalidateAllCaches()`. But first error with stale state retries without clearing — causing the second error. Should invalidate on first error.
- **Fix:** Move `invalidateAllCaches()` to the `else` (first error) branch, keep warning message at `=== 2`.

### H6. Duplicate `resolveAllOverrides()` calls not coordinated
- **File:** `src/resources/extensions/gsd/auto-dispatch.ts:99-100` + `auto-post-unit.ts:288`
- **Root Cause:** Called from two places with no idempotency check. If second call silently fails, override state becomes inconsistent.
- **Fix:** Add idempotency guard — check if overrides are already resolved before calling, or consolidate to a single call site.

---

## WAVE 3 — Medium

### M1. Stuck detection blind spot: verification retries skip `recentUnits` update
- **File:** `src/resources/extensions/gsd/auto/phases.ts:510-519`
- **Fix:** Push to `recentUnits` even when `pendingVerificationRetry` is set, so a unit failing verification repeatedly triggers stuck detection.

### M2. Stuck recovery attempts not persisted across sessions
- **File:** `src/resources/extensions/gsd/auto/loop.ts:47`
- **Fix:** Persist `stuckRecoveryAttempts` to `.gsd/runtime/session.json` and restore on `autoLoop()` init.

### M3. Timeout blocker silently overwrites existing partial summaries
- **File:** `src/resources/extensions/gsd/auto-recovery.ts:520`
- **Fix:** Check if summary exists before overwrite. If it does, rename to `{task}-SUMMARY.backup.md`, then write the blocker.

### M4. `rewriteAttemptCount` lost on pause/resume
- **File:** `src/resources/extensions/gsd/auto-dispatch.ts:104`
- **Fix:** Persist `rewriteAttemptCount` map to `.gsd/runtime/session.json` alongside other session state. Restore on resume.

### M5. Overrides leak between milestones (no scope filter)
- **File:** `src/resources/extensions/gsd/auto-dispatch.ts:94`
- **Fix:** Filter loaded overrides by `currentMilestoneId` in the rewrite-docs dispatch rule. Only apply overrides where `appliedAt` milestone matches current.

### M6. `resolveAllOverrides` not called on `stopAuto`
- **File:** `src/resources/extensions/gsd/auto.ts:565`
- **Fix:** Call `resolveAllOverrides(s.basePath)` during `stopAuto` cleanup, before releasing the session lock.

### M7. `reconcilePlanCheckboxes()` misses edge cases
- **File:** `src/resources/extensions/gsd/auto-worktree.ts:536-613`
- **Fix:** Handle checkboxes inside code blocks (skip them). Add test for non-standard checkbox formatting. Consider using the native parser instead of regex.

### M8. Memory extraction fire-and-forget — silently dropped
- **File:** `src/resources/extensions/gsd/auto-unit-closeout.ts:40-42`
- **Fix:** Queue memory extractions in a lightweight FIFO. Process serially. Log failures instead of silently dropping.

### M9. `hasImplementationArtifacts()` is fail-open on git errors
- **File:** `src/resources/extensions/gsd/auto-recovery.ts:409-414`
- **Fix:** On git error, return `false` (fail-closed) and log the error, rather than assuming artifacts exist.

---

## WAVE 4 — Low

| # | Issue | File | Fix |
|---|-------|------|-----|
| L1 | Session lock heartbeat gap during async pre-dispatch | `auto/loop.ts:89` | Move `validateSessionLock` to immediately before dispatch call |
| L2 | No timeout on `appendOverride` in `handleSteer` | `commands-handlers.ts:225` | Wrap with 5s timeout, catch and notify on failure |
| L3 | Reactive batch suffix uses fragile string encoding | `auto-dispatch.ts:413` | Encode as `JSON.stringify(selected)`, decode with `JSON.parse` |
| L4 | Concurrent `/gsd dispatch` during auto-mode | `auto-direct-dispatch.ts:31` | Check session lock in `dispatchDirectPhase`, error if auto-mode active |
| L5 | Bootstrap consecutive-complete guard off-by-one | `auto-start.ts:355` | Change `> 2` to `>= 2` |
| L6 | Empty task PLAN files pass artifact verification | `auto-recovery.ts:354` | Check `stat.size > 0` in addition to `existsSync` |
| L7 | Cache not invalidated on merge error path | `worktree-resolver.ts:389` | Call `invalidateAllCaches()` in error handler catch block |
| L8 | `STUCK_WINDOW_SIZE` constant — verify defined | `auto/phases.ts:525` | Locate or define; add to `constants.ts` with value `10` |
| L9 | Self-heal only handles `complete-slice` | `auto-recovery.ts:662` | Add self-heal cases for `execute-task` and `plan-slice` stuck patterns |

---

## Fix Order Summary

```
Wave 1 (CRITICAL — must fix before any PR merge):
  [C1] syncWorktreeStateBack() in mergeMilestoneToMain         auto-worktree.ts
  [C2] Artifact verification retry cap (max 3)                 auto-post-unit.ts
  [C3] /steer writes to s.basePath not process.cwd()           commands-handlers.ts

Wave 2 (HIGH — fix in same PR):
  [H1] /steer UX message clarification                         commands-handlers.ts
  [H2] Sidecar queue bypasses rewrite circuit breaker          auto/loop.ts + auto-dispatch.ts
  [H3] Reactive graph snapshot cleared on override             auto-dispatch.ts
  [H4] Crash recovery reads pi session JSONL                   crash-recovery.ts
  [H5] Cache invalidation on 1st loop error, not 2nd          auto/loop.ts
  [H6] Deduplicate resolveAllOverrides calls                   auto-dispatch.ts + auto-post-unit.ts

Wave 3 (MEDIUM — can be follow-up PR):
  [M1-M9] Stuck detection, persistence, blocker safety, etc.

Wave 4 (LOW — cleanup PR):
  [L1-L9] Hardening, edge cases, constants
```

---

## Files Modified in Wave 1+2

- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/auto-post-unit.ts`
- `src/resources/extensions/gsd/commands-handlers.ts`
- `src/resources/extensions/gsd/auto/loop.ts`
- `src/resources/extensions/gsd/auto-dispatch.ts`
- `src/resources/extensions/gsd/crash-recovery.ts`
