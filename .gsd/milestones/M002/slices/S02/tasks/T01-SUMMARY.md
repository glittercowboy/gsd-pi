---
id: T01
parent: S02
milestone: M002
provides:
  - Optional cachePath parameter injection for ModelRegistry constructor
key_files:
  - packages/pi-coding-agent/src/core/model-registry.ts
key_decisions:
  - Added cachePath as third optional parameter to preserve backward compatibility
patterns_established:
  - Dependency injection via optional constructor parameter for test isolation
observability_surfaces:
  - None (internal implementation detail)
duration: 15m
verification_result: passed
completed_at: 2026-03-14T16:07:02-05:00
blocker_discovered: false
---

# T01: Add cache path injection to ModelRegistry

**Added optional `cachePath` parameter to ModelRegistry constructor for test isolation.**

## What Happened

Implemented the cache path injection feature as specified in the task plan:

1. Added `private cachePath?: string` field to ModelRegistry class (line 233)
2. Added `cachePath?: string` as third constructor parameter (line 238)
3. Stored parameter in field: `this.cachePath = cachePath` (line 242)
4. Modified `loadBuiltInModels()` to call `getCachedModelsDev(this.cachePath)` instead of `getCachedModelsDev()` (line 319)

The change is minimal and non-breaking - when cachePath is not provided, behavior is identical to the original implementation since `getCachedModelsDev()` accepts an optional parameter and uses its own default when undefined.

## Verification

- **Code review**: Verified `getCachedModelsDev()` signature accepts optional `cachePath?: string` parameter (confirmed at `packages/pi-ai/src/models-dev.ts:51`)
- **TypeScript compilation**: No new TypeScript errors introduced in model-registry.ts (pre-existing build errors are unrelated to this change - they concern `@gsd/pi-agent-core` module resolution)
- **Non-breaking change verified**: Constructor signature change is backward compatible - existing calls without cachePath continue to work
- **Implementation verified**: Grep confirmed `getCachedModelsDev(this.cachePath)` is called in `loadBuiltInModels()`

## Diagnostics

No new observability surfaces added - this is an internal implementation detail that enables test isolation. Future agents can inspect:
- ModelRegistry constructor signature to see the optional `cachePath` parameter
- `loadBuiltInModels()` implementation to see how `this.cachePath` is passed to `getCachedModelsDev()`

## Deviations

None - implementation followed the task plan exactly.

## Known Issues

None discovered.

## Files Created/Modified

- `packages/pi-coding-agent/src/core/model-registry.ts` — Added optional cachePath parameter to constructor and field, modified loadBuiltInModels() to pass cachePath to getCachedModelsDev()
