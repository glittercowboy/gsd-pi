# S01: Auto-worktree lifecycle in auto-mode

**Goal:** `startAuto()` on a new milestone creates a worktree under `.gsd/worktrees/<MID>/`, `chdir`s into it, and dispatches units inside the worktree. Pause/resume re-enters the worktree. `stopAuto()` exits cleanly.

**Demo:** Run auto-mode on a milestone → verify `process.cwd()` resolves inside `.gsd/worktrees/M003/`, git branch is `milestone/M003`, file operations resolve correctly. Pause, resume → re-enters worktree. Stop → returns to project root.

## Must-Haves

- `createAutoWorktree(basePath, milestoneId)` creates worktree with `milestone/<MID>` branch
- `teardownAutoWorktree(basePath, milestoneId)` removes worktree, returns to main tree
- `isInAutoWorktree(basePath)` detects if currently in an auto-worktree
- `getAutoWorktreePath(basePath, milestoneId)` resolves worktree path
- `enterAutoWorktree(basePath, milestoneId)` does `process.chdir` into existing worktree
- `getAutoWorktreeOriginalBase()` returns original project root
- `startAuto()` creates/enters worktree before first dispatch
- Resume path re-enters worktree if it exists
- `stopAuto()` exits worktree, resets basePath to original root
- Manual `/worktree` coexists (different branch prefix: `worktree/` vs `milestone/`)
- `.gsd/` planning files available in worktree after creation

## Proof Level

- This slice proves: integration
- Real runtime required: yes (temp repo with real git operations)
- Human/UAT required: no (automated test covers the lifecycle)

## Verification

- `npm test -- --grep "auto-worktree"` — integration test in temp repo covering create/enter/detect/teardown lifecycle
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — test file
- Build passes: `npm run build` (or equivalent TypeScript check)
- Failure diagnostic: `getAutoWorktreeOriginalBase()` returns `null` when not in worktree (split-brain prevented); `isInAutoWorktree()` returns `false` after teardown

## Observability / Diagnostics

- Runtime signals: `process.cwd()` value after chdir, git branch name after worktree creation
- Inspection surfaces: `git worktree list`, `ls .gsd/worktrees/<MID>/`
- Failure visibility: split-brain detection — `basePath` vs `process.cwd()` mismatch logged as error
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `worktree-manager.ts` (createWorktree, removeWorktree, worktreePath, worktreesDir, getMainBranch), `worktree-command.ts` (nudgeGitBranchCache pattern)
- New wiring introduced in this slice: `auto-worktree.ts` module, `auto.ts` startAuto/resume/stop hooks
- What remains before the milestone is truly usable end-to-end: S02 (--no-ff slice merges), S03 (milestone squash to main), S04 (preferences gating)

## Tasks

- [x] **T01: Create auto-worktree.ts module and generalize worktree-manager branch naming** `est:45m`
  - Why: The boundary map requires 6 focused functions for auto-worktree lifecycle. `worktree-manager.ts` hardcodes `worktree/<name>` branch prefix — must accept a custom branch name for `milestone/<MID>`.
  - Files: `src/resources/extensions/gsd/auto-worktree.ts`, `src/resources/extensions/gsd/worktree-manager.ts`
  - Do: (1) Add optional `branch` parameter to `createWorktree` in worktree-manager.ts — when provided, use it instead of `worktreeBranchName(name)`. Same for `removeWorktree`. (2) Create `auto-worktree.ts` with: `createAutoWorktree(basePath, mid)` — calls `createWorktree` with branch `milestone/<MID>`, does `process.chdir`, stores `originalBase`, nudges git branch cache. `teardownAutoWorktree(basePath, mid)` — chdir back to originalBase, calls `removeWorktree`. `isInAutoWorktree(basePath)` — checks if basePath is inside `.gsd/worktrees/` AND current git branch starts with `milestone/`. `getAutoWorktreePath(basePath, mid)` — returns `worktreePath(basePath, mid)` if it exists, null otherwise. `enterAutoWorktree(basePath, mid)` — chdir into existing worktree, store originalBase. `getAutoWorktreeOriginalBase()` — returns stored originalBase.
  - Verify: Unit test — import functions, call `createAutoWorktree` in a temp git repo, verify path exists, branch is `milestone/M003`, `isInAutoWorktree` returns true, `getAutoWorktreeOriginalBase()` returns original path. Then teardown and verify cleanup.
  - Done when: All 6 functions exported, `createWorktree` accepts custom branch, unit test passes.

- [x] **T02: Wire auto-worktree lifecycle into auto.ts startAuto/resume/stop** `est:45m`
  - Why: The auto-worktree module must be called at the right points in auto.ts's state machine to create worktrees on fresh starts, re-enter on resume, and exit on stop.
  - Files: `src/resources/extensions/gsd/auto.ts`
  - Do: (1) In `startAuto()` fresh-start path (after git init/gitignore, before first dispatch ~line 624-762): call `createAutoWorktree(base, mid)` or `enterAutoWorktree(base, mid)` if worktree already exists. Update `basePath` to worktree path. Re-create `gitService` with new basePath. (2) In resume path (~line 560-597): if `isInAutoWorktree` is false but worktree exists for current milestone, call `enterAutoWorktree` and update basePath. Handle missing worktree (recreate from milestone branch). (3) In `stopAuto()` (~line 338): if in auto-worktree, call `teardownAutoWorktree`, reset basePath to original root. (4) In `pauseAuto()`: no chdir — stay in worktree while paused so user can inspect. (5) Store `originalBasePath` module variable for teardown. (6) After any chdir, immediately update both `basePath` and re-create `gitService` in same try block to prevent split-brain.
  - Verify: Build passes. Manual trace through code paths confirms basePath/chdir consistency.
  - Done when: `startAuto` creates/enters worktree, resume re-enters, stop exits. No split-brain paths exist.

- [x] **T03: Integration test for auto-worktree lifecycle** `est:30m`
  - Why: Proves the full lifecycle works end-to-end in a real git repo — the primary risk retirement for this slice.
  - Files: `src/resources/extensions/gsd/tests/auto-worktree.test.ts`
  - Do: (1) Create temp git repo with initial commit. (2) Create `.gsd/milestones/M003/` with a dummy CONTEXT file (simulates planning artifacts). Commit. (3) Call `createAutoWorktree(base, "M003")`. Assert: worktree dir exists, git branch is `milestone/M003`, `.gsd/milestones/M003/` exists in worktree (planning files inherited), `process.cwd()` is worktree path, `isInAutoWorktree` returns true, `getAutoWorktreeOriginalBase()` returns original. (4) Create a file in worktree, commit. (5) Call `teardownAutoWorktree`. Assert: process.cwd() back to original, worktree dir removed, `isInAutoWorktree` returns false. (6) Test re-entry: create worktree again, exit without teardown, call `enterAutoWorktree` — verify re-entry works. (7) Test coexistence: create manual worktree with `worktree/<name>` branch alongside auto-worktree — both exist without conflict.
  - Verify: `npm test -- --grep "auto-worktree"`
  - Done when: All lifecycle scenarios pass — create, detect, teardown, re-enter, coexistence.

## Files Likely Touched

- `src/resources/extensions/gsd/auto-worktree.ts` (new)
- `src/resources/extensions/gsd/worktree-manager.ts` (generalize branch param)
- `src/resources/extensions/gsd/auto.ts` (wire lifecycle hooks)
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` (new)
