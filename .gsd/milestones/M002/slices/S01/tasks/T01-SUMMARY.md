---
id: T01
parent: S01
milestone: M002
provides:
  - Working TypeScript build with correct .js import specifiers
  - Fixed nullability type error in models-dev.ts
key_files:
  - packages/pi-ai/src/models-dev.test.ts
  - packages/pi-ai/src/models-dev-mapper.test.ts
  - packages/pi-ai/src/models-dev.ts
key_decisions:
  - Non-null assertion (cache!.data) used instead of explicit null check after isCacheValid() guard
patterns_established:
  - Use .js extension in import specifiers for Node16 module resolution (per D017)
observability_surfaces:
  - Build errors surface import path issues and type errors in stderr
  - No new runtime signals added (fix is compile-time only)
duration: 15m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T01: Fix import extensions and nullability issues

<!-- One-liner must say what actually shipped, not just that work completed.
     Good: "Added retry-aware worker status logging"
     Bad: "Implemented logging improvements" -->

**Fixed TypeScript build by converting .ts imports to .js and resolving nullability type error**

## What Happened

1. **Fixed import extensions in test files:**
   - `models-dev.test.ts` lines 13-14: Changed `.ts` to `.js` in both import statements
   - `models-dev-mapper.test.ts` lines 3-4: Changed `.ts` to `.js` in both import statements

2. **Fixed nullability error in models-dev.ts:**
   - Line 179 accessed `cache.data` after `isCacheValid(cache, ttlMs, version)` check
   - TypeScript doesn't narrow the type based on the custom type guard function
   - Added non-null assertion (`cache!.data`) with a comment explaining the safety guarantee

3. **Added observability sections to plan files:**
   - Updated S01-PLAN.md with Observability / Diagnostics section
   - Updated T01-PLAN.md with Observability Impact section

## Verification

```bash
# Build succeeded
npm run build -w @gsd/pi-ai

# No .ts imports remain
grep -E "from ['\"].*\.ts['\"]" packages/pi-ai/src/*.test.ts && exit 1 || echo "No .ts imports found"

# Test files compiled successfully
ls packages/pi-ai/dist/*.test.js
# Output: packages/pi-ai/dist/models-dev-mapper.test.js
#         packages/pi-ai/dist/models-dev.test.js
```

## Diagnostics

- **Build failures:** TypeScript errors in stderr indicate remaining import or type issues
- **Cache inspection:** `cat ~/.gsd/agent/cache/models-dev.json` to inspect cached data
- **Compiled output:** `ls -la packages/pi-ai/dist/` verifies test files are included

## Deviations

None - executed exactly as planned.

## Known Issues

None discovered.

## Files Created/Modified

- `packages/pi-ai/src/models-dev.test.ts` — Changed import extensions from .ts to .js
- `packages/pi-ai/src/models-dev-mapper.test.ts` — Changed import extensions from .ts to .js
- `packages/pi-ai/src/models-dev.ts` — Added non-null assertion at line 179
- `.gsd/milestones/M002/slices/S01/S01-PLAN.md` — Added observability section, marked T01 complete
- `.gsd/milestones/M002/slices/S01/tasks/T01-PLAN.md` — Added observability impact section
