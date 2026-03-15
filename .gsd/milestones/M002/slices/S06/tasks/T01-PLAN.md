---
estimated_steps: 5
estimated_files: 3
---

# T01: Unit tests for Node-side pure functions, state accessors, and constrainScreenshot

**Slice:** S06 — Test coverage
**Milestone:** M002

## Description

Create the browser-tools test infrastructure and write unit tests for all pure Node-side functions. Uses jiti for TypeScript imports (the resolve-ts ESM hook breaks on core.js), `node:test` for the runner, and `node:assert/strict` for assertions. Tests constrainScreenshot with synthetic sharp buffers — it's a pure buffer-in/buffer-out function since S03 removed the page dependency.

## Steps

1. Create `src/resources/extensions/browser-tools/tests/` directory and the `.cjs` test file with jiti-based imports of utils.ts, state.ts, evaluate-helpers.ts, and capture.ts.
2. Write tests for pure utility functions from utils.ts: parseRef (valid ref, invalid ref, legacy format), formatVersionedRef, staleRefGuidance, formatCompactStateSummary (with mock CompactPageState), verificationFromChecks (pass/fail cases), verificationLine, sanitizeArtifactName (valid, empty, special chars), isCriticalResourceType (document/stylesheet/script vs image/font), getUrlHash, firstErrorLine (Error, string, unknown), formatArtifactTimestamp.
3. Write tests for EVALUATE_HELPERS_SOURCE: parseable via `new Function(source)`, contains all 9 expected function assignment strings (cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, domPath, selectorHints).
4. Write tests for state accessor round-trips (setBrowser/getBrowser, setContext/getContext, setActiveFrame/getActiveFrame, setSessionStartedAt/getSessionStartedAt, setSessionArtifactDir/getSessionArtifactDir, setCurrentRefMap/getCurrentRefMap, setRefVersion/getRefVersion, setRefMetadata/getRefMetadata, setLastActionBeforeState/getLastActionBeforeState, setLastActionAfterState/getLastActionAfterState) and resetAllState clearing all of them.
5. Write tests for constrainScreenshot: create synthetic JPEG buffer (800×600) via sharp — should pass through unchanged. Create oversized JPEG buffer (3000×2000) — should resize within 1568px. Create oversized PNG buffer — should resize and return PNG. Add `test:browser-tools` script to package.json: `node --test src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs`.

## Must-Haves

- [ ] jiti imports work for all browser-tools modules
- [ ] All pure utility function tests pass
- [ ] EVALUATE_HELPERS_SOURCE syntax validation passes
- [ ] State accessor round-trip tests pass
- [ ] resetAllState clears all state
- [ ] constrainScreenshot passthrough for small images
- [ ] constrainScreenshot resizes oversized JPEG
- [ ] constrainScreenshot resizes oversized PNG
- [ ] `test:browser-tools` script added to package.json

## Verification

- `npm run test:browser-tools` exits 0
- Test output shows all test cases passing

## Inputs

- `src/resources/extensions/browser-tools/utils.ts` — pure functions to test
- `src/resources/extensions/browser-tools/state.ts` — accessor pairs and resetAllState
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — EVALUATE_HELPERS_SOURCE constant
- `src/resources/extensions/browser-tools/capture.ts` — constrainScreenshot function
- S01 summary — accessor pattern details, jiti compatibility requirement
- S03 summary — constrainScreenshot is now pure buffer-in/buffer-out with unused `_page` param

## Expected Output

- `src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs` — complete unit test file with 30+ test cases
- `package.json` — `test:browser-tools` script added
