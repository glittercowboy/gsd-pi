---
id: T02
parent: S02
milestone: M004
provides:
  - generateDecisionsMd — canonical DECISIONS.md generator from Decision arrays with pipe escaping
  - generateRequirementsMd — REQUIREMENTS.md generator with section grouping, traceability table, coverage summary
  - nextDecisionId — computes next D-number from DB state (MAX+1, zero-padded)
  - saveDecisionToDb — auto-ID + upsert + regenerate DECISIONS.md
  - updateRequirementInDb — merge updates + upsert + regenerate REQUIREMENTS.md (throws on missing)
  - saveArtifactToDb — insert artifact to DB + write file to disk
key_files:
  - src/resources/extensions/gsd/db-writer.ts
  - src/resources/extensions/gsd/tests/db-writer.test.ts
key_decisions:
  - Direct port from memory-db worktree — no modifications needed
patterns_established:
  - "gsd-db:" prefixed stderr logging for DB write helper failures with function name context
  - Dynamic import (`await import('./gsd-db.js')`) in async write helpers to avoid circular imports
observability_surfaces:
  - stderr: `gsd-db: <functionName> failed: <message>` on write helper failures
  - stderr: `gsd-db: nextDecisionId failed: <message>` with D001 fallback
  - disk: DECISIONS.md / REQUIREMENTS.md regenerated after every DB write
duration: 4m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Port db-writer.ts and its test suite

**Ported DB writer module with markdown generators, ID sequencing, and DB-first write helpers — 127 assertions passing with full round-trip fidelity**

## What Happened

Copied `db-writer.ts` (338 lines) and `db-writer.test.ts` (602 lines) from the memory-db reference worktree. No modifications were needed — all import paths (`./types.js`, `./paths.js`, `./files.js`, dynamic `./gsd-db.js`) resolve correctly against the existing M004 module set. The test file uses `.ts` extensions resolved by the `resolve-ts.mjs` hook.

## Verification

- `db-writer.test.ts`: **127 assertions passed** (plan estimated ≥76) covering:
  - `generateDecisionsMd` round-trip, format, empty input, pipe escaping
  - `generateRequirementsMd` round-trip, section filtering, empty input
  - `nextDecisionId` — empty DB returns D001, after D005 returns D006
  - `saveDecisionToDb` — auto-ID, DB state, markdown file written, round-trip of written file
  - `updateRequirementInDb` — status merge, markdown regeneration, throws on missing ID
  - `saveArtifactToDb` — DB insertion, file written to disk at correct path
  - Full DB round-trip: insert via DB → generate markdown → parse → field-identical
- S01 regression tests: **133 assertions passed** (gsd-db: 41, context-store: 56, worktree-db: 36)
- T01 md-importer tests: **70 assertions passed**
- `npx tsc --noEmit`: clean

### Slice-level verification status (S02 has 2 tasks, both now complete):
- ✅ md-importer.test.ts — 70 assertions passing
- ✅ db-writer.test.ts — 127 assertions passing
- ✅ S01 tests still pass (gsd-db, context-store, worktree-db)
- ✅ `npx tsc --noEmit` clean
- ✅ All slice verification checks pass

## Diagnostics

- Write helper failures emit `gsd-db: <functionName> failed: <message>` to stderr
- `nextDecisionId` logs to stderr and falls back to D001 on failure
- After any write operation, inspect the generated `.gsd/DECISIONS.md` or `.gsd/REQUIREMENTS.md` on disk
- DB state queryable via `_getAdapter().prepare('SELECT * FROM decisions').all()`

## Deviations

None — direct port with no modifications required.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/db-writer.ts` — new file, 338 lines, exports 6 functions (generators, ID sequencer, write helpers)
- `src/resources/extensions/gsd/tests/db-writer.test.ts` — new file, 602 lines, 127 assertions
