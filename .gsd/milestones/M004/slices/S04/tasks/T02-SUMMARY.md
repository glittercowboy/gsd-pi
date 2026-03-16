---
id: T02
parent: S04
milestone: M004
provides:
  - token-savings.test.ts — 99 assertions proving ≥30% char savings on plan-slice and research-milestone prompts with realistic fixture data (24 decisions × 3 milestones, 21 requirements × 5 slices)
  - derive-state-db.test.ts — 51 assertions proving DB-first deriveState produces identical GSDState, fallback when DB unavailable, partial DB fills gaps from disk, cache invalidation works
key_files:
  - src/resources/extensions/gsd/tests/token-savings.test.ts
  - src/resources/extensions/gsd/tests/derive-state-db.test.ts
key_decisions:
  - Tests require --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs for .js→.ts resolution; the plan omitted this flag but it's the standard loader pattern used by all other tests in this suite
patterns_established:
  - All tests in this suite require --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs alongside --experimental-test-module-mocks when run with node --test
observability_surfaces:
  - token-savings.test.ts prints savings percentages to stdout: "Plan-slice savings: 52.2% (DB: 10996 chars, full: 23016 chars)" — re-run any time to validate savings claim
  - derive-state-db.test.ts covers 7 named scenarios, each printed to stdout — failure output includes the specific field mismatch and scenario name
duration: 10m
verification_result: passed
completed_at: 2026-03-16
blocker_discovered: false
---

# T02: Port test suites and verify ≥30% savings

**Ported both test files from memory-db worktree; all 150 assertions pass with 52.2% plan-slice savings confirmed.**

## What Happened

Copied `token-savings.test.ts` and `derive-state-db.test.ts` verbatim from the memory-db worktree. No import-path adaptation was needed — all referenced modules (`../gsd-db.ts`, `../md-importer.ts`, `../context-store.ts`, `../state.ts`, `./test-helpers.ts`) exist at the expected paths in M004.

One deviation from the plan: the verification commands needed `--import ./src/resources/extensions/gsd/tests/resolve-ts.mjs` to activate the `.js`→`.ts` resolver. Without it, Node.js resolves `.ts` imports as `.js` at runtime and throws `ERR_MODULE_NOT_FOUND`. This is the same loader flag used by all other tests in this suite — the plan simply omitted it from the command examples.

Both tests ran clean after adding the loader flag. The full suite (188 test files) also passed with zero regressions.

## Verification

**token-savings.test.ts** — 99 assertions, 0 failures:
- Plan-slice savings: **52.2%** (DB: 10,996 chars vs full: 23,016 chars) — exceeds the 30% target
- Research-milestone decisions savings: 66.3% (M001-scoped 8 of 24 decisions)
- Research-milestone composite savings: 32.2%
- Scoping correctness: M001 queries return exactly 8 decisions, no M002/M003 cross-contamination
- All 5 slices (S01–S05) have requirements; milestone counts sum to total (8+8+8=24)

**derive-state-db.test.ts** — 51 assertions, 0 failures:
- DB path → identical GSDState as file path (phase, activeMilestone, activeSlice, activeTask, registry, requirements, progress)
- Fallback when DB unavailable (isDbAvailable() = false → file reads)
- Empty DB falls back to disk reads
- Partial DB fills gaps from disk (roadmap in DB, plan from disk → correct state)
- Requirements counting from DB content only (no REQUIREMENTS.md on disk)
- Multi-milestone registry from DB (M001 complete, M002 active)
- Cache invalidation: second call returns cached state; after invalidateStateCache() picks up updated DB content

**metrics-io.test.ts** — 24 assertions, 0 failures (opts backward compat confirmed)

**Full suite** — 188 test files, 0 failures:
```
node --test --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs src/resources/extensions/gsd/tests/*.test.ts
```

**TypeScript** — `npx tsc --noEmit` — clean, no output

**Slice-level checks:**
- `grep -c 'lastPromptCharCount\|lastBaselineCharCount' src/resources/extensions/gsd/auto.ts` → 18 (≥15 ✓)
- `grep 'snapshotUnitMetrics(' src/resources/extensions/gsd/auto.ts | grep -cv 'promptCharCount'` → 0 ✓

## Diagnostics

Re-run savings validation any time:
```
node --test --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs src/resources/extensions/gsd/tests/token-savings.test.ts
```
Output includes explicit savings percentages. If savings drop below 30%, the assertion fails with `(actual: X.X%)` in the error message — investigate `formatDecisionsForPrompt`/`formatRequirementsForPrompt` output size.

Re-run DB-first derivation validation:
```
node --test --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs src/resources/extensions/gsd/tests/derive-state-db.test.ts
```
7 named scenarios printed to stdout. If DB path diverges from file path, the deep-equal assertion fails with the specific GSDState field that mismatches.

## Deviations

Plan verification commands omitted `--import ./src/resources/extensions/gsd/tests/resolve-ts.mjs`. Required for all tests in this suite (`.js`→`.ts` loader). Not a code change — just a documentation gap in the plan. T02-PLAN.md updated to note the correct invocation pattern.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/token-savings.test.ts` — new; 99-assertion test proving ≥30% character savings on plan-slice and research-milestone prompts using fixture data
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — new; 51-assertion test proving DB-first state derivation produces identical GSDState, with fallback, partial DB, and cache invalidation coverage
- `.gsd/milestones/M004/slices/S04/tasks/T02-PLAN.md` — added Observability Impact section (pre-flight fix)
