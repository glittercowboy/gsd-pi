---
id: T02
parent: S06
milestone: M002
provides:
  - 45 Playwright integration tests covering browser-side evaluate scripts against real DOM
  - Coverage for all 7 window.__pi utilities, 4 intent scoring differentiations, 5 label resolution methods
key_files:
  - src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs
  - package.json
key_decisions:
  - Extracted module-private buildIntentScoringScript and buildFormAnalysisScript by reading .ts source, brace-matching the function body, stripping TS annotations, and eval'ing to get callable functions — avoids needing to export test-only APIs
patterns_established:
  - Source extraction pattern for testing module-private functions: readFileSync → brace-match → strip TS types → new Function("return " + fnBody)()
  - window.__pi persistence across page.setContent() calls — must explicitly delete for missing-helper tests
observability_surfaces:
  - none
duration: ~12 minutes
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T02: Integration tests for browser-side utilities, intent scoring, and form analysis via Playwright

**Created 45 Playwright integration tests exercising evaluate-helpers.ts, intent.ts scoring, and forms.ts analysis against real Chromium DOM.**

## What Happened

Built `browser-tools-integration.test.mjs` with three test suites:

1. **window.__pi utilities** (26 tests): simpleHash determinism/uniqueness, isVisible for visible/display:none/visibility:hidden, isEnabled for enabled/disabled/aria-disabled, inferRole for button/link/textbox/searchbox/explicit-role, accessibleName for text-content/aria-label/aria-labelledby/placeholder, isInteractiveEl for button/div/input/anchor/tabindex, cssPath round-trip validation and id shortcut.

2. **Intent scoring** (7 tests): submit_form (inside-form outscores outside), close_dialog (× button in dialog is top), search_field (type=search outscores type=text), primary_cta (large main button outscores small nav link), plus result structure validation, unknown intent error, and missing __pi error.

3. **Form analysis** (12 tests): label resolution via label[for], wrapping label, aria-label, aria-labelledby, placeholder fallback. Hidden input detection, submit button discovery, result structure, required field identification, select option enumeration, auto-detection, and missing selector error.

Extracted the module-private `buildIntentScoringScript` and `buildFormAnalysisScript` functions by reading the TypeScript source at test time, brace-matching to find the full function body, stripping type annotations, and wrapping in `new Function()` — cleanly replicates the actual codepath without requiring exports.

## Verification

- `npm run test:browser-tools` exits 0: 108 tests (63 unit + 45 integration), 0 failures
- Integration tests alone complete in ~580ms (well under 30s limit)
- Both test files run from the single npm script

## Diagnostics

None — pure test file with no runtime surfaces.

## Deviations

- The "missing window.__pi returns error" test needed an explicit `delete window.__pi` since `page.setContent()` doesn't reset JavaScript globals within the same browsing context. Minor adaptation, same coverage intent.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs` — 45 Playwright integration tests
- `package.json` — Updated `test:browser-tools` script to glob both test files
