---
estimated_steps: 4
estimated_files: 4
---

# T01: Merge S01 and create test scaffolding

**Slice:** S02 — Enhanced Collection TUI
**Milestone:** M001

## Description

S01's `getManifestStatus()`, `ManifestStatus` type, and contract tests live on the `gsd/M001/S01` branch but haven't been merged to this branch. The orchestrator function planned for T03 depends on these. This task merges S01, verifies the merge is clean, and creates the test file for S02 with initially-failing assertions that target the functions built in T02–T03.

## Steps

1. Merge the `gsd/M001/S01` branch into the current `gsd/M001/S02` branch. Resolve any conflicts (the diff is 4 files, 525 insertions — types.ts, files.ts, and test files).
2. Verify `ManifestStatus` type exists in `types.ts` and `getManifestStatus()` exists in `files.ts`. Run `npm run build` to confirm no compile errors from the merge.
3. Run `npm run test` to confirm existing tests still pass after the merge.
4. Create `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` with test cases that import not-yet-existing functions and assert on expected behavior. Tests should cover: (a) orchestrator correctly categorizes entries as pending/existing/skipped, (b) existing keys are excluded from collection, (c) manifest statuses are updated after collection, (d) `showSecretsSummary()` render function produces lines with correct status glyphs, (e) guidance lines appear in `collectOneSecret()` render output. Tests will fail at this point — that's expected.

## Must-Haves

- [ ] S01 branch merged cleanly into S02 branch
- [ ] `ManifestStatus` type importable from `gsd/types.ts`
- [ ] `getManifestStatus()` importable from `gsd/files.ts`
- [ ] `npm run build` passes after merge
- [ ] `npm run test` passes after merge (no regressions)
- [ ] `collect-from-manifest.test.ts` exists with meaningful test stubs

## Verification

- `git log --oneline -5` shows the merge commit from S01
- `npm run build` exits 0
- `npm run test` exits 0 (existing tests pass)
- `node --test src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` runs — tests fail because the functions don't exist yet (expected)

## Observability Impact

- Signals added/changed: None
- How a future agent inspects this: `git log --oneline` to verify S01 merge; `grep ManifestStatus src/resources/extensions/gsd/types.ts` to confirm type availability
- Failure state exposed: None

## Inputs

- `gsd/M001/S01` branch — commits `93c0852` and `05ff6c6` containing `ManifestStatus` type, `getManifestStatus()` function, and contract tests
- S01 task summaries (authoritative source since S01-SUMMARY is a placeholder)
- S02-RESEARCH.md — test structure guidance and pitfall warnings

## Expected Output

- Clean merge commit on `gsd/M001/S02` branch
- `src/resources/extensions/gsd/tests/collect-from-manifest.test.ts` — new test file with 5+ test cases targeting T02/T03 functions
- Build and existing tests green
