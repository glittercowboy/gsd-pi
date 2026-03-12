---
phase: 12-gsd-2-compatibility-pass
plan: "03"
subsystem: server
tags: [gsd2, watcher, server, fs-api, claude-process, path-migration]

# Dependency graph
requires:
  - phase: 12-02
    provides: GSD2State types and state-deriver rewrite
provides:
  - watcher.ts dotfile filter allows .gsd/ events through
  - server.ts startup and switchProject resolve .gsd/ not .planning/
  - fs-api.ts project detection checks .gsd/ directory
  - claude-process.ts spawns gsd binary not claude, --resume removed

affects:
  - Phase 13 (Pi SDK arg mapping builds on gsd binary foundation)
  - All server path resolution downstream of server.ts

# Tech tracking
tech-stack:
  added: []
  patterns:
    - String-level surgical edits: only the literal ".planning" values changed to ".gsd", variable name planningDir preserved throughout

key-files:
  created: []
  modified:
    - packages/mission-control/src/server/watcher.ts
    - packages/mission-control/src/server.ts
    - packages/mission-control/src/server/fs-api.ts
    - packages/mission-control/src/server/fs-types.ts
    - packages/mission-control/src/server/pipeline.ts
    - packages/mission-control/src/server/claude-process.ts

key-decisions:
  - "--resume flag removed entirely rather than kept (Claude Code specific; Phase 13 adds gsd session continuity)"
  - "planningDir variable name preserved throughout — only the string value .planning changed to .gsd"
  - "state-deriver.ts migration detection check for .planning/ intentionally kept (needsMigration flow)"

patterns-established:
  - "GSD 2 config dir is .gsd/ — all new server-side path resolutions use resolve(root, '.gsd')"
  - "GSD 2 binary is gsd — spawn calls use 'gsd' as first argument"

requirements-completed: [COMPAT-01, COMPAT-05]

# Metrics
duration: 15min
completed: 2026-03-12
---

# Phase 12 Plan 03: Path Migration and Binary Swap Summary

**All server-side .planning path strings migrated to .gsd and spawn binary changed from claude to gsd, making watcher, server startup, project detection, and process spawning GSD 2 compatible**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-03-12T18:30:00Z
- **Completed:** 2026-03-12T18:45:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- watcher.ts dotfile filter now passes `.gsd/` events through (not `.planning/`)
- server.ts startup and switchProject handler both resolve `.gsd/` as planningDir
- fs-api.ts `listDirectory()` and `detectProject()` both check for `.gsd/` to set `isGsdProject`
- claude-process.ts spawns `gsd` binary with `--resume` flag removed; all 3 claude-process-gsd.test.ts assertions GREEN

## Task Commits

Each task was committed atomically:

1. **Task 1: Migrate .planning -> .gsd path strings in watcher, server, fs-api, pipeline** - `678ba68` (feat)
2. **Task 2: Change claude-process.ts spawn binary from claude to gsd** - `ade6831` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified
- `packages/mission-control/src/server/watcher.ts` - Dotfile filter changed to .gsd; file-level docstring updated
- `packages/mission-control/src/server.ts` - Startup planningDir and switchProject planningDir both resolve .gsd/
- `packages/mission-control/src/server/fs-api.ts` - Both isGsdProject checks now look for .gsd/ directory
- `packages/mission-control/src/server/fs-types.ts` - Comments on isGsdProject field updated
- `packages/mission-control/src/server/pipeline.ts` - Comment "one level up from .planning" updated to .gsd
- `packages/mission-control/src/server/claude-process.ts` - Binary gsd, --resume removed, comments updated

## Decisions Made
- `--resume` flag removed entirely rather than conditionally — it is Claude Code SDK-specific; Phase 13 will implement proper gsd session continuity
- `planningDir` variable name preserved throughout — renaming would cause a wide ripple; only the string value `".planning"` changed to `".gsd"`
- `state-deriver.ts` migration detection code (checking `.planning/` existence) intentionally not touched — it is the migration banner flow that correctly needs to check for the v1 directory

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All GSD 2 server path wiring complete (Phases 12-01 through 12-03)
- Phase 13 can build on the `gsd` binary foundation to implement full Pi SDK arg mapping
- watcher.test.ts, pipeline-switch.test.ts, and claude-process-gsd.test.ts all GREEN

---
*Phase: 12-gsd-2-compatibility-pass*
*Completed: 2026-03-12*
