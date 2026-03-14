# S02: Production-Like Scenario Testing

**Goal:** Add production-like integration tests that exercise the real ModelRegistry startup path using temporary directories instead of mutating `~/.gsd/agent/`.

**Demo:** All scenario tests pass reliably with temporary directory isolation, covering fresh install, cache hit, stale cache, version change, offline fallback, and override scenarios.

## Must-Haves

- Fresh install scenario — No cache file exists; verifies snapshot/static fallback
- Cache hit scenario — Valid cache with current version and fresh TTL; verifies cached data used
- Stale cache scenario — Cache exists but TTL expired; verifies graceful handling
- Version mismatch scenario — Cache exists but version changed; verifies refresh logic
- Offline fallback scenario — No network + stale cache; verifies stale cache still used
- Override application scenario — models.json with provider/per-model overrides; verifies overrides applied correctly

## Proof Level

- This slice proves: integration
- Real runtime required: yes
- Human/UAT required: no

## Verification

- `npm test -w @gsd/pi-ai` — All existing registry-path tests pass
- `npm test -w @gsd/pi-coding-agent` — New scenario tests pass with temporary directory isolation
- Manual inspection: `grep -r "homedir()" packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` returns no matches (proves tmpdir usage)

## Observability / Diagnostics

- Runtime signals: Test output shows which scenario passed/failed; TAP format provides per-test results
- Inspection surfaces: Test file includes descriptive `it()` messages explaining each scenario's setup and expectation
- Failure visibility: Assertion failures include expected vs actual values; test names identify which scenario failed
- Redaction constraints: None — tests use sample data only

## Integration Closure

- Upstream surfaces consumed: `ModelRegistry` constructor, `getCachedModelsDev()`, `writeCache()`, `mapToModelRegistry()`, `SNAPSHOT` from `@gsd/pi-ai`
- New wiring introduced in this slice: Optional `cachePath` parameter in `ModelRegistry` constructor enabling path injection
- What remains before the milestone is truly usable end-to-end: S03 (live models.dev verification)

## Tasks

- [x] **T01: Add cache path injection to ModelRegistry** `est:30m`
  - Why: ModelRegistry currently hardcodes cache path via `getAgentDir()`, preventing isolated testing. Adding an optional cachePath parameter enables production-like scenario tests with temporary directories.
  - Files: `packages/pi-coding-agent/src/core/model-registry.ts`
  - Do: Add optional `cachePath?: string` parameter to ModelRegistry constructor (third parameter, after modelsJsonPath). Store as private field. Pass to `getCachedModelsDev(cachePath)` in `loadBuiltInModels()` instead of using default path. Maintain backward compatibility — undefined cachePath uses current behavior.
  - Verify: `npm run build -w @gsd/pi-ai && npm run build -w @gsd/pi-coding-agent` succeed with no TypeScript errors. Existing `model-registry.test.ts` continues to pass (uses default paths).
  - Done when: TypeScript compiles successfully, all existing tests pass, and `getCachedModelsDev(cachePath)` is called with the injected path when provided.

- [x] **T02: Create production-like scenario test suite** `est:1h30m`
  - Why: Exercise the real ModelRegistry startup path across six lifecycle scenarios using temporary directories to prevent test pollution and prove production behavior.
  - Files: `packages/pi-coding-agent/src/core/model-registry-scenario.test.ts`
  - Do: Create new test file using `node:test` with `tmpdir()` + `mkdtempSync()` pattern. Implement six test suites:
    1. **Fresh install** — Empty temp directory, verify registry falls back to snapshot/static MODELS
    2. **Cache hit** — Write valid cache with current version and fresh TTL, verify registry uses cached data
    3. **Stale cache** — Write cache with expired TTL (fetchedAt > 12h ago), verify graceful handling
    4. **Version mismatch** — Write cache with old version, verify registry handles version change
    5. **Offline fallback** — Write stale cache, simulate network failure (cache still used despite staleness)
    6. **Override application** — Write cache AND models.json with overrides, verify overrides applied to all models
    Each test: setup temp dir → write cache/models.json as needed → instantiate ModelRegistry with custom paths → assert expected behavior → cleanup in `after()` hook. Use 500ms delay after instantiation for async refresh to settle (fire-and-forget pattern).
  - Verify: `npm test -w @gsd/pi-coding-agent` runs new scenario tests. All six scenarios pass. No test writes to `~/.gsd/agent/` (verify with `grep -r "homedir()" model-registry-scenario.test.ts` returning no matches).
  - Done when: All six scenario tests pass reliably with temporary directory isolation, and running tests multiple times produces consistent results (no flakiness from async timing).

## Files Likely Touched

- `packages/pi-coding-agent/src/core/model-registry.ts` — Add cachePath parameter
- `packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` — New scenario test file
