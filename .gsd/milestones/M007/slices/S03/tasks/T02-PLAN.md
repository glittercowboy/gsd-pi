---
estimated_steps: 4
estimated_files: 1
---

# T02: End-to-end fixture harness test

**Slice:** S03 — Fixture Harness
**Milestone:** M007

## Description

Write a comprehensive test file that exercises all 3 concept fixtures end-to-end: load fixture → validate state integrity → verify claim mix → write synthetic metrics JSONL → read back with `readMetricsJsonl` and assert telemetry shape matches manifest expectations. This is the slice's primary verification artifact.

Important: Use `npx tsx --test` as the test runner (K007). Use `os.tmpdir() + crypto.randomUUID()` for temp directory isolation (S02 pattern).

## Steps

1. Create `src/resources/extensions/gsd/tests/fixture-e2e.test.ts` using Node's built-in `node:test` module (`describe`, `it`).
2. For each fixture (`low-unknown`, `high-unknown`, `mixed-confidence`), write a test group that:
   - Calls `loadFixture(fixtureId, tmpDir)` to load state into a temp directory
   - Calls `validateFixtureState(manifest, tmpDir)` and asserts `valid === true` and `missingFiles.length === 0`
   - Asserts `manifest.claimMix.total === manifest.claims.length`
   - Asserts claim verdict counts match claimMix (e.g., count claims with `verdict === 'confirmed'` equals `claimMix.confirmed`)
3. Add a metrics extraction test group: for each fixture, write a synthetic `dispatch-metrics.jsonl` file to a temp path containing a UnitMetrics-shaped entry whose fact-check fields match `manifest.expectedTelemetryShape.factCheck`. Read it back with `readMetricsJsonl` and assert the parsed unit's fact-check values match.
4. Clean up temp dirs in `afterEach` or use unique dirs per test that don't need cleanup.

## Must-Haves

- [ ] All 3 fixtures (low-unknown, high-unknown, mixed-confidence) tested
- [ ] State integrity validation passes for every fixture
- [ ] Claim mix consistency verified (total matches array length, verdict counts match)
- [ ] Synthetic metrics JSONL round-trip verified via readMetricsJsonl
- [ ] Test runs with `npx tsx --test`

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/fixture-e2e.test.ts` — all tests pass

## Inputs

- `src/resources/extensions/gsd/tests/fixture-harness.ts` — loadFixture, readFixtureManifest, validateFixtureState (from T01)
- `src/resources/extensions/gsd/metrics-reader.ts` — readMetricsJsonl
- `src/resources/extensions/gsd/tests/fixtures/concepts/` — all 3 concept fixture directories

## Expected Output

- `src/resources/extensions/gsd/tests/fixture-e2e.test.ts` — new test file, all assertions passing
