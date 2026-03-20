# S01: Telemetry Schema & Dispatch Hooking

**Goal:** Per-unit telemetry (tokens, cost, interventions, fact-checks, wall-clock) is captured durably in JSONL during auto-mode dispatch, with non-blocking writes that survive crashes.
**Demo:** Run `npx tsx --test src/resources/extensions/gsd/tests/metrics-extended.test.ts src/resources/extensions/gsd/tests/metrics-io.test.ts src/resources/extensions/gsd/tests/activity-log-save.test.ts src/resources/extensions/gsd/tests/activity-log-prune.test.ts` — all tests pass, proving schema completeness, dispatch integration, durable writing, and pruning.

## Must-Haves

- `UnitMetrics` interface includes tokens, cost, interventions, factCheck, wallClockMs, and skills fields
- `persistUnitMetrics` appends single-line JSON to `dispatch-metrics.jsonl` in `.gsd/activity/`
- All `snapshotUnitMetrics` call sites in `auto.ts` pipe through `persistUnitMetrics`
- `saveActivityLog` writes raw session JSONL with dedup, streaming, and non-blocking error handling
- All writes are fire-and-forget (catch blocks swallow errors, never block dispatch)
- Existing tests (94+) pass covering schema, I/O, aggregation, interventions, fact-checks, pruning

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/metrics-extended.test.ts src/resources/extensions/gsd/tests/metrics-io.test.ts src/resources/extensions/gsd/tests/activity-log-save.test.ts src/resources/extensions/gsd/tests/activity-log-prune.test.ts src/resources/extensions/gsd/tests/metrics.test.ts` — all pass
- `grep -c "persistUnitMetrics" src/resources/extensions/gsd/auto.ts` returns >= 14 (all dispatch paths wired)
- `grep -c "snapshotUnitMetrics" src/resources/extensions/gsd/auto.ts` returns >= 14

## Observability / Diagnostics

- Runtime signals: `dispatch-metrics.jsonl` lines in `.gsd/activity/`, per-unit JSONL session files
- Inspection surfaces: `cat .gsd/activity/dispatch-metrics.jsonl | jq .` to inspect captured metrics
- Failure visibility: Write failures are silently swallowed (by design) — absence of expected JSONL lines indicates a problem
- Redaction constraints: none (metrics contain no secrets)

## Tasks

- [ ] **T01: Verify telemetry schema completeness and dispatch integration** `est:30m`
  - Why: The implementation exists across `metrics.ts`, `metrics-logger.ts`, `activity-log.ts`, and `auto.ts`. This task confirms all roadmap requirements are met and tests pass.
  - Files: `src/resources/extensions/gsd/metrics.ts`, `src/resources/extensions/gsd/metrics-logger.ts`, `src/resources/extensions/gsd/activity-log.ts`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/tests/metrics-extended.test.ts`
  - Do: Run the full test suite. Verify `UnitMetrics` has all required fields (tokens, cost, interventions, factCheck, wallClockMs, skills). Verify `persistUnitMetrics` uses `appendFileSync` with non-blocking error handling. Verify all `snapshotUnitMetrics` sites in `auto.ts` call `persistUnitMetrics`. Verify `saveActivityLog` uses streaming writes and dedup. If any gap is found, fix it; if all checks pass, document the verification.
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/metrics-extended.test.ts src/resources/extensions/gsd/tests/metrics-io.test.ts src/resources/extensions/gsd/tests/activity-log-save.test.ts src/resources/extensions/gsd/tests/activity-log-prune.test.ts src/resources/extensions/gsd/tests/metrics.test.ts` — all pass
  - Done when: All tests pass, all dispatch paths are wired, schema includes all M007 fields

- [ ] **T02: Add JSONL schema documentation and telemetry contract test** `est:45m`
  - Why: The schema is defined as a TypeScript interface but has no standalone documentation. A contract test ensures the JSONL format is stable for downstream consumers (S02 metrics aggregation, S03 fixture harness).
  - Files: `src/resources/extensions/gsd/tests/telemetry-contract.test.ts`, `src/resources/extensions/gsd/metrics.ts`
  - Do: Write a contract test that constructs a `UnitMetrics` object with all fields populated, serializes to JSON, deserializes, and asserts round-trip fidelity for every field including optional M007 fields (interventions, factCheck, wallClockMs, skills). Assert the JSON keys match the documented schema. This gives S02/S03 a regression-safe contract to depend on.
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/telemetry-contract.test.ts` — all pass
  - Done when: Contract test passes and covers all `UnitMetrics` fields including optionals

## Files Likely Touched

- `src/resources/extensions/gsd/metrics.ts`
- `src/resources/extensions/gsd/metrics-logger.ts`
- `src/resources/extensions/gsd/activity-log.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/tests/metrics-extended.test.ts`
- `src/resources/extensions/gsd/tests/telemetry-contract.test.ts`
