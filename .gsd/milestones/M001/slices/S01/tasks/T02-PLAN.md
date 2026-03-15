---
estimated_steps: 5
estimated_files: 2
---

# T02: Add contract tests for getManifestStatus() and LLM-style round-trip parsing

**Slice:** S01 — Manifest Wiring & Prompt Verification
**Milestone:** M001

## Description

Create the test file for `getManifestStatus()` proving the S01→S02 boundary contract, and add LLM-style round-trip tests to the existing parser test file proving prompt compliance. These tests verify that realistic LLM output variations (extra whitespace, missing optional fields, extra blank lines) survive the parse→format→parse cycle.

## Steps

1. Create `src/resources/extensions/gsd/tests/manifest-status.test.ts` using the project's test pattern (`node:test` + `assert/strict`, temp directories, cleanup in `finally`). Tests:
   - **Mixed statuses**: Write a manifest with entries in pending/collected/skipped states plus one key set in env → verify `getManifestStatus()` returns correct categorization (env key in `existing`, others in their respective arrays)
   - **All pending**: Manifest with 3 pending entries, none in env → all in `pending`, others empty
   - **All collected**: Manifest with 2 collected entries, none in env → all in `collected`, others empty
   - **Key in env overrides manifest status**: An entry with `status: collected` but key IS in env → should appear in `existing`, not `collected`
   - **Missing manifest**: Call `getManifestStatus()` with a base path that has no manifest → returns `null`
   - **Empty manifest (no entries)**: Manifest file exists but has no H3 sections → returns `{ pending: [], collected: [], skipped: [], existing: [] }`

2. Each test creates a temp dir with `.gsd/milestones/M001/` structure, writes a `M001-SECRETS.md` manifest file, calls `getManifestStatus(tmpDir, "M001")`, and asserts the result. Use `process.env` manipulation for env-presence tests (save/restore in try/finally).

3. Add LLM-style round-trip tests to the end of `src/resources/extensions/gsd/tests/parsers.test.ts` (before the final summary output). Test cases:
   - **Extra whitespace**: Manifest with inconsistent indentation and trailing spaces → parse → format → parse produces semantically equal entries
   - **Missing optional fields**: Manifest with no Dashboard and no Format hint lines → parse fills defaults (empty strings), round-trip preserves them
   - **Extra blank lines**: Manifest with 3+ blank lines between sections → parser ignores them, round-trip produces clean output

4. Run all tests: `npx tsx src/resources/extensions/gsd/tests/manifest-status.test.ts` and `npx tsx src/resources/extensions/gsd/tests/parsers.test.ts`

5. Run `npm run build` and `npm run test` to confirm no regressions.

## Must-Haves

- [ ] `manifest-status.test.ts` covers: mixed statuses, all-pending, all-collected, env-override, missing manifest (null), empty manifest
- [ ] LLM-style round-trip tests added to `parsers.test.ts` covering: extra whitespace, missing optional fields, extra blank lines
- [ ] All new tests pass
- [ ] All existing 312+ parser tests still pass
- [ ] `npm run build` passes
- [ ] `npm run test` passes

## Verification

- `npx tsx src/resources/extensions/gsd/tests/manifest-status.test.ts` — all tests pass
- `npx tsx src/resources/extensions/gsd/tests/parsers.test.ts` — 312+ tests pass (existing + new)
- `npm run build` — no new errors
- `npm run test` — no new failures

## Observability Impact

- Signals added/changed: None (tests only)
- How a future agent inspects this: run the test files directly to verify contract health
- Failure state exposed: test assertion messages describe exactly which categorization or round-trip step failed

## Inputs

- `src/resources/extensions/gsd/files.ts` — `getManifestStatus()` from T01
- `src/resources/extensions/gsd/types.ts` — `ManifestStatus` type from T01
- `src/resources/extensions/gsd/tests/parsers.test.ts` — existing test patterns and assertions
- `src/resources/extensions/gsd/tests/secure-env-collect.test.ts` — reference for temp dir + env manipulation patterns

## Expected Output

- `src/resources/extensions/gsd/tests/manifest-status.test.ts` — new file with 6+ test cases
- `src/resources/extensions/gsd/tests/parsers.test.ts` — 3 new LLM-style round-trip test blocks appended
