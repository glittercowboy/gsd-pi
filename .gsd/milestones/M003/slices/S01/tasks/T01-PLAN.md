---
estimated_steps: 6
estimated_files: 2
---

# T01: Create auto-worktree.ts module and generalize worktree-manager branch naming

**Slice:** S01 — Auto-worktree lifecycle in auto-mode
**Milestone:** M003

## Description

Build the `auto-worktree.ts` module with 6 focused functions for auto-worktree lifecycle management, and generalize `worktree-manager.ts`'s `createWorktree`/`removeWorktree` to accept a custom branch name (needed for `milestone/<MID>` instead of `worktree/<name>`).

## Steps

1. Add optional `branch?: string` parameter to `createWorktree` in `worktree-manager.ts`. When provided, use it instead of `worktreeBranchName(name)`. Apply same pattern to `removeWorktree`.
2. Create `auto-worktree.ts` with module-level `originalBase: string | null` state.
3. Implement `createAutoWorktree(basePath, milestoneId)` — calls `createWorktree(basePath, milestoneId, { branch: \`milestone/${milestoneId}\` })`, does `process.chdir(worktreePath)`, stores `originalBase = basePath`, calls `nudgeGitBranchCache`.
4. Implement `teardownAutoWorktree(originalBasePath, milestoneId)` — `process.chdir(originalBase)`, calls `removeWorktree(originalBase, milestoneId, { branch: \`milestone/${milestoneId}\` })`, clears `originalBase`.
5. Implement `isInAutoWorktree(basePath)`, `getAutoWorktreePath(basePath, milestoneId)`, `enterAutoWorktree(basePath, milestoneId)`, `getAutoWorktreeOriginalBase()`.
6. Write initial unit test covering create → detect → teardown in temp git repo.

## Must-Haves

- [ ] `createWorktree` accepts optional branch override
- [ ] `removeWorktree` accepts optional branch override
- [ ] All 6 auto-worktree functions exported and working
- [ ] `process.chdir` + `originalBase` update in same try block (no split-brain)
- [ ] `nudgeGitBranchCache` called after chdir (proven pattern from worktree-command.ts)

## Verification

- Unit test passes: `npm test -- --grep "auto-worktree"`
- TypeScript compiles: `npx tsc --noEmit` (or build equivalent)

## Observability Impact

- Signals added/changed: none (pure functions, no runtime logging yet)
- How a future agent inspects this: call `isInAutoWorktree()` and `getAutoWorktreeOriginalBase()`
- Failure state exposed: split-brain prevented by atomic chdir+store pattern

## Inputs

- `src/resources/extensions/gsd/worktree-manager.ts` — `createWorktree`, `removeWorktree`, `worktreePath`, `worktreesDir`, `getMainBranch` functions
- `src/resources/extensions/gsd/worktree-command.ts` — `nudgeGitBranchCache` pattern (lines 83-92), `originalCwd` tracking pattern (line 42-55)

## Expected Output

- `src/resources/extensions/gsd/auto-worktree.ts` — new module with 6 exported functions
- `src/resources/extensions/gsd/worktree-manager.ts` — generalized branch parameter on create/remove
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — initial test covering core lifecycle
