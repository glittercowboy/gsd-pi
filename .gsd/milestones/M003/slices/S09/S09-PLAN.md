# S09: Test suite hardening

**Goal:** All test suites and builds pass clean — `npm run test:unit`, `npm run test:integration`, `npm run build`, `npm run build:web-host` exit 0 with no failures.
**Demo:** Run all four verification commands in sequence. Each exits 0. Unit tests show 1141 pass / 0 fail. Integration tests show 0 fail.

## Must-Haves

- `dist-redirect.mjs` resolver does not rewrite imports targeting `/dist/` directories (fixes 13 test failures)
- `.tsx` extension handled by the test resolver's load hook (fixes 1 test failure)
- Stale source-shape assertion in `web-mode-cli.test.ts` updated to match current code (fixes 1 test failure)
- `derive-state-db.test.ts` requirements test fixed to match actual loading path (fixes 1 test failure)
- `github-client.test.ts` assertion is environment-independent (fixes 1 test failure)
- `stop-auto-remote.test.ts` timing flake addressed or documented (fixes 1 intermittent failure)
- `npm run test:unit` — 0 failures
- `npm run test:integration` — 0 failures
- `npm run build` — exit 0
- `npm run build:web-host` — exit 0

## Proof Level

- This slice proves: final-assembly
- Real runtime required: yes (tests execute real code paths)
- Human/UAT required: no

## Verification

- `npm run test:unit` — 0 failures, all pass
- `npm run test:integration` — 0 failures, all pass
- `npm run build` — exit 0
- `npm run build:web-host` — exit 0

## Integration Closure

- Upstream surfaces consumed: `dist-redirect.mjs` (shared test resolver used by all suites), `resolve-ts.mjs` (loader registration)
- New wiring introduced in this slice: none — test infrastructure fixes only
- What remains before the milestone is truly usable end-to-end: nothing — this is the terminal slice

## Tasks

- [ ] **T01: Fix dist-redirect.mjs resolver to handle dist/ paths and .tsx extensions** `est:30m`
  - Why: The resolver's blanket `.js→.ts` rewrite breaks 13 tests by rewriting `../../packages/pi-ai/dist/oauth.js` to `dist/oauth.ts` (which doesn't exist). A second issue — Node's `--experimental-strip-types` doesn't handle `.tsx` — breaks 1 additional test after the oauth fix is applied.
  - Files: `src/resources/extensions/gsd/tests/dist-redirect.mjs`
  - Do: (1) Add a guard in the resolve hook: if the specifier contains `/dist/`, skip the `.js→.ts` rewrite — the `.js` file actually exists in dist. (2) Add `.tsx→.ts` support in the load hook for Node's strip-types limitation: when the resolved URL ends in `.tsx`, read the file and set format to `module` so it's handled like `.ts`. Constraint: must not break the 1130 tests that already pass — the guard must only skip rewrites for actual dist/ paths.
  - Verify: Run the 7 affected unit test files and 3 affected integration test files individually with `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test <file>`
  - Done when: All 14 previously-failing tests pass (13 oauth-related + 1 tsx-related), and a spot-check of 2-3 previously-passing test files still pass.

- [ ] **T02: Fix remaining isolated test failures and verify full green suite** `est:45m`
  - Why: Four independent test issues remain after T01: a stale assertion, a DB-vs-disk loading mismatch, a hardcoded git remote, and a timing flake. After fixing all, the full suite must pass clean to satisfy R110.
  - Files: `src/tests/web-mode-cli.test.ts`, `src/resources/extensions/gsd/tests/derive-state-db.test.ts`, `src/tests/github-client.test.ts`, `src/resources/extensions/gsd/tests/stop-auto-remote.test.ts`
  - Do: (1) `web-mode-cli.test.ts` line ~34 — the test asserts `web-mode.ts` contains `from './onboarding.js'` but this import was removed during M003. Read `web-mode.ts` to find what the test should actually verify, then update or replace the assertion. (2) `derive-state-db.test.ts` line ~252-278 — "requirements from DB content" test inserts REQUIREMENTS.md content into an in-memory DB but `deriveState()` reads from disk via `loadFile()`. Investigate whether this is an aspirational test or a real loading path; fix the test to match reality (likely write fixture to disk or adjust the expectation). (3) `github-client.test.ts` line ~138-144 — hardcodes expected remote as `gsd-build/gsd-2` but the fork's remote is different. Make the assertion check for non-null/valid owner+repo without asserting specific values, or use the actual remote. (4) `stop-auto-remote.test.ts` — fails in parallel but passes alone. Add tolerance (increase wait time or add retry) or mark as a known timing-sensitive test. (5) Run all four verification commands: `npm run test:unit`, `npm run test:integration`, `npm run build`, `npm run build:web-host`.
  - Verify: All four commands exit 0 with 0 failures
  - Done when: `npm run test:unit` shows 0 fail, `npm run test:integration` shows 0 fail, both builds exit 0

## Files Likely Touched

- `src/resources/extensions/gsd/tests/dist-redirect.mjs`
- `src/tests/web-mode-cli.test.ts`
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts`
- `src/tests/github-client.test.ts`
- `src/resources/extensions/gsd/tests/stop-auto-remote.test.ts`
