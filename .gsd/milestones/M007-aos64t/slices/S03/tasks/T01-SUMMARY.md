---
id: T01
parent: S03
milestone: M007-aos64t
provides:
  - Durable validation report for factcheck proof path
  - Machine-readable milestone closeout artifact
key_files:
  - src/resources/extensions/gsd/tests/factcheck-final-audit.test.ts
  - .gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json
key_decisions:
  - Used tsx for test execution due to Node.js --experimental-strip-types not handling transitive .js imports in .ts files
patterns_established:
  - Final audit tests write structured validation reports to milestone directory as durable evidence
observability_surfaces:
  - M007-VALIDATION-REPORT.json with schema version 1, dispatch action, and prompt evidence
duration: 20 minutes
verification_result: passed
completed_at: 2026-03-18T19:51:40Z
blocker_discovered: false
---

# T01: Create final audit test that writes durable validation report

**Created final audit test that exercises dispatch reroute and prompt assembly, writing a structured validation report as durable milestone closeout evidence.**

## What Happened

Created `factcheck-final-audit.test.ts` following the same setup pattern as S02's live test: copies S01 fixtures to a temp directory, runs the dispatch rule against planImpacting=true fixture data, runs prompt builder to extract evidence, and constructs a structured validation report. The report is written to `.gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json` and read back to verify structural validity.

The test exercises real dispatch rules and prompt builders (not mocks), capturing the reroute action, verifying the corrected value "5.2.0" appears in the prompt, and persisting all evidence in a machine-readable JSON report.

**Module resolution note**: The test requires `npx tsx --test` for execution because Node's `--experimental-strip-types` doesn't handle transitive `.js` imports within `.ts` files. The gsd extension has no dist/ build output and imports local modules with `.js` extensions, which tsx handles correctly.

## Verification

1. **Final audit test passes** — `npx tsx --test src/resources/extensions/gsd/tests/factcheck-final-audit.test.ts` — all 3 tests pass
2. **Validation report written** — `.gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json` exists with `result: "PASS"`
3. **Schema validation** — Report contains all required fields: schemaVersion (1), milestone (M007-aos64t), generatedAt, evidence (refutedCount=1, rerouteTarget=plan-slice, correctedValuePresent=true, dispatchAction), result, proofArtifacts
4. **S02 tests still pass** — `npx tsx --test src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts` — all 9 tests pass

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx --test src/resources/extensions/gsd/tests/factcheck-final-audit.test.ts` | 0 | ✅ pass | 822ms |
| 2 | `node -e "const r=JSON.parse(...asserts...); console.log('Report valid')"` | 0 | ✅ pass | <50ms |
| 3 | `npx tsx --test src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts` | 0 | ✅ pass | 762ms |

## Diagnostics

- **Validation report location**: `.gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json`
- **Schema version**: 1 (stable)
- **Key fields for inspection**: `evidence.refutedCount`, `evidence.rerouteTarget`, `evidence.correctedValuePresent`, `result`
- **Run audit again**: `npx tsx --test src/resources/extensions/gsd/tests/factcheck-final-audit.test.ts`

## Deviations

- **Test execution method**: Slice plan specified `node --test` but tests require `npx tsx --test` due to module resolution limitations with `--experimental-strip-types` not handling transitive `.js` imports in local TypeScript files. The gsd extension lacks a dist/ build output and all local imports use `.js` extensions internally.

## Known Issues

None. All must-haves satisfied.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/factcheck-final-audit.test.ts` — New test file exercising dispatch reroute + prompt assembly proof path, writing durable validation report
- `.gsd/milestones/M007-aos64t/M007-VALIDATION-REPORT.json` — Durable validation artifact with schema version 1, dispatch evidence, and PASS result
