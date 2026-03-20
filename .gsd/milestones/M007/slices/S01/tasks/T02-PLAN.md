---
estimated_steps: 4
estimated_files: 2
---

# T02: Add JSONL schema documentation and telemetry contract test

**Slice:** S01 — Telemetry Schema & Dispatch Hooking
**Milestone:** M007

## Description

Create a contract test that serializes a fully-populated `UnitMetrics` object to JSON and back, asserting round-trip fidelity for every field including optional M007 additions (interventions, factCheck, wallClockMs, skills). This gives S02 (metrics aggregation) and S03 (fixture harness) a regression-safe contract to depend on.

**Note:** Tests use `npx tsx --test` (not `node --test`) per K007.

## Steps

1. Create `src/resources/extensions/gsd/tests/telemetry-contract.test.ts`.
2. Import `UnitMetrics`, `InterventionCounts`, `FactCheckMetrics` from `../metrics.js`.
3. Construct a `UnitMetrics` object with ALL fields populated (required and optional), including nested `tokens`, `interventions`, `factCheck`, and `skills` array.
4. Serialize to JSON string, parse back, and assert every field matches. Assert optional fields survive round-trip when present and are absent when omitted.

## Must-Haves

- [ ] Contract test covers all `UnitMetrics` fields including optionals
- [ ] Round-trip JSON serialization/deserialization preserves all values
- [ ] Test passes via `npx tsx --test`

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/telemetry-contract.test.ts` — all pass

## Inputs

- `src/resources/extensions/gsd/metrics.ts` — `UnitMetrics`, `InterventionCounts`, `FactCheckMetrics` type definitions
- T01 verification confirms schema is complete

## Expected Output

- `src/resources/extensions/gsd/tests/telemetry-contract.test.ts` — new contract test file proving JSONL schema stability
