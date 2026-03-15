---
estimated_steps: 5
estimated_files: 1
---

# T03: Integration test for auto-worktree lifecycle

**Slice:** S01 — Auto-worktree lifecycle in auto-mode
**Milestone:** M003

## Description

End-to-end integration test in a temp git repo proving the full auto-worktree lifecycle: create, enter, detect, exit, teardown, re-enter, and coexistence with manual worktrees. This is the primary risk retirement for S01.

## Steps

1. Set up test: create temp directory, `git init`, initial commit, create `.gsd/milestones/M003/M003-CONTEXT.md`, commit planning files.
2. Test create: `createAutoWorktree(base, "M003")`. Assert worktree dir exists at `.gsd/worktrees/M003/`, git branch is `milestone/M003`, planning files are present in worktree, `isInAutoWorktree` returns true, `getAutoWorktreeOriginalBase()` returns original path.
3. Test teardown: create a file in worktree, commit. `teardownAutoWorktree(originalBase, "M003")`. Assert `process.cwd()` back to original, worktree dir removed, `isInAutoWorktree` returns false.
4. Test re-entry: create worktree again, `process.chdir` back to original manually (simulates fresh process), call `enterAutoWorktree` — verify re-entry works.
5. Test coexistence: create auto-worktree `milestone/M003` + manual worktree `worktree/explore` — both exist, no branch conflicts.

## Must-Haves

- [ ] All lifecycle states tested with real git operations
- [ ] Planning file inheritance verified
- [ ] Manual worktree coexistence verified
- [ ] Temp dirs cleaned up after test

## Verification

- `npm test -- --grep "auto-worktree"`

## Inputs

- `src/resources/extensions/gsd/auto-worktree.ts` — T01 output
- `src/resources/extensions/gsd/worktree-manager.ts` — generalized branch parameter from T01

## Observability Impact

- **Test output signals:** Console banners (`=== auto-worktree lifecycle ===`, `=== re-entry ===`, `=== coexistence ===`, `=== split-brain prevention ===`) with pass/fail counts.
- **Inspection:** `npm test -- --grep "auto-worktree"` — 21 assertions covering all lifecycle states.
- **Failure visibility:** Test runner reports exact assertion name and expected vs actual on failure.

## Expected Output

- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — comprehensive integration test
