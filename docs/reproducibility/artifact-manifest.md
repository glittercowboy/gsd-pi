# Artifact Manifest: M005–M008 Proof Artifacts

This manifest catalogs every durable proof artifact from the evidence-grounded pipeline development arc. All paths are relative to the repository root.

## Primary Proof Artifacts

| Path | Type | Description | Milestone |
|------|------|-------------|-----------|
| `.gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json` | JSON | Machine-readable validation report proving the fact-check correction loop passes end-to-end. Contains refuted count, reroute target, corrected-value presence, and dispatch action. | M007-aos64t |
| `.gsd/milestones/M007-aos64t/M007-aos64t-SUMMARY.md` | Markdown | Closeout summary documenting the runtime proof with verified success criteria, requirement transitions, and forward intelligence. | M007-aos64t |

## Milestone Summaries

| Path | Type | Description | Milestone |
|------|------|-------------|-----------|
| `.gsd/milestones/M005-8pv12q/M005-8pv12q-SUMMARY.md` | Markdown | Unknowns inventory design outcomes. Documents evidence classification vocabulary (`observed`, `training-data`, `inferred`, `assumption`, `unknown`) and resolution strategies. | M005-8pv12q |
| `.gsd/milestones/M006-tbhsp8/M006-tbhsp8-SUMMARY.md` | Markdown | Fact-check infrastructure outcomes. Documents async coordinator, scout architecture, durable annotations, and bounded reroute loop. | M006-tbhsp8 |
| `.gsd/milestones/M008/M008-SUMMARY.md` | Markdown | Experiment harness outcomes. Documents comparison runner, fidelity rubrics, and bounded iteration with convergence detection. | M008 |

## Knowledge and Decisions

| Path | Type | Description | Milestone |
|------|------|-------------|-----------|
| `.gsd/KNOWLEDGE.md` | Markdown | Knowledge register with K001–K008 entries. Key entries: K007 (test runner requirement), K008 (runtime-proof milestone design). | All |
| `.gsd/DECISIONS.md` | Markdown | Decisions register with D055–D058 entries. Key decisions: D056 (async service layer), D061 (explicit determinism for control loops). | All |

## Test Artifacts

| Path | Type | Description | Milestone |
|------|------|-------------|-----------|
| `src/resources/extensions/gsd/tests/factcheck-runtime-fixture.test.ts` | Test | Verifies fixture contract: synthetic claims exist, manifest declares expected outcomes, claim C001 is REFUTED with corrected value. | M007-aos64t |
| `src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts` | Test | Exercises real dispatcher and prompt assembly. Proves `planImpacting=true` reroutes to `plan-slice`, planner prompt contains `## Fact-Check Evidence` section. | M007-aos64t |
| `src/resources/extensions/gsd/tests/factcheck-final-audit.test.ts` | Test | Writes `.gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json`, schema-validates it, confirms all claims passed. | M007-aos64t |

## Fixture Artifacts

| Path | Type | Description | Milestone |
|------|------|-------------|-----------|
| `src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/M999-PROOF/slices/S01/factcheck/FACTCHECK-STATUS.json` | JSON | Control surface for proof fixture. Contains `planImpacting: true` to trigger reroute. | M007-aos64t |
| `src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/M999-PROOF/slices/S01/factcheck/claims/C001.json` | JSON | The refuted claim: "Node.js LTS is 18.x" with corrected value "22.x" (or "5.2.0" in fixture variant). | M007-aos64t |
| `src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/M999-PROOF/slices/S01/factcheck/claims/C002.json` | JSON | Additional test claim in proof fixture. | M007-aos64t |
| `src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/M999-PROOF/slices/S01/factcheck/claims/C003.json` | JSON | Additional test claim in proof fixture. | M007-aos64t |
| `src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/M999-PROOF/slices/S01/S01-RESEARCH.md` | Markdown | Research output for proof fixture, providing the context for claim extraction. | M007-aos64t |

## Slice-Level Verification Artifacts

Milestone M007-aos64t produced verification artifacts at each slice:

| Slice | Artifact Count | Location |
|-------|----------------|----------|
| S01 (fixture contract) | 3 | `.gsd/milestones/M007-aos64t/slices/S01/tasks/` |
| S02 (live runtime) | 2 | `.gsd/milestones/M007-aos64t/slices/S02/tasks/` |
| S03 (final audit) | 2 | `.gsd/milestones/M007-aos64t/slices/S03/tasks/` |

Each task directory contains T*-VERIFY.json files with structured verification records.

## Methodology Documentation

| Path | Type | Description | Milestone |
|------|------|-------------|-----------|
| `docs/evidence-grounded-pipeline.md` | Markdown | Consolidated methodology report synthesizing M005–M008 into a self-contained narrative with Background, Hypothesis, Method, Results, and Interpretation sections. | M009 |

## Verification Command

To verify all paths in this manifest exist:

```bash
grep -oP '(?<=\`)[^\`]+\.(json|md)(?=\`)' docs/reproducibility/README.md docs/reproducibility/artifact-manifest.md | while read f; do [ -f "$f" ] || echo "MISSING: $f"; done
```

Expected result: No output (all referenced artifacts resolve).
