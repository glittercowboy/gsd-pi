# S01: Build/Test Infrastructure Repair — UAT

**Milestone:** M002
**Written:** 2026-03-14

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: This slice repairs build/test infrastructure; verification is fully automated through npm scripts with no runtime behavior to observe

## Preconditions

- Repository checked out at the S01 completion commit
- Node.js 20+ available
- Dependencies installed (`npm install` completed)

## Smoke Test

```bash
npm run build -w @gsd/pi-ai && npm test -w @gsd/pi-ai
```

**Expected:** Both commands exit 0 with no errors.

## Test Cases

### 1. Build succeeds with no TypeScript errors

1. Run `npm run build -w @gsd/pi-ai`
2. **Expected:** Command exits with code 0, no TypeScript errors in output
3. **Expected:** `packages/pi-ai/dist/` contains compiled `.js` files including test files

### 2. Test suite runs and all tests pass

1. Run `npm test -w @gsd/pi-ai`
2. **Expected:** Command exits with code 0
3. **Expected:** Output shows 31 tests passed, 0 failed, 10 suites

### 3. No .ts imports in test files

1. Run `grep -E "from ['\"].*\.ts['\"]" packages/pi-ai/src/*.test.ts`
2. **Expected:** No matches found (exit code 1 from grep)

### 4. Compiled test files exist

1. Run `ls packages/pi-ai/dist/*.test.js`
2. **Expected:** Lists `models-dev-mapper.test.js` and `models-dev.test.js`

### 5. Full workflow from clean state

1. Run `rm -rf packages/pi-ai/dist`
2. Run `npm run build -w @gsd/pi-ai && npm test -w @gsd/pi-ai`
3. **Expected:** Both commands succeed, all tests pass

## Edge Cases

### Build after source modification

1. Make a trivial change to `packages/pi-ai/src/models-dev.ts` (add comment)
2. Run `npm run build -w @gsd/pi-ai`
3. **Expected:** Build succeeds, dist updated

### Test with missing dist directory

1. Run `rm -rf packages/pi-ai/dist`
2. Run `npm test -w @gsd/pi-ai`
3. **Expected:** Tests pass (test script runs from source via --experimental-strip-types)

## Failure Signals

- TypeScript errors mentioning `.ts` extension imports
- TypeScript error about `cache.data` being possibly null
- `npm test` exits with non-zero code
- Test output shows failures or skipped tests
- Missing `packages/pi-ai/dist/*.test.js` files after build

## Requirements Proved By This UAT

- R007 — Standard `npm run build` and `npm test` workflows execute registry-path verification without errors

## Not Proven By This UAT

- Test isolation from `~/.gsd/agent/` (S02)
- Live models.dev API connectivity (S03)
- Production-like scenario behavior (S02)

## Notes for Tester

- Tests take ~22 seconds due to network timeout tests (expected)
- No network connectivity required for UAT—all tests use mocks/fixtures
