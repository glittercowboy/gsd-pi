---
estimated_steps: 4
estimated_files: 7
---

# T01: Create mixed-confidence fixture and state integrity validator

**Slice:** S03 — Fixture Harness
**Milestone:** M007

## Description

Create the third concept fixture ("mixed-confidence") representing a balanced scenario with moderate certainty — distinct from high-unknown (many refutations) and low-unknown (mostly confirmed). Also add a `validateFixtureState` function to `fixture-harness.ts` that checks all `requiredFiles` from a manifest exist after loading.

## Steps

1. Create `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/FIXTURE-MANIFEST.json` with 4 claims: 2 confirmed, 1 refuted, 1 inconclusive. Follow the exact schema used by `high-unknown` and `low-unknown` manifests (fields: id, scenarioDescription, milestoneId, sliceId, createdAt, version, claimMix, expectedTelemetryShape, successCriteria, claims, requiredFiles, redactionConstraints). Set `syntheticOnly: true`.
2. Create the state tree files referenced in `requiredFiles`: `FACTCHECK-STATUS.json` and individual claim JSON files (`C001.json` through `C004.json`) under `state/slices/S01/factcheck/`. Model these on the existing `low-unknown` state files.
3. Add `validateFixtureState(manifest: FixtureManifest, targetBase: string): { valid: boolean; missingFiles: string[] }` to `fixture-harness.ts`. It checks each entry in `manifest.requiredFiles` exists under `targetBase/state/` (since `loadFixture` copies the `state/` tree into `targetBase/state/`). Return list of missing files.
4. Verify the manifest parses correctly: `node -e "JSON.parse(require('fs').readFileSync('src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/FIXTURE-MANIFEST.json','utf8'))"` and that `readFixtureManifest('mixed-confidence')` succeeds.

## Must-Haves

- [ ] FIXTURE-MANIFEST.json valid JSON with all required fields per FixtureManifest interface
- [ ] claimMix.total matches claims array length
- [ ] All requiredFiles have corresponding state tree files
- [ ] validateFixtureState exported from fixture-harness.ts
- [ ] redactionConstraints.syntheticOnly is true

## Verification

- `node -e "JSON.parse(require('fs').readFileSync('src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/FIXTURE-MANIFEST.json','utf8'))"` exits 0
- `npx tsx -e "import { readFixtureManifest } from './src/resources/extensions/gsd/tests/fixture-harness.js'; const m = readFixtureManifest('mixed-confidence'); console.log(m.id, m.claimMix.total);"` prints fixture id and count 4

## Inputs

- `src/resources/extensions/gsd/tests/fixture-harness.ts` — existing loader with types and loadFixture/readFixtureManifest
- `src/resources/extensions/gsd/tests/fixtures/concepts/low-unknown/FIXTURE-MANIFEST.json` — schema reference
- `src/resources/extensions/gsd/tests/fixtures/concepts/low-unknown/state/` — state tree structure reference

## Expected Output

- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/FIXTURE-MANIFEST.json` — new fixture manifest
- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/state/slices/S01/factcheck/FACTCHECK-STATUS.json` — status file
- `src/resources/extensions/gsd/tests/fixtures/concepts/mixed-confidence/state/slices/S01/factcheck/claims/C001.json` through `C004.json` — claim files
- `src/resources/extensions/gsd/tests/fixture-harness.ts` — modified with `validateFixtureState` export
