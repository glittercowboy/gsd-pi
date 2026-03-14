---
estimated_steps: 4
estimated_files: 1
---

# T01: Add cache path injection to ModelRegistry

**Slice:** S02 — Production-Like Scenario Testing
**Milestone:** M002

## Description

Add an optional `cachePath` parameter to the ModelRegistry constructor, enabling production-like scenario tests to inject temporary directory paths instead of using the hardcoded `getAgentDir()`-based default. This is a minimal, non-breaking change that preserves existing behavior while enabling test isolation.

## Steps

1. Add `private cachePath?: string` field to ModelRegistry class
2. Add `cachePath?: string` as third parameter to constructor (after `modelsJsonPath`)
3. Store parameter in field: `this.cachePath = cachePath`
4. Modify `loadBuiltInModels()` to call `getCachedModelsDev(this.cachePath)` instead of `getCachedModelsDev()`

## Must-Haves

- [ ] ModelRegistry constructor accepts optional third parameter `cachePath?: string`
- [ ] When cachePath is provided, `getCachedModelsDev()` uses it instead of default path
- [ ] When cachePath is not provided, behavior is identical to current implementation
- [ ] No breaking changes to existing ModelRegistry usage

## Verification

- `npm run build -w @gsd/pi-coding-agent` — TypeScript compiles without errors
- `npm test -w @gsd/pi-coding-agent` — All existing tests still pass
- Code review: verify `getCachedModelsDev()` is called with `this.cachePath` parameter

## Observability Impact

- Signals added/changed: None (internal implementation detail)
- How a future agent inspects this: Check ModelRegistry constructor signature and loadBuiltInModels() implementation
- Failure state exposed: None (non-breaking change)

## Inputs

- `packages/pi-coding-agent/src/core/model-registry.ts` — Current implementation with hardcoded cache path
- S01 summary — Build/test infrastructure is stable and ready for modifications

## Expected Output

- `packages/pi-coding-agent/src/core/model-registry.ts` — Modified with optional cachePath parameter
