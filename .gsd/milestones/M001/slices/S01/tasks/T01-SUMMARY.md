---
id: T01
parent: S01
milestone: M001
provides:
  - ManifestStatus type exported from types.ts
  - getManifestStatus() function exported from files.ts
key_files:
  - src/resources/extensions/gsd/types.ts
  - src/resources/extensions/gsd/files.ts
key_decisions:
  - Import checkExistingEnvKeys from ../get-secrets-from-user.ts (one level up from gsd/), not ../../ as the task plan suggested
patterns_established:
  - getManifestStatus() returns null for missing manifest (not empty object) — callers distinguish "no manifest" from "empty manifest"
observability_surfaces:
  - getManifestStatus() is a pure query — call it to inspect secrets status without side effects
duration: 10m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Implement getManifestStatus() and ManifestStatus type

**Added `ManifestStatus` type and `getManifestStatus()` function that reads a secrets manifest from disk and cross-references entries against the current environment.**

## What Happened

Added the `ManifestStatus` interface to `types.ts` with four string arrays: `pending`, `collected`, `skipped`, and `existing`. Added `getManifestStatus(base, milestoneId)` to `files.ts` that:

1. Resolves the manifest file path via `resolveMilestoneFile(base, milestoneId, "SECRETS")`
2. Loads the file with `loadFile()` — returns `null` if path resolution fails or file doesn't exist
3. Parses with `parseSecretsManifest()`
4. Cross-references keys against `.env` and `process.env` via `checkExistingEnvKeys()`
5. Categorizes: keys found in env → `existing`, otherwise → bucket matching the manifest entry's `status` field

## Verification

- `npm run build` — passes with no errors
- `npx tsx src/resources/extensions/gsd/tests/parsers.test.ts` — 312 passed, 0 failed
- `npm run test` — 125 passed, 19 failed (all 19 failures are pre-existing, confirmed by running on base branch)
- Manual inspection: `getManifestStatus` exported with correct signature, `ManifestStatus` exported from types

### Slice-level verification status (T01 of 2):
- `manifest-status.test.ts` — not yet created (T02 scope)
- `parsers.test.ts` — ✅ 312 tests pass, LLM-style round-trip tests not yet added (T02 scope)
- `npm run build` — ✅ passes
- `npm run test` — ✅ no new failures

## Diagnostics

Call `getManifestStatus(base, milestoneId)` — returns `ManifestStatus | null`. Returns `null` when no manifest file exists. Returns an object with empty arrays when the manifest exists but has no entries. Each entry is categorized by environment presence first, then manifest status.

## Deviations

The task plan specified the import path as `../../get-secrets-from-user.ts` but the correct relative path from `src/resources/extensions/gsd/files.ts` to `src/resources/extensions/get-secrets-from-user.ts` is `../get-secrets-from-user.ts` (one directory up, not two). Fixed during implementation — caught by the build step.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/types.ts` — Added `ManifestStatus` interface after `SecretsManifest`
- `src/resources/extensions/gsd/files.ts` — Added `resolve` import from `node:path`, `checkExistingEnvKeys` import, `ManifestStatus` type import, and `getManifestStatus()` function (~35 lines)
