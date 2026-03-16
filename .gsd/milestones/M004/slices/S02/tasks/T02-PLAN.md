---
estimated_steps: 3
estimated_files: 2
---

# T02: Port db-writer.ts and its test suite

**Slice:** S02 — Markdown Importers + Auto-Migration
**Milestone:** M004

## Description

Port the DB writer module from the memory-db reference worktree. This module generates DECISIONS.md and REQUIREMENTS.md markdown from arrays of typed objects, computes next decision IDs, and provides DB-first write helpers (`saveDecisionToDb`, `updateRequirementInDb`, `saveArtifactToDb`) that upsert to the database then regenerate the corresponding markdown file. The test suite proves round-trip fidelity: DB→generate→parse produces field-identical output.

## Steps

1. Copy `db-writer.ts` from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/db-writer.ts` to `src/resources/extensions/gsd/db-writer.ts`. Imports use `.js` extension convention (`./types.js`, `./paths.js`, `./files.js`). Uses `await import('./gsd-db.js')` for lazy loading in async write helpers — this avoids circular imports and the resolve-ts hook rewrites `.js` to `.ts` at test time.
2. Copy `db-writer.test.ts` from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/db-writer.test.ts` to `src/resources/extensions/gsd/tests/db-writer.test.ts`. Test file imports from `../gsd-db.ts`, `../md-importer.ts`, `../db-writer.ts`, `../types.ts` using `.ts` extension.
3. Run all tests (db-writer + S01 tests + md-importer) and TypeScript check to verify no regressions.

## Must-Haves

- [ ] `generateDecisionsMd()` exported — produces canonical DECISIONS.md with H1, HTML comment, table header, separator, data rows; escapes pipe characters in cell values
- [ ] `generateRequirementsMd()` exported — groups requirements by status into sections, only emits populated sections, appends Traceability table and Coverage Summary
- [ ] `nextDecisionId()` exported — queries MAX(CAST(SUBSTR(id,2) AS INTEGER)) from decisions table, returns D001 when empty, zero-pads to 3 digits
- [ ] `saveDecisionToDb()` exported — auto-assigns next ID, upserts to DB, fetches all decisions, generates markdown, writes file via `saveFile()`
- [ ] `updateRequirementInDb()` exported — verifies existence, merges updates, upserts, regenerates REQUIREMENTS.md; throws if requirement not found
- [ ] `saveArtifactToDb()` exported — inserts artifact to DB, writes file to disk at basePath/.gsd/path
- [ ] Round-trip tests pass: generate→parse produces field-identical output for both decisions and requirements
- [ ] Test suite passes: 76 assertions covering generators, round-trip, nextDecisionId, DB write helpers
- [ ] All S01 tests still pass; `npx tsc --noEmit` clean

## Verification

- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-writer.test.ts`
- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-db.test.ts src/resources/extensions/gsd/tests/context-store.test.ts src/resources/extensions/gsd/tests/worktree-db.test.ts src/resources/extensions/gsd/tests/md-importer.test.ts`
- `npx tsc --noEmit`

## Observability Impact

- **Stderr logging**: All three DB write helpers (`saveDecisionToDb`, `updateRequirementInDb`, `saveArtifactToDb`) emit `gsd-db:` prefixed stderr lines on failure, including the function name and error message. `nextDecisionId` also logs failures to stderr before falling back to `D001`.
- **Inspection**: After any write operation, the generated markdown file (DECISIONS.md or REQUIREMENTS.md) is immediately readable on disk. DB state can be queried directly via `_getAdapter()`.
- **Failure visibility**: `updateRequirementInDb` throws with the missing ID in the error message when a requirement doesn't exist. All write helpers re-throw after logging, so callers see the original error.

## Inputs

- `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/db-writer.ts` — source file to port (337 lines)
- `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/db-writer.test.ts` — test file to port (602 lines)
- `src/resources/extensions/gsd/md-importer.ts` — T01 output, provides `parseDecisionsTable`, `parseRequirementsSections` (needed for round-trip tests)
- `src/resources/extensions/gsd/gsd-db.ts` — S01 output, provides `openDatabase`, `closeDatabase`, `upsertDecision`, `upsertRequirement`, `insertArtifact`, `getDecisionById`, `getRequirementById`, `_getAdapter`
- `src/resources/extensions/gsd/paths.ts` — provides `resolveGsdRootFile`
- `src/resources/extensions/gsd/files.ts` — provides `saveFile` (async, atomic write with tmp+rename)
- `src/resources/extensions/gsd/types.ts` — provides `Decision`, `Requirement` interfaces
- `src/resources/extensions/gsd/tests/test-helpers.ts` — provides `createTestContext()` with `assertEq`, `assertTrue`, `assertMatch`, `report`

## Expected Output

- `src/resources/extensions/gsd/db-writer.ts` — new file, 337 lines, exports `generateDecisionsMd`, `generateRequirementsMd`, `nextDecisionId`, `saveDecisionToDb`, `updateRequirementInDb`, `saveArtifactToDb`
- `src/resources/extensions/gsd/tests/db-writer.test.ts` — new file, 602 lines, 76 assertions all passing
