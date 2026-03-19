# Reproducibility Kit: Evidence-Grounded Pipeline

This kit enables independent verification of the fact-check correction loop proof from milestones M005–M008. Follow these instructions to reproduce the runtime proof and verify the artifact chain.

## Prerequisites

### Environment

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥22.5 | Required for native TypeScript execution. Tested with v22.20.0 |
| npm | bundled with Node | For package installation |
| tsx | installed via npm | Required for test execution (K007) |

### Dependencies

The project uses npm workspaces. Install all dependencies from the repository root:

```bash
npm install
```

### Model/Configuration Assumptions

The fact-check loop was tested with:
- **Orchestrator model:** Configured via GSD settings (typically claude-sonnet-4 or equivalent)
- **Scout model:** Lower-cost model (haiku) for independent claim verification
- **Fixture claims:** Synthetic claims with known truth values for deterministic proof

The proof tests run against fixture data and do not require live model access.

## Proof Artifacts Location

All proof artifacts live under `.gsd/milestones/` relative to the repository root:

```
.gsd/
├── milestones/
│   ├── M007-aos64t/
│   │   ├── M007-VALIDATION-REPORT.json  # Primary proof artifact
│   │   └── M007-aos64t-SUMMARY.md       # Closeout summary
│   ├── M005-8pv12q/                     # Unknowns inventory design
│   ├── M006-tbhsp8/                     # Fact-check infrastructure
│   └── M008/                            # Experiment harness
└── KNOWLEDGE.md                         # K001–K008 design rationale
```

The synthetic fixture for the proof is at:

```
src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/M999-PROOF/
```

## Step-by-Step Reproduction

### 1. Verify the fixture exists

```bash
ls -la src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/M999-PROOF/slices/S01/factcheck/
```

Expected output should include:
- FACTCHECK-STATUS.json — control surface with planImpacting: true
- claims/C001.json — the refuted claim about Node.js version
- claims/C002.json, claims/C003.json — additional test claims

### 2. Run the full proof suite

Per K007, GSD extension tests require tsx rather than Node's built-in test runner:

```bash
npx tsx --test src/resources/extensions/gsd/tests/factcheck-*.test.ts
```

Expected result: **42 tests pass** covering:
- Fixture contract verification (factcheck-runtime-fixture.test.ts)
- Live dispatch reroute proof (factcheck-runtime-live.test.ts)
- Final audit and validation report generation (factcheck-final-audit.test.ts)

### 3. Verify the validation report

```bash
cat .gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json
```

Expected outcome:
- result: PASS
- refutedCount: 1
- rerouteTarget: plan-slice
- correctedValuePresent: true
- dispatchAction: action=dispatch, unitType=plan-slice, unitId=M999-PROOF/S01

### 4. Verify artifact link integrity

```bash
bash -c 'grep -oP "(?<=\`)[^\`]+\.(json|md)(?=\`)" docs/evidence-grounded-pipeline.md docs/reproducibility/*.md | while read f; do [ -f "$f" ] || echo "MISSING: $f"; done'
```

Expected result: No output (all referenced artifacts exist).

## Expected PASS Outcome

When all steps complete successfully, you will have verified:

1. **Deterministic fixture contract** — The synthetic claim about Node.js 18.x being LTS is correctly identified as refutable
2. **Live reroute proof** — The dispatcher inspects the factcheck status and reroutes to plan-slice when planImpacting is true
3. **Corrected evidence injection** — The planner prompt receives a Fact-Check Evidence section with REFUTED claim and corrected value
4. **Durable validation** — The validation report captures machine-readable proof status

## Troubleshooting

### npx tsx --test fails with import errors

The gsd extension uses .js import specifiers within .ts files. Ensure tsx is installed:

```bash
npm install -D tsx
```

### Validation report shows FAIL

If the validation report shows result: FAIL:
1. Check that fixture files exist under the M999-PROOF fixture directory
2. Verify FACTCHECK-STATUS.json contains planImpacting: true
3. Run individual test files to isolate the failure

### Missing artifact paths

If the link verification reports missing files, check that:
- You're running from the repository root
- All milestone summaries exist under `.gsd/milestones/`

## Cross-Reference

| Document | Path | Purpose |
|----------|------|---------|
| Methodology Report | `docs/evidence-grounded-pipeline.md` | Full narrative from hypothesis through results |
| Artifact Manifest | `docs/reproducibility/artifact-manifest.md` | Complete inventory of proof artifacts |
| Knowledge Register | `.gsd/KNOWLEDGE.md` | K001–K008 design rationale |
| Decisions Register | `.gsd/DECISIONS.md` | D055–D058 architectural decisions |
