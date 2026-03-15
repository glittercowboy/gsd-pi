---
estimated_steps: 8
estimated_files: 6
---

# T01: Resolve merge conflicts + add git preferences + resolver + gate auto.ts

**Slice:** S04 — Preferences + backwards compatibility
**Milestone:** M003

## Description

Single task covering the full S04 scope: resolve inherited merge conflicts in auto-worktree.ts, add `git.isolation` and `git.merge_to_main` preferences with validation, implement `shouldUseWorktreeIsolation()` resolver with legacy detection heuristic, gate all worktree creation/entry/merge sites in auto.ts behind the preferences, and write tests proving the contract. This is one task because all pieces are tightly coupled — the interface change, validation, resolver, and gating form a single logical unit with ~8 steps across 6 files.

## Steps

1. Resolve merge conflict markers in `auto-worktree.ts` — accept both HEAD (no new imports) and S03 (mergeMilestoneToMain function + helpers). Verify no `<<<<` markers remain.
2. Add `isolation?: "worktree" | "branch"` and `merge_to_main?: "milestone" | "slice"` to `GitPreferences` interface in `git-service.ts`.
3. Add validation blocks for both new fields in `validatePreferences()` in `preferences.ts`, following the existing `merge_strategy` Set-based pattern.
4. Add `shouldUseWorktreeIsolation(basePath: string): boolean` to `auto-worktree.ts`. Logic: load preferences → if `git.isolation` is set, return it === "worktree" → else run `git branch --list 'gsd/*/*'` → if branches exist, return false (legacy) → else return true (new project default).
5. In `auto.ts` fresh-start (~785) and resume (~620): wrap worktree creation/entry blocks with `if (shouldUseWorktreeIsolation(originalBasePath || base))`.
6. In `auto.ts` milestone merge (~1735): wrap `mergeMilestoneToMain` call with check for `merge_to_main !== "slice"` (skip milestone merge when user wants slice-level merging).
7. In `auto.ts` slice merge routing (~558 and ~1603): when `merge_to_main === "slice"`, force `mergeSliceToMain` path even when `isInAutoWorktree()` is true.
8. Write test files: `preferences-git.test.ts` (validation of new fields) and `isolation-resolver.test.ts` (resolver logic with mocked preferences and git state).

## Must-Haves

- [ ] `GitPreferences` interface extended with both new fields
- [ ] Validation rejects invalid values with clear error messages
- [ ] `shouldUseWorktreeIsolation` checks preference first, then legacy heuristic, then defaults to worktree
- [ ] All 3 worktree sites in auto.ts gated
- [ ] `merge_to_main: "slice"` overrides merge routing even in worktree mode
- [ ] Merge conflicts in auto-worktree.ts fully resolved
- [ ] Tests pass for preference validation and resolver logic

## Verification

- `npx tsc --noEmit` — zero errors
- `node --test src/resources/extensions/gsd/tests/preferences-git.test.ts` — all pass
- `node --test src/resources/extensions/gsd/tests/isolation-resolver.test.ts` — all pass
- `grep -c '<<<<<<' src/resources/extensions/gsd/auto-worktree.ts` returns 0

## Inputs

- `src/resources/extensions/gsd/git-service.ts` — existing `GitPreferences` interface (lines 31-39)
- `src/resources/extensions/gsd/preferences.ts` — existing `validatePreferences()` with Set-based pattern (lines 860-912)
- `src/resources/extensions/gsd/auto-worktree.ts` — S01 lifecycle functions + S03 merge functions (with conflict markers)
- `src/resources/extensions/gsd/auto.ts` — worktree creation/entry at ~785/~620, merge routing at ~558/~1603, milestone merge at ~1735
- S01 summary — `shouldUseWorktreeIsolation` must use `originalBasePath` for legacy detection

## Expected Output

- `src/resources/extensions/gsd/git-service.ts` — `GitPreferences` with 2 new optional fields
- `src/resources/extensions/gsd/preferences.ts` — 2 new validation blocks
- `src/resources/extensions/gsd/auto-worktree.ts` — conflict-free, with `shouldUseWorktreeIsolation()` exported
- `src/resources/extensions/gsd/auto.ts` — 5 sites gated behind preferences
- `src/resources/extensions/gsd/tests/preferences-git.test.ts` — preference validation tests
- `src/resources/extensions/gsd/tests/isolation-resolver.test.ts` — resolver logic tests
