# S04: Runtime Error Capture — UAT

**Milestone:** M001
**Written:** 2026-03-17

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All behavior is verified through unit tests with mocked bg-shell/browser-tools singletons. No live runtime, server, or browser session needed — the capture function's inputs and outputs are fully testable via dependency injection.

## Preconditions

- Repository cloned and dependencies installed (`npm install`)
- Node ≥ 20.6 available
- No dev server or browser session required — tests use injected mocks

## Smoke Test

Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"` — should show 14 passing tests covering all severity classes.

## Test Cases

### 1. Crashed bg-shell process blocks gate

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"` 
2. Verify the test "classifies crashed bg-shell process as blocking crash" passes
3. Inspect `src/resources/extensions/gsd/tests/verification-gate.test.ts` — the test injects a process with `status: 'crashed'` and asserts `blocking: true`, `severity: 'crash'`, `source: 'bg-shell'`
4. **Expected:** Test passes. A crashed bg-shell process produces a blocking RuntimeError.

### 2. Non-zero exit on dead process blocks gate

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"`
2. Verify the test "classifies non-zero exit on dead process as blocking crash" passes
3. **Expected:** A dead process with `exitCode !== 0` produces a blocking RuntimeError with severity `crash`.

### 3. Browser unhandled rejection blocks gate

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"`
2. Verify the test "classifies browser unhandled rejection as blocking crash" passes
3. The test injects a console log with `type: 'error'` and text containing "Unhandled" or "unhandledrejection"
4. **Expected:** Browser unhandled rejection produces a blocking RuntimeError with `source: 'browser'`, `severity: 'crash'`.

### 4. Browser console.error does NOT block gate

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"`
2. Verify the test "classifies browser console.error as non-blocking error" passes
3. **Expected:** A regular console.error produces a RuntimeError with `blocking: false`, `severity: 'error'`.

### 5. Browser deprecation warning does NOT block gate

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"`
2. Verify the test "classifies browser deprecation warning as non-blocking warning" passes
3. **Expected:** A console warning containing "deprecat" produces a RuntimeError with `blocking: false`, `severity: 'warning'`.

### 6. Graceful degradation when bg-shell unavailable

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"`
2. Verify the test "gracefully returns empty when bg-shell import fails" passes
3. **Expected:** When dynamic import of bg-shell throws, `captureRuntimeErrors()` returns `[]` without throwing.

### 7. Graceful degradation when browser-tools unavailable

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"`
2. Verify the test "gracefully returns empty when browser-tools import fails" passes
3. **Expected:** When dynamic import of browser-tools throws, `captureRuntimeErrors()` returns `[]` without throwing.

### 8. Runtime errors appear in T##-VERIFY.json

1. Run `npm run test:unit -- --test-name-pattern "verification-evidence"`
2. Verify the test "includes runtimeErrors in JSON when present" passes
3. **Expected:** `writeVerificationJSON` includes `runtimeErrors` array in the JSON output when runtime errors exist in the result.

### 9. Runtime errors omitted from JSON when absent

1. Run `npm run test:unit -- --test-name-pattern "verification-evidence"`
2. Verify the test "omits runtimeErrors from JSON when absent" passes
3. **Expected:** JSON output has no `runtimeErrors` key when the result has no runtime errors.

### 10. Runtime errors render in markdown evidence table

1. Run `npm run test:unit -- --test-name-pattern "verification-evidence"`
2. Verify the test "appends Runtime Errors section to markdown table" passes
3. **Expected:** Markdown output contains "## Runtime Errors" section with Source | Severity | Blocking | Message columns.

### 11. Gate integration in auto.ts

1. Run `grep -n "captureRuntimeErrors" src/resources/extensions/gsd/auto.ts`
2. **Expected:** Shows exactly 2 lines: 1 import (line ~23) and 1 call site (line ~1530).
3. Run `grep -n "result.passed = false" src/resources/extensions/gsd/auto.ts`
4. **Expected:** Shows the blocking runtime error override alongside the existing verification failure line.

### 12. No test regressions

1. Run `npm run test:unit`
2. **Expected:** 1088 pass, 8 fail (all 8 are pre-existing chokidar/octokit failures, none from this slice).

## Edge Cases

### Browser console text truncation

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"`
2. Verify the test "truncates browser console text to 500 chars" passes
3. **Expected:** Console text longer than 500 chars is truncated to 500 chars with "..." appended.

### Mixed bg-shell and browser errors

1. Run `npm run test:unit -- --test-name-pattern "captureRuntimeErrors"`
2. Verify the test covering mixed sources passes — both bg-shell crashes and browser errors in the same capture call
3. **Expected:** Returns RuntimeError entries from both sources in a single array.

### Markdown message truncation

1. Run `npm run test:unit -- --test-name-pattern "verification-evidence"`
2. Verify the test "truncates messages to 100 chars in markdown table" passes
3. **Expected:** Messages longer than 100 chars are truncated in the markdown table but preserved in full in JSON.

## Failure Signals

- Any "captureRuntimeErrors" test failing indicates a regression in severity classification
- Missing `runtimeErrors` import in auto.ts would mean runtime errors are silently skipped
- If `npm run test:unit` shows more than 8 failures, this slice introduced regressions
- If `grep captureRuntimeErrors auto.ts` returns fewer than 2 lines, the integration is broken

## Requirements Proved By This UAT

- R006 — Tests prove bg-shell process scanning (4 severity classes) and browser console scanning (3 severity classes) with graceful degradation
- R007 — Tests prove severity classification per D004: crashes/unhandled rejections block, console.error/deprecation log without blocking

## Not Proven By This UAT

- Live runtime behavior — tests use mocked bg-shell/browser-tools, not actual crashed processes or browser sessions
- Evidence file appearance on disk during real auto-mode execution — would require end-to-end auto-mode test
- Interaction with auto-fix retry loop (S03) when runtime errors cause gate failure — the retry behavior is tested in S03, not here

## Notes for Tester

- The 8 pre-existing test failures (chokidar, octokit) are unrelated to this slice — they're missing optional packages in the test environment
- All runtime error tests use dependency injection (`getProcesses`, `getConsoleLogs` overrides) rather than actual module imports — this is intentional and the recommended testing pattern
- The `captureRuntimeErrors()` function returns an empty array (not an error) when extensions are unavailable — this is correct graceful degradation behavior, not a bug
