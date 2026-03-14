# S02: Production-Like Scenario Testing — Research

**Date:** 2026-03-14

## Summary

S02 must add production-like integration tests that exercise the real `ModelRegistry` startup path using temporary directories instead of mutating `~/.gsd/agent/`. The current test suite has three critical gaps: (1) **test pollution** — tests use `homedir()` which modifies the user's actual cache and config files; (2) **incomplete scenario coverage** — missing tests for stale cache, version-mismatch, and offline fallback scenarios; (3) **fragile async timing** — uses `setTimeout(100)` delays instead of deterministic synchronization.

The recommendation is to create a new test file `packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` that uses Node.js `tmpdir()` + `mkdtempSync()` for isolated test environments, covering six lifecycle scenarios: fresh install (no cache), cache hit (valid cache), stale cache (TTL expired), version mismatch (old version triggers refresh), offline fallback (network failure with stale cache), and models.json override application. Each test should set up a controlled filesystem state in a temporary directory, instantiate `ModelRegistry` with a custom `modelsJsonPath`, and verify the correct behavior.

For async refresh synchronization, tests should either: (a) await a small delay (500ms instead of 100ms) with clear comments, or (b) add a test hook that exposes a promise-based completion signal. Given the fire-and-forget nature of `refreshFromModelsDev()`, option (a) is simpler and matches the existing pattern.

## Recommendation

Create `model-registry-scenario.test.ts` with six test suites, each using temporary directory isolation:

1. **Fresh install scenario** — No cache file exists; verifies snapshot fallback or static MODELS
2. **Cache hit scenario** — Valid cache with current version and fresh TTL; verifies cached data used
3. **Stale cache scenario** — Cache exists but TTL expired; verifies graceful handling
4. **Version mismatch scenario** — Cache exists but version changed; verifies refresh triggered
5. **Offline fallback scenario** — No network + stale cache; verifies stale cache still used
6. **Override application scenario** — models.json with provider/per-model overrides; verifies overrides applied correctly across all scenarios

Key implementation pattern:
```typescript
let tempDir: string;
let cachePath: string;
let modelsJsonPath: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "model-registry-test-"));
  cachePath = join(tempDir, "cache", "models-dev.json");
  modelsJsonPath = join(tempDir, "models.json");
});

after(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("scenario name", () => {
  // Set up filesystem state
  writeCacheFile(cachePath, {...});
  writeFileSync(modelsJsonPath, JSON.stringify({...}));
  
  // Instantiate registry with custom paths
  const registry = new ModelRegistry(auth, modelsJsonPath);
  
  // Verify behavior
  const models = registry.getAll();
  assert.ok(...);
});
```

Tests should use the existing `getCachedModelsDev()`, `writeCache()`, and `mapToModelRegistry()` helpers from `@gsd/pi-ai` where possible, but set up filesystem state directly rather than relying on those functions' default paths.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Temporary directory management | Node.js `tmpdir()` + `mkdtempSync()` | Already used in `models-dev.test.ts`; provides clean isolation without manual cleanup |
| Cache file path resolution | Direct path construction with `join(tempDir, "cache", "models-dev.json")` | Tests control the exact filesystem layout; avoids `getDefaultCachePath()` complexity |
| models.json override application | Existing `applyModelOverride()` and `applyOverridesToModels()` helpers in `model-registry.ts` | Deep-merges nested objects (cost, compat) correctly; already tested |
| Sample test data | `SAMPLE_MODELS_DEV_DATA` from existing `model-registry.test.ts` | Reuse known-good fixtures; ensures consistency |
| Async refresh timing | `await new Promise(resolve => setTimeout(resolve, 500))` with explanatory comment | Matches existing pattern; 500ms is more reliable than 100ms for network calls |
| Zod schema validation | Existing `ModelsDevData` schema in `models-dev-types.ts` | Single source of truth for models.dev API structure |

## Existing Code and Patterns

- `packages/pi-coding-agent/src/core/model-registry.ts` — Actual startup path; constructor calls `loadModels()` synchronously then `refreshFromModelsDev()` fire-and-forget; lines 316-360 show cache→snapshot→static fallback chain; lines 397-414 show async refresh logic
- `packages/pi-coding-agent/src/core/model-registry.test.ts` — Existing integration tests using `homedir()`-based paths (lines 15-25 show helper functions); proves override application but mutates `~/.gsd/agent/`; uses `setTimeout(100)` for async timing (line 331)
- `packages/pi-ai/src/models-dev.test.ts` — Unit tests using `tmpdir()` + `mkdtempSync()` correctly (lines 63-72); proves cache hit/miss/TTL/version-check behavior; good pattern to follow for S02
- `packages/pi-ai/src/models-dev-snapshot.ts` — Bundled snapshot used as intermediate fallback; tests can verify snapshot is used when cache miss occurs
- `packages/pi-ai/src/models-dev.ts` — Cache orchestration with `getCachedModelsDev()`, `isCacheValid()`, `writeCache()`; has non-null assertion at line 183 after S01 fix

## Constraints

- **Node.js version**: Requires Node >=20.6.0 (from root `package.json` engines field)
- **Module resolution**: Node16 module resolution with `allowImportingTsExtensions: false` means test imports must use `.js` specifiers (D017)
- **Test isolation**: All tests must use `tmpdir()` instead of `homedir()` to prevent test pollution (D018)
- **Fire-and-forget refresh**: `refreshFromModelsDev()` is private and async; tests cannot directly await it, must use delay or add test hook
- **Fallback chain preservation**: Tests must verify cache → snapshot → static fallback order is maintained
- **Override preservation**: `models.json` overrides must be re-applied after async refresh completes
- **No network dependencies**: S02 scenario tests should NOT require live network access (that's S03's scope); use mocks or invalid URLs to simulate network failure

## Common Pitfalls

- **Test pollution from homedir() usage** — The current `model-registry.test.ts` uses `getAgentDir()` which resolves to the actual `~/.gsd/agent/` directory. Always use `tmpdir()` + `mkdtempSync()` for test isolation and clean up with `rmSync()` in `after()` hooks.

- **Async refresh timing in tests** — The constructor's `refreshFromModelsDev()` is fire-and-forget async, so tests that verify post-refresh state must `await` a delay. Use 500ms instead of 100ms for reliability, and add a comment explaining why the delay exists.

- **Cache directory creation** — The `writeCache()` function calls `mkdirSync(dirname(path), { recursive: true })` which is safe, but tests should ensure the directory exists before writing to avoid ENOENT errors.

- **Import specifier mismatches** — Test files must use `.js` extensions in imports (not `.ts`) to satisfy TypeScript compiler with Node16 module resolution (D017).

- **Snapshot validation** — The snapshot file is large and may change; tests should not assert exact model counts from snapshot, only that fallback behavior works.

- **Mocking network calls** — To test offline fallback, use an invalid URL (e.g., `http://invalid-url-that-does-not-exist.local/api.json`) rather than trying to mock `fetch()`, which requires additional test infrastructure.

## Open Risks

- **Async timing flakiness** — Even with 500ms delay, tests may flake on slow CI runners. If this becomes an issue, consider adding a test hook that exposes a promise-based completion signal from `refreshFromModelsDev()`.

- **Snapshot file changes** — The bundled snapshot (`models-dev-snapshot.ts`) may be updated between runs, which could affect tests that assert specific model presence. Tests should focus on behavior (fallback occurs) rather than exact data.

- **Test execution time** — Production-like scenario tests with filesystem setup will be slower than unit tests. Expect 2-3x slower per test. The test runner should support parallelization.

- **Windows filesystem differences** — The `tmpdir()` path and file locking behavior may differ on Windows. Tests should use Node.js fs primitives and avoid platform-specific assumptions.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Node.js test infrastructure | Built-in `node:test` module | Available — already used in existing tests |
| TypeScript ESM resolution | Custom resolver hooks | Available — `resolve-ts.mjs` + `resolve-ts-hooks.mjs` exist |
| Temporary directory management | Node.js `tmpdir()` + `mkdtempSync()` | Available — pattern established in `models-dev.test.ts` |
| Zod schema validation | Runtime type validation | Available — already used via `ModelsDevData` schema |

No professional agent skills are needed for this work — it's all standard Node.js/TypeScript test infrastructure.

## Sources

- Model registry startup path analysis (source: `packages/pi-coding-agent/src/core/model-registry.ts`)
- Existing registry tests using homedir() (source: `packages/pi-coding-agent/src/core/model-registry.test.ts`)
- Cache/fetch unit tests using tmpdir() (source: `packages/pi-ai/src/models-dev.test.ts`)
- Snapshot fallback implementation (source: `packages/pi-ai/src/models-dev-snapshot.ts`)
- M002 research findings on test isolation needs (source: `.gsd/milestones/M002/M002-RESEARCH.md`)
- Decision D017: Use .js extension in import specifiers (source: `.gsd/DECISIONS.md`)
- Decision D018: Use tmpdir() instead of homedir() for registry tests (source: `.gsd/DECISIONS.md`)

## Open Questions

- **How much async synchronization is needed?** — Current plan: use 500ms delay with comment. If tests flake, add test hook.
- **Should scenario tests be in a separate file or same file as existing tests?** — Separate file (`model-registry-scenario.test.ts`) keeps concerns clear and allows selective execution.
- **Should tests verify the snapshot file content or just fallback behavior?** — Just behavior — asserting snapshot content creates brittle tests.
