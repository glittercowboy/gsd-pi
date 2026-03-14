---
estimated_steps: 8
estimated_files: 1
---

# T02: Create production-like scenario tests

**Slice:** S02 — Production-Like Scenario Testing
**Milestone:** M002

## Description

Create `model-registry-scenario.test.ts` with six integration test suites covering the real ModelRegistry startup path: fresh install, cache hit, stale cache, version mismatch, offline fallback, and override application. Each test uses temporary directory isolation via `tmpdir()` + `mkdtempSync()` and the new cachePath parameter from T01.

## Steps

1. Create test file with imports: `node:test` utilities, `node:assert`, `node:os` tmpdir, `node:path` join, `node:fs` operations, ModelRegistry, AuthStorage, cache helpers from `@gsd/pi-ai`
2. Set up test scaffolding: `before()` hook creates temp dir with mkdtempSync, `after()` hook cleans up with rmSync recursive
3. Implement fresh install scenario: empty temp dir, verify registry falls back to snapshot or static MODELS (getAll() returns non-empty array)
4. Implement cache hit scenario: write valid cache with current version and fresh fetchedAt, verify registry uses cached data (model IDs match cache)
5. Implement stale cache scenario: write cache with fetchedAt > 12h ago, verify registry handles gracefully (still returns models)
6. Implement version mismatch scenario: write cache with old version string, verify registry handles version change (returns models)
7. Implement offline fallback scenario: write stale cache, use invalid models.dev URL or network failure simulation, verify stale cache still used
8. Implement override application scenario: write cache AND models.json with provider-level/per-model overrides, verify overrides applied (check specific model properties)

## Must-Haves

- [ ] Test file uses `tmpdir()` + `mkdtempSync()` for all filesystem operations (no homedir() usage)
- [ ] Fresh install test proves fallback to snapshot/static works
- [ ] Cache hit test proves cached data is used when valid
- [ ] Stale cache test proves graceful handling of expired TTL
- [ ] Version mismatch test proves version-triggered refresh handling
- [ ] Offline fallback test proves stale cache used when network unavailable
- [ ] Override test proves models.json overrides applied to all scenarios
- [ ] All tests use 500ms delay for async refresh with explanatory comments
- [ ] Import specifiers use `.js` extension (D017 compliance)

## Verification

- `npm test -w @gsd/pi-coding-agent` — All six scenario tests pass
- `grep -r "homedir()" packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` — Returns no matches (proves tmpdir usage)
- Run tests 3 times in succession — All passes, no flakiness from async timing
- Test output shows TAP format with 6 new passing tests

## Observability Impact

- Signals added/changed: Test names and assertion messages clearly identify which scenario and what expectation failed
- How a future agent inspects this: Run test file directly with node test runner, check temp dir contents during debugging
- Failure state exposed: Assertion failures show expected vs actual model data, cache state, or override application results

## Inputs

- `packages/pi-coding-agent/src/core/model-registry.ts` — Modified with cachePath parameter (from T01)
- `packages/pi-ai/src/models-dev.ts` — Cache helper functions accepting custom paths
- `packages/pi-ai/src/models-dev.test.ts` — Pattern for tmpdir() + mkdtempSync() usage
- `packages/pi-coding-agent/src/core/model-registry.test.ts` — SAMPLE_MODELS_DEV_DATA fixture pattern

## Expected Output

- `packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` — New test file with six passing scenario tests
