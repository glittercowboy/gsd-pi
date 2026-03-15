# S06: Test Coverage — Research

**Date:** 2026-03-12

## Summary

S06 needs to deliver test coverage for the browser-tools modules built across S01-S05 — shared utilities, evaluate helpers, screenshot resizing, settle logic, form analysis, and intent scoring. The codebase currently has **zero** browser-tools tests.

The work splits into three natural layers: (1) pure Node-side function unit tests importable via jiti without a browser, (2) browser-side utility tests that run `window.__pi` functions against DOM fixtures via Playwright `page.evaluate`, and (3) integration tests for intent scoring and form analysis against real HTML pages. The main constraint is that browser-tools modules can't be imported through the project's existing `resolve-ts` hook because `core.js` is a plain JS file and the hook's `.js→.ts` fallback doesn't catch it. jiti (the `@mariozechner/jiti` fork already in node_modules) handles this correctly.

The intent scoring and form analysis functions (`buildIntentScoringScript`, `buildFormAnalysisScript`) are module-private — they're not exported. To unit-test the scoring heuristics without a browser, they'd need to be exported (a small, safe refactor). Alternatively, the scoring logic can be tested end-to-end via Playwright integration tests, which is how S04/S05 verified them. For this slice, the Playwright integration approach is preferred for scoring/forms — it tests the real evaluate scripts against real DOM, which is the exact codepath that matters. The pure functions in utils.ts and the sharp-based `constrainScreenshot` are straightforward unit tests.

## Recommendation

**Two test files, one test script:**

1. **`browser-tools-unit.test.cjs`** — Pure function tests using `node:test` + jiti imports. Covers: `parseRef`, `formatVersionedRef`, `staleRefGuidance`, `formatCompactStateSummary`, `verificationFromChecks`, `verificationLine`, `sanitizeArtifactName`, `isCriticalResourceType`, `getUrlHash`, `firstErrorLine`, `formatArtifactTimestamp`, `EVALUATE_HELPERS_SOURCE` validation, `resetAllState` + accessor pairs, `constrainScreenshot` with sharp buffer fixtures.

2. **`browser-tools-integration.test.mjs`** — Playwright integration tests. Covers: `window.__pi` utility functions in a real browser context (simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, cssPath), intent scoring differentiation (submit_form, close_dialog, search_field, primary_cta), form label resolution (7-level priority chain), settle zero-mutation short-circuit. Launches Chromium, navigates to `data:` URLs or inline HTML, runs evaluate scripts, asserts results.

Place both files in `src/resources/extensions/browser-tools/tests/`. Add a `test:browser-tools` script to package.json. Don't modify the existing `test` script — keep browser-tools tests separate since they need Playwright (slow, requires Chromium).

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| TypeScript import resolution for `.js` specifiers | `@mariozechner/jiti` (already in node_modules) | Handles `.js→.ts` rewrite and `core.js` correctly; proven by S01 verification |
| Test runner + assertions | `node:test` + `node:assert/strict` | Already used by newer tests (auto-secrets-gate, manifest-status). Zero deps. |
| Synthetic image buffers for screenshot tests | `sharp` create API | `sharp({ create: { width, height, channels, background } }).jpeg().toBuffer()` — already a dependency |
| Real browser for integration tests | `playwright` | Already a dependency; launches Chromium with full DOM API |

## Existing Code and Patterns

- `src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` — Reference pattern for `node:test` + `node:assert/strict` style tests. Uses temp dirs for isolation, `test()` blocks with descriptive names, `after()` for cleanup.
- `src/resources/extensions/gsd/tests/resolve-ts.mjs` + `resolve-ts-hooks.mjs` — ESM resolver for `.js→.ts` rewrite. **Does NOT work** for browser-tools imports because `core.js` has no `.ts` counterpart and the fallback fails in Node 22. Don't use it — use jiti instead.
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — EVALUATE_HELPERS_SOURCE is a self-contained IIFE string. Parseable via `new Function()` for syntax validation. Contains all 9 `window.__pi` functions.
- `src/resources/extensions/browser-tools/tools/intent.ts` — `buildIntentScoringScript()` is module-private (not exported). Returns an IIFE string for `page.evaluate()`. Test by evaluating it in Playwright against HTML fixtures, not by importing the function.
- `src/resources/extensions/browser-tools/tools/forms.ts` — `buildFormAnalysisScript()` and `buildPostFillValidationScript()` are module-private. Same approach — test via Playwright.
- `src/resources/extensions/browser-tools/capture.ts` — `constrainScreenshot` takes `(Page, Buffer, mimeType, quality)` where Page is unused (`_page`). Testable by passing `null` cast as Page with synthetic sharp buffers.

## Constraints

- **core.js blocks resolve-ts hook** — The existing ESM resolve hook rewrites `./core.js` → `./core.ts` which doesn't exist. The jiti loader handles this correctly. Unit tests must use jiti for imports (`.cjs` file), not the resolve-ts ESM hook.
- **Intent/form scoring functions are module-private** — `buildIntentScoringScript` and `buildFormAnalysisScript` are not exported. Options: (a) export them for direct testing, or (b) test via Playwright end-to-end. Playwright approach is preferred — tests the actual evaluate codepath.
- **Playwright tests need Chromium** — Integration tests require `npx playwright install chromium` to have been run. CI/CD consideration, but locally it's already installed for browser-tools development.
- **jiti is a CJS loader** — Tests using jiti must be `.cjs` files, not `.ts`. The `node:test` API works fine from CJS. Integration tests using Playwright's ESM API should be `.mjs`.
- **`constrainScreenshot` takes a Page parameter** — The `_page` parameter is unused (D008) but required by the type signature. Pass `null` with a type cast in tests.
- **No existing browser-tools test infrastructure** — No test directory, no test script glob. Need to create both.

## Common Pitfalls

- **Importing utils.ts via ESM resolver** — The `.js→.ts` fallback silently fails for `core.js`, but throws for `core.ts` not found. Use jiti (`.cjs`) for any import that transits through the browser-tools module graph.
- **Testing evaluate scripts in Node without DOM** — The intent/form scoring scripts use `document.querySelector`, `getBoundingClientRect`, `window.getComputedStyle`, etc. They cannot run in Node. Must use Playwright's `page.evaluate()` against real HTML.
- **sharp buffer format detection** — sharp infers format from buffer headers. When creating test fixtures with `sharp({ create: ... })`, must explicitly call `.jpeg()` or `.png()` before `.toBuffer()` — sharp defaults to raw pixel data without a format.
- **Accessor pattern testing** — State accessors use module-level variables behind jiti's CJS shim. Need to test that `setX(value); getX()` returns the value, and `resetAllState()` clears everything. Watch for test isolation — state is shared across test cases in the same process.

## Open Risks

- **Playwright test flakiness** — Browser-based tests can be flaky due to timing. Mitigate by using `data:text/html,...` URLs or `page.setContent()` (no network), generous timeouts, and deterministic DOM fixtures.
- **Test execution time** — Playwright tests with Chromium launch add 2-5s overhead. Keep the integration test file to ~20-30 test cases max. Unit tests via jiti are fast (~200ms).
- **Intent scoring edge cases** — The scoring heuristics use `getBoundingClientRect` for size-based scoring (primary_cta) and position detection (close_dialog top-right). In headless Chromium with default viewport, element sizes may differ from real browsing. Set explicit viewport dimensions in test setup.
- **State leakage between tests** — jiti loads modules once and caches them. State module variables persist across test() blocks. Must call `resetAllState()` in `beforeEach` or `after()` cleanup.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Playwright | bobmatnyc/claude-mpm-skills@playwright-e2e-testing | available (1.2K installs, but not needed — internal testing, not general e2e) |
| Node test runner | shino369/claude-code-personal-workspace@javascript-testing | available (11 installs, low value) |

No skills recommended for installation — this is straightforward testing work with well-understood tools.

## Sources

- Verified jiti import path via manual testing (`/tmp/test-jiti*.cjs` experiments) — all browser-tools modules load correctly via `@mariozechner/jiti`
- Verified resolve-ts hook failure with core.js — `ERR_MODULE_NOT_FOUND: Cannot find module 'core.ts'` when importing through browser-tools module graph
- Verified sharp synthetic buffer creation — `sharp({ create: { width: 2000, height: 2000, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg({ quality: 80 }).toBuffer()` produces valid JPEG
- Verified EVALUATE_HELPERS_SOURCE is parseable via `new Function()` and contains all 9 expected function assignments
- S04/S05 verification approach: Playwright test scripts against real HTML fixtures (from T01-SUMMARY files)
