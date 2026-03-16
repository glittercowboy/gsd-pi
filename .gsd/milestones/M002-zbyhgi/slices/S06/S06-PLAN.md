# S06: Test coverage

**Goal:** Test suite covers shared browser-side utilities, settle logic, screenshot resizing, form analysis heuristics, intent scoring, and semantic action resolution.
**Demo:** `npm run test:browser-tools` passes — unit tests via jiti and integration tests via Playwright both green.

## Must-Haves

- Unit tests for pure Node-side functions: parseRef, formatVersionedRef, staleRefGuidance, formatCompactStateSummary, verificationFromChecks, verificationLine, sanitizeArtifactName, isCriticalResourceType, getUrlHash, firstErrorLine, formatArtifactTimestamp
- Unit test for EVALUATE_HELPERS_SOURCE syntax validity (parseable via `new Function()`)
- Unit tests for state accessor pairs (set/get round-trip) and resetAllState
- Unit tests for constrainScreenshot with synthetic sharp buffers (JPEG/PNG, within-bounds passthrough, over-bounds resize)
- Integration tests for window.__pi utility functions (simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, cssPath) via Playwright page.evaluate against real DOM
- Integration tests for intent scoring differentiation (submit_form, close_dialog, search_field, primary_cta) via Playwright page.evaluate of buildIntentScoringScript output
- Integration tests for form label resolution (7-level priority chain) via Playwright page.evaluate of buildFormAnalysisScript output
- `test:browser-tools` script in package.json — separate from existing `test` script

## Verification

- `npm run test:browser-tools` exits 0 with all tests passing
- Unit test file: `src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs`
- Integration test file: `src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs`

## Tasks

- [x] **T01: Unit tests for Node-side pure functions, state accessors, and constrainScreenshot** `est:30m`
  - Why: Covers all pure-function logic from utils.ts, state.ts, evaluate-helpers.ts, and capture.ts that can be tested without a browser. These are the fastest, most stable tests.
  - Files: `src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs`, `package.json`
  - Do: Create tests/ directory. Write CJS test file using `node:test` + `node:assert/strict` + `@mariozechner/jiti` for imports. Test pure functions from utils.ts (parseRef, formatVersionedRef, staleRefGuidance, formatCompactStateSummary, verificationFromChecks, verificationLine, sanitizeArtifactName, isCriticalResourceType, getUrlHash, firstErrorLine, formatArtifactTimestamp). Test EVALUATE_HELPERS_SOURCE parseable via `new Function()` and contains all 9 expected function names. Test state accessor round-trips and resetAllState. Test constrainScreenshot with synthetic sharp buffers: small JPEG passthrough, oversized JPEG resize, PNG resize. Add `test:browser-tools` script to package.json.
  - Verify: `npm run test:browser-tools` passes all unit tests
  - Done when: All unit tests pass, `test:browser-tools` script exists

- [x] **T02: Integration tests for browser-side utilities, intent scoring, and form analysis via Playwright** `est:30m`
  - Why: Covers the evaluate-script logic that requires a real DOM — window.__pi functions, intent scoring heuristics, and form label resolution. These test the actual codepath (page.evaluate with IIFE strings) that the tools use in production.
  - Files: `src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs`, `package.json`
  - Do: Write ESM test file using `node:test` + `node:assert/strict` + Playwright chromium. Launch browser once in `before()`, close in `after()`. Test window.__pi functions by injecting EVALUATE_HELPERS_SOURCE then evaluating each function against HTML fixtures via `page.setContent()`. Test intent scoring by calling buildIntentScoringScript (not exported — read forms.ts and intent.ts to extract the evaluate script strings, or use the same evaluate-script-building approach from the source). Test form analysis by evaluating buildFormAnalysisScript output against a multi-field HTML form. Set explicit viewport dimensions (1280×720) for deterministic scoring. Update `test:browser-tools` script to include this file.
  - Verify: `npm run test:browser-tools` passes all integration tests
  - Done when: All integration tests pass including browser-side utility, intent scoring, and form analysis tests

## Files Likely Touched

- `src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs`
- `src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs`
- `package.json`
