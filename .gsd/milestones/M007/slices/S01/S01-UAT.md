# S01: Telemetry Schema & Dispatch Hooking — UAT

**Milestone:** M007
**Written:** 2026-03-19

## UAT Type

- **UAT mode:** artifact-driven
- **Why this mode is sufficient:** The telemetry layer is a data pipeline — correctness is proven by contract tests (111 assertions) and grep verification of dispatch wiring. No live runtime execution is needed because the schema and integration points are deterministically testable.

## Preconditions

- Node.js with tsx available (`npx tsx`)
- Project at `/home/ubuntulinuxqa2/repos/gsd-2`

## Smoke Test

Run the contract test — if it passes, the JSON schema is stable:

```bash
npx tsx --test src/resources/extensions/gsd/tests/telemetry-contract.test.ts
```

**Expected:** All 111 assertions pass.

## Test Cases

### 1. Schema Completeness

1. Run: `npx tsx --test src/resources/extensions/gsd/tests/metrics.test.ts`
2. **Expected:** 94 tests pass, covering tokens, cost, budget fields

### 2. Dispatch Integration Wiring

1. Run: `grep -c "persistUnitMetrics" src/resources/extensions/gsd/auto.ts`
2. Run: `grep -c "snapshotUnitMetrics" src/resources/extensions/gsd/auto.ts`
3. **Expected:** Both return >= 14

### 3. Non-Blocking Write Pattern

1. Inspect `src/resources/extensions/gsd/metrics-logger.ts` — find `persistUnitMetrics` function
2. **Expected:** Function uses `appendFileSync` wrapped in try/catch that swallows errors

### 4. JSONL Persistence

1. Run: `npx tsx --test src/resources/extensions/gsd/tests/metrics-io.test.ts`
2. **Expected:** 24 tests pass, including file content verification and persistence across init/reset cycles

### 5. Activity Log Deduplication

1. Run: `npx tsx --test src/resources/extensions/gsd/tests/activity-log-save.test.ts`
2. **Expected:** 13 tests pass, covering dedup tracking per unit

### 6. Activity Log Pruning

1. Run: `npx tsx --test src/resources/extensions/gsd/tests/activity-log-prune.test.ts`
2. **Expected:** 20 tests pass, covering retention policies

## Edge Cases

### Empty Session Handling

1. Run: `npx tsx --test src/resources/extensions/gsd/tests/metrics.test.ts` — look for "Empty session" test
2. **Expected:** Handles empty metrics gracefully without crashing

### Backward Compatibility

1. Run: Look for "Backward compat" tests in metrics.test.ts output
2. **Expected:** UnitMetrics without budget fields still works

## Failure Signals

- Test failures in telemetry-contract.test.ts → JSON schema changed (breaking change)
- Test failures in metrics*.test.ts → core metrics fields broken
- grep count < 14 → dispatch paths not fully wired
- Missing try/catch in persistUnitMetrics → writes could block dispatch

## Not Proven By This UAT

- **Live auto-mode execution** — this UAT verifies the schema and wiring, not end-to-end dispatch
- **Crash recovery** — the fire-and-forget pattern is designed to survive crashes, but testing crash behavior requires simulation
- **S02 aggregation** — metrics aggregation (reading dispatch-metrics.jsonl) is S02's scope

## Notes for Tester

- The activity directory `.gsd/activity/` may not have `dispatch-metrics.jsonl` until first auto-mode dispatch runs
- Write failures are silently swallowed by design — if you need to verify writes work, inspect the file after running a real dispatch
- All tests use `npx tsx --test` because the gsd extension uses `.js` imports internally that Node's native type stripping doesn't handle