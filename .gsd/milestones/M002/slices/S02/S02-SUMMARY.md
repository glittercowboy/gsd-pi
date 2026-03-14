---
id: S02
parent: M002
milestone: M002
provides:
  - Optional cachePath parameter injection for ModelRegistry constructor
  - Production-like scenario test suite covering 6 lifecycle scenarios with tmpdir isolation
requires:
  - slice: S01
    provides: Working build/test infrastructure for @gsd/pi-ai
affects:
  - S03
key_files:
  - packages/pi-coding-agent/src/core/model-registry.ts
  - packages/pi-coding-agent/src/core/model-registry-scenario.test.ts
key_decisions:
  - D021: Optional cachePath parameter in ModelRegistry constructor enables test isolation
  - All tests use tmpdir() + mkdtempSync() pattern, never homedir()
patterns_established:
  - Six distinct scenario suites: fresh install, cache hit, stale cache, version mismatch, offline fallback, override application
  - 500ms delay for async refresh settlement (fire-and-forget pattern)
observability_surfaces:
  - Test names identify which scenario failed
  - Assertion messages show expected vs actual model data
  - TAP format output provides per-test pass/fail results
drill_down_paths:
  - .gsd/milestones/M002/slices/S02/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S02/tasks/T02-SUMMARY.md
duration: 1h
verification_result: passed
completed_at: 2026-03-14T16:10:00-05:00
---

# S02: Production-Like Scenario Testing

**Added production-like integration tests for ModelRegistry startup path using tmpdir isolation, covering all six lifecycle scenarios.**

## What Happened

Two tasks executed in sequence:

1. **T01: Cache path injection** — Added optional `cachePath` parameter to ModelRegistry constructor (third parameter, after modelsJsonPath). The parameter is stored as a private field and passed to `getCachedModelsDev()` in `loadBuiltInModels()`. Backward compatible: undefined cachePath uses default behavior.

2. **T02: Scenario test suite** — Created `model-registry-scenario.test.ts` with 9 tests across 6 scenario suites:
   - **Fresh install** (1 test): Empty tmpdir proves snapshot/static MODELS fallback
   - **Cache hit** (2 tests): Valid cache with current version proves cached data used; models.dev fields preserved
   - **Stale cache** (1 test): Expired TTL proves graceful handling
   - **Version mismatch** (1 test): Old version proves refresh logic works
   - **Offline fallback** (1 test): Stale cache + network failure proves fallback chain
   - **Override application** (3 tests): Provider-level, per-model, and combined overrides prove merge logic

All tests use `tmpdir() + mkdtempSync()` pattern with `after()` cleanup. No test writes to `~/.gsd/agent/`.

## Verification

- **@gsd/pi-ai tests**: 31 tests pass via `npm test -w @gsd/pi-ai`
- **Scenario tests**: 9 tests pass via `node --test packages/pi-coding-agent/dist/core/model-registry-scenario.test.js`
- **Isolation verified**: `grep -r "homedir()" model-registry-scenario.test.ts` returns no matches
- **No flakiness**: Tests pass reliably across multiple runs

## Requirements Advanced

- R008 — Advanced from pending to validated: Production-like scenario tests now exercise the real startup path with tmpdir isolation, covering all six lifecycle scenarios

## Requirements Validated

- R008 — Registry behavior must be proven through production-like startup scenarios — Now validated by 9 passing scenario tests with tmpdir isolation covering fresh state, cache hit, stale cache, version change, offline fallback, and models.json overrides

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

None — implementation followed the slice plan exactly.

## Known Limitations

- 500ms delay for async refresh is a heuristic; not deterministic but works reliably in practice
- pi-coding-agent workspace has no `npm test` script configured — tests run via direct `node --test` invocation

## Follow-ups

- None discovered during execution

## Files Created/Modified

- `packages/pi-coding-agent/src/core/model-registry.ts` — Added optional cachePath parameter to constructor
- `packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` — New test file with 6 scenario suites (9 tests)
- `packages/pi-ai/src/models-dev.ts` — Fixed merge conflict markers (unrelated blocking issue)
- `packages/pi-ai/src/models-dev.test.ts` — Fixed merge conflict markers (unrelated blocking issue)
- `packages/pi-ai/src/models-dev-mapper.test.ts` — Fixed merge conflict markers (unrelated blocking issue)

## Forward Intelligence

### What the next slice should know
- Scenario tests run via `node --test packages/pi-coding-agent/dist/core/model-registry-scenario.test.js`, not `npm test -w @gsd/pi-coding-agent` (no test script configured)
- The tmpdir pattern established in T02 can be reused for S03 live verification if needed

### What's fragile
- The 500ms async delay is a reasonable heuristic but not deterministic — if tests become flaky, consider a more explicit synchronization mechanism

### Authoritative diagnostics
- `node --test packages/pi-coding-agent/dist/core/model-registry-scenario.test.js` — TAP output shows which scenario/expectation failed with clear assertion messages

### What assumptions changed
- Merge conflict markers were found in pi-ai test files — resolved during T02, but this was unrelated to the planned work
