# S03: Surgical Prompt Injection + Dual-Write

**Goal:** All 11 `build*Prompt()` functions in `auto-prompts.ts` use scoped DB queries instead of `inlineGsdRootFile`. DB lifecycle wired into auto-mode (init, re-import, cleanup). Falls back to filesystem when DB unavailable.
**Demo:** `grep -c 'inlineGsdRootFile(base' auto-prompts.ts` returns 0 for data-artifact calls in prompt builders. DB opens on `startAuto()`, re-imports after each unit in `handleAgentEnd()`, closes on `stopAuto()`.

## Must-Haves

- 3 DB-aware inline helpers (`inlineDecisionsFromDb`, `inlineRequirementsFromDb`, `inlineProjectFromDb`) that fall back to `inlineGsdRootFile` when DB unavailable or empty
- All 19 `inlineGsdRootFile` data-artifact calls replaced across 9 prompt builders with correct scoping (decisions by milestone, requirements by slice in slice-level builders, unscoped in milestone-level builders)
- `inlineGsdRootFile` function definition and export preserved (used as fallback by helpers)
- DB auto-migration in `startAuto()` — if `.gsd/` has markdown but no `gsd.db`, import on first run
- DB open in `startAuto()` — if `gsd.db` exists, open it
- DB re-import in `handleAgentEnd()` — after doctor + rebuildState + auto-commit, re-import markdown into DB
- DB close in `stopAuto()` — hygiene cleanup
- All placement constraints respected (DB init after worktree setup, re-import before post-unit hooks)
- Dynamic imports in helpers (`await import("./context-store.js")`) to avoid circular dependencies
- Fallback to filesystem when DB unavailable — no crash, no visible error

## Proof Level

- This slice proves: integration
- Real runtime required: no (unit tests exercise the DB-aware helpers and lifecycle wiring patterns)
- Human/UAT required: no

## Verification

- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-db.test.ts` — all assertions pass
- All existing tests pass (361+): `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/*.test.ts`
- `npx tsc --noEmit` — clean, no errors
- `grep 'inlineGsdRootFile(base' src/resources/extensions/gsd/auto-prompts.ts` — returns zero matches (the function definition line uses different syntax)

## Observability / Diagnostics

- Runtime signals: `gsd-migrate:` prefixed stderr lines during auto-migration in `startAuto()`, `gsd-db:` prefixed stderr on re-import failure in `handleAgentEnd()`
- Inspection surfaces: `isDbAvailable()` boolean, `getDbProvider()` provider name
- Failure visibility: stderr logs on migration failure, re-import failure, or DB open failure — all non-fatal with graceful fallback
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `gsd-db.ts` (`openDatabase`, `closeDatabase`, `isDbAvailable`), `context-store.ts` (`queryDecisions`, `queryRequirements`, `queryProject`, `formatDecisionsForPrompt`, `formatRequirementsForPrompt`), `md-importer.ts` (`migrateFromMarkdown`)
- New wiring introduced in this slice: DB lifecycle in `auto.ts` (init + migration in `startAuto`, re-import in `handleAgentEnd`, close in `stopAuto`); 3 DB-aware helpers in `auto-prompts.ts` replacing 19 direct filesystem calls
- What remains before the milestone is truly usable end-to-end: S04 (token measurement + state derivation), S05 (worktree DB isolation), S06 (structured LLM tools + inspect), S07 (integration verification)

## Tasks

- [x] **T01: Add DB-aware helpers and rewire all prompt builders** `est:45m`
  - Why: Core value delivery — this is where prompt injection switches from whole-file dumps to scoped DB queries. The 3 helpers and 19 call replacements are in the same file, tightly coupled, and best done together.
  - Files: `src/resources/extensions/gsd/auto-prompts.ts`
  - Do: Add 3 DB-aware helper functions (`inlineDecisionsFromDb`, `inlineRequirementsFromDb`, `inlineProjectFromDb`) after the existing `inlineGsdRootFile` export. Each uses dynamic `import("./context-store.js")` and `import("./gsd-db.js")`, guards with `isDbAvailable()`, falls back to `inlineGsdRootFile`. Then replace all 19 `inlineGsdRootFile` data-artifact calls in 9 prompt builders per the exact replacement map in research. Scoping: decisions always by `mid`, requirements by `sid` only in slice-level builders (`buildResearchSlicePrompt`, `buildPlanSlicePrompt`, `buildCompleteSlicePrompt`), unscoped in milestone-level builders. Leave `buildExecuteTaskPrompt` and `buildRewriteDocsPrompt` untouched. Keep `inlineGsdRootFile` exported.
  - Verify: `npx tsc --noEmit` clean. `grep 'inlineGsdRootFile(base' src/resources/extensions/gsd/auto-prompts.ts` returns 0 matches in builder functions.
  - Done when: All 19 data-artifact calls use DB-aware helpers, TypeScript compiles, `inlineGsdRootFile` still exported as fallback.

- [x] **T02: Wire DB lifecycle into auto.ts** `est:30m`
  - Why: Without lifecycle wiring, the DB layer from S01/S02 is never opened, populated, or refreshed during auto-mode. This connects the plumbing.
  - Files: `src/resources/extensions/gsd/auto.ts`
  - Do: (1) In `startAuto()`, after `.gsd/` bootstrap and after auto-worktree creation (after the worktree try/catch block, before `initMetrics`): add auto-migration block (if `gsd.db` doesn't exist but markdown files do, open DB + `migrateFromMarkdown`), then open existing DB block (if `gsd.db` exists but not yet opened). Use dynamic imports for `gsd-db.js` and `md-importer.js`. All wrapped in try/catch, non-fatal, stderr logging. (2) In `handleAgentEnd()`, after the doctor + rebuildState + auto-commit block but BEFORE the post-unit hooks section: add re-import block guarded by `isDbAvailable()`, calling `migrateFromMarkdown(basePath)`. Non-fatal, stderr on failure. (3) In `stopAuto()`, after worktree teardown but before metrics finalization: add `closeDatabase()` call guarded by `isDbAvailable()`, non-fatal. (4) Add `isDbAvailable` to imports from `./gsd-db.js`.
  - Verify: `npx tsc --noEmit` clean. `grep -n 'isDbAvailable\|openDatabase\|closeDatabase\|migrateFromMarkdown' src/resources/extensions/gsd/auto.ts` shows all 4 functions referenced.
  - Done when: DB opens on startAuto, re-imports in handleAgentEnd, closes on stopAuto, all with graceful fallback.

- [x] **T03: Port prompt-db tests and run full verification** `est:30m`
  - Why: Proves the DB-aware helpers return scoped content, fall back correctly, and that scoping actually reduces content size. Also ensures all existing tests still pass.
  - Files: `src/resources/extensions/gsd/tests/prompt-db.test.ts`
  - Do: Port `prompt-db.test.ts` from `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/prompt-db.test.ts`. The reference file (385 lines) uses `createTestContext` from `test-helpers.ts`, imports from `gsd-db.ts` and `context-store.ts`. Tests: (a) scoped decisions queries return fewer results than unscoped, (b) scoped requirements by sliceId filter correctly, (c) project query returns content from DB, (d) formatted output matches `### Label\nSource: ...\n\n<content>` wrapping pattern, (e) fallback behavior when DB unavailable returns non-null from filesystem. Adapt import paths if needed (memory-db uses `.ts` extensions in test imports). Run full test suite to verify zero regressions.
  - Verify: `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-db.test.ts` — all assertions pass. Full suite: all existing + new tests pass. `npx tsc --noEmit` clean.
  - Done when: prompt-db.test.ts passes all assertions, full existing test suite passes with zero regressions, TypeScript compiles clean.

## Files Likely Touched

- `src/resources/extensions/gsd/auto-prompts.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/tests/prompt-db.test.ts`
