---
estimated_steps: 4
estimated_files: 2
---

# T02: Port test suites and verify ≥30% savings

**Slice:** S04 — Token Measurement + State Derivation
**Milestone:** M004

## Description

Port `token-savings.test.ts` and `derive-state-db.test.ts` from the memory-db worktree. These tests validate R051 (measurement fields in UnitMetrics), R052 (DB-first state derivation), and provide evidence for R057 (≥30% savings).

## Steps

1. **Copy token-savings.test.ts from memory-db**
   - Copy the file from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/token-savings.test.ts` to `src/resources/extensions/gsd/tests/token-savings.test.ts`.
   - No adaptation needed — import paths (`../gsd-db.ts`, `../md-importer.ts`, `../context-store.ts`, `./test-helpers.ts`) all resolve correctly in the M004 worktree.
   - The test creates fixture data with 24 decisions across 3 milestones and 21 requirements across 5 slices, imports them into a `:memory:` DB, then compares DB-scoped content size vs full-markdown content size.

2. **Copy derive-state-db.test.ts from memory-db**
   - Copy the file from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/derive-state-db.test.ts` to `src/resources/extensions/gsd/tests/derive-state-db.test.ts`.
   - No adaptation needed — imports (`../state.ts`, `../gsd-db.ts`, `./test-helpers.ts`) all exist.
   - The test proves: DB path produces identical GSDState as file path, fallback when DB unavailable, empty DB falls back to files, partial DB fills gaps from disk, requirements counting from DB content, multi-milestone registry, cache invalidation.

3. **Run new tests individually**
   - `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/token-savings.test.ts`
   - `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/derive-state-db.test.ts`
   - Both must pass with zero failures.
   - `token-savings.test.ts` output must show ≥30% savings on plan-slice prompt.

4. **Run full test suite for regressions**
   - `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/metrics-io.test.ts` — verifies opts param backward compat.
   - `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/*.test.ts` — all existing tests pass.
   - `npx tsc --noEmit` — still clean.

## Must-Haves

- [ ] `token-savings.test.ts` passes with ≥30% savings on plan-slice prompt
- [ ] `derive-state-db.test.ts` passes — DB path produces identical GSDState
- [ ] Existing `metrics-io.test.ts` tests pass (backward compat with optional opts)
- [ ] Full test suite passes with zero regressions

## Verification

- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/token-savings.test.ts` — all pass
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/derive-state-db.test.ts` — all pass
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/*.test.ts` — all pass
- `npx tsc --noEmit` — clean

## Inputs

- T01's completed changes to `metrics.ts`, `auto.ts`, `state.ts`
- Memory-db reference test files at known paths
- `src/resources/extensions/gsd/gsd-db.ts` — `openDatabase`, `closeDatabase`, `insertArtifact`, `isDbAvailable`
- `src/resources/extensions/gsd/md-importer.ts` — `migrateFromMarkdown`
- `src/resources/extensions/gsd/context-store.ts` — `queryDecisions`, `queryRequirements`, `formatDecisionsForPrompt`, `formatRequirementsForPrompt`
- `src/resources/extensions/gsd/state.ts` — `deriveState`, `invalidateStateCache`
- `src/resources/extensions/gsd/tests/test-helpers.ts` — `createTestContext`

## Expected Output

- `src/resources/extensions/gsd/tests/token-savings.test.ts` — new test file proving ≥30% savings
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — new test file proving DB-first state derivation

## Observability Impact

**Signals this task makes visible:**
- Test output from `token-savings.test.ts` reports concrete savings percentages (e.g. "saved 45.2%") — the primary evidence surface for R057.
- `derive-state-db.test.ts` output confirms the DB-first path produces byte-for-byte identical `GSDState` vs file path — validates R052 without a live DB.

**Future agent inspection:**
- Re-run `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/token-savings.test.ts` to see savings % on fixture data.
- Re-run `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/derive-state-db.test.ts` to validate DB-first derivation still works after any changes to `state.ts` or `gsd-db.ts`.

**Failure visibility:**
- If savings drop below 30%: `token-savings.test.ts` assertion fails with actual % in the error message — investigate `formatDecisionsForPrompt` / `formatRequirementsForPrompt` output bloat.
- If DB path diverges: `derive-state-db.test.ts` deep-equal assertion fails with a diff of the mismatched `GSDState` fields — investigate `_deriveStateImpl` DB branch logic.
- If `isDbAvailable()` or `openDatabase()` changes contract: derive-state-db tests will surface it via fallback-path assertion failures rather than silent wrong behavior.
