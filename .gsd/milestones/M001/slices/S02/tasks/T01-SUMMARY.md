---
id: T01
parent: S02
milestone: M001
provides:
  - S01 code (ManifestStatus type, getManifestStatus function, contract tests) available on S02 branch
  - Test scaffolding for S02 functions with 9 initially-failing test cases
key_files:
  - src/resources/extensions/gsd/tests/collect-from-manifest.test.ts
key_decisions:
  - Used dynamic imports in test file so individual tests fail with clear messages instead of the whole file crashing at module-level import
patterns_established:
  - loadOrchestrator() / loadGuidanceExport() pattern for testing not-yet-exported functions with clear error messages per test
observability_surfaces:
  - none
duration: 15m
verification_result: passed
blocker_discovered: false
---

# T01: Merge S01 and create test scaffolding

**Merged S01 branch (ManifestStatus, getManifestStatus, contract tests) into S02 and created 9-test scaffolding file targeting T02/T03 functions**

## What Happened

Fast-forward merged `gsd/M001/S01` (commits 93c0852, 05ff6c6) into `gsd/M001/S02`. The merge brought 4 files: `types.ts` (+7 lines for ManifestStatus interface), `files.ts` (+46 lines for getManifestStatus function), `manifest-status.test.ts` (283 lines, 7 contract tests), and `parsers.test.ts` (+190 lines, secrets manifest parser tests).

Created `collect-from-manifest.test.ts` with 9 test cases covering all 5 areas specified in the task plan:
- Tests 1-2: Orchestrator categorizes entries correctly (pending/existing/skipped)
- Test 2: Existing keys excluded from collection UI
- Test 3: Manifest statuses updated after collection (reads back file to verify)
- Tests 4-5: showSecretsSummary render output contains key names and status indicators
- Tests 6-8: Guidance lines in collectOneSecret render output (present, wrapping, absent)
- Test 9: Result shape with applied/skipped/existingSkipped arrays

All 9 tests fail as expected — `collectSecretsFromManifest`, `showSecretsSummary`, and `collectOneSecretWithGuidance` don't exist yet.

## Verification

- `git log --oneline -5` confirms S01 commits (93c0852, 05ff6c6) in history
- `grep ManifestStatus src/resources/extensions/gsd/types.ts` → line 139
- `grep getManifestStatus src/resources/extensions/gsd/files.ts` → line 816
- `npm run build` exits 0
- `npm run test` — 132 pass, 19 fail (all pre-existing failures from `VALID_BRANCH_NAME` missing export and `AGENTS.md` issues, identical to pre-merge state)
- `node --test manifest-status.test.ts` (via proper loader) — 7/7 pass
- `node --test secure-env-collect.test.ts` (via proper loader) — 12/12 pass
- `node --test collect-from-manifest.test.ts` (via proper loader) — 0/9 pass (expected: all fail with clear error messages)

**Slice-level verification (partial — T01 is first of 3 tasks):**
- ✅ `npm run build` passes
- ✅ `npm run test` passes (no new failures)
- ⬜ `collect-from-manifest.test.ts` — 9 tests exist, all fail (functions not implemented yet — T02/T03)
- ✅ `secure-env-collect.test.ts` — 12/12 pass

## Diagnostics

- `git log --oneline` to verify S01 merge presence
- `grep ManifestStatus src/resources/extensions/gsd/types.ts` to confirm type availability
- `grep getManifestStatus src/resources/extensions/gsd/files.ts` to confirm function availability

## Deviations

Used dynamic `import()` in test file with `loadOrchestrator()` / `loadGuidanceExport()` helper functions instead of static top-level imports. This avoids the entire file crashing at module load time when the functions don't exist yet, letting each test fail independently with a clear message like "collectSecretsFromManifest is not exported — T03 will implement this".

## Known Issues

19 pre-existing test failures across the test suite, all caused by `VALID_BRANCH_NAME` missing from `git-service.ts` exports and `AGENTS.md` sync issues. These exist on main branch and are unrelated to S02 work.

## Files Created/Modified

- `src/resources/extensions/gsd/types.ts` — ManifestStatus interface added (from S01 merge)
- `src/resources/extensions/gsd/files.ts` — getManifestStatus() function added (from S01 merge)
- `src/resources/extensions/gsd/tests/manifest-status.test.ts` — 7 contract tests for getManifestStatus (from S01 merge)
- `src/resources/extensions/gsd/tests/parsers.test.ts` — secrets manifest parser tests added (from S01 merge)
- `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — new test scaffolding with 9 test cases for T02/T03 functions
