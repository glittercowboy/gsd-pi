# S06: Test coverage — UAT

**Milestone:** M002
**Written:** 2026-03-12

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: This slice produces only test files and a npm script. Verification is running the tests — no runtime behavior, UI, or human-experience aspects to check.

## Preconditions

- Node.js and npm available
- Project dependencies installed (`npm install`)
- Chromium available for Playwright (integration tests launch a browser)

## Smoke Test

Run `npm run test:browser-tools` — should exit 0 with 108 passing tests.

## Test Cases

### 1. Unit tests pass

1. Run `npm run test:browser-tools`
2. **Expected:** 63 unit tests pass (15 suites) covering parseRef, formatVersionedRef, staleRefGuidance, formatCompactStateSummary, verificationFromChecks, verificationLine, sanitizeArtifactName, isCriticalResourceType, getUrlHash, firstErrorLine, formatArtifactTimestamp, EVALUATE_HELPERS_SOURCE validation, state accessors, resetAllState, and constrainScreenshot

### 2. Integration tests pass

1. Run `npm run test:browser-tools`
2. **Expected:** 45 integration tests pass (3 suites) covering window.__pi utilities (26 tests), intent scoring (7 tests), and form analysis (12 tests) — all exercised against real Chromium DOM

### 3. Test script exists and is isolated

1. Run `npm run test:browser-tools`
2. Run `npm test`
3. **Expected:** Both scripts execute independently. `test:browser-tools` runs only browser-tools tests, not the full project test suite.

## Edge Cases

### No Chromium installed

1. Remove Playwright browsers
2. Run `npm run test:browser-tools`
3. **Expected:** Unit tests still pass. Integration tests fail with a clear Playwright browser-not-found error.

## Failure Signals

- `npm run test:browser-tools` exits non-zero
- Any test shows `not ok` in TAP output
- Integration tests hang (Chromium launch failure)

## Requirements Proved By This UAT

- R026 — Test suite covers shared utilities, heuristics, and new tools; verified by test runner passing

## Not Proven By This UAT

- End-to-end action pipeline latency improvements (R017, R018, R019) — verified by spot-check in S02
- Full 47-tool registration and execution (R015) — verified by spot-check in S01
- Real-world form filling and intent resolution (R022–R025) — verified by Playwright scripts in S04/S05

## Notes for Tester

This is a pure test-infrastructure slice. If `npm run test:browser-tools` passes, the slice is verified. No browser UI or manual testing needed.
