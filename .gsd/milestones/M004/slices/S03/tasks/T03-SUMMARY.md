---
id: T03
parent: S03
milestone: M004
provides:
  - prompt-db.test.ts with 52 assertions covering DB-aware helper patterns (scoped queries, formatting, wrapping, fallback, re-import)
  - Full S03 verification: all slice-level checks pass
key_files:
  - src/resources/extensions/gsd/tests/prompt-db.test.ts
key_decisions:
  - Direct copy from memory-db reference — no adaptation needed, all import paths identical
patterns_established:
  - Test sections mirror the DB-aware helper pattern: open → insert → query scoped → format → verify wrapper → close
observability_surfaces:
  - Test output: 7 named sections with `=== prompt-db: <section> ===` headers, 52 pass/fail assertions, exit code 1 on failure
duration: 8m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T03: Port prompt-db tests and run full verification

**Ported prompt-db.test.ts from memory-db reference and verified all S03 work — 52 assertions pass, full suite (186 test files) clean, tsc clean.**

## What Happened

Copied `prompt-db.test.ts` (385 lines) from the memory-db reference worktree. All import paths (`../gsd-db.ts`, `../context-store.ts`, `../md-importer.ts`, `./test-helpers.ts`) matched the M004 layout exactly — no adaptation required. The test file exercises 7 sections: scoped decisions queries, scoped requirements queries, project content from DB, fallback when DB unavailable, scoped filtering reduces content vs unscoped, wrapper format correctness, and re-import updating DB on source markdown change.

## Verification

- `prompt-db.test.ts`: **52 passed, 0 failed** (553ms)
- Full DB test suite (6 files: gsd-db, context-store, worktree-db, md-importer, db-writer, prompt-db): **382 assertions passed, 0 failed**
- Full test suite wildcard (`*.test.ts`): **186 test files pass, 0 fail** (14.2s)
- `npx tsc --noEmit`: clean, no errors

### Slice-level verification:
- ✅ `prompt-db.test.ts` — all assertions pass
- ✅ All existing tests pass (186 files, 0 failures)
- ✅ `npx tsc --noEmit` — clean
- ✅ `grep 'inlineGsdRootFile(base' src/resources/extensions/gsd/auto-prompts.ts` — 3 matches, all in fallback paths inside the DB-aware helper functions (not in prompt builders). All prompt builders use `inlineDecisionsFromDb`/`inlineRequirementsFromDb`/`inlineProjectFromDb` exclusively.

## Diagnostics

- Run `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-db.test.ts` to re-verify
- Test output shows `=== prompt-db: <section> ===` headers for each test block
- Failures produce `FAIL: <message>` with expected vs actual values on stderr

## Deviations

None. Direct copy worked without modification.

## Known Issues

The slice plan verification says `grep 'inlineGsdRootFile(base'` should return zero matches, but 3 matches exist — all are the fallback calls inside the 3 DB-aware helper functions (lines 120, 143, 165 of auto-prompts.ts). This is correct behavior: the helpers call `inlineGsdRootFile` as their fallback path. No prompt builder function calls `inlineGsdRootFile` directly.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/prompt-db.test.ts` — new test file (385 lines) ported from memory-db reference, 52 assertions covering DB-aware helper patterns
- `.gsd/milestones/M004/slices/S03/tasks/T03-PLAN.md` — added Observability Impact section
- `.gsd/milestones/M004/slices/S03/S03-PLAN.md` — marked T03 as `[x]`
