---
id: T02
parent: S01
milestone: M001
provides:
  - Contract tests proving getManifestStatus() categorization logic
  - LLM-style round-trip tests proving manifest parser resilience to realistic LLM output
key_files:
  - src/resources/extensions/gsd/tests/manifest-status.test.ts
  - src/resources/extensions/gsd/tests/parsers.test.ts
key_decisions: []
patterns_established:
  - Manifest-status tests use temp dirs with full .gsd/milestones/M001/ structure and real SECRETS files
  - process.env manipulation with save/restore in try/finally for env-presence tests
observability_surfaces:
  - Run `npx tsx src/resources/extensions/gsd/tests/manifest-status.test.ts` to verify manifest status contract
  - Run `npx tsx src/resources/extensions/gsd/tests/parsers.test.ts` to verify parser round-trip contract (377 tests)
duration: 10m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T02: Add contract tests for getManifestStatus() and LLM-style round-trip parsing

**Created 7 manifest-status contract tests and 3 LLM-style round-trip parser tests proving the S01→S02 boundary contract**

## What Happened

Created `manifest-status.test.ts` with 7 test cases using `node:test` + `assert/strict`:
- Mixed statuses: pending/collected/skipped entries + one key in env → correct categorization
- All pending: 3 pending entries, none in env → all in pending
- All collected: 2 collected entries, none in env → all in collected
- Env override: collected entry with key present in process.env → appears in existing, not collected
- Missing manifest: no .gsd directory → returns null
- Empty manifest: manifest file with no H3 sections → returns empty arrays in all categories
- .env file: key present only in .env file (not process.env) → correctly detected as existing

Added 3 LLM-style round-trip test blocks to `parsers.test.ts`:
- Extra whitespace: inconsistent indentation, trailing spaces → parse strips them, round-trip produces clean output
- Missing optional fields: no Dashboard/Format hint lines → defaults to empty strings, round-trip preserves
- Extra blank lines: 3+ blank lines between sections → parser ignores them, formatted output is clean

## Verification

- `npx tsx src/resources/extensions/gsd/tests/manifest-status.test.ts` — 7/7 pass
- `npx tsx src/resources/extensions/gsd/tests/parsers.test.ts` — 377/377 pass (was ~312 baseline + new LLM tests)
- `npm run build` — passes
- `npm run test` — all new tests pass in suite (19 pre-existing failures unrelated to this work)

## Diagnostics

Run test files directly to verify contract health:
- `npx tsx src/resources/extensions/gsd/tests/manifest-status.test.ts` — 7 tests covering categorization logic
- `npx tsx src/resources/extensions/gsd/tests/parsers.test.ts` — 377 tests including LLM resilience

Assertion messages describe exactly which categorization or round-trip step failed.

## Deviations

Added a 7th test (`.env file detection`) beyond the 6 specified in the plan — verifies that `checkExistingEnvKeys` integration works via .env file, not just process.env.

## Known Issues

None

## Files Created/Modified

- `src/resources/extensions/gsd/tests/manifest-status.test.ts` — new file with 7 getManifestStatus contract tests
- `src/resources/extensions/gsd/tests/parsers.test.ts` — appended 3 LLM-style round-trip test blocks (extra whitespace, missing optional fields, extra blank lines)
