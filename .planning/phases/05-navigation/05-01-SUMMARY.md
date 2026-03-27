---
phase: 05-navigation
plan: 01
subsystem: watch/tree-renderer
tags: [tree-renderer, visible-node, collapse, navigation, tdd]
dependency_graph:
  requires: []
  provides: [VisibleNode type, VisibleNodeKind type, collapse-aware renderTreeLines]
  affects: [renderer-entry.ts (renderTree caller), Phase 05 Plan 02 navigation wiring]
tech_stack:
  added: []
  patterns: [TDD red-green, parallel array metadata, optional param with default Set]
key_files:
  created: []
  modified:
    - src/resources/extensions/gsd/watch/tree-renderer.ts
    - src/resources/extensions/gsd/tests/watch-tree-renderer.test.ts
    - src/resources/extensions/gsd/watch/renderer-entry.ts
decisions:
  - "Option A chosen: extend renderTreeLines() return to { lines, nodes } rather than separate buildVisibleNodes() pass — collapse logic co-located with line generation, single tree traversal"
  - "collapsedPhases defaults to new Set() for backward compatibility — callers without collapse support still work unchanged"
  - "Truncate phase line before appending ▸ at narrow widths to ensure width constraint is never violated"
metrics:
  duration_minutes: 3
  completed_date: "2026-03-27"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 3
---

# Phase 05 Plan 01: VisibleNode Type and Collapse-Aware renderTreeLines Summary

**One-liner:** Extended `renderTreeLines()` to return `{ lines, nodes }` with parallel `VisibleNode[]` metadata and collapse support via `Set<string>` of phase `dirName` values.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Add failing tests 17-26 for VisibleNode and collapse | aa73642f | watch-tree-renderer.test.ts |
| 1 (GREEN) | Implement VisibleNode types and collapse-aware renderTreeLines | 8d4af3a8 | tree-renderer.ts |
| 1 (DEVIATION) | Fix renderer-entry.ts destructure for new return type | 9e541598 | renderer-entry.ts |

## What Was Built

- `VisibleNodeKind` type (`"milestone" | "phase" | "plan"`) exported from tree-renderer.ts
- `VisibleNode` interface with `kind`, optional `dirName` (phases), optional `planId` (plans)
- `renderTreeLines()` signature updated: accepts optional `collapsedPhases?: Set<string>`, returns `{ lines: string[]; nodes: VisibleNode[] }`
- Collapsed phases append ` ▸` to their phase line and skip all child plan lines
- Width guard: at narrow widths where ▸ would overflow, the phase line is truncated first then ▸ appended
- 10 new tests (17-26) cover all VisibleNode and collapse behaviors
- All 16 existing tests updated to destructure `{ lines }` — pass unchanged

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated renderer-entry.ts caller for new return type**
- **Found during:** Post-implementation verification
- **Issue:** `renderer-entry.ts` line 265 called `renderTreeLines()` and assigned result directly to `const lines = ...` — broke because return is now `{ lines, nodes }` not `string[]`
- **Fix:** Changed to `const { lines } = renderTreeLines(milestone, width)`
- **Files modified:** `src/resources/extensions/gsd/watch/renderer-entry.ts`
- **Commit:** 9e541598

## Verification

```
npx tsx --test src/resources/extensions/gsd/tests/watch-tree-renderer.test.ts
ℹ tests 26
ℹ pass 26
ℹ fail 0
```

All 28 renderer-entry tests also pass after deviation fix.

## Known Stubs

None — all new exports are fully implemented and tested.

## Self-Check: PASSED

- FOUND: src/resources/extensions/gsd/watch/tree-renderer.ts
- FOUND: src/resources/extensions/gsd/tests/watch-tree-renderer.test.ts
- FOUND: .planning/phases/05-navigation/05-01-SUMMARY.md
- FOUND: aa73642f (test RED commit)
- FOUND: 8d4af3a8 (feat GREEN commit)
- FOUND: 9e541598 (fix deviation commit)
