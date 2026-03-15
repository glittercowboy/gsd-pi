# S07: Integration Verification + Polish — UAT

**Milestone:** M001
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S07 is purely verification work — integration tests and requirements bookkeeping. The test files and REQUIREMENTS.md are the artifacts to verify. No live runtime or UI involved.

## Preconditions

- Working directory is the memory-db worktree: `.gsd/worktrees/memory-db/`
- Node.js available with `npm run test:unit` functional
- All prior slices (S01–S06) complete with their tests passing

## Smoke Test

Run `npm run test:unit -- --test-name-pattern "integration-lifecycle|integration-edge"` from the project root. Both test suites should pass with 0 failures and ≥60 total assertions.

## Test Cases

### 1. Full lifecycle integration test passes

1. Run `npm run test:unit -- --test-name-pattern "integration-lifecycle"`
2. Check output for assertion count
3. **Expected:** All assertions pass. Output includes "Results: N passed, 0 failed" with N ≥ 40. Token savings percentage visible in test output showing ≥30%.

### 2. Edge case integration tests pass

1. Run `npm run test:unit -- --test-name-pattern "integration-edge"`
2. Check output for three test groups: empty project, partial migration, fallback mode
3. **Expected:** All assertions pass. Output includes "Results: N passed, 0 failed" with N ≥ 20. Each edge case scenario (empty, partial, fallback) has at least one passing group.

### 3. Full test suite has zero regressions

1. Run `npm run test:unit`
2. Check total test count and failure count
3. **Expected:** ≥288 tests pass, 0 failures. No test from S01–S06 broke.

### 4. TypeScript compilation is clean

1. Run `npx tsc --noEmit`
2. **Expected:** No output (clean compilation, exit code 0).

### 5. All requirements validated in REQUIREMENTS.md

1. Open `.gsd/REQUIREMENTS.md`
2. In the Active section, count entries with `Status: active`
3. In the Validated section, count `### R` headings
4. Check the Coverage Summary at the bottom
5. **Expected:** 0 active requirements remaining. 21 entries in Validated section. Coverage summary shows "Active requirements: 0" and "Validated: 21".

### 6. R001 has correct validation proof

1. Find R001 in the Active section of `.gsd/REQUIREMENTS.md`
2. Check Status and Validation fields
3. **Expected:** Status is `validated`. Validation field references S01 (DB layer), S02 (schema migration), and S07 (lifecycle integration test proving end-to-end composition across gsd-db, md-importer, context-store, and db-writer modules).

### 7. R019 has correct validation proof

1. Find R019 in the Active section of `.gsd/REQUIREMENTS.md`
2. Check Status and Validation fields
3. **Expected:** Status is `validated`. Validation field references S07 lifecycle test proving "same data in = same prompt out" across the full pipeline. Notes that UAT for subjective LLM quality is a separate concern.

### 8. Traceability table consistency

1. In `.gsd/REQUIREMENTS.md`, compare the Traceability table rows for R001 and R019
2. **Expected:** R001 shows status `validated` with proof `S01+S02+S07 validated`. R019 shows status `validated` with proof `S07 validated`.

## Edge Cases

### Empty REQUIREMENTS.md Active section

1. Run `grep "Status: active" .gsd/REQUIREMENTS.md` (case-sensitive)
2. **Expected:** 0 matches. All requirements have moved past active status.

### Integration test files exist

1. Check `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` exists and has content
2. Check `src/resources/extensions/gsd/tests/integration-edge.test.ts` exists and has content
3. **Expected:** Both files exist. Lifecycle test is ~230 LOC. Edge case test is ~175 LOC.

### Token savings threshold

1. In the lifecycle test output, look for savings percentage
2. **Expected:** Reported savings ≥30%. Actual from T01: 42.4%.

## Failure Signals

- Any test failure in the integration test suites indicates a composition problem between M001 modules
- `tsc --noEmit` errors indicate type-level regressions
- Any `Status: active` remaining in REQUIREMENTS.md means the bookkeeping is incomplete
- Test count dropping below 288 means a prior test was deleted or broken

## Requirements Proved By This UAT

- R001 — SQLite DB layer with schema versioning: lifecycle test proves end-to-end composition
- R019 — No regression in auto-mode output quality: lifecycle test proves data fidelity across full pipeline (necessary condition; subjective quality is UAT-only)

## Not Proven By This UAT

- Subjective LLM output quality (R019 sufficient condition) — requires running auto-mode on a real project and evaluating whether the LLM produces equivalent or better output with DB-backed context vs. markdown loading
- Real project token savings measurement — fixture data proves the mechanism works; actual savings depend on real project data volume and composition

## Notes for Tester

- This is the final slice of M001. If all test cases pass, M001 is ready for milestone completion.
- The lifecycle integration test uses file-backed SQLite (not :memory:) to match production WAL behavior — temp files are created in the OS temp directory and cleaned up automatically.
- Token savings of 42.4% are fixture-measured. Real project savings will vary based on decision/requirement density and milestone scope.
