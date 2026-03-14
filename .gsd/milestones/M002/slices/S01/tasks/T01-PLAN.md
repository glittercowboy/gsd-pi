---
estimated_steps: 4
estimated_files: 3
---

# T01: Fix import extensions and nullability issues

**Slice:** S01 — Build/Test Infrastructure Repair
**Milestone:** M002

## Description

Fix TypeScript build failures in `@gsd/pi-ai` by converting `.ts` import extensions to `.js` (per D017) and fixing the nullability error where `cache.data` is accessed after `isCacheValid()` check.

## Steps

1. Open `packages/pi-ai/src/models-dev.test.ts` and replace `.ts` import extensions with `.js`:
   - Line 13: `from "./models-dev.ts"` → `from "./models-dev.js"`
   - Line 14: `from "./models-dev.ts"` → `from "./models-dev.js"`

2. Open `packages/pi-ai/src/models-dev-mapper.test.ts` and replace `.ts` import extensions with `.js`:
   - Line 3: `from "./models-dev-mapper.ts"` → `from "./models-dev-mapper.js"`
   - Line 4: `from "./models-dev-types.ts"` → `from "./models-dev-types.js"`

3. Fix nullability error in `packages/pi-ai/src/models-dev.ts` line 179:
   - The issue: TypeScript doesn't narrow `cache` type after `isCacheValid(cache, ...)` returns true
   - Solution: Add explicit null check or non-null assertion after the validity check

4. Run `npm run build -w @gsd/pi-ai` to verify compilation succeeds

## Must-Haves

- [ ] Test files use `.js` import specifiers (no `.ts` extensions)
- [ ] `npm run build -w @gsd/pi-ai` succeeds without TypeScript errors
- [ ] Nullability bug in `models-dev.ts` line 179 is fixed

## Verification

```bash
# Build must succeed
npm run build -w @gsd/pi-ai

# Verify no .ts imports remain
! grep -E "from ['\"].*\.ts['\"]" packages/pi-ai/src/*.test.ts
```

## Inputs

- `packages/pi-ai/src/models-dev.test.ts` — existing test file with `.ts` imports
- `packages/pi-ai/src/models-dev-mapper.test.ts` — existing test file with `.ts` imports
- `packages/pi-ai/src/models-dev.ts` — source file with nullability issue at line 179
- D017: Use .js extension in import specifiers

## Expected Output

- `packages/pi-ai/src/models-dev.test.ts` — imports use `.js` extensions
- `packages/pi-ai/src/models-dev-mapper.test.ts` — imports use `.js` extensions
- `packages/pi-ai/src/models-dev.ts` — nullability issue resolved
- `packages/pi-ai/dist/` — compiled JavaScript output with test files included

## Observability Impact

- **Import specifiers:** Changed from `.ts` to `.js` — build errors will surface if any `.ts` imports remain
- **Nullability fix:** Non-null assertion (`cache!.data`) at line 179 — TypeScript error will surface if null check is removed
- **Diagnostic surface:** Build output shows which files fail and why; no new runtime signals added (fix is compile-time only)
