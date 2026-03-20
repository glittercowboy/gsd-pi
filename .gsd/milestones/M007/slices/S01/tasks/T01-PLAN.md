---
estimated_steps: 5
estimated_files: 5
---

# T01: Verify telemetry schema completeness and dispatch integration

**Slice:** S01 — Telemetry Schema & Dispatch Hooking
**Milestone:** M007

## Description

The telemetry capture layer is already implemented across `metrics.ts`, `metrics-logger.ts`, `activity-log.ts`, and `auto.ts`. This task runs the full test suite and verifies all roadmap requirements are met: schema fields, dispatch wiring, non-blocking writes, and durable activity logging. Fix any gaps found.

**Note:** Tests use `npx tsx --test` (not `node --test`) per K007.

## Steps

1. Run `npx tsx --test src/resources/extensions/gsd/tests/metrics-extended.test.ts src/resources/extensions/gsd/tests/metrics-io.test.ts src/resources/extensions/gsd/tests/activity-log-save.test.ts src/resources/extensions/gsd/tests/activity-log-prune.test.ts src/resources/extensions/gsd/tests/metrics.test.ts` and confirm all pass.
2. Verify `UnitMetrics` in `src/resources/extensions/gsd/metrics.ts` includes: `tokens`, `cost`, `interventions`, `factCheck`, `wallClockMs`, `skills`, `type`, `id`, `model`, `startedAt`, `finishedAt`, `toolCalls`, `assistantMessages`, `userMessages`.
3. Verify `persistUnitMetrics` in `src/resources/extensions/gsd/metrics-logger.ts` uses `appendFileSync` wrapped in try/catch with `void e`.
4. Count `persistUnitMetrics` calls in `auto.ts` — expect >= 14.
5. Count `snapshotUnitMetrics` calls in `auto.ts` — expect >= 14. Confirm each snapshot site also calls `persistUnitMetrics`.

## Must-Haves

- [ ] All existing tests pass (94+ assertions across 5 test files)
- [ ] `UnitMetrics` has all required M007 fields
- [ ] All dispatch paths in `auto.ts` are wired to `persistUnitMetrics`
- [ ] All writes are non-blocking (fire-and-forget error handling)

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/metrics-extended.test.ts src/resources/extensions/gsd/tests/metrics-io.test.ts src/resources/extensions/gsd/tests/activity-log-save.test.ts src/resources/extensions/gsd/tests/activity-log-prune.test.ts src/resources/extensions/gsd/tests/metrics.test.ts` — all pass
- `grep -c "persistUnitMetrics" src/resources/extensions/gsd/auto.ts` >= 14

## Inputs

- `src/resources/extensions/gsd/metrics.ts` — UnitMetrics interface and snapshot logic
- `src/resources/extensions/gsd/metrics-logger.ts` — JSONL writer
- `src/resources/extensions/gsd/activity-log.ts` — session JSONL writer
- `src/resources/extensions/gsd/auto.ts` — dispatch loop with all hook call sites

## Expected Output

- All tests pass with no modifications needed (or small fixes applied if gaps found)
- Verification results documented confirming schema completeness and dispatch coverage
