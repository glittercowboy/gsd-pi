---
estimated_steps: 4
estimated_files: 2
---

# T02: Integration tests for browser-side utilities, intent scoring, and form analysis via Playwright

**Slice:** S06 — Test coverage
**Milestone:** M002

## Description

Write Playwright-based integration tests that exercise the browser-side evaluate scripts against real DOM. These test the actual codepath — IIFE strings evaluated via `page.evaluate()` against HTML fixtures. Covers window.__pi utilities from evaluate-helpers.ts, intent scoring from intent.ts, and form label resolution from forms.ts. The scoring and form analysis functions are module-private (not exported), so we replicate the evaluate approach: read the source files to extract the IIFE strings, then evaluate them in Playwright.

## Steps

1. Create the `.mjs` test file. Import `node:test`, `node:assert/strict`, `playwright` (chromium), and use jiti or direct file reads to get EVALUATE_HELPERS_SOURCE and the evaluate script source strings. Launch Chromium once in `before()`, set viewport to 1280×720, close in `after()`.
2. Write window.__pi utility tests: inject EVALUATE_HELPERS_SOURCE via `page.evaluate()`, then test each function against inline HTML fixtures via `page.setContent()`:
   - `simpleHash` — deterministic output for same input, different output for different input
   - `isVisible` — visible element returns true, `display:none` returns false
   - `isEnabled` — enabled input returns true, disabled returns false
   - `inferRole` — button element → "button", anchor with href → "link", input[type=text] → "textbox"
   - `accessibleName` — button with text content, input with aria-label, input with label[for]
   - `isInteractiveEl` — button → true, div → false, input → true
   - `cssPath` — returns a valid CSS selector string that `querySelector` resolves back to the element
3. Write intent scoring tests: read `tools/intent.ts` source, extract the IIFE returned by `buildIntentScoringScript` for each intent (or replicate the script-building approach), then evaluate against HTML fixtures:
   - `submit_form` — form with submit button scores higher than a random button outside the form
   - `close_dialog` — dialog with × button and Cancel: × button scores highest
   - `search_field` — input[type=search] scores higher than input[type=text]
   - `primary_cta` — large styled button in main content scores higher than small nav link
4. Write form analysis tests: replicate `buildFormAnalysisScript()` call (or extract the script string), evaluate against a multi-field HTML form:
   - Label via `label[for]` resolves correctly
   - Label via wrapping `<label>` resolves correctly
   - Label via `aria-label` resolves correctly
   - Label via `aria-labelledby` resolves correctly
   - Label via `placeholder` as fallback
   - Hidden input is flagged as hidden
   - Submit button is discovered
   Update `test:browser-tools` script to glob both test files.

## Must-Haves

- [ ] Chromium launches and closes cleanly
- [ ] All 7 window.__pi utility functions tested
- [ ] Intent scoring tests show differentiated rankings for at least 4 intents
- [ ] Form analysis tests verify label resolution for at least 5 association methods
- [ ] `test:browser-tools` script runs both unit and integration test files

## Verification

- `npm run test:browser-tools` exits 0 with both unit and integration tests passing
- Integration tests complete in <30s

## Inputs

- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — EVALUATE_HELPERS_SOURCE for injection
- `src/resources/extensions/browser-tools/tools/intent.ts` — buildIntentScoringScript source (module-private, need to extract the script string)
- `src/resources/extensions/browser-tools/tools/forms.ts` — buildFormAnalysisScript source (module-private, need to extract the script string)
- T01 output — test infrastructure exists, `test:browser-tools` script in package.json

## Expected Output

- `src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs` — integration test file with ~20-25 test cases
- `package.json` — `test:browser-tools` script updated to include both files
