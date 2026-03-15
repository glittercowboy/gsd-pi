---
id: S06
parent: M002
milestone: M002
provides:
  - 108 automated tests (63 unit + 45 integration) covering all browser-tools pure functions, state accessors, image processing, browser-side utilities, intent scoring, and form analysis
  - test:browser-tools npm script for isolated browser-tools test execution
requires:
  - slice: S01
    provides: Module structure, state.ts accessors, evaluate-helpers.ts, utils.ts pure functions, refs.ts parseRef/formatVersionedRef
  - slice: S02
    provides: Consolidated captureCompactPageState, settle logic (testable via state types)
  - slice: S03
    provides: Sharp-based constrainScreenshot (testable with synthetic buffers)
  - slice: S04
    provides: Form analysis evaluate scripts (buildFormAnalysisScript), label resolution heuristics
  - slice: S05
    provides: Intent scoring evaluate scripts (buildIntentScoringScript), 4-dimension heuristic model
affects: []
key_files:
  - src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs
  - src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs
  - package.json
key_decisions:
  - D025: jiti for CJS-based TypeScript imports in tests — ESM resolve-ts hook breaks on core.js plain .js files
  - D026: Source extraction pattern for testing module-private functions — read TS source, brace-match, strip types, eval
patterns_established:
  - "jiti import pattern: `const jiti = require('jiti')(__filename, { interopDefault: true }); const mod = jiti('../module.ts');`"
  - "Source extraction for private functions: readFileSync → brace-match → strip TS annotations → new Function()"
  - Synthetic sharp buffers for image processing tests
  - window.__pi persistence across page.setContent() — must explicitly delete for missing-helper tests
observability_surfaces:
  - none
drill_down_paths:
  - .gsd/milestones/M002/slices/S06/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S06/tasks/T02-SUMMARY.md
duration: ~24m
verification_result: passed
completed_at: 2026-03-12
---

# S06: Test coverage

**108 automated tests covering browser-tools pure functions, state management, image processing, browser-side utilities, intent scoring, and form analysis — all passing in ~700ms.**

## What Happened

Built two test files exercising the full browser-tools codebase from S01–S05.

**Unit tests (T01, 63 tests):** CJS file using jiti for TypeScript imports. Covers parseRef (5 tests), formatVersionedRef (2), staleRefGuidance (1), formatCompactStateSummary (3), verificationFromChecks (3), verificationLine (1), sanitizeArtifactName (7), isCriticalResourceType (7), getUrlHash (3), firstErrorLine (5), formatArtifactTimestamp (1), EVALUATE_HELPERS_SOURCE syntax validation + 9 function name checks (10), state accessor round-trips (10), resetAllState (1), and constrainScreenshot with synthetic sharp buffers — passthrough, JPEG resize, PNG resize, height-only overflow (4).

**Integration tests (T02, 45 tests):** ESM file using Playwright chromium. Tests window.__pi utilities against real DOM (26 tests covering simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, cssPath). Tests intent scoring differentiation for submit_form, close_dialog, search_field, primary_cta plus structure/error cases (7 tests). Tests form label resolution via 5 association methods plus hidden inputs, submit discovery, required fields, select options, auto-detection, and error handling (12 tests).

The module-private `buildIntentScoringScript` and `buildFormAnalysisScript` were extracted at test time by reading TS source, brace-matching to find function bodies, stripping type annotations, and wrapping in `new Function()` — replicates the actual codepath without needing test-only exports.

## Verification

- `npm run test:browser-tools` exits 0: 108 tests, 0 failures, 18 suites, ~700ms
- Unit tests: 63 pass across 15 suites
- Integration tests: 45 pass across 3 suites (~580ms with Chromium)
- Both test files execute from the single `test:browser-tools` npm script

## Requirements Advanced

- R026 — Test suite now covers shared utilities, state management, image processing, browser-side evaluate helpers, intent scoring, and form analysis heuristics

## Requirements Validated

- R026 — 108 passing tests across unit and integration suites; `npm run test:browser-tools` exits 0

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- none

## Known Limitations

- Tests don't cover the full action pipeline end-to-end (captureCompactPageState, settleAfterActionAdaptive) — those are integration-level concerns verified by spot-checking in prior slices
- Module-private function extraction via source reading is fragile to refactors that change function signatures or positions — acceptable for test code

## Follow-ups

- none

## Files Created/Modified

- `src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs` — 63 unit tests across 15 describe blocks
- `src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs` — 45 Playwright integration tests across 3 suites
- `package.json` — added `test:browser-tools` script

## Forward Intelligence

### What the next slice should know
- This is the final slice of M002. No downstream slices.

### What's fragile
- The source extraction pattern in integration tests reads raw .ts source and brace-matches — any significant refactor to buildIntentScoringScript or buildFormAnalysisScript function shape will break the extraction. The tests will fail clearly though.

### Authoritative diagnostics
- `npm run test:browser-tools` — single command runs all 108 tests, exits non-zero on any failure

### What assumptions changed
- none — slice executed as planned
