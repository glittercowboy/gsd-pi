# S01: Build/Test Infrastructure Repair

**Goal:** `npm run build` and `npm test` succeed in `@gsd/pi-ai`, enabling all downstream registry-path verification work.

**Demo:** Running `npm run build -w @gsd/pi-ai` produces no TypeScript errors, and `npm test -w @gsd/pi-ai` executes all registry-path tests successfully.

## Must-Haves

- All `.ts` extension imports in test files converted to `.js` specifiers for Node16 module resolution compatibility
- Nullability bug in `models-dev.ts` line 179 fixed (cache.data access after isCacheValid check)
- Test script added to `@gsd/pi-ai/package.json` that runs tests with the project's custom ESM resolver
- `npm run build -w @gsd/pi-ai` exits with code 0
- `npm test -w @gsd/pi-ai` executes both test files and exits with code 0

## Proof Level

- This slice proves: operational
- Real runtime required: yes (TypeScript compiler and Node test runner)
- Human/UAT required: no

## Verification

```bash
# Build must succeed
npm run build -w @gsd/pi-ai

# Tests must run and pass
npm test -w @gsd/pi-ai

# Verify no .ts imports remain in test files
grep -E "from ['\"].*\.ts['\"]" packages/pi-ai/src/*.test.ts && exit 1 || echo "No .ts imports found"

# Verify test files are included in compilation output
ls packages/pi-ai/dist/*.test.js
```

## Observability / Diagnostics

- **Build failures:** TypeScript errors surface import path issues and type errors in stderr
- **Cache inspection:** `cat ~/.gsd/agent/cache/models-dev.json` to inspect cached data structure
- **Failure state:** Functions return `null` on cache miss / network failure — no thrown errors
- **Diagnostic command:** Check compilation output exists: `ls -la packages/pi-ai/dist/`
- **Test diagnostics:** `npm test` outputs TAP format with per-test pass/fail; failed tests include stack traces

## Tasks

- [x] **T01: Fix import extensions and nullability issues** `est:30m`
  - Why: TypeScript build fails due to `.ts` extension imports and nullability error, blocking all downstream work
  - Files: `packages/pi-ai/src/models-dev.test.ts`, `packages/pi-ai/src/models-dev-mapper.test.ts`, `packages/pi-ai/src/models-dev.ts`
  - Do:
    1. Change all `.ts` imports to `.js` in test files (4 imports across 2 files)
    2. Fix nullability in `models-dev.ts` line 179 by adding null check or using non-null assertion after `isCacheValid` returns true
  - Verify: `npm run build -w @gsd/pi-ai` exits with code 0
  - Done when: Build succeeds with no TypeScript errors

- [x] **T02: Add test script and verify build/test workflow** `est:20m`
  - Why: Package needs test infrastructure to run tests through standard workflow
  - Files: `packages/pi-ai/package.json`
  - Do:
    1. Add `"test"` script to `@gsd/pi-ai/package.json` using Node's built-in test runner with the project's custom ESM resolver: `node --import ../gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/**/*.test.ts`
    2. Run `npm test -w @gsd/pi-ai` to verify all tests pass
  - Verify: `npm test -w @gsd/pi-ai` runs both test files and exits with code 0
  - Done when: Both build and test commands succeed via standard npm scripts

## Files Likely Touched

- `packages/pi-ai/src/models-dev.test.ts`
- `packages/pi-ai/src/models-dev-mapper.test.ts`
- `packages/pi-ai/src/models-dev.ts`
- `packages/pi-ai/package.json`
