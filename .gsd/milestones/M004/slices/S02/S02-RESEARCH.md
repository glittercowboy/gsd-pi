# S02: Markdown Importers + Auto-Migration — Research

**Date:** 2026-03-15

## Summary

This is a straightforward port of two well-tested modules from the memory-db worktree (`md-importer.ts` and `db-writer.ts`) into the current M004 worktree. All upstream dependencies are already in place from S01 — `gsd-db.ts` exports every function the importer needs (`upsertDecision`, `upsertRequirement`, `insertArtifact`, `openDatabase`, `transaction`, `_getAdapter`), and the utility functions it imports (`resolveGsdRootFile`, `milestonesDir`, `resolveTaskFiles`, `findMilestoneIds`) all exist in the current codebase with compatible signatures.

The key risk — whether the memory-db parsers handle the current file formats — is retired. The current DECISIONS.md uses the exact pipe-table format the parser expects (48 decision rows, all with 7 columns, no unescaped pipe characters in cells). The current REQUIREMENTS.md uses the exact section/bullet format the parser expects (55 requirements across `## Active`, `## Validated`, `## Deferred`, `## Out of Scope` sections with `### RXXX — Title` headings and `- Field: value` bullets). No format drift has occurred.

## Recommendation

Direct port with minimal adaptation. Copy `md-importer.ts` and `db-writer.ts` from the memory-db worktree, adjusting only the import paths (`.js` extension convention used in the current codebase). Port the corresponding test files (`md-importer.test.ts` and `db-writer.test.ts`) as-is — they use the same `test-helpers.ts` framework already present in the M004 worktree.

Auto-migration wiring into `startAuto()` is S03 scope (dual-write integration), not S02. S02 delivers the modules and proves they work via tests. The boundary map confirms: S02 produces `migrateFromMarkdown()` and individual parsers; S03 consumes them.

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/md-importer.ts` — **new file**, port from memory-db (526 lines). Contains `parseDecisionsTable()`, `parseRequirementsSections()`, `migrateFromMarkdown()`, plus internal helpers for hierarchy artifact walking. Imports from `gsd-db.ts` (S01), `paths.ts`, and `guided-flow.ts` (both existing).
- `src/resources/extensions/gsd/db-writer.ts` — **new file**, port from memory-db (337 lines). Contains `generateDecisionsMd()`, `generateRequirementsMd()`, `nextDecisionId()`, `saveDecisionToDb()`, `updateRequirementInDb()`, `saveArtifactToDb()`. Imports from `gsd-db.ts` (S01), `paths.ts`, `files.ts`, `md-importer.ts` (for round-trip parsing in tests).
- `src/resources/extensions/gsd/tests/md-importer.test.ts` — **new file**, port from memory-db (290 lines, ~55 assertions). Tests parser correctness, supersession detection, orchestrator behavior, idempotent re-import, missing file handling, round-trip fidelity.
- `src/resources/extensions/gsd/tests/db-writer.test.ts` — **new file**, port from memory-db (370 lines, ~50 assertions). Tests markdown generation, round-trip through parse→generate→parse, `nextDecisionId`, `saveDecisionToDb`, `updateRequirementInDb`, `saveArtifactToDb`.

### Existing Files (read-only dependencies)

- `src/resources/extensions/gsd/gsd-db.ts` — S01 output. All needed exports present: `openDatabase`, `closeDatabase`, `upsertDecision`, `upsertRequirement`, `insertArtifact`, `getDecisionById`, `getRequirementById`, `getActiveDecisions`, `getActiveRequirements`, `transaction`, `_getAdapter`, `isDbAvailable`.
- `src/resources/extensions/gsd/paths.ts` — `resolveGsdRootFile('DECISIONS'|'REQUIREMENTS')`, `milestonesDir()`, `resolveTaskFiles()`.
- `src/resources/extensions/gsd/guided-flow.ts` — `findMilestoneIds()`.
- `src/resources/extensions/gsd/files.ts` — `saveFile()` (async, atomic write with tmp+rename).
- `src/resources/extensions/gsd/types.ts` — `Decision`, `Requirement` interfaces (added in S01).
- `src/resources/extensions/gsd/tests/test-helpers.ts` — `createTestContext()` assertion framework.
- `src/resources/extensions/gsd/tests/resolve-ts.mjs` + `resolve-ts-hooks.mjs` — ESM test resolver.

### Build Order

1. **Port `md-importer.ts` first** — it has no dependency on `db-writer.ts` and is the foundation (parsers + migration orchestrator).
2. **Port `md-importer.test.ts`** — verify parsers work against fixture data and the orchestrator runs correctly. This proves R047.
3. **Port `db-writer.ts`** — depends on `md-importer.ts` parsers for round-trip verification in tests.
4. **Port `db-writer.test.ts`** — verify markdown generators round-trip through parsers. This proves R048.

### Verification Approach

Run from the M004 worktree root:

```bash
# md-importer tests
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/md-importer.test.ts

# db-writer tests
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/db-writer.test.ts

# Existing tests still pass
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/gsd-db.test.ts \
  src/resources/extensions/gsd/tests/context-store.test.ts \
  src/resources/extensions/gsd/tests/worktree-db.test.ts

# TypeScript clean
npx tsc --noEmit
```

Observable success: all parser tests pass (decisions parsed with supersession chains, requirements parsed across all 4 status sections), round-trip tests pass (generate→parse produces field-identical output), orchestrator imports a fixture tree with decisions/requirements/artifacts all queryable from DB.

## Constraints

- **`saveFile` is async** — `db-writer.ts` functions `saveDecisionToDb`, `updateRequirementInDb`, `saveArtifactToDb` are async because they call `saveFile`. The markdown generators (`generateDecisionsMd`, `generateRequirementsMd`) are sync.
- **`findMilestoneIds` import from `guided-flow.ts`** — this function is in the guided-flow module, not in paths.ts. The memory-db importer imports it from there. This works but creates a dependency on the guided-flow module during import. If this causes circular dependency issues at runtime, the function could be extracted, but it's unlikely given it's a simple filesystem read.
- **`--experimental-sqlite` required** — all test commands must include this flag for Node 22.

## Common Pitfalls

- **Pipe characters in decision cells** — the parser splits on `|`. Current DECISIONS.md has no unescaped pipes in cell content (backtick-wrapped code doesn't contain pipes). The db-writer's `generateDecisionsMd` escapes pipes via `.replace(/\|/g, '\\|')`. If a future decision contains a pipe, the generator handles it but the parser would need updating to handle escaped pipes. Low risk — flag but don't fix preemptively.
- **Requirements deduplication** — `parseRequirementsSections` deduplicates by ID, keeping the first occurrence and merging non-empty fields from later ones. The current REQUIREMENTS.md has no duplicate IDs across sections, so this is defensive code that works correctly.
- **`db-writer.ts` uses `await import('./gsd-db.js')` for lazy loading** — this is the memory-db pattern for avoiding circular imports. The dynamic import resolves `gsd-db.js` which the resolve-ts hook rewrites to `gsd-db.ts`. Works in both pi runtime and test runner.
