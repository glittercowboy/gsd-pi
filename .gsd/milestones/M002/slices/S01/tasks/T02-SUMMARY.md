---
id: T02
parent: S01
milestone: M002
provides:
  - Test script configured in @gsd/pi-ai/package.json
  - Verified build/test workflow with npm run build && npm test
  - All 31 tests pass across 10 test suites
key_files:
  - packages/pi-ai/package.json
key_decisions:
  - Use ../../src/resources/ path for custom ESM resolver (relative to packages/pi-ai/)
patterns_established:
  - Test script uses Node's built-in test runner with --import for custom ESM resolver
  - Test command: node --import ../../src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/**/*.test.ts
observability_surfaces:
  - TAP format test output with per-test pass/fail
  - Non-zero exit code on test failure for CI/CD gating
  - Failed tests include stack traces in stderr
duration: 10m
verification_result: passed
completed_at: 2026-03-14T17:23:00-05:00
blocker_discovered: false
---

# T02: Add test script and verify workflow

**Test script added to @gsd/pi-ai/package.json enabling `npm run build && npm test` workflow with all 31 tests passing.**

## What Happened

Added the `test` script to `packages/pi-ai/package.json` using Node's built-in test runner with the custom ESM resolver. Initial path `../src/resources/...` was incorrect—resolved to `packages/src/...` from the package directory. Fixed to `../../src/resources/...` which correctly resolves to the project root.

Ran verification:
- `npm test -w @gsd/pi-ai` - all 31 tests pass across 10 suites
- `npm run build -w @gsd/pi-ai && npm test -w @gsd/pi-ai` - full workflow succeeds
- Confirmed compiled test files exist: `dist/models-dev.test.js` and `dist/models-dev-mapper.test.js`
- Verified no `.ts` imports remain in test files

## Verification

```bash
# Full workflow succeeds
npm run build -w @gsd/pi-ai && npm test -w @gsd/pi-ai

# Test output: 31 tests, 10 suites, 0 failures
npm test -w @gsd/pi-ai

# Compiled test files present
ls packages/pi-ai/dist/*.test.js
# Output: models-dev-mapper.test.js, models-dev.test.js

# No .ts imports in test files
grep -E "from ['\"].*\.ts['\"]" packages/pi-ai/src/*.test.ts && exit 1 || echo "No .ts imports found"
```

## Diagnostics

- Test execution outputs TAP format with pass/fail per test
- Failed tests show assertion error with stack trace in stderr
- Exit code 1 on failure enables CI/CD gating
- Diagnostic inspection: `npm test -w @gsd/pi-ai 2>&1 | grep -E '(pass|fail|Error)'`

## Deviations

- Path correction: task plan specified `../src/resources/...` but actual path from `packages/pi-ai/` requires `../../src/resources/...`

## Known Issues

None.

## Files Created/Modified

- `packages/pi-ai/package.json` — Added `test` script with custom ESM resolver
