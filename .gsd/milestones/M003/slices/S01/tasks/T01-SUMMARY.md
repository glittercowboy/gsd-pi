---
id: T01
parent: S01
milestone: M003
provides:
  - auto-worktree.ts module with 6 lifecycle functions
  - generalized branch parameter on createWorktree/removeWorktree
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/worktree-manager.ts
  - src/resources/extensions/gsd/tests/auto-worktree.test.ts
key_decisions:
  - Replicated nudgeGitBranchCache locally rather than exporting from worktree-command.ts (avoids coupling to command layer)
  - Used realpathSync in isInAutoWorktree to handle macOS /tmp symlink
patterns_established:
  - Atomic chdir + originalBase update in same try block (split-brain prevention)
  - milestone/<MID> branch naming for auto-worktrees vs worktree/<name> for manual
observability_surfaces:
  - isInAutoWorktree(basePath) — runtime detection of auto-worktree state
  - getAutoWorktreeOriginalBase() — returns null when not in worktree (split-brain sentinel)
duration: 20m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T01: Create auto-worktree.ts module and generalize worktree-manager branch naming

**Added auto-worktree.ts with 6 lifecycle functions and generalized worktree-manager branch parameter**

## What Happened

Added optional `branch` parameter to `createWorktree` and `removeWorktree` in worktree-manager.ts so callers can override the default `worktree/<name>` prefix. Created auto-worktree.ts with: `createAutoWorktree`, `teardownAutoWorktree`, `isInAutoWorktree`, `getAutoWorktreePath`, `enterAutoWorktree`, `getAutoWorktreeOriginalBase`. All use `milestone/<MID>` branch naming. Atomic chdir + state update prevents split-brain. nudgeGitBranchCache replicated locally to avoid coupling to command layer.

## Verification

- `npm test -- --grep "auto-worktree"` — 21 passed, 0 failed (create, detect, teardown, re-entry, coexistence, split-brain prevention)
- `npx tsc --noEmit` — clean, no errors
- Slice-level checks: test passes ✅, build passes ✅, failure diagnostic (originalBase null after teardown) ✅

## Diagnostics

- `isInAutoWorktree(basePath)` returns current state
- `getAutoWorktreeOriginalBase()` returns null when not in worktree
- Test covers: lifecycle, re-entry after manual chdir, coexistence with manual worktrees

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — new module with 6 auto-worktree lifecycle functions
- `src/resources/extensions/gsd/worktree-manager.ts` — added optional `branch` param to createWorktree and removeWorktree
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — 21 tests covering full lifecycle
- `.gsd/milestones/M003/slices/S01/S01-PLAN.md` — marked T01 done, added failure diagnostic verification
