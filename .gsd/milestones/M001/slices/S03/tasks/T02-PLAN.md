---
estimated_steps: 4
estimated_files: 1
---

# T02: Write integration test and verify build+test pass

**Slice:** S03 — Auto-Mode & Guided Flow Integration
**Milestone:** M001

## Description

Create an integration test that exercises the secrets collection gate logic end-to-end using real filesystem state. The test proves that `getManifestStatus` → `collectSecretsFromManifest` composition works correctly for the three key scenarios: no manifest, pending keys present, and no pending keys. Then verify full build and test suite pass.

## Steps

1. Create `src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` following the pattern from `manifest-status.test.ts` (temp dirs, real `.gsd/milestones/M001/` structure, cleanup in finally blocks).
2. Write three test cases:
   - **No manifest exists**: Call `getManifestStatus(base, 'M001')` on a base with no `M001-SECRETS.md` → returns `null`. Proves the gate's null-check path.
   - **Pending keys exist**: Write a manifest with 2 pending entries + set 1 key in `process.env` to simulate existing. Call `getManifestStatus` → assert `pending.length > 0` and `existing.length > 0`. This proves the gate would trigger collection. Then call `collectSecretsFromManifest` with a mock UI context (the function needs `{ ui, hasUI, cwd }` — provide a stub `ui` with no-op methods since the test won't actually render TUI). Verify the manifest file on disk is updated (entry statuses changed from pending to skipped/collected).
   - **No pending keys**: Write a manifest where all entries have status `collected` or are in `process.env`. Call `getManifestStatus` → assert `pending.length === 0`. Proves the gate's skip path.
3. Run `npm run build` — confirm no new TypeScript errors.
4. Run `npm run test` — confirm no new test failures beyond pre-existing 19.

## Must-Haves

- [ ] Test file created at `src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts`
- [ ] Tests cover: null manifest, pending keys, no pending keys
- [ ] Tests use real filesystem (temp dirs), not mocks for manifest/files
- [ ] All three tests pass
- [ ] `npm run build` passes
- [ ] `npm run test` — no new failures

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` — all tests pass
- `npm run build` — clean
- `npm run test` — no new failures beyond pre-existing baseline

## Observability Impact

- Signals added/changed: None — test file only
- How a future agent inspects this: Run the test file directly with `npx tsx --test`
- Failure state exposed: Test assertions provide specific failure messages for each scenario

## Inputs

- `src/resources/extensions/gsd/auto.ts` — T01 output with the gate in place
- `src/resources/extensions/gsd/tests/manifest-status.test.ts` — pattern reference for test structure
- `src/resources/extensions/gsd/files.ts` — `getManifestStatus()` function
- `src/resources/extensions/get-secrets-from-user.ts` — `collectSecretsFromManifest()` function

## Expected Output

- `src/resources/extensions/gsd/tests/auto-secrets-gate.test.ts` — integration test proving the gate logic
- Clean build and test suite pass
