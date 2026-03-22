---
phase: 01-engine-foundation
plan: 03
subsystem: projections
tags: [markdown-rendering, sqlite, projections, state-management]

# Dependency graph
requires:
  - "Schema v5 tables: milestones, slices, tasks, verification_evidence"
  - "WorkflowEngine class with typed query methods"
  - "deriveState() returning GSDState from DB reads"
provides:
  - "renderPlanContent/renderPlanProjection for PLAN.md from DB rows"
  - "renderRoadmapContent/renderRoadmapProjection for ROADMAP.md from DB rows"
  - "renderSummaryContent/renderSummaryProjection for SUMMARY.md from DB rows"
  - "renderStateContent/renderStateProjection for STATE.md from engine state"
  - "renderAllProjections for full milestone regeneration"
  - "regenerateIfMissing for on-demand projection repair (PROJ-05)"
affects: [1-04-tools, 1-05-manifest-events]

# Tech tracking
tech-stack:
  added: []
  patterns: [pure-content-renderer-plus-disk-writer, non-fatal-projection-failure]

key-files:
  created:
    - "src/resources/extensions/gsd/workflow-projections.ts"
    - "src/resources/extensions/gsd/engine/projections.test.ts"
  modified: []

key-decisions:
  - "Pure content renderers separated from disk writers for testability without DB"
  - "renderStateContent matches buildStateMarkdown format exactly for backward compatibility"
  - "All projection writes wrapped in try/catch per D-02 (non-fatal failure)"

patterns-established:
  - "Pure render functions (renderXContent) take row data, return string — no side effects, no DB"
  - "Projection writers (renderXProjection) query DB + call pure render + atomicWriteSync"
  - "regenerateIfMissing checks disk then calls renderer — on-demand repair pattern"

requirements-completed: [PROJ-01, PROJ-02, PROJ-03, PROJ-04, PROJ-05]

# Metrics
duration: 5min
completed: 2026-03-22
---

# Phase 1 Plan 03: Projection Renderers Summary

**PLAN/ROADMAP/SUMMARY/STATE markdown projections from DB rows with pure renderers, atomicWriteSync, and on-demand regeneration**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-22T22:00:45Z
- **Completed:** 2026-03-22T22:05:54Z
- **Tasks:** 2
- **Files created:** 2

## Accomplishments
- 4 projection renderers (PLAN, ROADMAP, SUMMARY, STATE) producing format-compatible markdown from DB rows
- renderAllProjections regenerates all projection files for a milestone in one call
- regenerateIfMissing provides on-demand repair for corrupted/deleted projection files (PROJ-05)
- 12 passing unit tests covering all pure content renderers with mock row data
- renderStateContent byte-compatible with buildStateMarkdown from doctor.ts

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Failing tests for PLAN/ROADMAP renderers** - `173e73f4` (test)
2. **Task 1 GREEN: PLAN.md and ROADMAP.md projection renderers** - `fa20e3fc` (feat)
3. **Task 2 RED: Failing tests for SUMMARY/STATE renderers** - `cd7fe16f` (test)
4. **Task 2 GREEN: SUMMARY, STATE, renderAllProjections, regenerateIfMissing** - `8435d6d0` (feat)

## Files Created/Modified
- `src/resources/extensions/gsd/workflow-projections.ts` - All 5 projection renderers (PLAN, ROADMAP, SUMMARY, STATE, all) + regenerateIfMissing
- `src/resources/extensions/gsd/engine/projections.test.ts` - 12 unit tests for pure content renderers

## Decisions Made
- Separated pure content renderers (renderXContent) from disk writers (renderXProjection) so tests run without DB
- Matched buildStateMarkdown format exactly including glyph selection logic for milestone registry
- All projection writes use atomicWriteSync for crash safety
- renderAllProjections wraps each individual render in try/catch per D-02 (non-fatal projection failure)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed import extensions for strip-types mode**
- **Found during:** Task 1 (test execution)
- **Issue:** Test file used `.js` imports but strip-types mode requires `.ts` extensions for source files
- **Fix:** Changed test imports to use `.ts` extensions matching existing engine test convention
- **Files modified:** src/resources/extensions/gsd/engine/projections.test.ts
- **Verification:** All tests resolve and pass
- **Committed in:** fa20e3fc (Task 1 GREEN commit)

**2. [Rule 3 - Blocking] Used resolve-ts.mjs loader for test execution**
- **Found during:** Task 1 (test execution)
- **Issue:** `node --experimental-strip-types --test` cannot resolve `.js` -> `.ts` in production imports
- **Fix:** Used `--import ./src/resources/extensions/gsd/tests/resolve-ts.mjs` matching existing test:unit script
- **Files modified:** None (runtime flag only)
- **Verification:** All tests pass with correct loader

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes were necessary to run tests. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 5 projection functions exported and tested, ready for Plan 1-04 (agent tools) to call after commands
- renderAllProjections available for post-command projection refresh
- regenerateIfMissing available for health checks and on-demand repair

---
*Phase: 01-engine-foundation*
*Completed: 2026-03-22*
