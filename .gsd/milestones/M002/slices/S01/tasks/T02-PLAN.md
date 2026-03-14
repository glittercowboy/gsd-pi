---
estimated_steps: 3
estimated_files: 1
---

# T02: Add test script and verify workflow

**Slice:** S01 — Build/Test Infrastructure Repair
**Milestone:** M002

## Description

Add a `test` script to `@gsd/pi-ai/package.json` using Node's built-in test runner with the project's custom ESM resolver, then verify both build and test commands work via standard npm scripts.

## Steps

1. Add `"test"` script to `packages/pi-ai/package.json`:
   ```json
   "test": "node --import ../src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/**/*.test.ts"
   ```

2. Run `npm test -w @gsd/pi-ai` to verify all tests pass

3. Run full workflow verification: `npm run build -w @gsd/pi-ai && npm test -w @gsd/pi-ai`

## Must-Haves

- [ ] `@gsd/pi-ai/package.json` has a `test` script
- [ ] `npm test -w @gsd/pi-ai` executes all test files and exits with code 0
- [ ] Both `npm run build` and `npm test` work via standard npm scripts

## Verification

```bash
# Full workflow must succeed
npm run build -w @gsd/pi-ai && npm test -w @gsd/pi-ai

# Verify test files are in compilation output
ls packages/pi-ai/dist/*.test.js
```

## Inputs

- `packages/pi-ai/package.json` — needs test script added
- `src/resources/extensions/gsd/tests/resolve-ts.mjs` — custom ESM resolver that rewrites .js to .ts

## Expected Output

- `packages/pi-ai/package.json` — has `test` script configured
- Test output showing all tests pass
- `packages/pi-ai/dist/*.test.js` — compiled test files

## Observability Impact

- **Test execution visibility:** `node --test` outputs TAP format results showing pass/fail per test file
- **Failure diagnostics:** Failed tests show assertion error with stack trace in stderr
- **Exit code signaling:** Non-zero exit on test failure enables CI/CD gating
- **Agent inspection:** Future agents can verify test execution with `npm test -w @gsd/pi-ai 2>&1 | grep -E '(pass|fail|Error)'`
