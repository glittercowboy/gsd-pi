---
id: S03
parent: M004
milestone: M004
provides:
  - 3 DB-aware inline helpers (inlineDecisionsFromDb, inlineRequirementsFromDb, inlineProjectFromDb) with scoped filtering and silent fallback
  - All 19 prompt builder data-artifact calls rewired from inlineGsdRootFile to DB-aware helpers with correct milestone/slice scoping
  - DB lifecycle wired into auto-mode (init+migrate in startAuto, re-import in handleAgentEnd, close in stopAuto)
  - 52-assertion test suite proving scoped queries, formatting, wrapping, fallback, and re-import
requires:
  - slice: S01
    provides: gsd-db.ts (openDatabase, closeDatabase, isDbAvailable), context-store.ts (queryDecisions, queryRequirements, queryProject, formatDecisionsForPrompt, formatRequirementsForPrompt)
  - slice: S02
    provides: md-importer.ts (migrateFromMarkdown), markdown parsers for all artifact types
affects:
  - S04
  - S06
  - S07
key_files:
  - src/resources/extensions/gsd/auto-prompts.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/tests/prompt-db.test.ts
key_decisions:
  - Dynamic imports in DB-aware helpers (await import gsd-db.js, context-store.js) to avoid circular dependencies
  - Silent catch-and-fallback in helpers — DB failures degrade to filesystem with zero stderr noise
  - DB lifecycle placement: after worktree setup but before initMetrics in startAuto; re-import after doctor/rebuildState/commit but before post-unit hooks in handleAgentEnd; close after worktree teardown in stopAuto
  - All DB operations non-fatal with stderr prefix logging (gsd-migrate:, gsd-db:)
patterns_established:
  - DB-aware helper pattern: check isDbAvailable → dynamic import → query scoped → format → wrap with heading+source, else fallback to inlineGsdRootFile
  - Scoping convention: decisions always filtered by milestoneId; requirements filtered by sliceId only in slice-level builders (buildResearchSlicePrompt, buildPlanSlicePrompt, buildCompleteSlicePrompt), unscoped in milestone-level builders
  - DB lifecycle hook pattern: isDbAvailable() guard → dynamic import → operation → try/catch with stderr prefix logging → non-fatal continuation
observability_surfaces:
  - isDbAvailable() boolean indicates DB-sourced vs filesystem-sourced prompt content
  - "gsd-migrate: auto-migration failed:" stderr on first-run migration failure
  - "gsd-db: failed to open existing database:" stderr on DB open failure
  - "gsd-db: re-import failed:" stderr on re-import failure in handleAgentEnd
drill_down_paths:
  - .gsd/milestones/M004/slices/S03/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004/slices/S03/tasks/T02-SUMMARY.md
  - .gsd/milestones/M004/slices/S03/tasks/T03-SUMMARY.md
duration: 31m
verification_result: passed
completed_at: 2026-03-15
---

# S03: Surgical Prompt Injection + Dual-Write

**All 19 prompt builder data-artifact calls rewired from whole-file dumps to scoped DB queries with milestone/slice filtering, DB lifecycle wired into auto-mode (init, re-import, close), silent fallback to filesystem when DB unavailable.**

## What Happened

Three tasks delivered the core prompt injection rewiring and auto-mode integration:

**T01 (15m)** added 3 DB-aware inline helpers to `auto-prompts.ts` — `inlineDecisionsFromDb`, `inlineRequirementsFromDb`, `inlineProjectFromDb`. Each uses dynamic imports for `gsd-db.js` and `context-store.js` to avoid circular dependencies, guards with `isDbAvailable()`, and silently falls back to `inlineGsdRootFile` on failure. Then replaced all 19 `inlineGsdRootFile(base` calls across 9 prompt builders with the appropriate helper, applying correct scoping: decisions always by `mid`, requirements by `sid` only in slice-level builders, unscoped in milestone-level builders. `buildExecuteTaskPrompt` and `buildRewriteDocsPrompt` left untouched (no data-artifact calls). Created `prompt-db.test.ts` with 36 initial assertions.

**T02 (8m)** wired DB lifecycle into `auto.ts` at three insertion points: (1) `startAuto()` — after worktree setup, before `initMetrics`: auto-migration block (if `.gsd/` has markdown but no `gsd.db`, open DB + `migrateFromMarkdown`) plus open-existing block (if `gsd.db` exists but not yet opened); (2) `handleAgentEnd()` — after doctor/rebuildState/commit, before post-unit hooks: re-import via `migrateFromMarkdown(basePath)` so next unit's prompts use fresh DB content; (3) `stopAuto()` — after worktree teardown: `closeDatabase()` cleanup. All operations use dynamic imports, `basePath` for worktree awareness, and non-fatal try/catch with descriptive stderr logging.

**T03 (8m)** ported the full `prompt-db.test.ts` (385 lines, 52 assertions) from the memory-db reference. No adaptation needed — import paths matched exactly. Tests cover scoped decisions queries, scoped requirements queries, project content from DB, fallback when DB unavailable, scoped filtering reducing content vs unscoped, wrapper format correctness, and re-import updating DB on source markdown change.

## Verification

- `npx tsc --noEmit` — zero errors
- `prompt-db.test.ts` — 52 passed, 0 failed
- Full test suite — 186 test files, 186 pass, 0 fail
- `grep 'inlineGsdRootFile(base' auto-prompts.ts` — 3 matches, all inside fallback paths of DB-aware helpers (zero in prompt builder bodies)
- `grep -c 'inlineDecisionsFromDb|inlineRequirementsFromDb|inlineProjectFromDb' auto-prompts.ts` — 22 (3 definitions + 19 call sites)
- `grep -n 'isDbAvailable|openDatabase|closeDatabase|migrateFromMarkdown' auto.ts` — all 4 functions referenced at correct lifecycle points
- `grep -n 'gsd-migrate:|gsd-db:' auto.ts` — stderr logging at all 3 insertion points

## Requirements Advanced

- R049 — All 19 data-artifact calls rewired to DB-aware helpers with scoped filtering. 52 test assertions prove scoped queries return correct content. Prompt builders now inject only milestone-relevant decisions and slice-relevant requirements instead of entire files.
- R050 — Re-import in `handleAgentEnd()` keeps DB in sync after each dispatch unit's auto-commit. DB-first write direction (structured tools → DB → markdown) infrastructure established. Markdown-first direction (auto-commit → re-import → DB) wired and tested.
- R046 — Prompt builder fallback path now wired: all 3 DB-aware helpers fall back to `inlineGsdRootFile` when `isDbAvailable()` returns false. All lifecycle hooks non-fatal. Complete chain: DB unavailable → helpers fall back → auto.ts lifecycle skips DB ops → zero crash, zero visible error.

## Requirements Validated

- R046 — Full fallback chain now proven end-to-end: S01 proved DB layer returns empty results when unavailable, S03 proved prompt builders fall back to filesystem, and lifecycle hooks skip DB operations. Both halves of the contract are satisfied with test coverage.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

None. All 3 tasks executed as planned with no modifications needed.

## Known Limitations

- The `grep 'inlineGsdRootFile(base'` check from the slice plan returns 3 matches (not 0) because the 3 DB-aware helpers themselves call `inlineGsdRootFile` as their fallback path. This is correct behavior — the check validates that no prompt builder calls `inlineGsdRootFile` directly, which is true.
- DB-first write direction (structured tools writing to DB first, then generating markdown) is infrastructure only — the actual structured LLM tools are deferred to S06.
- Token savings measurement is not yet wired — that's S04's responsibility.

## Follow-ups

- S04 should wire `promptCharCount`/`baselineCharCount` measurement into the rewired prompt builders to prove the ≥30% savings claim.
- S06 should register the 3 structured LLM tools that use the dual-write infrastructure established here.
- S07 should run a full lifecycle test proving migration → scoped queries → re-import round-trip under auto-mode.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-prompts.ts` — added 3 DB-aware helper functions (~70 lines), replaced 19 call sites across 9 prompt builders
- `src/resources/extensions/gsd/auto.ts` — added isDbAvailable import, DB init/migrate block in startAuto(), re-import block in handleAgentEnd(), close block in stopAuto() (~35 lines)
- `src/resources/extensions/gsd/tests/prompt-db.test.ts` — new test file (385 lines), 52 assertions covering DB-aware helpers

## Forward Intelligence

### What the next slice should know
- The 3 DB-aware helpers (`inlineDecisionsFromDb`, `inlineRequirementsFromDb`, `inlineProjectFromDb`) are the primary integration surface. They accept optional `milestoneId`/`sliceId` params for scoping and return the same `string | null` type as `inlineGsdRootFile`.
- Re-import in `handleAgentEnd()` calls `migrateFromMarkdown(basePath)` which is idempotent — it upserts all rows, so repeated calls are safe.
- `isDbAvailable()` is the single guard for all DB-conditional logic. It's a static import from `gsd-db.js`.

### What's fragile
- Dynamic imports in the DB-aware helpers (`await import("./context-store.js")`) — if module paths change, the helpers will silently fall back to filesystem with no error. This is by design but could mask real import failures during refactoring.
- The `basePath` vs `base` distinction in auto.ts lifecycle hooks — `basePath` is worktree-aware (resolves to `.gsd/worktrees/M004/`), `base` is the original project root. Using the wrong one would import/query from the wrong `.gsd/` directory.

### Authoritative diagnostics
- `grep -c 'inlineDecisionsFromDb|inlineRequirementsFromDb|inlineProjectFromDb' auto-prompts.ts` should return ≥22 — if lower, a prompt builder was reverted to direct filesystem loading.
- `prompt-db.test.ts` exercises the full DB-aware helper pipeline — if it passes, the scoped injection is working correctly.
- Stderr prefixes `gsd-migrate:` and `gsd-db:` in auto-mode logs indicate lifecycle failures.

### What assumptions changed
- The memory-db reference `prompt-db.test.ts` required zero adaptation for import paths — the M004 worktree layout matches memory-db exactly. This suggests future S01/S02 test ports will also be direct copies.
