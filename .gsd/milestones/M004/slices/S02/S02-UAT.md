# S02: Markdown Importers + Auto-Migration — UAT

**Milestone:** M004
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All deliverables are pure functions (parsers, generators, write helpers) with no UI, no server, and no runtime wiring. Contract correctness is fully provable via test assertions and artifact inspection.

## Preconditions

- Node 22.5+ with `--experimental-sqlite` support
- Working directory is the M004 worktree (`/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/M004`)
- S01 DB foundation modules exist (`gsd-db.ts`, `context-store.ts`)

## Smoke Test

Run the md-importer and db-writer test suites — both must pass with zero failures:

```bash
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/md-importer.test.ts
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-writer.test.ts
```

**Expected:** 70 passed (md-importer), 127 passed (db-writer), 0 failures in both.

## Test Cases

### 1. Decision Parsing — Pipe-Table Format

1. Create a DECISIONS.md with 4 rows including one with `(amends D002)` in the Decision column
2. Call `parseDecisionsTable(content)`
3. **Expected:** Returns 4 Decision objects. The amending row has `supersedes: 'D002'`. All fields (id, scope, decision, choice, rationale, revisable, when) populated correctly. Pipe characters inside cells are handled without corruption.

### 2. Requirements Parsing — Multi-Section Format

1. Create a REQUIREMENTS.md with all 4 sections (## Active, ## Validated, ## Deferred, ## Out of Scope), each with at least one requirement using bullet-field format (- Class:, - Status:, - Description:, etc.)
2. Call `parseRequirementsSections(content)`
3. **Expected:** Returns one Requirement object per section entry. Each has correct `status` matching its section header. Bullet fields (class, description, source, primaryOwner, validation, notes) all populated. Duplicate IDs across sections are deduplicated (last wins).

### 3. Full Migration Orchestrator

1. Create a temp directory with `.gsd/DECISIONS.md` (4 decisions), `.gsd/REQUIREMENTS.md` (5 requirements), and a milestone hierarchy (`.gsd/milestones/M001/M001-ROADMAP.md`, slices, tasks)
2. Call `migrateFromMarkdown(tmpDir)`
3. **Expected:** Returns `{decisions: 4, requirements: 5, artifacts: N}` where N matches the number of hierarchy files. DB has all rows queryable via `getActiveDecisions()`, `getActiveRequirements()`.

### 4. Idempotent Re-Import

1. Run `migrateFromMarkdown()` twice on the same fixture data
2. **Expected:** DB row counts are identical after both runs. No duplicate rows. Second run upserts over existing rows.

### 5. Round-Trip Fidelity — Decisions

1. Create Decision array, call `generateDecisionsMd(decisions)`
2. Parse the output with `parseDecisionsTable(generatedMd)`
3. **Expected:** Parsed decisions have field-identical values to the original array. Pipe characters in cell values are escaped in markdown and restored on parse.

### 6. Round-Trip Fidelity — Requirements

1. Create Requirement array with all 4 statuses, call `generateRequirementsMd(requirements)`
2. Parse the output with `parseRequirementsSections(generatedMd)`
3. **Expected:** Parsed requirements have field-identical values to the original array. Each requirement appears under the correct status section.

### 7. nextDecisionId Sequencing

1. Open empty in-memory DB, call `nextDecisionId()`
2. **Expected:** Returns `'D001'`
3. Insert decision D005, call `nextDecisionId()` again
4. **Expected:** Returns `'D006'`

### 8. saveDecisionToDb Write Helper

1. Call `saveDecisionToDb({scope: 'arch', decision: 'Test', choice: 'A', rationale: 'Because', revisable: 'No'})`
2. **Expected:** Decision inserted with auto-assigned ID (D001 if empty DB). `DECISIONS.md` file regenerated on disk. DB row matches passed fields.

### 9. updateRequirementInDb Write Helper

1. Insert requirement R001 into DB
2. Call `updateRequirementInDb('R001', {status: 'validated'})`
3. **Expected:** DB row updated with new status. `REQUIREMENTS.md` regenerated on disk.
4. Call `updateRequirementInDb('R999', {status: 'validated'})`
5. **Expected:** Throws error — requirement not found.

### 10. saveArtifactToDb Write Helper

1. Call `saveArtifactToDb({path: 'milestones/M001/M001-ROADMAP.md', content: '# Roadmap', type: 'roadmap'})`
2. **Expected:** Artifact row inserted in DB. File written to disk at the resolved path.

## Edge Cases

### Empty Input

1. Call `parseDecisionsTable('')`
2. **Expected:** Returns empty array, no error

### Missing Files in Migration

1. Call `migrateFromMarkdown()` on a directory with no `.gsd/` files
2. **Expected:** Completes without error. Returns `{decisions: 0, requirements: 0, artifacts: 0}`. Stderr shows `gsd-migrate: imported 0 decisions, 0 requirements, 0 artifacts`.

### Malformed Decision Rows

1. Provide DECISIONS.md with rows that have wrong column count or empty required fields
2. Call `parseDecisionsTable(content)`
3. **Expected:** Malformed rows are silently skipped. Valid rows still parse correctly.

### Pipe Characters in Cell Values

1. Create a decision with `|` characters in the Choice or Rationale field
2. Run through `generateDecisionsMd()` → `parseDecisionsTable()`
3. **Expected:** Pipe characters are escaped in the generated markdown (as `\|`) and correctly restored on parse.

## Failure Signals

- Any test assertion failure in md-importer.test.ts or db-writer.test.ts
- `npx tsc --noEmit` produces type errors
- S01 regression tests (gsd-db, context-store, worktree-db) fail after S02 changes
- `gsd-migrate:` stderr output shows unexpected zero counts on non-empty fixture data
- `gsd-db:` stderr output shows unexpected write helper failures
- Round-trip test produces field-mismatched values after generate→parse cycle

## Requirements Proved By This UAT

- R047 (Auto-migration) — parseDecisionsTable, parseRequirementsSections, migrateFromMarkdown proven via test cases 1-4 and edge cases. Wiring into startAuto() is S03 scope.
- R048 (Round-trip fidelity) — generate→parse→compare proven via test cases 5-6 and pipe escaping edge case.

## Not Proven By This UAT

- Auto-migration triggered at runtime (requires S03 wiring into `startAuto()`)
- Dual-write re-import after auto-commit (S03)
- Structured LLM tools using the write helpers (S06)
- Worktree import via `migrateFromMarkdown()` (S05)
- Token savings from surgical prompt injection (S04/S07)

## Notes for Tester

- The md-importer test harness reports 70 assertions vs the plan's 71. This is a harness counting artifact — all assertion calls in source execute. No functional gap.
- The db-writer test suite produced 127 assertions vs the plan's 76 estimate — the memory-db reference suite was more thorough than estimated. This is a surplus, not a deficit.
- All tests run against in-memory SQLite — no file-backed database or filesystem fixtures outside of temp directories created by the tests themselves.
