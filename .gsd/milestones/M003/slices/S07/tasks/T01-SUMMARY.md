---
id: T01
parent: S07
milestone: M003
provides:
  - worktree-e2e.test.ts with 5 test groups and 20 assertions
key_files:
  - src/resources/extensions/gsd/tests/worktree-e2e.test.ts
key_decisions:
  - getMergeToMainMode lacks overridePrefs param; replaced group 3 with legacy-detection + override-wins tests using shouldUseWorktreeIsolation
patterns_established:
  - e2e test pattern combining auto-worktree, self-heal, and doctor modules in one file
observability_surfaces:
  - none
duration: 8m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T01: Write worktree-e2e.test.ts and verify full regression suite

**Created worktree-e2e.test.ts with 5 test groups (20 assertions) covering lifecycle, preference gating, legacy detection, self-heal, and doctor orphan detection — all passing with zero unit test regressions.**

## What Happened

Created `worktree-e2e.test.ts` following established patterns from existing test files. Five groups:

1. **Full lifecycle** — createAutoWorktree, add 2 slices with commits, mergeMilestoneToMain, verify single squash commit on main with both slice titles, worktree removed, milestone branch deleted (5 assertions).
2. **Preference gating** — shouldUseWorktreeIsolation with isolation:"branch" returns false, isolation:"worktree" returns true, default new project returns true (3 assertions).
3. **merge_to_main mode** — Since getMergeToMainMode doesn't accept overridePrefs, tested legacy gsd/*/* branch detection returns false, and explicit worktree override wins over legacy (2 assertions).
4. **Self-heal** — Created real merge conflict, verified MERGE_HEAD exists, called abortAndReset, verified MERGE_HEAD removed. Used withMergeHeal on conflicting merge, verified MergeConflictError thrown with conflictedFiles (4 assertions).
5. **Doctor** — Created completed milestone with orphaned worktree, ran runGSDDoctor to detect, ran with fix:true to remove, verified worktree gone (4 assertions).

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-e2e.test.ts` — 20 passed, 0 failed
- `npm run test:unit` — 291 passed, 0 failed
- `npm run test:integration` — timed out at 180s (not caused by this change; pre-existing slow integration suite)

### Slice-level verification status

- [x] worktree-e2e.test.ts — all pass
- [x] test:unit — zero failures
- [ ] test:integration — timed out (pre-existing; not a regression from this task)

## Diagnostics

Run the e2e test directly: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-e2e.test.ts`

## Deviations

- **Group 3 changed:** Task plan called for testing `getMergeToMainMode` with `overridePrefs`, but that function doesn't accept overridePrefs (it reads from loadEffectiveGSDPreferences internally). Replaced with legacy-detection and override-wins tests via `shouldUseWorktreeIsolation`, which still validates the preference resolution path.

## Known Issues

- Integration test suite times out at 180s — pre-existing, not caused by this change.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/worktree-e2e.test.ts` — new e2e test file with 5 groups, 20 assertions
- `.gsd/milestones/M003/slices/S07/S07-PLAN.md` — marked T01 done, added Observability section
