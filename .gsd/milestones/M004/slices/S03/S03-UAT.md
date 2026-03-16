# S03: Surgical Prompt Injection + Dual-Write — UAT

**Milestone:** M004
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All changes are to prompt builder functions and auto-mode lifecycle hooks. Correctness is fully provable by examining generated prompt content and verifying DB operations execute at the right lifecycle points. No live runtime or human experience verification needed.

## Preconditions

- Node 22.5+ with `--experimental-sqlite` flag available
- Working directory is the M004 worktree (`.gsd/worktrees/M004/`)
- S01 and S02 DB infrastructure already built (gsd-db.ts, context-store.ts, md-importer.ts, db-writer.ts)

## Smoke Test

Run `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-db.test.ts` — should output `52 passed, 0 failed`.

## Test Cases

### 1. All prompt builders use DB-aware helpers (no direct inlineGsdRootFile calls)

1. Run `grep 'inlineGsdRootFile(base' src/resources/extensions/gsd/auto-prompts.ts`
2. **Expected:** Exactly 3 matches, all inside the fallback paths of `inlineDecisionsFromDb`, `inlineRequirementsFromDb`, `inlineProjectFromDb`. Zero matches inside any `build*Prompt()` function body.

### 2. DB-aware helper count matches expected wiring

1. Run `grep -c 'inlineDecisionsFromDb\|inlineRequirementsFromDb\|inlineProjectFromDb' src/resources/extensions/gsd/auto-prompts.ts`
2. **Expected:** 22 (3 function definitions + 19 call sites across 9 prompt builders)

### 3. Scoped decisions filtering returns fewer results than unscoped

1. Run prompt-db.test.ts
2. Inspect the `=== prompt-db: scoped filtering reduces content ===` section
3. **Expected:** Scoped query for a specific milestone returns fewer decisions than an unscoped query across all milestones. The assertion `scopedLength < unscopedLength` passes.

### 4. Scoped requirements filtering by sliceId works correctly

1. Run prompt-db.test.ts
2. Inspect the `=== prompt-db: scoped requirements from DB ===` section
3. **Expected:** Requirements query filtered by sliceId returns only requirements owned by or supporting that slice, not all requirements.

### 5. Fallback to filesystem when DB unavailable

1. Run prompt-db.test.ts
2. Inspect the `=== prompt-db: fallback when DB unavailable ===` section
3. **Expected:** When no DB is opened, `inlineDecisionsFromDb` returns non-null content loaded from the filesystem via `inlineGsdRootFile`. No crash, no error.

### 6. DB lifecycle wired into auto.ts at correct insertion points

1. Run `grep -n 'isDbAvailable\|openDatabase\|closeDatabase\|migrateFromMarkdown' src/resources/extensions/gsd/auto.ts`
2. **Expected:** 
   - `isDbAvailable` imported at top (line ~130)
   - `openDatabase` + `migrateFromMarkdown` in `startAuto()` (lines ~730-741)
   - `migrateFromMarkdown` in `handleAgentEnd()` (lines ~946-949)
   - `closeDatabase` in `stopAuto()` (lines ~404-407)

### 7. All DB lifecycle operations have error handling

1. Run `grep -n 'gsd-migrate:\|gsd-db:' src/resources/extensions/gsd/auto.ts`
2. **Expected:** 3 stderr log lines with descriptive prefixes:
   - `gsd-migrate: auto-migration failed:` in startAuto
   - `gsd-db: failed to open existing database:` in startAuto
   - `gsd-db: re-import failed:` in handleAgentEnd

### 8. Re-import updates DB when source markdown changes

1. Run prompt-db.test.ts
2. Inspect the `=== prompt-db: re-import updates DB when source markdown changes ===` section
3. **Expected:** After modifying a DECISIONS.md file and re-running `migrateFromMarkdown`, the DB returns the updated content.

### 9. TypeScript compilation clean

1. Run `npx tsc --noEmit` from the worktree root
2. **Expected:** Zero errors, zero output

### 10. Full test suite regression check

1. Run `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/*.test.ts`
2. **Expected:** 186 test files pass, 0 fail

## Edge Cases

### DB helpers with empty DB (no imported data)

1. Open a DB but don't import any markdown
2. Call `inlineDecisionsFromDb(base, "M001")`
3. **Expected:** Returns null or falls back to filesystem — does not return an empty wrapper with no content

### Auto-migration detection with no markdown files

1. Start auto-mode with a `.gsd/` directory that has no DECISIONS.md, REQUIREMENTS.md, or milestones/ directory
2. **Expected:** Auto-migration block is skipped entirely (no `gsd.db` created, no error)

### Re-import when DB is unavailable

1. In `handleAgentEnd`, `isDbAvailable()` returns false
2. **Expected:** Re-import block is skipped entirely (guard prevents dynamic import and `migrateFromMarkdown` call)

### buildExecuteTaskPrompt and buildRewriteDocsPrompt unchanged

1. Run `grep 'inlineDecisionsFromDb\|inlineRequirementsFromDb\|inlineProjectFromDb' src/resources/extensions/gsd/auto-prompts.ts` and check these two functions
2. **Expected:** Neither function contains any DB-aware helper calls — they were intentionally left untouched

## Failure Signals

- `prompt-db.test.ts` reports any assertion failures
- `npx tsc --noEmit` produces type errors
- Full test suite has failures (186 expected passes)
- `grep 'inlineGsdRootFile(base'` returns matches inside prompt builder functions (outside the 3 helper fallback paths)
- `grep -c` for DB-aware helpers returns fewer than 22
- auto.ts missing `isDbAvailable` import or any of the 3 lifecycle insertion points

## Requirements Proved By This UAT

- R049 — All prompt builders use scoped DB queries instead of whole-file dumps. Test cases 1-5 prove correct wiring and scoping.
- R050 — Re-import in handleAgentEnd keeps DB in sync after each unit's auto-commit. Test cases 6, 8 prove lifecycle wiring and re-import correctness.
- R046 — Full fallback chain: DB unavailable → helpers fall back to filesystem → lifecycle hooks skip DB ops. Test case 5 proves helper fallback, test cases 6-7 prove lifecycle non-fatality.

## Not Proven By This UAT

- Token savings quantification (S04 responsibility — R051, R057)
- Structured LLM tools using DB-first write direction (S06 responsibility — R055)
- Worktree DB copy/reconcile with new lifecycle hooks (S05 responsibility — R053, R054)
- Full auto-mode lifecycle integration test (S07 responsibility)
- Live runtime behavior under real auto-mode execution (requires running actual auto-mode with a mature project)

## Notes for Tester

- The `grep 'inlineGsdRootFile(base'` returning 3 matches is correct — these are the fallback calls inside the 3 DB-aware helpers. The plan originally said "returns zero" but the helpers legitimately call `inlineGsdRootFile` as their fallback path. Verify the 3 matches are all on lines inside `inlineDecisionsFromDb`, `inlineRequirementsFromDb`, and `inlineProjectFromDb` (approximately lines 120, 143, 165 of auto-prompts.ts).
- All tests require the `--experimental-sqlite` flag. Without it, the DB provider chain falls to null and DB-dependent tests may behave differently.
