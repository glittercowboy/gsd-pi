---
id: M002
provides:
  - Working TypeScript build with Node16-compatible .js import specifiers
  - Fixed nullability type error in models-dev.ts cache access
  - Test script configured for @gsd/pi-ai enabling standard npm test workflow
  - All 32 registry-path tests passing through standard test runner
  - Optional cachePath parameter injection for ModelRegistry constructor
  - Production-like scenario test suite covering 6 lifecycle scenarios with tmpdir isolation
  - Live models.dev verification test in main test suite with clear diagnostics
  - Code quality hardening through import fixes, testability injection, and observable diagnostics
key_decisions:
  - D017: Use .js extension in import specifiers for Node16 module resolution
  - D021: Optional cachePath parameter in ModelRegistry constructor enables test isolation
  - D022: LIVE_MODELS_DEV_TEST env var skips test when set to "false" or "0"
patterns_established:
  - Test imports use .js specifiers; custom ESM resolver rewrites at runtime
  - Test command: node --import ../../src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/**/*.test.ts
  - Non-null assertion after type guard when TypeScript cannot narrow custom guard return types
  - Six distinct scenario suites: fresh install, cache hit, stale cache, version mismatch, offline fallback, override application
  - 500ms delay for async refresh settlement (fire-and-forget pattern)
  - Live verification tests use console.log for diagnostic output visible in TAP
  - Env var gates allow selective disabling without code changes
observability_surfaces:
  - TypeScript errors in stderr indicate import path or type issues
  - TAP format test output with per-test pass/fail and stack traces on failure
  - Non-zero exit code on test failure for CI/CD gating
  - Test names identify which scenario failed
  - Assertion messages show expected vs actual model data
  - Console logs show fetch URL, timeout, provider count, sample model IDs on success
  - Network failure message explicitly identifies URL and suggests checking connectivity
requirement_outcomes:
  - id: R007
    from_status: active
    to_status: validated
    proof: S01 - npm run build -w @gsd/pi-ai exits 0, npm test -w @gsd/pi-ai exits 0 with all 32 tests passing
  - id: R008
    from_status: active
    to_status: validated
    proof: S02 - Nine scenario tests pass with tmpdir isolation covering fresh state, cache hit, stale cache, version change, offline fallback, and models.json overrides
  - id: R009
    from_status: active
    to_status: validated
    proof: S03 - Live test fetches from production models.dev API with Zod schema validation and env var gate for CI/offline control
  - id: R010
    from_status: active
    to_status: validated
    proof: M002 - Import path fixes (S01), cachePath injection for testability (S02), observable diagnostics (S03) delivered through slice work
duration: 2h
verification_result: passed
completed_at: 2026-03-14T16:15:00-05:00
---

# M002: Model Registry Hardening and Real-Scenario Verification

**Hardened model registry path with repaired build/test infrastructure, production-like scenario testing with tmpdir isolation, and live models.dev verification in main test suite.**

## What Happened

Three slices executed in sequence to harden the model registry verification path:

1. **S01: Build/Test Infrastructure Repair** — Fixed `.ts` import extensions to `.js` specifiers for Node16 module resolution, added non-null assertion for cache access after type guard, configured test script in @gsd/pi-ai package.json. Build and test workflows now succeed with all 32 tests passing.

2. **S02: Production-Like Scenario Testing** — Added optional `cachePath` parameter to ModelRegistry constructor enabling test isolation. Created scenario test suite with 9 tests across 6 suites (fresh install, cache hit, stale cache, version mismatch, offline fallback, override application) using tmpdir pattern. Tests no longer mutate `~/.gsd/agent/`.

3. **S03: Live models.dev Verification** — Added live verification test that fetches from production models.dev API, validates response via Zod schema, confirms mapper produces non-empty output. Includes env var gate (`LIVE_MODELS_DEV_TEST=0`) for CI/offline scenarios and clear diagnostics distinguishing network vs schema errors.

A minor fix was needed during milestone completion: the live test's timeout option was incorrectly positioned after the function instead of before it in the `it()` call signature. Fixed by moving `{ timeout: 35000 }` to the correct position.

## Cross-Slice Verification

**Success Criteria Verified:**

1. **Build/test workflow trustworthy** — `npm run build -w @gsd/pi-ai` exits 0, `npm test -w @gsd/pi-ai` exits 0 with 32 tests passing across 11 suites.

2. **Production-like scenarios** — 9 scenario tests pass using tmpdir isolation:
   - Fresh install: falls back to snapshot/static MODELS
   - Cache hit: valid cache with current version is used
   - Stale cache: expired TTL handled gracefully
   - Version mismatch: version-triggered refresh works
   - Offline fallback: stale cache used when network unavailable
   - Override application: provider-level, per-model, and combined overrides work

3. **Live verification in main suite** — Live test fetches from `https://models.dev/api.json`, validates via `ModelsDevData` Zod schema, confirms mapper produces non-empty output. Console diagnostics show 102 providers, 3742 models. Env var gate allows CI/offline control.

4. **Test isolation** — `grep -r "homedir()"` returns no matches in scenario tests. All tests use `tmpdir() + mkdtempSync()` pattern with `after()` cleanup.

**Definition of Done:**
- All slice deliverables complete (S01, S02, S03 all [x])
- Build succeeds without TypeScript errors
- Test suite executes all registry-path tests including mapper tests
- Production-like scenario tests pass with tmpdir isolation
- Live verification runs with clear diagnostics
- Tests no longer mutate `~/.gsd/agent/`

## Requirement Changes

- **R007**: active → validated — `npm run build -w @gsd/pi-ai` and `npm test -w @gsd/pi-ai` both succeed with clean exit
- **R008**: active → validated — Nine scenario tests prove real ModelRegistry startup behavior with tmpdir isolation across all lifecycle scenarios
- **R009**: active → validated — Live test fetches from production models.dev API with Zod schema validation, clear diagnostics, and env var gate
- **R010**: active → validated — Import path fixes, cachePath injection for testability, and observable diagnostics delivered through slice work

## Forward Intelligence

### What the next milestone should know
- Build/test infrastructure is stable — M003 can proceed with confidence
- Test command pattern: `node --import ../../src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/**/*.test.ts`
- Scenario tests run via `node --test packages/pi-coding-agent/dist/core/model-registry-scenario.test.js` (pi-coding-agent has no npm test script)
- Env var gate pattern (`LIVE_MODELS_DEV_TEST`) can be reused for other network-dependent tests

### What's fragile
- Path to ESM resolver is relative — depends on `packages/pi-ai/` location within monorepo structure
- The 500ms async delay in scenario tests is a reasonable heuristic but not deterministic — if tests become flaky, consider explicit synchronization

### Authoritative diagnostics
- `npm run build -w @gsd/pi-ai 2>&1` — TypeScript errors surface here
- `npm test -w @gsd/pi-ai 2>&1` — TAP output with per-test results and timing
- `node --test packages/pi-coding-agent/dist/core/model-registry-scenario.test.js` — Scenario test output

### What assumptions changed
- Live test timeout option must come BEFORE the function in Node.js `it()` signature, not after

## Files Created/Modified

- `packages/pi-ai/src/models-dev.test.ts` — Changed import extensions from .ts to .js
- `packages/pi-ai/src/models-dev-mapper.test.ts` — Changed import extensions from .ts to .js
- `packages/pi-ai/src/models-dev.ts` — Added non-null assertion at line 179
- `packages/pi-ai/package.json` — Added test script with custom ESM resolver
- `packages/pi-ai/src/models-dev-live.test.ts` — New live verification test (68 lines)
- `packages/pi-coding-agent/src/core/model-registry.ts` — Added optional cachePath parameter to constructor
- `packages/pi-coding-agent/src/core/model-registry-scenario.test.ts` — New test file with 6 scenario suites (9 tests)
