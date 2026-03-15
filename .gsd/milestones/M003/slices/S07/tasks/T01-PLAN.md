---
estimated_steps: 7
estimated_files: 1
---

# T01: Write worktree-e2e.test.ts and verify full regression suite

**Slice:** S07 — Test suite for worktree-isolated flow
**Milestone:** M003

## Description

Create `worktree-e2e.test.ts` with 5 test groups covering the cross-cutting gaps not tested by individual slice tests: full lifecycle chain, preference gating, merge_to_main mode, self-heal in merge context, and doctor detection of orphaned worktrees. Then run the full regression suite to confirm zero breakage.

## Steps

1. Create `worktree-e2e.test.ts` with imports from auto-worktree.ts, git-self-heal.ts, doctor.ts, and test-helpers.ts. Set up shared helpers (createTempRepo, run, addSliceToMilestone — reuse pattern from auto-worktree-milestone-merge.test.ts).
2. Write test group 1 (full lifecycle): createAutoWorktree → add 2 slices with commits → mergeSliceToMilestone for each → mergeMilestoneToMain → assert `git log --oneline main` shows exactly one new commit, commit message contains both slice titles, worktree directory removed, milestone branch deleted.
3. Write test group 2 (preference gating): call `shouldUseWorktreeIsolation` with `overridePrefs: { git: { isolation: "branch" } }` → assert returns false. Call with `{ git: { isolation: "worktree" } }` → assert returns true.
4. Write test group 3 (merge_to_main mode): call `getMergeToMainMode` with overridePrefs `{ git: { merge_to_main: "slice" } }` → assert returns "slice". Call with "milestone" → assert returns "milestone".
5. Write test group 4 (self-heal): create repo, write a MERGE_HEAD file to simulate corrupt state, call `abortAndReset` → assert MERGE_HEAD removed. Then create a real merge conflict, call `withMergeHeal` wrapping a merge that conflicts → assert MergeConflictError thrown with conflictedFiles.
6. Write test group 5 (doctor): create a completed milestone scenario with an orphaned worktree, call `checkGitHealth` → assert orphaned_auto_worktree issue detected. Call with fix:true → assert worktree removed.
7. Run `npm run test:unit && npm run test:integration` and confirm zero new failures.

## Must-Haves

- [ ] 5 test groups covering lifecycle, preferences, merge mode, self-heal, doctor
- [ ] 15+ assertions total
- [ ] All existing tests pass (zero regressions)
- [ ] No Unicode in JSDoc comments
- [ ] cwd restored in every finally block

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-e2e.test.ts` — all pass
- `npm run test:unit` — zero failures
- `npm run test:integration` — zero failures

## Inputs

- `src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — pattern for addSliceToMilestone helper and temp repo setup
- `src/resources/extensions/gsd/tests/git-self-heal.test.ts` — pattern for corrupt state setup
- `src/resources/extensions/gsd/tests/doctor-git.test.ts` — pattern for checkGitHealth testing
- `src/resources/extensions/gsd/tests/isolation-resolver.test.ts` — pattern for overridePrefs usage

## Expected Output

- `src/resources/extensions/gsd/tests/worktree-e2e.test.ts` — new test file with 5 test groups and 15+ assertions
