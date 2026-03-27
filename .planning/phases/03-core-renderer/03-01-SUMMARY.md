---
phase: 03-core-renderer
plan: 01
subsystem: watch/tree-model
tags: [tree-model, data-layer, tdd, types, status-derivation, badge-detection]
dependency_graph:
  requires: []
  provides: [buildMilestoneTree, NodeStatus, PlanNode, PhaseNode, MilestoneNode]
  affects: [renderer-entry.ts, future-renderer-phase]
tech_stack:
  added: []
  patterns: [pure-functions, tdd-red-green, node-fs-sync, status-rollup]
key_files:
  created:
    - src/resources/extensions/gsd/watch/tree-model.ts
    - src/resources/extensions/gsd/tests/watch-tree-model.test.ts
  modified:
    - src/resources/extensions/gsd/watch/types.ts
key_decisions:
  - "readMilestoneLabel extracts text after em/en-dash from ROADMAP.md heading for concise label"
  - "derivePhaseStatus ignores badges — status derived from plan files only, badges are purely visual"
  - "scanPlans filters /^\\d{2}-\\d{2}-PLAN\\.md$/ strictly — no SUMMARY or other files in plans array"
metrics:
  duration: "~3 minutes"
  completed: "2026-03-27"
  tasks: 1
  files: 3
---

# Phase 3 Plan 01: Tree Data Model Summary

**One-liner:** Pure filesystem scanner producing typed MilestoneNode tree with 7-element badge arrays and worst-case status rollup via TDD.

## What Was Built

A data-layer module for the GSD Watch sidebar that scans `.planning/phases/` and returns a fully typed tree structure. No rendering, no stdout — pure functions returning typed data.

### Files Created / Modified

- **`src/resources/extensions/gsd/watch/types.ts`** — Extended with 4 new exports: `NodeStatus`, `PlanNode`, `PhaseNode`, `MilestoneNode`
- **`src/resources/extensions/gsd/watch/tree-model.ts`** — New module containing 7 exported functions plus main `buildMilestoneTree()` export
- **`src/resources/extensions/gsd/tests/watch-tree-model.test.ts`** — 17 unit tests covering all behaviors

### Key Behaviors

| Function | Purpose |
|----------|---------|
| `buildMilestoneTree(projectRoot)` | Main entry: scans `.planning/phases/`, returns `MilestoneNode` |
| `detectBadges(phaseFiles)` | Maps 7 `BADGE_SUFFIXES` to boolean presence array |
| `scanPlans(phaseDir, phaseFiles)` | Filters plan files, derives `PlanNode[]` with status |
| `derivePlanStatus(planId, phaseFiles)` | done if SUMMARY exists, active otherwise |
| `derivePhaseStatus(plans, badges)` | pending (no plans), done (all done), active (any active) |
| `deriveMilestoneStatus(phases)` | Worst-case: blocked > active > done > pending |
| `readMilestoneLabel(projectRoot)` | Extracts label from ROADMAP.md first heading |
| `formatPhaseLabel(dirName)` | "03-core-renderer" -> "3. Core Renderer" |

## TDD Execution

- **RED commit:** `b17aa44e` — 17 failing tests, `tree-model.ts` absent
- **GREEN commit:** `b991ed25` — All 17 tests pass after implementation

## Test Coverage (17 tests)

- Core structure: 4 tests (phase count, sort order, dirNames, label)
- Badge detection: 3 tests (specific arrays, partial presence, always-7-elements)
- Plan status: 2 tests (done with SUMMARY, active without)
- Phase status rollup: 3 tests (pending/done/active)
- Milestone status rollup: 2 tests (all-done/any-active)
- Edge cases: 3 tests (missing phases dir, non-directory files ignored, label humanization)

## Deviations from Plan

None - plan executed exactly as written.

## Decisions Made

1. `readMilestoneLabel` extracts text after em/en-dash from ROADMAP.md heading — produces concise "GSD Watch" label instead of full "Roadmap — GSD Watch"
2. `derivePhaseStatus` ignores the `badges` parameter — status is derived only from plan file presence, badges are a purely visual concern
3. `scanPlans` uses strict regex `/^\d{2}-\d{2}-PLAN\.md$/` — only matches exactly `XX-YY-PLAN.md` pattern, SUMMARY files do not appear in plans array

## Self-Check: PASSED

- FOUND: `src/resources/extensions/gsd/watch/tree-model.ts`
- FOUND: `src/resources/extensions/gsd/watch/types.ts` (modified)
- FOUND: `src/resources/extensions/gsd/tests/watch-tree-model.test.ts`
- FOUND: commit b17aa44e (TDD RED — failing tests)
- FOUND: commit b991ed25 (TDD GREEN — 17 tests pass)
