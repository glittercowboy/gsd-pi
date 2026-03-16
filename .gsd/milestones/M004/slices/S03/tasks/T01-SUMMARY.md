---
id: T01
parent: S03
milestone: M004
provides:
  - 3 DB-aware inline helpers (inlineDecisionsFromDb, inlineRequirementsFromDb, inlineProjectFromDb)
  - All 19 prompt builder data-artifact calls rewired to DB-aware helpers with correct scoping
key_files:
  - src/resources/extensions/gsd/auto-prompts.ts
  - src/resources/extensions/gsd/tests/prompt-db.test.ts
key_decisions:
  - Dynamic imports in helpers to avoid circular deps (await import gsd-db.js, context-store.js)
  - Silent catch-and-fallback pattern: DB failures degrade to filesystem with zero stderr noise
patterns_established:
  - DB-aware helper pattern: check isDbAvailable → query → format → wrap with heading+source, else fallback to inlineGsdRootFile
  - Scoping convention: decisions always by milestoneId, requirements by sliceId only in slice-level builders
observability_surfaces:
  - isDbAvailable() boolean indicates whether DB-sourced or filesystem-sourced content is being injected
duration: 15m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Add DB-aware helpers and rewire all prompt builders

**Added 3 DB-aware inline helpers and replaced all 19 inlineGsdRootFile data-artifact calls across 9 prompt builders with correct milestone/slice scoping.**

## What Happened

Added 3 exported async helper functions to `auto-prompts.ts` after the existing `inlineGsdRootFile` definition:

- `inlineDecisionsFromDb(base, milestoneId?, scope?)` — queries decisions filtered by milestone, formats as markdown table, falls back to `inlineGsdRootFile`
- `inlineRequirementsFromDb(base, sliceId?)` — queries requirements filtered by slice, formats as structured sections, falls back to `inlineGsdRootFile`  
- `inlineProjectFromDb(base)` — queries PROJECT.md artifact from DB, falls back to `inlineGsdRootFile`

All 3 use dynamic `import()` for `gsd-db.js` and `context-store.js` to avoid circular dependencies. Each guards with `isDbAvailable()` and wraps the DB path in try/catch for silent fallback.

Replaced all 19 `inlineGsdRootFile(base` calls in 9 prompt builders:
- `buildResearchMilestonePrompt`: 3 calls (project, requirements unscoped, decisions by mid)
- `buildPlanMilestonePrompt`: 3 calls (project, requirements unscoped, decisions by mid)
- `buildResearchSlicePrompt`: 2 calls (decisions by mid, requirements by sid)
- `buildPlanSlicePrompt`: 2 calls (decisions by mid, requirements by sid)
- `buildCompleteSlicePrompt`: 1 call (requirements by sid)
- `buildCompleteMilestonePrompt`: 3 calls (requirements unscoped, decisions by mid, project)
- `buildReplanSlicePrompt`: 1 call (decisions by mid)
- `buildRunUatPrompt`: 1 call (project)
- `buildReassessRoadmapPrompt`: 3 calls (project, requirements unscoped, decisions by mid)

`buildExecuteTaskPrompt` and `buildRewriteDocsPrompt` left untouched (zero `inlineGsdRootFile` calls). `inlineGsdRootFile` function and export preserved as fallback path.

Created `prompt-db.test.ts` with 36 assertions covering DB-sourced content, scoped filtering, filesystem fallback, and empty-DB fallback.

## Verification

- `npx tsc --noEmit` — zero errors
- `grep 'inlineGsdRootFile(base' src/resources/extensions/gsd/auto-prompts.ts` — 3 matches, all inside fallback paths of the 3 new helpers (zero matches in prompt builder bodies)
- `grep -c 'inlineDecisionsFromDb\|inlineRequirementsFromDb\|inlineProjectFromDb' src/resources/extensions/gsd/auto-prompts.ts` — 22 (3 definitions + 19 call sites)
- `prompt-db.test.ts` — 36 passed, 0 failed
- Full test suite — 186 tests passed, 0 failed

## Diagnostics

- `isDbAvailable()` from `gsd-db.ts` indicates whether prompt builders are using DB-sourced or filesystem-sourced content
- Helpers produce no stderr on fallback — silent degradation by design
- Verify wiring: `grep -c 'inlineDecisionsFromDb\|inlineRequirementsFromDb\|inlineProjectFromDb' src/resources/extensions/gsd/auto-prompts.ts` should return ≥22

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-prompts.ts` — added 3 DB-aware helpers (~70 lines), replaced 19 call sites
- `src/resources/extensions/gsd/tests/prompt-db.test.ts` — created, 36 assertions testing DB-aware helpers
- `.gsd/milestones/M004/slices/S03/tasks/T01-PLAN.md` — added Observability Impact section
- `.gsd/milestones/M004/slices/S03/S03-PLAN.md` — marked T01 done
- `.gsd/STATE.md` — updated next action to T02
