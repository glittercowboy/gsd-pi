# S04: Token Measurement + State Derivation — UAT

**Milestone:** M004
**Written:** 2026-03-16

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: Both deliverables (token measurement and DB-first state derivation) are fully testable via the fixture-based test suites. No live runtime dispatch is needed to prove the contracts — the fixture data covers realistic project scale (24 decisions, 21 requirements, 5 slices), and the derive-state tests cover all branching paths including fallback.

## Preconditions

- Working directory: `.gsd/worktrees/M004` (the M004 worktree)
- Node.js 22.5+ available (`node --version` ≥ 22.5)
- `node:sqlite` available (default on Node 22.5+)
- TypeScript compiled clean (`npx tsc --noEmit` exits 0)

## Smoke Test

Run the token savings test and confirm savings ≥30%:

```bash
node --test --experimental-test-module-mocks \
  --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  src/resources/extensions/gsd/tests/token-savings.test.ts
```

**Expected:** `99 passed, 0 failed`. Output includes:
```
Plan-slice savings: 52.2% (DB: 10996 chars, full: 23016 chars)
```

---

## Test Cases

### 1. Token savings: plan-slice prompt ≥30%

**What this proves:** DB-scoped queries on a plan-slice (decisions + requirements filtered to active milestone + slice) deliver ≥30% fewer characters than whole-file loading.

1. Run:
   ```bash
   node --test --experimental-test-module-mocks \
     --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     src/resources/extensions/gsd/tests/token-savings.test.ts
   ```
2. Observe stdout section: `=== token-savings: plan-slice prompt ≥30% character savings ===`
3. **Expected:** `Plan-slice savings: 52.2% (DB: 10996 chars, full: 23016 chars)`. Assertion passes (savings > 30%).

### 2. Token savings: research-milestone prompt

**What this proves:** Research-level prompts (milestone-scoped decisions only) also exceed 30%.

1. Same run as Test 1 (all scenarios in same file).
2. Observe stdout section: `=== token-savings: research-milestone prompt shows meaningful savings ===`
3. **Expected:**
   ```
   Decisions savings (M001): 66.3% (DB: 3455, full: 10262)
   Research-milestone composite savings: 32.2% (DB: 15608, full: 23016)
   ```
   Both assertions pass.

### 3. Token savings: scoping correctness, no cross-contamination

**What this proves:** Milestone-scoped queries return only that milestone's decisions (no leakage between M001/M002/M003).

1. Same run as Test 1.
2. Observe section: `=== token-savings: quality — correct scoping, no cross-contamination ===`
3. **Expected:** 99 total assertions pass. M001 query returns exactly 8 decisions; M002 query returns exactly 8; M003 query returns exactly 8. No assertion failures.

### 4. Token savings: fixture data realism

**What this proves:** The fixture data is representative of a mature GSD project (24 decisions across 3 milestones, 21 requirements across 5 slices).

1. Same run as Test 1.
2. Observe section: `=== token-savings: fixture data realism ===`
3. **Expected:** No assertion failures. Milestone decision counts sum to 24 (8+8+8); slice requirement counts sum to 21.

### 5. DB-first state derivation: identity parity

**What this proves:** `deriveState()` produces identical `GSDState` when content is loaded from the DB artifacts table vs. read from disk files.

1. Run:
   ```bash
   node --test --experimental-test-module-mocks \
     --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     src/resources/extensions/gsd/tests/derive-state-db.test.ts
   ```
2. Observe section: `=== derive-state-db: DB path matches file path ===`
3. **Expected:** `51 passed, 0 failed`. GSDState fields compared: `phase`, `activeMilestone`, `activeSlice`, `activeTask`, `registry`, `requirements`, `progress`.

### 6. DB-first state derivation: fallback when DB unavailable

**What this proves:** When `isDbAvailable()` returns false, `deriveState()` falls back to filesystem reads and produces correct state.

1. Same run as Test 5.
2. Observe section: `=== derive-state-db: fallback when DB unavailable ===`
3. **Expected:** Assertion passes. GSDState derived from disk matches expected.

### 7. DB-first state derivation: empty DB falls through to disk

**What this proves:** An empty artifacts table (migration not yet run) behaves identically to no DB — `dbContentLoaded` stays false and native batch parser runs.

1. Same run as Test 5.
2. Observe section: `=== derive-state-db: empty DB falls back to files ===`
3. **Expected:** Assertion passes. State from empty DB = state from disk.

### 8. DB-first state derivation: partial DB fills gaps from disk

**What this proves:** When only some artifacts are in the DB (e.g., roadmap present, plan absent), `deriveState()` correctly uses DB content where available and disk content for the gaps.

1. Same run as Test 5.
2. Observe section: `=== derive-state-db: partial DB fills gaps from disk ===`
3. **Expected:** Assertion passes. State reflects roadmap from DB + plan from disk combined correctly.

### 9. DB-first state derivation: cache invalidation

**What this proves:** After `invalidateStateCache()`, a second call to `deriveState()` re-runs derivation and picks up updated DB content.

1. Same run as Test 5.
2. Observe section: `=== derive-state-db: cache invalidation ===`
3. **Expected:** Assertion passes. First call returns cached result; after invalidation, second call reflects updated DB content.

### 10. Metrics interface backward compatibility

**What this proves:** The new `opts?` 6th parameter on `snapshotUnitMetrics` is genuinely optional — existing callers without it continue to work.

1. Run:
   ```bash
   node --test --experimental-test-module-mocks \
     --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     src/resources/extensions/gsd/tests/metrics-io.test.ts
   ```
2. **Expected:** `24 passed, 0 failed`. Ledger writes/reads work with and without opts.

### 11. All 11 call sites updated

**What this proves:** No `snapshotUnitMetrics` call in `auto.ts` is missing the opts argument.

1. Run:
   ```bash
   grep 'snapshotUnitMetrics(' src/resources/extensions/gsd/auto.ts | grep -cv 'promptCharCount'
   ```
2. **Expected:** Output is `0` (exit code 1 is normal for grep -cv with zero matches — the count is what matters).

### 12. Measurement vars declared and reset (structural check)

**What this proves:** `lastPromptCharCount` and `lastBaselineCharCount` are wired at enough locations (declarations + resets + measurement block + 11 call sites).

1. Run:
   ```bash
   grep -c 'lastPromptCharCount\|lastBaselineCharCount' src/resources/extensions/gsd/auto.ts
   ```
2. **Expected:** Output is `18` (≥15 required).

### 13. Full test suite — zero regressions

**What this proves:** S04 changes don't break any existing test in the suite.

1. Run:
   ```bash
   node --test --experimental-test-module-mocks \
     --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     src/resources/extensions/gsd/tests/*.test.ts
   ```
2. **Expected:** `188 passed, 0 failed` (or current suite count). Zero regressions.

---

## Edge Cases

### Baseline computation when DB unavailable

If `isDbAvailable()` returns false at measurement time, `lastBaselineCharCount` stays `undefined`.

1. The snapshotUnitMetrics call still fires (with `promptCharCount` set, `baselineCharCount` undefined).
2. **Expected:** Ledger record has `promptCharCount` but no `baselineCharCount` field (key omitted, not null). Metrics module does not crash.

### Empty artifacts table at state derivation time

If DB is available but migration hasn't run (artifacts table empty):

1. `dbContentLoaded` stays false.
2. Native batch parser runs as if DB didn't exist.
3. **Expected:** `deriveState()` returns correct state from disk. Behavior identical to pre-S04.

---

## Failure Signals

- `token-savings.test.ts` fails with `AssertionError: X.X% < 30%` — savings dropped below threshold; investigate `formatDecisionsForPrompt`/`formatRequirementsForPrompt` output size
- `derive-state-db.test.ts` fails with a deep-equal mismatch — the specific GSDState field that diverges is printed in the error message; cross-reference the scenario name
- `metrics-io.test.ts` fails — `snapshotUnitMetrics` signature regression; check metrics.ts opts parameter
- `grep -cv 'promptCharCount'` returns non-zero — one or more call sites missing opts argument; run grep without -c to find them
- `npx tsc --noEmit` has errors — type mismatch in metrics.ts, auto.ts, or state.ts; the error message will point to the exact line

## Requirements Proved By This UAT

- R051 — Token measurement infrastructure deployed and producing ≥30% savings on fixture data (plan-slice 52.2%, decisions-only 66.3%, research composite 32.2%)
- R052 — DB-first state derivation produces identical GSDState, falls back correctly when DB unavailable, handles empty DB, handles partial DB, correctly invalidates cache

## Not Proven By This UAT

- R051/R052 end-to-end in a live auto-mode dispatch (ledger entries in `.gsd/metrics.json` from real planning runs) — deferred to S07
- `baselineCharCount` accuracy against production prompt sizes (fixture approximation vs. actual per-builder injection) — deferred to S07
- Performance improvement from DB-first content loading on a real project with 100+ artifact files — deferred to S07

## Notes for Tester

- The `--import ./src/resources/extensions/gsd/tests/resolve-ts.mjs` flag is required for all test commands — without it, Node resolves `.ts` imports as `.js` and throws `ERR_MODULE_NOT_FOUND`
- Savings percentages are printed to stdout, not just in test assertions — scan for the `Plan-slice savings:` line to confirm the exact number
- The `grep -cv` check exits with code 1 when count is 0 (grep behavior) — this is expected and correct; the output `0` is what matters
