---
estimated_steps: 4
estimated_files: 2
---

# T01: Implement getManifestStatus() and ManifestStatus type

**Slice:** S01 — Manifest Wiring & Prompt Verification
**Milestone:** M001

## Description

Add the `ManifestStatus` type and `getManifestStatus()` function — the primary contract this slice produces for S02 and S03. The function reads a secrets manifest from disk, cross-references each entry's status with the current environment (`.env` + `process.env`), and returns a categorized status object.

## Steps

1. Add `ManifestStatus` interface to `src/resources/extensions/gsd/types.ts` after the existing `SecretsManifest` interface (around line 137):
   ```ts
   export interface ManifestStatus {
     pending: string[];    // manifest status = pending AND not in env
     collected: string[];  // manifest status = collected AND not in env
     skipped: string[];    // manifest status = skipped
     existing: string[];   // key present in .env or process.env (regardless of manifest status)
   }
   ```

2. Add `getManifestStatus()` to `src/resources/extensions/gsd/files.ts`. Import `checkExistingEnvKeys` from `../../get-secrets-from-user.ts`, `resolveMilestoneFile` from `./paths.ts`, and `ManifestStatus` from `./types.ts`. Implementation:
   - Call `resolveMilestoneFile(base, milestoneId, "SECRETS")` — return `null` if no path resolved
   - Call `loadFile(resolvedPath)` — return `null` if file doesn't exist on disk
   - Parse with `parseSecretsManifest(content)`
   - Get all entry keys, call `checkExistingEnvKeys(keys, resolve(base, '.env'))`
   - Build result: iterate entries, put key in `existing` if in env, otherwise categorize by manifest `status` field (`pending` | `collected` | `skipped`)
   - Return the `ManifestStatus` object

3. Add necessary imports at the top of `files.ts`: `resolve` from `node:path` (if not already imported), `checkExistingEnvKeys` from `../../get-secrets-from-user.ts`, `resolveMilestoneFile` from `./paths.ts`, `ManifestStatus` from `./types.ts`.

4. Run `npm run build` to confirm no type errors or compilation failures.

## Must-Haves

- [ ] `ManifestStatus` type exported from `types.ts`
- [ ] `getManifestStatus()` exported from `files.ts`
- [ ] Returns `null` when manifest file doesn't exist (both path resolution failure and file not on disk)
- [ ] Keys in env go to `existing` regardless of manifest status
- [ ] Keys not in env are categorized by their manifest `status` field
- [ ] Uses `resolve(base, '.env')` for env file path (consistent with `secure_env_collect`)
- [ ] `npm run build` passes

## Verification

- `npm run build` completes with no new errors
- Manual inspection: `getManifestStatus` is exported and has correct signature

## Observability Impact

- Signals added/changed: `getManifestStatus()` returns `null` for missing manifest — callers can distinguish "no manifest" from "empty manifest"
- How a future agent inspects this: call `getManifestStatus(base, mid)` — pure query, no side effects
- Failure state exposed: graceful degradation — unrecognized status values default to `pending` via the parser

## Inputs

- `src/resources/extensions/gsd/types.ts` — existing `SecretsManifest`, `SecretsManifestEntry`, `SecretsManifestEntryStatus` types
- `src/resources/extensions/gsd/files.ts` — existing `parseSecretsManifest()`, `loadFile()`
- `src/resources/extensions/gsd/paths.ts` — existing `resolveMilestoneFile()`
- `src/resources/extensions/get-secrets-from-user.ts` — existing `checkExistingEnvKeys()`

## Expected Output

- `src/resources/extensions/gsd/types.ts` — `ManifestStatus` interface added (~5 lines)
- `src/resources/extensions/gsd/files.ts` — `getManifestStatus()` function added (~25 lines) with new imports
