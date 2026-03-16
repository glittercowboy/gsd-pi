# S02: Markdown Importers + Auto-Migration

**Goal:** Existing GSD projects with markdown files can be imported into the SQLite database. All artifact types (decisions, requirements, hierarchy artifacts) parse correctly and round-trip through generate→parse with field fidelity.

**Demo:** Run `migrateFromMarkdown(projectDir)` on a fixture tree → gsd.db has all decisions/requirements/artifacts queryable. Run `generateDecisionsMd(decisions)` → parse the output → get identical field values back.

## Must-Haves

- `parseDecisionsTable()` parses DECISIONS.md pipe-table format with supersession chain detection
- `parseRequirementsSections()` parses REQUIREMENTS.md across all 4 status sections (Active, Validated, Deferred, Out of Scope)
- `migrateFromMarkdown()` orchestrator imports decisions + requirements + hierarchy artifacts in a single transaction
- Idempotent re-import (running twice produces same DB state, no duplicates)
- Missing files handled gracefully (no errors, zero counts)
- `generateDecisionsMd()` produces canonical DECISIONS.md from Decision arrays with pipe escaping
- `generateRequirementsMd()` produces canonical REQUIREMENTS.md with section grouping, traceability table, coverage summary
- `nextDecisionId()` computes next D-number from DB state
- `saveDecisionToDb()`, `updateRequirementInDb()`, `saveArtifactToDb()` — DB-first write helpers that upsert then regenerate markdown
- Round-trip fidelity: generate→parse produces field-identical output for both decisions and requirements

## Proof Level

- This slice proves: contract
- Real runtime required: no (in-memory SQLite + fixture trees sufficient)
- Human/UAT required: no

## Verification

- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/md-importer.test.ts` — 71 assertions covering parsers, supersession, orchestrator, idempotency, missing files, round-trip
- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-writer.test.ts` — 76 assertions covering markdown generators, round-trip through parse→generate→parse, nextDecisionId, saveDecisionToDb, updateRequirementInDb, saveArtifactToDb
- Existing S01 tests still pass (gsd-db.test.ts, context-store.test.ts, worktree-db.test.ts)
- `npx tsc --noEmit` clean
- Failure-path check: `migrateFromMarkdown()` on a directory with no .gsd/ files completes without error and logs zero counts to stderr; `parseDecisionsTable('')` returns empty array; orchestrator per-category try/catch emits `gsd-migrate:` prefixed skip reasons inspectable in stderr output

## Observability / Diagnostics

- Runtime signals: `gsd-migrate:` prefixed stderr log lines with import counts per artifact type
- Inspection surfaces: DB queries against decisions/requirements/artifacts tables after migration
- Failure visibility: Per-category try/catch in orchestrator logs skip reasons to stderr; individual parse errors surface via test assertions
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `gsd-db.ts` (openDatabase, closeDatabase, upsertDecision, upsertRequirement, insertArtifact, transaction, _getAdapter, getDecisionById, getRequirementById, getActiveDecisions, getActiveRequirements, isDbAvailable), `paths.ts` (resolveGsdRootFile, milestonesDir, resolveTaskFiles), `guided-flow.ts` (findMilestoneIds), `files.ts` (saveFile), `types.ts` (Decision, Requirement)
- New wiring introduced in this slice: none — modules are standalone, consumed by S03 (dual-write) and S05 (worktree import)
- What remains before the milestone is truly usable end-to-end: S03 wires auto-migration into `startAuto()` and prompt builders; S05 wires into worktree create; S06 wires structured LLM tools

## Tasks

- [x] **T01: Port md-importer.ts and its test suite** `est:20m`
  - Why: Foundation — parsers and migration orchestrator that all downstream slices depend on. Directly proves R047 (auto-migration) and the import half of R048 (round-trip fidelity).
  - Files: `src/resources/extensions/gsd/md-importer.ts`, `src/resources/extensions/gsd/tests/md-importer.test.ts`
  - Do: Copy md-importer.ts from memory-db worktree at `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/md-importer.ts`. All import paths already use `.js` extension convention. No adaptation needed — the file imports from `gsd-db.js`, `paths.js`, `guided-flow.js`, `types.js`, all of which exist in the M004 worktree with compatible exports. Copy md-importer.test.ts from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/md-importer.test.ts`. Test file imports from `../gsd-db.ts` and `../md-importer.ts` using `.ts` extension (resolved by resolve-ts.mjs hook).
  - Verify: `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/md-importer.test.ts` — all 71 assertions pass
  - Done when: md-importer.ts exports `parseDecisionsTable`, `parseRequirementsSections`, `migrateFromMarkdown`; test suite passes with 71 assertions; `npx tsc --noEmit` clean

- [x] **T02: Port db-writer.ts and its test suite** `est:20m`
  - Why: Completes the DB↔markdown bidirectional bridge. Generators + write helpers are consumed by S06 (structured LLM tools) and S03 (dual-write). Proves R048 round-trip fidelity (generate→parse→compare).
  - Files: `src/resources/extensions/gsd/db-writer.ts`, `src/resources/extensions/gsd/tests/db-writer.test.ts`
  - Do: Copy db-writer.ts from memory-db worktree at `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/db-writer.ts`. Imports from `types.js`, `paths.js`, `files.js` — all exist with compatible exports. Uses `await import('./gsd-db.js')` for lazy loading (avoids circular imports). Copy db-writer.test.ts from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/db-writer.test.ts`. Test imports from `../gsd-db.ts`, `../md-importer.ts`, `../db-writer.ts`, `../types.ts`.
  - Verify: `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-writer.test.ts` — all 76 assertions pass
  - Done when: db-writer.ts exports `generateDecisionsMd`, `generateRequirementsMd`, `nextDecisionId`, `saveDecisionToDb`, `updateRequirementInDb`, `saveArtifactToDb`; test suite passes with 76 assertions; all S01 tests still pass; `npx tsc --noEmit` clean

## Files Likely Touched

- `src/resources/extensions/gsd/md-importer.ts` (new — 526 lines)
- `src/resources/extensions/gsd/db-writer.ts` (new — 337 lines)
- `src/resources/extensions/gsd/tests/md-importer.test.ts` (new — 411 lines)
- `src/resources/extensions/gsd/tests/db-writer.test.ts` (new — 602 lines)
