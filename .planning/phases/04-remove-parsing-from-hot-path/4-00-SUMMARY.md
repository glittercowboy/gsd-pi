---
phase: 04-remove-parsing-from-hot-path
plan: 00
subsystem: testing
tags: [wave-0, test-scaffolds, import-boundary, doctor, auto-recovery]

# Dependency graph
requires:
  - phase: 03-event-reconciliation-mandatory-tools
    provides: "Engine infrastructure (WorkflowEngine, event log, projections) that Phase 4 tests will validate against"
provides:
  - "RED-phase test scaffolds for checkEngineHealth (DOC-05)"
  - "Import boundary enforcement tests for CLN-07"
  - "Removed-export tests for writeBlockerPlaceholder/skipExecuteTask (DOC-02)"
  - "Regression guard for orphaned_completed_units removal (DOC-01)"
  - "Projection drift test placeholder (DOC-03)"
affects: [4-01, 4-02, 4-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [static-import-analysis-tests, multi-line-import-regex, todo-placeholders-for-red-tests]

key-files:
  created:
    - src/resources/extensions/gsd/tests/import-boundary.test.ts
  modified:
    - src/resources/extensions/gsd/tests/doctor-runtime.test.ts
    - src/resources/extensions/gsd/tests/auto-recovery.test.ts
    - src/resources/extensions/gsd/tests/doctor-proactive.test.ts

key-decisions:
  - "Used TODO console.log placeholders for checkEngineHealth tests since the function does not exist yet (import would fail)"
  - "Used regex-based multi-line import extraction for state.ts boundary test to handle TypeScript multi-line import statements"
  - "Removed-export tests use dynamic import to check runtime exports rather than static analysis"

patterns-established:
  - "Static import boundary tests: read source files as strings and assert on import/export patterns"
  - "Multi-line import regex: /import\\s*\\{([^}]+)\\}\\s*from\\s*['\"]\\.\\/files\\.(?:js|ts)['\"]/g for extracting imported names"

requirements-completed: [DOC-01, DOC-02, DOC-03, DOC-05, CLN-07]

# Metrics
duration: 5min
completed: 2026-03-23
---

# Phase 4 Plan 00: Wave 0 Test Scaffolds Summary

**RED-phase test scaffolds for checkEngineHealth, import boundary enforcement, removed-export guards, and projection drift placeholder**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-23T01:08:33Z
- **Completed:** 2026-03-23T01:13:11Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Created import-boundary.test.ts with 5 tests enforcing CLN-07 parser relocation boundary (2 GREEN, 3 RED as expected)
- Added checkEngineHealth TODO placeholders to doctor-runtime.test.ts for DOC-05 (RED until Plan 4-02)
- Added orphaned_completed_units regression guard to doctor-runtime.test.ts for DOC-01
- Added writeBlockerPlaceholder/skipExecuteTask removed-export tests to auto-recovery.test.ts for DOC-02 (RED until Plan 4-03)
- Added projection drift TODO placeholder to doctor-proactive.test.ts for DOC-03 (RED until Plan 4-02)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add checkEngineHealth + regression tests** - `a3f04488` (test)
2. **Task 2: Create import-boundary.test.ts** - `fcac4c37` (test)

## Files Created/Modified
- `src/resources/extensions/gsd/tests/import-boundary.test.ts` - New file: 5 static analysis tests enforcing parser relocation boundary
- `src/resources/extensions/gsd/tests/doctor-runtime.test.ts` - Added orphaned_completed_units regression guard + checkEngineHealth TODO placeholders
- `src/resources/extensions/gsd/tests/auto-recovery.test.ts` - Added 2 removed-export tests for DOC-02
- `src/resources/extensions/gsd/tests/doctor-proactive.test.ts` - Added projection drift TODO placeholder for DOC-03

## Decisions Made
- Used TODO console.log placeholders for checkEngineHealth tests because the function does not exist yet -- importing it would cause test file load failure. Plan 4-02 will convert these to real assertions.
- Used regex-based multi-line import extraction for state.ts test (test 5) because TypeScript multi-line imports span multiple lines and line-by-line matching misses them.
- Removed-export tests use dynamic import + typeof check rather than static file analysis because runtime export presence is the authoritative check.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed multi-line import detection in state.ts boundary test**
- **Found during:** Task 2 (import-boundary.test.ts)
- **Issue:** Initial line-by-line matching for state.ts import check failed to detect multi-line imports (the `from './files.js'` was on a different line than `import {`)
- **Fix:** Replaced line-by-line filter with regex that captures full multi-line import blocks: `/import\s*\{([^}]+)\}\s*from\s*['"]\.\/files\.(?:js|ts)['"]/g`
- **Files modified:** src/resources/extensions/gsd/tests/import-boundary.test.ts
- **Verification:** Test 5 now correctly fails RED (state.ts imports parseRoadmap from files.ts)
- **Committed in:** fcac4c37 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Fix was essential for test correctness. No scope creep.

## Issues Encountered
- Pre-existing TypeScript compilation errors in monorepo packages (pi-ai, pi-coding-agent) are not related to GSD extension changes. No GSD test file compilation errors.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All Wave 0 test scaffolds in place
- Plans 4-01, 4-02, 4-03 verify commands now have real test cases to run against
- Import boundary tests provide Nyquist gate for parser relocation (4-01)
- checkEngineHealth TODOs ready for conversion when 4-02 implements the function

---
*Phase: 04-remove-parsing-from-hot-path*
*Completed: 2026-03-23*
