---
estimated_steps: 6
estimated_files: 1
---

# T02: Wire auto-worktree lifecycle into auto.ts startAuto/resume/stop

**Slice:** S01 — Auto-worktree lifecycle in auto-mode
**Milestone:** M003

## Description

Integrate the `auto-worktree.ts` functions into `auto.ts`'s state machine: create/enter worktree on fresh start, re-enter on resume, exit on stop. The key risk is basePath/process.cwd() split-brain — every chdir must immediately update `basePath` and re-create `gitService`.

## Steps

1. Import auto-worktree functions into `auto.ts`.
2. Add `originalBasePath` module variable alongside existing `basePath`.
3. In `startAuto()` fresh-start path (after git init, before first dispatch): if worktree exists for `currentMilestoneId`, call `enterAutoWorktree`; otherwise call `createAutoWorktree`. Update `basePath` to worktree path. Re-create `gitService = new GitServiceImpl(basePath, ...)`.
4. In resume path: detect if worktree exists but `process.cwd()` is at project root (fresh process after crash). If so, `enterAutoWorktree` and update basePath. If worktree was deleted while paused, recreate it.
5. In `stopAuto()`: if `isInAutoWorktree(basePath)`, call `teardownAutoWorktree`, reset `basePath = originalBasePath`. Do NOT teardown on pause — user stays in worktree to inspect.
6. Update `clearLock` and `rebuildState` calls to use correct basePath after transitions.

## Must-Haves

- [ ] No code path where `basePath` and `process.cwd()` can diverge after chdir
- [ ] `gitService` re-created after basePath change
- [ ] Resume from fresh process (crash recovery) re-enters worktree
- [ ] Pause keeps user in worktree
- [ ] Stop exits worktree and resets basePath
- [ ] `captureIntegrationBranch` called with original basePath (not worktree path)

## Verification

- Build passes
- Code review: trace every chdir call and verify basePath update follows immediately
- Integration test from T03 exercises these paths

## Inputs

- `src/resources/extensions/gsd/auto-worktree.ts` — T01 output (all 6 functions)
- `src/resources/extensions/gsd/auto.ts` — existing state machine with basePath at line 146

## Expected Output

- `src/resources/extensions/gsd/auto.ts` — modified with worktree lifecycle hooks at startAuto/resume/stop

## Observability Impact

- **New UI notifications**: "Created/Entered/Re-entered/Exited auto-worktree at <path>" messages on start/resume/stop
- **Failure visibility**: Worktree setup failures emit warning notifications with error details but don't block auto-mode (graceful degradation)
- **Diagnostic signals**: `process.cwd()` after chdir reflects worktree path; `isInAutoWorktree(basePath)` returns runtime state
- **Split-brain prevention**: Every chdir immediately followed by basePath + gitService update in same try block
