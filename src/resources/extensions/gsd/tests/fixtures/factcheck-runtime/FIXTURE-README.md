# Fact-Check Runtime Proof Fixture

This directory contains deterministic fixture assets for testing the live fact-check runtime loop. The fixture represents a synthetic research output with a known false claim that produces a plan-impacting refutation.

## Directory Structure

```
factcheck-runtime/
├── FIXTURE-MANIFEST.json      # Contract boundary: expected claims, outcomes, assertions
├── FIXTURE-README.md          # This file
└── M999-PROOF/                # Synthetic milestone directory
    └── slices/
        └── S01/
            ├── S01-RESEARCH.md           # Research output with Unknowns Inventory
            └── factcheck/
                ├── FACTCHECK-STATUS.json # Aggregate status (planImpacting: true)
                └── claims/
                    ├── C001.json         # REFUTED: version claim (impact: slice)
                    ├── C002.json         # CONFIRMED: API signature
                    └── C003.json         # INCONCLUSIVE: maintenance status
```

## The False Claim (C001)

**Original claim:** `@synthetic/lib version is 4.1.0`
**Evidence basis:** training-data recall
**Actual value:** `5.2.0` (verified via npm registry)
**Impact:** `slice` — triggers reroute to `plan-slice`

This is the primary assertion target for runtime proof tests. The fixture encodes:
- A clear refutation with a corrected value
- Plan-impacting impact level (slice)
- Expected reroute behavior to plan-slice

## Loading the Fixture

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const fixtureRoot = 'src/resources/extensions/gsd/tests/fixtures/factcheck-runtime';

// Load manifest
const manifest = JSON.parse(
  readFileSync(join(fixtureRoot, 'FIXTURE-MANIFEST.json'), 'utf-8')
);

// Verify required files
for (const file of manifest.requiredFiles) {
  if (!existsSync(join(fixtureRoot, file))) {
    throw new Error(`Missing fixture file: ${file}`);
  }
}

// Load research output
const research = readFileSync(
  join(fixtureRoot, 'M999-PROOF/slices/S01/S01-RESEARCH.md'),
  'utf-8'
);

// Load factcheck artifacts
const status = JSON.parse(
  readFileSync(join(fixtureRoot, 'M999-PROOF/slices/S01/factcheck/FACTCHECK-STATUS.json'), 'utf-8')
);
```

## Expected Assertions

1. **Manifest contract:**
   - `expectedClaimCount === 3`
   - `expectedRefutationClaimId === 'C001'`
   - `expectedImpact === 'slice'`
   - `expectedCorrectedValue === '5.2.0'`
   - `expectedPlanImpacting === true`

2. **Aggregate status:**
   - `overallStatus === 'has-refutations'`
   - `planImpacting === true`
   - `counts.refuted === 1`
   - `rerouteTarget === 'plan-slice'`

3. **Refuted claim (C001):**
   - `verdict === 'refuted'`
   - `correctedValue === '5.2.0'`
   - `impact === 'slice'`
   - `citations.length > 0`

## Synthetic Data Guarantee

This fixture contains **no real package references**. `@synthetic/lib` is a fictional package name used only for testing. All data is synthetic and deterministic.

## Usage in Tests

```typescript
test('fixture: loads and validates manifest', () => {
  const manifest = loadFixtureManifest();
  assert.strictEqual(manifest.expectedClaimCount, 3);
  assert.strictEqual(manifest.expectedPlanImpacting, true);
});

test('fixture: C001 is refuted with corrected value', () => {
  const claim = loadClaimAnnotation('C001');
  assert.strictEqual(claim.verdict, 'refuted');
  assert.strictEqual(claim.correctedValue, '5.2.0');
  assert.strictEqual(claim.impact, 'slice');
});

test('fixture: aggregate status is plan-impacting', () => {
  const status = loadAggregateStatus();
  assert.strictEqual(status.planImpacting, true);
  assert.strictEqual(status.overallStatus, 'has-refutations');
});
```

## Failure State Visibility

If the fixture is malformed or files are missing, tests should fail with:
- `fixtureId` from the manifest (or "missing manifest" if manifest absent)
- `stage` indicating where validation failed
- `expectedPath` showing which file was expected

Example error structure:
```typescript
interface FixtureValidationError {
  fixtureId: string;
  stage: 'manifest-load' | 'manifest-parse' | 'file-check' | 'artifact-parse';
  expectedPath: string;
  message: string;
}
```

## Downstream Dependencies

- **S02 (Live Reroute Proof):** Uses this fixture to prove the dispatcher reroutes on plan-impacting refutations.
- **S03 (Durable Validation):** Uses fixture validation output as proof-run diagnostics.

## Maintenance

If the fixture schema changes, update:
1. `FIXTURE-MANIFEST.json` with new expected values
2. This README with new assertions
3. The corresponding test file `factcheck-runtime-fixture.test.ts`
