# S01: Auto-worktree lifecycle in auto-mode — Research

**Date:** 2026-03-14

## Summary

The worktree infrastructure already exists in `worktree-manager.ts` (create, list, remove, merge) and `worktree-command.ts` proves that `process.chdir` into worktrees works correctly with all file tools. The dynamic-cwd bash/file tools in `index.ts` (lines 108-140) already read `process.cwd()` dynamically via `spawnHook`, so `chdir` propagation is proven. The main work is wiring this into `auto.ts`'s `startAuto()`, `dispatchNextUnit()`, pause/resume, and `stopAuto()`.

The key risk — `basePath` vs `process.cwd()` split-brain — is real. `auto.ts` uses a module-level `basePath` variable (line 146) that's set once in `startAuto()` and used everywhere. In worktree mode, `basePath` must be updated to the worktree path after `chdir`, and all functions that pass `basePath` to git/file operations will naturally resolve correctly since they already use it (not a hardcoded original path). However, the original project root must be preserved separately for teardown/merge operations that need to run from the main tree.

## Recommendation

Create a new `auto-worktree.ts` module with 5-6 focused functions (`createAutoWorktree`, `teardownAutoWorktree`, `isInAutoWorktree`, `getAutoWorktreePath`, `enterAutoWorktree`, `getAutoWorktreeOriginalBase`). Wire into `startAuto()` at the point after git repo validation but before first `dispatchNextUnit()`. Reuse `worktree-manager.ts` for the actual git worktree operations but use `milestone/<MID>` branch naming (D032) instead of `worktree/<name>`.

The `worktree-command.ts` pattern of tracking `originalCwd` (line 52) is the proven model — adapt it for auto-mode. The `nudgeGitBranchCache` helper should be reused directly.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Worktree create/remove | `worktree-manager.ts` `createWorktree`/`removeWorktree` | Battle-tested, handles edge cases (stale branches, locked dirs, prune) |
| Git branch cache nudge | `worktree-command.ts` `nudgeGitBranchCache` | Proven fix for footer branch display after chdir |
| Dynamic cwd propagation | `index.ts` `spawnHook` + dynamic file tools | Already ensures bash/read/write/edit follow `process.cwd()` |
| Main branch detection | `worktree-manager.ts` `getMainBranch` | Handles origin/HEAD, main, master fallbacks |
| Git command execution | `worktree-manager.ts` `runGit` (private) / `git-service.ts` `runGit` | Suppresses git-svn noise, handles env properly |

## Existing Code and Patterns

- `worktree-manager.ts` — `createWorktree()` creates under `.gsd/worktrees/<name>/` with branch `worktree/<name>`. For auto-worktrees, need a variant that uses branch `milestone/<MID>` per D032. Can either add a `branchPrefix` option or create a thin wrapper.
- `worktree-command.ts` lines 52-55 — `originalCwd` tracking pattern. `handleCreate` sets it before `chdir`, `handleReturn` clears it after `chdir` back. **Adapt this for auto-mode.**
- `worktree-command.ts` lines 228-242 — `/reload` recovery: detects if `process.cwd()` is inside `.gsd/worktrees/` and restores `originalCwd`. Auto-mode needs equivalent for resume.
- `auto.ts` line 146 — `basePath` module variable. Must be updated to worktree path after `chdir`. The original base must be stored separately.
- `auto.ts` lines 560-597 — Resume (paused) path. Needs: detect if worktree exists for current milestone, `chdir` into it, update `basePath`.
- `auto.ts` lines 624-762 — Fresh start path. Needs: create worktree after git init/gitignore but before first dispatch.
- `auto.ts` line 3136 — `ensureSliceBranch` call in `ensureUnitDirectories`. In worktree mode, slice branches are still created within the worktree (git allows this — the worktree has its own checkout).
- `worktree.ts` `detectWorktreeName()` — Detects if basePath is inside `.gsd/worktrees/`. Can be extended or a parallel `detectAutoWorktree()` added that checks for `milestone/` branch prefix.
- `git-service.ts` `GitServiceImpl` — Constructed with `basePath`. When basePath changes to worktree path, a new instance must be created (or the cached service in `worktree.ts` must be invalidated).
- `index.ts` lines 108-140 — Dynamic cwd tools prove `process.chdir` works. No changes needed here.

## Constraints

- `worktree-manager.ts` `createWorktree` hardcodes `worktreeBranchName(name)` → `worktree/<name>`. Auto-worktrees need `milestone/<MID>`. Either generalize `createWorktree` with a branch name parameter or write a parallel function. Generalizing is cleaner.
- `worktree-manager.ts` `createWorktree` validates name with `/^[a-zA-Z0-9_-]+$/`. Milestone IDs like `M003` pass this. IDs with suffixes like `M003-abc123` also pass.
- `cachedService` in `worktree.ts` caches by `basePath`. When `basePath` changes from project root to worktree path, the cache auto-invalidates (different string). This is correct behavior.
- The `removeWorktree` function already handles "if we're inside the worktree, chdir out first" (line ~315). Good for teardown.
- `stopAuto()` (line 338) calls `clearLock(basePath)` and `rebuildState(basePath)`. After teardown, `basePath` must point back to the original project root.
- `process.chdir` is synchronous and global. No async race conditions, but any error between `chdir` into worktree and setting `basePath` could leave state inconsistent.

## Common Pitfalls

- **Split-brain basePath** — If `process.chdir()` succeeds but `basePath` update fails (thrown exception), all subsequent operations use wrong paths. Mitigation: update `basePath` immediately after `chdir`, in the same try block.
- **GitServiceImpl cache stale after chdir** — The `worktree.ts` `cachedService` is keyed on `basePath`. When `basePath` changes, the old service is naturally replaced. But if any code holds a reference to the old `GitServiceImpl` (like `auto.ts` line 625 `gitService` variable), it will operate on the old path. Must re-create `gitService` in `auto.ts` after chdir.
- **Resume without worktree** — User deletes worktree manually while paused. Resume must handle: worktree dir missing → recreate it from the milestone branch (which still exists in git).
- **Worktree branch already exists** — `createWorktree` already handles leftover branches (resets them to main HEAD). Good.
- **`.gsd/` planning files must be present in worktree** — When worktree is created from main HEAD, `.gsd/milestones/M003/` should already be committed on main (planning happens before auto-mode creates the worktree). Verify: planning files (CONTEXT, ROADMAP) are committed to main before worktree creation.
- **Lock file path** — `auto.lock` is written to `basePath/.gsd/auto.lock`. After chdir, this goes into the worktree's `.gsd/`. On resume, must check the worktree's lock, not the main tree's.

## Open Risks

- **Pause/resume across sessions** — If the process dies while in a worktree, the next `startAuto()` call starts with `process.cwd()` at the project root (fresh process). Must detect that a worktree exists for the active milestone and re-enter it. The crash recovery path (line 635-655) needs worktree awareness.
- **`mergeOrphanedSliceBranches` in worktree context** — This function (called at line 758) operates on basePath. In worktree mode, orphaned slice branches exist within the worktree's branch namespace. Should work correctly since it uses `basePath` which will be the worktree path, but needs verification.
- **Doctor running inside worktree** — `runGSDDoctor` (line 817) uses basePath. Doctor checks may behave differently inside a worktree (different `.gsd/` state). Likely fine for S01 scope but watch for edge cases.
- **`captureIntegrationBranch` semantics change** — In worktree mode, the "integration branch" concept changes. Slices merge into the milestone branch (which is checked out in the worktree), not into main. The existing `captureIntegrationBranch` may need adjustment or bypass in worktree mode.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| git worktrees | n/a | No external skill needed — all logic is internal |

## Sources

- `worktree-manager.ts` — full worktree CRUD implementation (source: codebase)
- `worktree-command.ts` — proven `process.chdir` + `originalCwd` pattern (source: codebase)
- `auto.ts` — full auto-mode state machine with basePath usage (source: codebase)
- `index.ts` — dynamic cwd tools proving chdir propagation works (source: codebase)
- `git-service.ts` — `GitServiceImpl` and `GitPreferences` interface (source: codebase)
- `worktree.ts` — thin facade with cached service pattern (source: codebase)
