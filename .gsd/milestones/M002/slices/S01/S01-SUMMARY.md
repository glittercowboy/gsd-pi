---
id: S01
parent: M002
milestone: M002
provides:
  - Working TypeScript build with Node16-compatible .js import specifiers
  - Fixed nullability type error in models-dev.ts cache access
  - Test script configured for @gsd/pi-ai enabling standard npm test workflow
  - All 31 registry-path tests passing through standard test runner
requires: []
affects:
  - S02
  - S03
key_files:
  - packages/pi-ai/src/models-dev.test.ts
  - packages/pi-ai/src/models-dev-mapper.test.ts
  - packages/pi-ai/src/models-dev.ts
  - packages/pi-ai/package.json
key_decisions:
  - D017: Use .js extension in import specifiers for Node16 module resolution
patterns_established:
  - Test imports use .js specifiers; custom ESM resolver rewrites at runtime
  - Test command: node --import ../../src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/**/*.test.ts
  - Non-null assertion after type guard when TypeScript cannot narrow custom guard return types
observability_surfaces:
  - TypeScript errors in stderr indicate import path or type issues
  - TAP format test output with per-test pass/fail and stack traces on failure
  - Non-zero exit code on test failure for CI/CD gating
drill_down_paths:
  - .gsd/milestones/M002/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S01/tasks/T02-SUMMARY.md
duration: 25m
verification_result: passed
completed_at: 2026-03-14T17:30:00-05:00
---

# S01: Build/Test Infrastructure Repair

**Repaired TypeScript build and test infrastructure enabling `npm run build && npm test` workflow with all 31 registry-path tests passing.**

## What Happened

Two focused tasks resolved the blocking build and test failures:

1. **Import extensions fixed:** Converted all `.ts` imports to `.js` specifiers in test files (4 imports across 2 files) to comply with Node16 module resolution requirements. The custom ESM resolver rewrites these at runtime.

2. **Nullability bug fixed:** Line 179 of `models-dev.ts` accessed `cache.data` after `isCacheValid()` check, but TypeScript doesn't narrow types through custom type guard functions. Added non-null assertion (`cache!.data`) with explanatory comment.

3. **Test script added:** Configured `test` script in `@gsd/pi-ai/package.json` using Node's built-in test runner with the project's custom ESM resolver. Initial path was incorrect (`../src/resources/...`)—corrected to `../../src/resources/...` which properly resolves from `packages/pi-ai/`.

## Verification

```bash
# Build succeeds with no TypeScript errors
npm run build -w @gsd/pi-ai

# All 31 tests pass across 10 suites
npm test -w @gsd/pi-ai
# Output: tests 31, suites 10, pass 31, fail 0

# No .ts imports remain in test files
grep -E "from ['\"].*\.ts['\"]" packages/pi-ai/src/*.test.ts && exit 1 || echo "PASS"

# Compiled test files present
ls packages/pi-ai/dist/*.test.js
# Output: models-dev-mapper.test.js, models-dev.test.js
```

## Requirements Advanced

- R007 — Registry path build/test workflow must be trustworthy — Build and test now succeed through standard npm scripts

## Requirements Validated

- R007 — `npm run build -w @gsd/pi-ai` exits 0, `npm test -w @gsd/pi-ai` exits 0 with all 31 tests passing

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

- Path correction: Task T02 plan specified `../src/resources/...` for ESM resolver path, but actual path from `packages/pi-ai/` requires `../../src/resources/...`

## Known Limitations

- Test isolation not yet implemented—tests still use `~/.gsd/agent/` for cache (S02 will address with tmpdir)
- No live models.dev verification in main suite yet (S03)

## Follow-ups

- S02: Production-like scenario testing with temporary directory isolation
- S03: Live models.dev verification test

## Files Created/Modified

- `packages/pi-ai/src/models-dev.test.ts` — Changed import extensions from .ts to .js
- `packages/pi-ai/src/models-dev-mapper.test.ts` — Changed import extensions from .ts to .js
- `packages/pi-ai/src/models-dev.ts` — Added non-null assertion at line 179
- `packages/pi-ai/package.json` — Added test script with custom ESM resolver

## Forward Intelligence

### What the next slice should know
- Build/test infrastructure is now stable—S02 and S03 can proceed with confidence
- Test command pattern established: `node --import ../../src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/**/*.test.ts`
- All 31 existing tests are contract-level unit tests; S02 will add integration tests

### What's fragile
- Path to ESM resolver is relative—depends on `packages/pi-ai/` location within monorepo structure

### Authoritative diagnostics
- `npm run build -w @gsd/pi-ai 2>&1` — TypeScript errors surface here
- `npm test -w @gsd/pi-ai 2>&1` — TAP output with per-test results

### What assumptions changed
- None—executed as planned with minor path correction
