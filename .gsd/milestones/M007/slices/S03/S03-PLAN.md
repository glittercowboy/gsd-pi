# S03: Fixture Harness

**Goal:** Provide a complete fixture harness with 3 concept fixtures and end-to-end verification that fixture loading, state integrity checking, and metric extraction work together.
**Demo:** `npx tsx --test src/resources/extensions/gsd/tests/fixture-e2e.test.ts` passes — loads each concept fixture, validates state integrity against manifest `requiredFiles`, and verifies expected telemetry shape fields are present and correct.

## Must-Haves

- Third concept fixture ("mixed-confidence") with distinct claim mix profile
- State integrity validation function that checks all `requiredFiles` exist after loading
- End-to-end test exercising all 3 fixtures through load → validate state → verify telemetry shape
- Metrics extraction test: write synthetic JSONL matching fixture expectations, read back with `readMetricsJsonl`, assert telemetry shape matches manifest

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/fixture-e2e.test.ts` — all assertions pass
- Third fixture exists: `test -f src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/FIXTURE-MANIFEST.json`

## Observability / Diagnostics

- Runtime signals: fixture load errors throw with fixture ID and missing file path
- Inspection surfaces: `FIXTURE-MANIFEST.json` per fixture, `readFixtureManifest()` API
- Failure visibility: manifest validation errors name the specific field or file that's wrong

## Integration Closure

- Upstream surfaces consumed: `fixture-harness.ts` (loader), `metrics-reader.ts` (JSONL reader), concept fixture manifests
- New wiring introduced in this slice: `validateFixtureState()` function, mixed-confidence fixture
- What remains before the milestone is truly usable end-to-end: nothing — this is the final slice

## Tasks

- [ ] **T01: Create mixed-confidence fixture and state integrity validator** `est:30m`
  - Why: Need 3rd concept fixture + a function to verify loaded state matches manifest's `requiredFiles`
  - Files: `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/FIXTURE-MANIFEST.json`, `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/state/slices/S01/factcheck/`, `src/resources/extensions/gsd/tests/fixture-harness.ts`
  - Do: Create mixed-confidence fixture with ~4 claims (2 confirmed, 1 refuted, 1 inconclusive). Add `validateFixtureState(manifest, targetBase): { valid, missingFiles }` to fixture-harness.ts that checks all `requiredFiles` exist under targetBase.
  - Verify: `node -e "const m = require('fs').readFileSync('src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/FIXTURE-MANIFEST.json','utf8'); JSON.parse(m)"` exits 0
  - Done when: mixed-confidence fixture has valid manifest + state tree, `validateFixtureState` exported from fixture-harness.ts

- [ ] **T02: End-to-end fixture harness test** `est:45m`
  - Why: Proves all 3 fixtures load correctly, state integrity passes, and metrics extraction matches expected telemetry shapes
  - Files: `src/resources/extensions/gsd/tests/fixture-e2e.test.ts`
  - Do: Write test file with 3 groups (one per fixture). Each group: (1) loadFixture into temp dir, (2) validateFixtureState passes, (3) verify manifest.claimMix totals match claims array, (4) write synthetic dispatch-metrics.jsonl matching expectedTelemetryShape, (5) read back with readMetricsJsonl and assert shape. Use `os.tmpdir() + crypto.randomUUID()` for isolation per K007/S02 patterns. Run with `npx tsx --test`.
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/fixture-e2e.test.ts`
  - Done when: All fixture load + validate + metrics extraction assertions pass for all 3 concept fixtures

## Files Likely Touched

- `src/resources/extensions/gsd/tests/fixture-harness.ts`
- `src/resources/extensions/gsd/tests/fixture-e2e.test.ts`
- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/FIXTURE-MANIFEST.json`
- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/state/slices/S01/factcheck/FACTCHECK-STATUS.json`
- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/state/slices/S01/factcheck/claims/C001.json`
- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/state/slices/S01/factcheck/claims/C002.json`
- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/state/slices/S01/factcheck/claims/C003.json`
- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/state/slices/S01/factcheck/claims/C004.json`
