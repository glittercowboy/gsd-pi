---
id: T02
parent: S01
milestone: M003
provides:
  - auto-worktree lifecycle wired into auto.ts startAuto/resume/stop
key_files:
  - src/resources/extensions/gsd/auto.ts
key_decisions:
  - Worktree creation is non-fatal — auto-mode continues in project root if creation fails
  - captureIntegrationBranch uses originalBasePath (not worktree path) to capture correct branch
  - SIGTERM handler re-registered with worktree basePath after chdir
patterns_established:
  - Every auto-worktree chdir immediately followed by basePath + gitService update in same try block
  - originalBasePath stored at startAuto, reset at stopAuto, used for teardown
observability_surfaces:
  - UI notifications on worktree create/enter/exit/failure
  - isInAutoWorktree(basePath) runtime detection in stopAuto guard
duration: 15m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T02: Wire auto-worktree lifecycle into auto.ts startAuto/resume/stop

**Wired auto-worktree create/enter/teardown into auto.ts state machine with split-brain prevention**

## What Happened

Imported 6 auto-worktree functions into auto.ts. Added `originalBasePath` module variable. In `startAuto()` fresh-start path: after `captureIntegrationBranch` (which needs the original base), create or enter worktree, update basePath and gitService. In resume path: detect if not in worktree and re-enter (or recreate if deleted). In `stopAuto()`: teardown worktree, reset basePath to original, re-create gitService. Pause intentionally does not chdir — user stays in worktree to inspect. Fixed `captureIntegrationBranch` in `dispatchNextUnit` to use `originalBasePath || basePath`.

## Verification

- `npx tsc --noEmit` — clean, no type errors
- `npm test -- auto-worktree.test.ts` — 21 tests pass (existing T01 tests still green)
- Code review: traced all chdir paths — each immediately updates basePath + gitService in same try block
- Slice-level checks: build passes ✅, auto-worktree tests pass ✅

## Diagnostics

- UI notifications: "Created/Entered/Re-entered/Exited auto-worktree at <path>"
- Failure notifications include error message but don't block auto-mode
- `isInAutoWorktree(basePath)` checked in stopAuto guard before teardown

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto.ts` — imported auto-worktree functions, added originalBasePath, wired lifecycle into startAuto/resume/stop
- `.gsd/milestones/M003/slices/S01/tasks/T02-PLAN.md` — added Observability Impact section
- `.gsd/milestones/M003/slices/S01/S01-PLAN.md` — marked T02 done
