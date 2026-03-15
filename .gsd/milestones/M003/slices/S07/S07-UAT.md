# S07: Test suite for worktree-isolated flow — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: This slice is purely a test suite — verification is running the tests and confirming pass counts.

## Preconditions

- Repository cloned with all M003 changes present
- Node.js available with `--experimental-strip-types` support

## Smoke Test

Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-e2e.test.ts` — should show "20 passed, 0 failed".

## Test Cases

### 1. E2E test file passes all 5 groups

1. Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-e2e.test.ts`
2. **Expected:** 20 passed, 0 failed. Output includes "Full lifecycle", "Preference gating", "merge_to_main mode", "Self-heal", "Doctor" groups.

### 2. Full unit test regression

1. Run `npm run test:unit`
2. **Expected:** 291+ passed, 0 failed. No new failures introduced.

### 3. Lifecycle group verifies squash commit

1. Inspect test output for "Full lifecycle" group
2. **Expected:** Single commit on main after milestone squash, commit message contains both slice titles, worktree directory removed, milestone branch deleted.

### 4. Self-heal group verifies conflict handling

1. Inspect test output for "Self-heal" group
2. **Expected:** MERGE_HEAD created and cleared by abortAndReset, MergeConflictError thrown with conflictedFiles populated.

### 5. Doctor group verifies orphan detection

1. Inspect test output for "Doctor" group
2. **Expected:** Orphaned worktree detected, fix removes it, worktree directory gone after fix.

## Edge Cases

### Pre-existing integration timeout

1. Run `npm run test:integration`
2. **Expected:** May timeout at 180s — this is pre-existing and not caused by S07.

## Failure Signals

- Any test showing "FAIL" in worktree-e2e.test.ts output
- Unit test count dropping below 291
- New failures in existing test files

## Requirements Proved By This UAT

- R041 — Test coverage for worktree-isolated flow confirmed by 20 passing assertions across 5 scenario groups

## Not Proven By This UAT

- Live auto-mode execution (covered by earlier slices' UAT)
- Remote push behavior (not tested in e2e)

## Notes for Tester

The e2e tests create real git repos in temp directories and clean up after themselves. No manual setup needed.
