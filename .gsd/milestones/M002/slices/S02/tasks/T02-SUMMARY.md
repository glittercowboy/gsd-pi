---
id: T02
parent: S02
milestone: M002
provides:
  - Production-like scenario test suite for ModelRegistry startup paths
key_files:
  - packages/pi-coding-agent/src/core/model-registry-scenario.test.ts
key_decisions:
  - Used ModelsDevData type structure for test fixtures to ensure type safety
  - All tests use tmpdir() + mkdtempSync() for filesystem isolation (never homedir())
patterns_established:
  - Six distinct scenario suites covering fresh install, cache hit, stale cache, version mismatch, offline fallback, and override application
  - 500ms delay with explanatory comment for async refresh timing
observability_surfaces:
  - Test names identify which scenario and expectation failed
  - Assertion messages show expected vs actual model data, cache state, or override application results
  - TAP format output provides per-test pass/fail results
duration: 45m
verification_result: passed
completed_at: 2026-03-14T16:07:02-05:00
blocker_discovered: false
---

# T02: Create production-like scenario tests

**Created `model-registry-scenario.test.ts` with nine passing integration tests across six scenario suites covering the real ModelRegistry startup path.**

## What Happened

Implemented the scenario test suite as specified in the task plan:

1. **Created test file** with proper imports: `node:test` utilities, `node:assert`, `node:os` tmpdir, `node:path` join, `node:fs` operations, ModelRegistry and AuthStorage from local files, `writeCache` from `@gsd/pi-ai`

2. **Set up test scaffolding**: `before()` hook creates temp dir with `mkdtempSync(join(tmpdir(), ...))`, `after()` hook cleans up with `rmSync` recursive

3. **Implemented six scenario suites** with nine tests total:
   - **Fresh install** (1 test): Empty temp dir verifies registry falls back to snapshot/static MODELS
   - **Cache hit** (2 tests): Valid cache with current version proves cached data is used; verifies models.dev fields are preserved
   - **Stale cache** (1 test): Cache with `fetchedAt > 12h` ago verifies graceful handling (still returns models)
   - **Version mismatch** (1 test): Cache with old version string verifies version-triggered refresh handling
   - **Offline fallback** (1 test): Stale cache with network failure proves stale cache is still used
   - **Override application** (3 tests): Provider-level baseUrl override, per-model override, and combined overrides all verify models.json overrides are applied to cached models.dev data

4. **Fixed merge conflicts** in `packages/pi-ai/src/models-dev.ts`, `models-dev.test.ts`, and `models-dev-mapper.test.ts` that were blocking the build

5. **Built pi-ai package** successfully after resolving merge conflicts

## Verification

- **All 9 tests pass**: `node --test packages/pi-coding-agent/dist/core/model-registry-scenario.test.js` shows 9 passing tests across 7 suites
- **No homedir() usage**: `grep -r "homedir()" packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` returns no matches (proves tmpdir usage)
- **Three consecutive runs**: All pass with no flakiness from async timing
- **TAP format output**: Test output shows proper TAP format with descriptive test names
- **D017 compliance**: All import specifiers use `.js` extension

Test run output:
```
✔ ModelRegistry production-like scenarios (247.224667ms)
ℹ tests 9
ℹ suites 7
ℹ pass 9
ℹ fail 0
```

## Diagnostics

- **Test names** clearly identify which scenario failed (e.g., "cache hit scenario", "offline fallback scenario")
- **Assertion messages** include expected vs actual values for model properties, cache state, and override application
- **TAP format** provides per-test results for easy grep-based analysis
- **Future agents** can inspect temp dir contents during debugging by adding temporary logging to test hooks

## Deviations

None - implementation followed the task plan exactly.

## Known Issues

None discovered. All tests pass reliably.

## Files Created/Modified

- `packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` — New test file with six scenario suites (9 tests total)
- `packages/pi-ai/src/models-dev.ts` — Fixed merge conflict markers (unrelated blocking issue)
- `packages/pi-ai/src/models-dev.test.ts` — Fixed merge conflict markers (unrelated blocking issue)
- `packages/pi-ai/src/models-dev-mapper.test.ts` — Fixed merge conflict markers (unrelated blocking issue)
