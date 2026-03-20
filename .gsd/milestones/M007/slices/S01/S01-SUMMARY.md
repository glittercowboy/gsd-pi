---
id: S01
parent: M007
milestone: M007
provides:
  - Per-unit telemetry (tokens, cost, interventions, fact-check, wall-clock) captured durably in JSONL during auto-mode dispatch
  - Non-blocking writes that survive crashes via fire-and-forget pattern
  - JSONL schema contract test proving round-trip fidelity
requires: []
affects:
  - M007/S02 (metrics aggregation reads from dispatch-metrics.jsonl)
  - M007/S03 (fixture harness uses metrics for verification)
key_files:
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/metrics.ts
  - src/resources/extensions/gsd/metrics-logger.ts
  - src/resources/extensions/gsd/activity-log.ts
  - src/resources/extensions/gsd/tests/telemetry-contract.test.ts
key_decisions:
  - appendFileSync with try/catch error swallowing for non-blocking persistence
  - 14 dispatch paths wired to call persistUnitMetrics after snapshotUnitMetrics
patterns_established:
  - Fire-and-forget metric persistence pattern (errors swallowed, never blocks dispatch)
  - Contract test pattern for JSON schema stability verification
observability_surfaces:
  - .gsd/activity/dispatch-metrics.jsonl — per-unit JSONL lines with full UnitMetrics
  - .gsd/activity/*.jsonl — session activity logs with raw unit data
duration: ~35min
verification_result: passed
completed_at: 2026-03-19T21:26:00-04:00
---

# S01: Telemetry Schema & Dispatch Hooking

**Per-unit telemetry (tokens, cost, interventions, fact-check, wall-clock) is captured durably in JSONL during auto-mode dispatch, with non-blocking writes that survive crashes.**

## What Happened

Slice S01 delivered the foundational telemetry layer for M007:

1. **T01 - Dispatch Integration**: Implemented `persistUnitMetrics` function in `metrics-logger.ts` that appends UnitMetrics as single-line JSON to `dispatch-metrics.jsonl` in `.gsd/activity/`. The function uses `appendFileSync` with try/catch error swallowing to ensure writes never block the dispatch loop. All 14 call sites of `snapshotUnitMetrics` in `auto.ts` now call `persistUnitMetrics`, ensuring every unit execution captures metrics durably.

2. **T02 - Schema Contract Test**: Created `telemetry-contract.test.ts` with 111 assertions proving JSON round-trip fidelity for all UnitMetrics fields. The test covers:
   - Full metrics with all required and optional fields
   - Minimal metrics with optional fields omitted
   - Partial optional fields (skills-only, interventions-only, factCheck-only, wallClockMs-only)
   - Edge cases: zero values, empty arrays, large numbers
   - JSONL line format validation

The `UnitMetrics` interface now includes all M007 fields: tokens, cost, interventions, factCheck, wallClockMs, and skills.

## Verification

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx --test src/resources/extensions/gsd/tests/metrics*.test.ts src/resources/extensions/gsd/tests/activity-log-*.test.ts` | 0 | ✅ 175 pass | ~1.7s |
| 2 | `npx tsx --test src/resources/extensions/gsd/tests/telemetry-contract.test.ts` | 0 | ✅ 111 pass | ~0.2s |
| 3 | `grep -c "persistUnitMetrics" src/resources/extensions/gsd/auto.ts` | 0 | ✅ 15 calls | <1s |
| 4 | `grep -c "snapshotUnitMetrics" src/resources/extensions/gsd/auto.ts` | 0 | ✅ 14 calls | <1s |

## New Requirements Surfaced

None — all requirements for this slice are validated by the test suite.

## Deviations

None — implemented exactly as planned.

## Known Limitations

- `dispatch-metrics.jsonl` is created on first auto-mode dispatch (not pre-existing)
- Write failures are silently swallowed by design — absence of expected lines indicates a problem

## Follow-ups

S02 (Metrics Aggregation & Reporting) should read from `.gsd/activity/dispatch-metrics.jsonl` to produce comparison tables.

## Files Created/Modified

- `src/resources/extensions/gsd/auto.ts` — added persistUnitMetrics calls to all snapshotUnitMetrics sites
- `src/resources/extensions/gsd/metrics-logger.ts` — persistUnitMetrics implementation
- `src/resources/extensions/gsd/activity-log.ts` — activity logging utilities
- `src/resources/extensions/gsd/tests/telemetry-contract.test.ts` — new contract test (111 assertions)
- `.gsd/milestones/M007/slices/S01/tasks/T01-SUMMARY.md` — enhanced with diagnostics/verification
- `.gsd/milestones/M007/slices/S01/tasks/T02-SUMMARY.md` — task completion summary

## Forward Intelligence

### What the next slice should know
- The telemetry JSONL lives at `.gsd/activity/dispatch-metrics.jsonl` — each line is a complete UnitMetrics JSON object
- The schema is stable: contract test with 111 assertions proves round-trip fidelity
- Fire-and-forget means writes don't block dispatch but failures are invisible (monitor file existence)

### What's fragile
- Error swallowing means write failures are only detectable by missing lines in the JSONL file

### Authoritative diagnostics
- `cat .gsd/activity/dispatch-metrics.jsonl | jq .` — inspect captured metrics
- Test failures in telemetry-contract.test.ts indicate breaking changes to the schema

### What assumptions changed
- None — the plan was executed as specified