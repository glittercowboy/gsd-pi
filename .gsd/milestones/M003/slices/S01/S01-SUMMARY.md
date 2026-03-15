---
id: S01
parent: M003
milestone: M003
provides:
  - auto-worktree.ts module with 6 lifecycle functions (create, teardown, detect, path, enter, getOriginalBase)
  - generalized branch parameter on createWorktree/removeWorktree in worktree-manager.ts
  - auto-worktree lifecycle wired into auto.ts startAuto/resume/stop state machine
  - integration test suite with 21 assertions covering full lifecycle
requires:
  - slice: none
    provides: first slice — no upstream dependencies
affects:
  - S02 (worktree infrastructure for --no-ff slice merges)
  - S03 (teardown + squash-merge on milestone complete)
  - S04 (preferences gating worktree vs branch isolation)
  - S05 (worktree detection for scoping self-heal repairs)
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/worktree-manager.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/tests/auto-worktree.test.ts
key_decisions:
  - D034: Replicated nudgeGitBranchCache locally in auto-worktree.ts rather than exporting from worktree-command.ts to avoid coupling module to command layer
  - D035: Worktree creation is non-fatal in auto.ts — auto-mode continues in project root if creation fails
  - D036: captureIntegrationBranch uses originalBasePath (not worktree path) to capture correct branch name
patterns_established:
  - Atomic chdir + originalBase + basePath + gitService update in same try block (split-brain prevention)
  - milestone/<MID> branch naming for auto-worktrees vs worktree/<name> for manual
  - realpathSync on temp dirs to handle macOS /tmp symlink in assertions
observability_surfaces:
  - isInAutoWorktree(basePath) — runtime detection of auto-worktree state
  - getAutoWorktreeOriginalBase() — returns null when not in worktree (split-brain sentinel)
  - UI notifications on worktree create/enter/exit/failure
drill_down_paths:
  - .gsd/milestones/M003/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M003/slices/S01/tasks/T02-SUMMARY.md
  - .gsd/milestones/M003/slices/S01/tasks/T03-SUMMARY.md
duration: 40m
verification_result: passed
completed_at: 2026-03-14
---

# S01: Auto-worktree lifecycle in auto-mode

**Auto-worktree module with 6 lifecycle functions wired into auto.ts state machine, proven by 21-assertion integration test**

## What Happened

Created `auto-worktree.ts` with 6 focused functions: `createAutoWorktree`, `teardownAutoWorktree`, `isInAutoWorktree`, `getAutoWorktreePath`, `enterAutoWorktree`, `getAutoWorktreeOriginalBase`. Generalized `worktree-manager.ts` to accept an optional `branch` parameter so auto-worktrees use `milestone/<MID>` branches while manual worktrees keep `worktree/<name>`. Wired the lifecycle into `auto.ts`: startAuto creates/enters worktree before first dispatch, resume re-enters if not already in worktree, stop tears down and resets basePath. Every chdir atomically updates basePath + gitService in the same try block to prevent split-brain. Worktree creation is non-fatal — auto-mode degrades gracefully to project root on failure. Integration test covers lifecycle, re-entry, coexistence with manual worktrees, and split-brain prevention.

## Verification

- `node --test auto-worktree.test.ts` — 21 passed, 0 failed across 4 test groups (lifecycle, re-entry, coexistence, split-brain prevention)
- `npx tsc --noEmit` — clean build, no type errors
- Planning files (.gsd/milestones/) verified accessible in worktree after creation
- `getAutoWorktreeOriginalBase()` returns null after teardown (failure diagnostic confirmed)
- `isInAutoWorktree()` returns false after teardown (state cleanup confirmed)

## Requirements Advanced

- R029 — Auto-worktree creation on milestone start: createAutoWorktree creates worktree with `milestone/<MID>` branch, chdir, and dispatches from within. Wired into startAuto fresh-start and resume paths.
- R039 — Manual `/worktree` coexistence: Different branch prefixes (`milestone/` vs `worktree/`) prevent collisions. Integration test proves both can exist simultaneously.

## Requirements Validated

- None moved to validated yet — R029 needs S02/S03 for full end-to-end proof, R039 needs S04 preferences integration.

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

None.

## Known Limitations

- Worktree creation is non-fatal: if git worktree add fails, auto-mode continues in project root without isolation. This is intentional degradation, not a bug.
- Pause does not chdir out of worktree — user stays in worktree to inspect state. This is by design.
- No preferences gating yet — worktree creation happens unconditionally. S04 adds `git.isolation` preference.

## Follow-ups

- S02: Wire `--no-ff` slice merges within the worktree
- S03: Milestone squash-merge to main + worktree teardown on completion
- S04: Gate worktree creation behind `git.isolation` preference

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — new module with 6 auto-worktree lifecycle functions
- `src/resources/extensions/gsd/worktree-manager.ts` — added optional `branch` param to createWorktree and removeWorktree
- `src/resources/extensions/gsd/auto.ts` — imported auto-worktree functions, added originalBasePath, wired lifecycle into startAuto/resume/stop
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — 21 tests covering full lifecycle

## Forward Intelligence

### What the next slice should know
- `createAutoWorktree` does chdir + state update atomically. Any new code that calls it must not assume cwd is unchanged after the call.
- `originalBasePath` in auto.ts is the canonical "project root" reference after worktree entry. Use it for anything that needs the real project root (e.g., captureIntegrationBranch).

### What's fragile
- The `originalBasePath` module variable in auto.ts is set on startAuto and cleared on stopAuto. If a code path bypasses stopAuto (crash, SIGKILL), the variable is lost. The worktree itself persists on disk and can be re-entered on resume.

### Authoritative diagnostics
- `isInAutoWorktree(basePath)` + `getAutoWorktreeOriginalBase()` — the two canonical signals for worktree state. If these disagree with `process.cwd()`, there's a split-brain bug.
- `git worktree list` — ground truth for what worktrees exist

### What assumptions changed
- No assumptions changed. The implementation matched the plan closely.
