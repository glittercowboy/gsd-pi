---
estimated_steps: 8
estimated_files: 4
---

# T02: Fix remaining isolated test failures and verify full green suite

**Slice:** S09 — Test suite hardening
**Milestone:** M003

## Description

After T01 fixes the resolver (14 of 17 failures), 3-4 isolated test issues remain — each with a different root cause. This task fixes them all and runs the full verification suite to confirm R110.

**Relevant skill:** `test` — load for test framework conventions if needed.

## Steps

1. **Fix `web-mode-cli.test.ts` stale assertion (line ~34).**
   - Read `src/tests/web-mode-cli.test.ts` to find the failing assertion (it checks that `web-mode.ts` contains `from './onboarding.js'`).
   - Read `src/web/web-mode.ts` to see what imports actually exist now.
   - Update the test assertion to match the current source shape. The test verifies that web-mode reuses the browser opener — find what replaced the onboarding import and assert on that instead. If the concept no longer applies, remove the assertion and add a comment explaining why.

2. **Fix `derive-state-db.test.ts` requirements test (line ~252-278).**
   - Read `src/resources/extensions/gsd/tests/derive-state-db.test.ts` around lines 252-278 to understand the "requirements from DB content" test.
   - The test inserts REQUIREMENTS.md content into an in-memory DB, but `deriveState()` reads from disk via `loadFile()`, not from DB. Investigate: does `loadFile()` have a DB-aware hook, or is this test aspirational?
   - If aspirational (likely): fix the test to match reality — either write the fixture content to a temp file on disk that `loadFile()` will find, or adjust the assertion to expect no requirements (since the DB content isn't actually read by this path).
   - If there's a DB-aware hook: investigate why it isn't working and fix the test setup.

3. **Fix `github-client.test.ts` hardcoded remote (line ~138-144).**
   - Read `src/tests/github-client.test.ts` around lines 138-144.
   - The test hardcodes expected remote as `gsd-build/gsd-2` but the fork's remote is `snowdamiz`.
   - Fix: make the assertion environment-independent — check that the result is non-null with valid owner and repo strings (non-empty, no slashes in each part), without asserting specific values. Or detect the actual remote and use it.

4. **Address `stop-auto-remote.test.ts` timing flake.**
   - Read `src/resources/extensions/gsd/tests/stop-auto-remote.test.ts` to understand the timing-sensitive assertion (sends SIGTERM and asserts process exited).
   - Add tolerance: increase wait time, add a retry loop for the exit check, or add `{ timeout: ... }` to the test. If the fix is uncertain, add a `// KNOWN FLAKE:` comment documenting the behavior.

5. **Run `npm run test:unit`** — verify 0 failures. If any new failures appear, investigate and fix before proceeding.

6. **Run `npm run test:integration`** — verify 0 failures. Integration tests are slow (~5 min). If the `stop-auto-remote` flake persists, document it but don't block on it.

7. **Run `npm run build`** — verify exit 0.

8. **Run `npm run build:web-host`** — verify exit 0.

## Must-Haves

- [ ] `web-mode-cli.test.ts` assertion updated to match current source shape
- [ ] `derive-state-db.test.ts` requirements test fixed to match actual loading behavior
- [ ] `github-client.test.ts` assertion is environment-independent
- [ ] `stop-auto-remote.test.ts` timing flake addressed (fix or documented tolerance)
- [ ] `npm run test:unit` — 0 failures
- [ ] `npm run test:integration` — 0 failures
- [ ] `npm run build` — exit 0
- [ ] `npm run build:web-host` — exit 0

## Verification

- `npm run test:unit` — 0 failures
- `npm run test:integration` — 0 failures
- `npm run build` — exit 0
- `npm run build:web-host` — exit 0

## Inputs

- T01 completed: `dist-redirect.mjs` resolver fixed, 14 of 17 failures resolved
- `src/tests/web-mode-cli.test.ts` — stale onboarding assertion
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — DB requirements loading mismatch
- `src/tests/github-client.test.ts` — hardcoded git remote
- `src/resources/extensions/gsd/tests/stop-auto-remote.test.ts` — timing flake
- `src/web/web-mode.ts` — current source to compare against stale assertion

## Expected Output

- `src/tests/web-mode-cli.test.ts` — updated assertion matching current source
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — fixed to match actual loading path
- `src/tests/github-client.test.ts` — environment-independent assertion
- `src/resources/extensions/gsd/tests/stop-auto-remote.test.ts` — timing tolerance added
- All four verification commands pass clean (R110 validated)
