---
estimated_steps: 4
estimated_files: 1
---

# T01: Fix dist-redirect.mjs resolver to handle dist/ paths and .tsx extensions

**Slice:** S09 — Test suite hardening
**Milestone:** M003

## Description

The shared test module resolver `dist-redirect.mjs` has a blanket `.js→.ts` rewrite rule for all imports within `/src/`. This breaks 13 tests because it rewrites `../../packages/pi-ai/dist/oauth.js` to `dist/oauth.ts` — a file that doesn't exist. The `.js` file in `dist/` is a real compiled artifact and should not be rewritten.

A second issue: `web-diagnostics-contract.test.ts` dynamically imports `../../web/lib/gsd-workspace-store.tsx`. Node v25.3.0's `--experimental-strip-types` handles `.ts` but not `.tsx`. The resolver's load hook needs to handle `.tsx` files by reading and serving them as module source.

This single file fix resolves 14 of the 17 total failures.

## Steps

1. Read `src/resources/extensions/gsd/tests/dist-redirect.mjs` to understand the current resolve and load hooks.
2. In the **resolve hook**: add a guard before the `.js→.ts` rewrite. If the specifier (or the resolved path) contains `/dist/`, skip the rewrite and let Node resolve the `.js` file normally. The guard must be specific to `/dist/` — don't over-restrict by blocking all `../` paths.
3. In the **load hook**: add handling for `.tsx` files. When the resolved URL ends in `.tsx`, read the file contents with `fs.readFileSync`, and return `{ format: 'module', source: fileContents, shortCircuit: true }`. This mirrors how the existing `.ts` handling works with `--experimental-strip-types` but bypasses Node's lack of `.tsx` support.
4. Verify the fix by running the 7 affected unit test files individually:
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts`
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-diagnostics-contract.test.ts`
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-interaction-contract.test.ts`
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-live-state-contract.test.ts`
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-onboarding-contract.test.ts`
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-recovery-diagnostics-contract.test.ts`
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts`
   Then spot-check 2-3 previously-passing test files to confirm no regression.

## Must-Haves

- [ ] Imports containing `/dist/` are NOT rewritten from `.js` to `.ts`
- [ ] `.tsx` files are loadable via the resolver's load hook
- [ ] All 1130 previously-passing tests still pass (no regressions)
- [ ] The 13 oauth-related test failures are resolved
- [ ] The 1 `.tsx`-related test failure (`web-diagnostics-contract.test.ts`) is resolved

## Verification

- Run each of the 7 affected unit test files individually — all pass
- Run 2-3 previously-passing unit test files — still pass
- No import resolution errors for `dist/oauth.js` in test output

## Inputs

- `src/resources/extensions/gsd/tests/dist-redirect.mjs` — the resolver to fix
- `src/resources/extensions/gsd/tests/resolve-ts.mjs` — registers dist-redirect.mjs as a Node loader (read to understand registration, don't modify)
- `src/web/web-auth-storage.ts` — contains the `../../packages/pi-ai/dist/oauth.js` import that triggers the bug (read for context, don't modify)

## Expected Output

- `src/resources/extensions/gsd/tests/dist-redirect.mjs` — updated with `/dist/` guard in resolve hook and `.tsx` handling in load hook
