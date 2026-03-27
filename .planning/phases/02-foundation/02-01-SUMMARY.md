---
phase: 02-foundation
plan: 01
subsystem: watch
tags: [file-watching, chokidar, debounce, types, tdd]
dependency_graph:
  requires: []
  provides: [watch/types.ts, watch/watcher.ts]
  affects: [02-02, 02-03, 02-04]
tech_stack:
  added: []
  patterns: [chokidar-v5-function-ignored, single-coalescing-debounce, tdd-red-green]
key_files:
  created:
    - src/resources/extensions/gsd/watch/types.ts
    - src/resources/extensions/gsd/watch/watcher.ts
    - src/resources/extensions/gsd/tests/watch-watcher.test.ts
  modified: []
decisions:
  - "Use function-based ignored predicate in chokidar v5 instead of glob array (glob patterns unreliable in v5)"
metrics:
  duration_seconds: 167
  completed_date: "2026-03-27"
  tasks_completed: 1
  files_created: 3
  files_modified: 0
---

# Phase 02 Plan 01: Watch Types and Watcher Module Summary

Chokidar v5 wrapper with single coalescing 300ms debounce for .planning/ watching, plus shared type definitions for the entire watch module.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Add failing tests for watcher | 71d77970 | tests/watch-watcher.test.ts |
| 1 (GREEN) | Implement watch types and watcher | a31f34f5 | watch/types.ts, watch/watcher.ts |

## Verification

```
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --experimental-test-isolation=process --test src/resources/extensions/gsd/tests/watch-watcher.test.ts
```

Result: 9/9 tests pass.

```
  ✔ Test 1: single file write triggers onChange within 400ms
  ✔ Test 2: 10 rapid writes coalesce into exactly 1 onChange call
  ✔ Test 3: .swp files do NOT trigger onChange
  ✔ Test 4: files ending in ~ do NOT trigger onChange
  ✔ Test 5: .tmp files do NOT trigger onChange
  ✔ Test 6: .DS_Store files do NOT trigger onChange
  ✔ Test 7: creating a new subdirectory triggers onChange
  ✔ Test 8: removing a subdirectory triggers onChange
  ✔ Test 9: watcher.close() stops firing events
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Chokidar v5 glob-based ignored patterns not working**

- **Found during:** Task 1 (GREEN phase, first test run)
- **Issue:** Tests 5 (.tmp) and 6 (.DS_Store) failed despite `IGNORED_PATTERNS` containing `**/*.tmp` and `**/.DS_Store`. Chokidar v5 changed glob-based `ignored` array matching behavior — these patterns were not being applied.
- **Fix:** Replaced `ignored: IGNORED_PATTERNS` with a function predicate `isIgnored(filePath)` that checks `basename` against each ignored pattern. This is the reliable approach for chokidar v5 and covers all versions.
- **Files modified:** `src/resources/extensions/gsd/watch/watcher.ts`
- **Note:** `IGNORED_PATTERNS` in `types.ts` is retained as documentation — the constant defines which patterns apply, but `watcher.ts` implements them via function for v5 compatibility.
- **Commit:** a31f34f5

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Function-based ignored predicate in chokidar v5 | Glob array patterns unreliable in v5; function-based check on basename is reliable and clear |

## Known Stubs

None. All exports are fully implemented and wired.

## Self-Check: PASSED
