# S01: Manifest Wiring & Prompt Verification

**Goal:** The plan-milestone prompt produces a `M00x-SECRETS.md` file that round-trips through `parseSecretsManifest()`, and the manifest status can be queried by calling `getManifestStatus()`.
**Demo:** `getManifestStatus(base, "M001")` returns a categorized status object with `pending`, `collected`, `skipped`, and `existing` arrays. A realistic LLM-style manifest round-trips through `parseSecretsManifest() → formatSecretsManifest() → parseSecretsManifest()` with semantic equality.

## Must-Haves

- `getManifestStatus()` reads the manifest from disk, cross-references `.env`/`process.env` via `checkExistingEnvKeys()`, and returns `{ pending, collected, skipped, existing }` arrays
- `getManifestStatus()` returns `null` when no manifest file exists
- `ManifestStatus` type exported from `types.ts`
- Round-trip parser tests prove LLM-style manifests (varying whitespace, missing optional fields) survive `parse → format → parse` with semantic equality
- `getManifestStatus()` contract tests prove correct categorization across all status/env combinations
- `npm run build` passes with no new errors
- Existing test suite (`npm run test`) passes with no new failures

## Proof Level

- This slice proves: contract
- Real runtime required: no (all tests use filesystem fixtures and in-memory data)
- Human/UAT required: no

## Verification

- `npx tsx src/resources/extensions/gsd/tests/manifest-status.test.ts` — all tests pass (getManifestStatus categorization, missing manifest, edge cases)
- `npx tsx src/resources/extensions/gsd/tests/parsers.test.ts` — all 312+ existing tests pass, plus new LLM-style round-trip tests
- `npm run build` — passes with no new errors
- `npm run test` — no new failures in full suite

## Observability / Diagnostics

- Runtime signals: `getManifestStatus()` returns `null` for missing manifest (not empty object) — callers can distinguish "no manifest" from "manifest with zero entries"
- Inspection surfaces: `getManifestStatus()` is a pure query — any future agent can call it to inspect secrets status without side effects
- Failure visibility: parser returns `status: 'pending'` as default for unrecognized status values — malformed manifests degrade gracefully rather than throwing
- Redaction constraints: none (manifest contains key names and service metadata, never actual secret values)

## Integration Closure

- Upstream surfaces consumed: `parseSecretsManifest()` and `formatSecretsManifest()` from `files.ts`, `checkExistingEnvKeys()` from `get-secrets-from-user.ts`, `resolveMilestoneFile()` from `paths.ts`, `loadFile()` from `files.ts`
- New wiring introduced in this slice: `getManifestStatus()` function and `ManifestStatus` type — contract only, not yet consumed by any runtime flow
- What remains before the milestone is truly usable end-to-end: S02 (enhanced collection TUI with guidance rendering and summary screen), S03 (auto-mode entry gate and guided flow hookup that actually call `getManifestStatus()` and trigger collection)

## Tasks

- [x] **T01: Implement getManifestStatus() and ManifestStatus type** `est:30m`
  - Why: This is the core contract S02/S03 depend on — a function that reads a secrets manifest from disk, checks each entry against the environment, and returns categorized status
  - Files: `src/resources/extensions/gsd/types.ts`, `src/resources/extensions/gsd/files.ts`
  - Do: Add `ManifestStatus` interface to `types.ts` with `{ pending: string[], collected: string[], skipped: string[], existing: string[] }`. Add `getManifestStatus(base: string, milestoneId: string)` to `files.ts` that uses `resolveMilestoneFile()` + `loadFile()` + `parseSecretsManifest()` + `checkExistingEnvKeys()`. Return `null` when no manifest exists. Categorize: `existing` = key present in env (regardless of manifest status), `pending` = manifest status is pending AND not in env, `collected`/`skipped` = manifest status value AND not in env.
  - Verify: `npm run build` passes
  - Done when: `getManifestStatus()` is exported from `files.ts`, `ManifestStatus` is exported from `types.ts`, build succeeds

- [x] **T02: Add contract tests for getManifestStatus() and LLM-style round-trip parsing** `est:45m`
  - Why: Proves the S01→S02 boundary contract works and that the parser handles realistic LLM output variations
  - Files: `src/resources/extensions/gsd/tests/manifest-status.test.ts`, `src/resources/extensions/gsd/tests/parsers.test.ts`
  - Do: Create `manifest-status.test.ts` with tests covering: manifest with mixed statuses returns correct categorization, keys in env are in `existing` regardless of manifest status, missing manifest returns `null`, manifest with all-pending entries, manifest with all-collected entries. Add LLM-style round-trip tests to `parsers.test.ts`: manifest with extra whitespace, missing optional fields (no Dashboard, no Format hint), extra blank lines between sections.
  - Verify: `npx tsx src/resources/extensions/gsd/tests/manifest-status.test.ts` passes, `npx tsx src/resources/extensions/gsd/tests/parsers.test.ts` passes (312+ tests), `npm run build` passes, `npm run test` passes
  - Done when: All tests pass, no regressions in existing suite

## Files Likely Touched

- `src/resources/extensions/gsd/types.ts`
- `src/resources/extensions/gsd/files.ts`
- `src/resources/extensions/gsd/tests/manifest-status.test.ts` (new)
- `src/resources/extensions/gsd/tests/parsers.test.ts`
