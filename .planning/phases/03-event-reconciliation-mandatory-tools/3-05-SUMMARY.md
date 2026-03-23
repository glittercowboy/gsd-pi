---
phase: 03-event-reconciliation-mandatory-tools
plan: 05
subsystem: conflict-resolution
tags: [conflict-resolution, event-log, worktree, cli, tdd]
dependency_graph:
  requires: [workflow-reconcile.ts, workflow-engine.ts, workflow-events.ts, atomic-write.ts]
  provides: [resolveConflict, listConflicts, removeConflictsFile, gsd-resolve-conflict-cli]
  affects: [commands/handlers/ops.ts, commands/catalog.ts]
tech_stack:
  added: []
  patterns: [CONFLICTS.md parser (regex line-by-line), dynamic import for CLI handler, partial conflict resolution]
key_files:
  created:
    - src/resources/extensions/gsd/engine/resolve-conflict.test.ts
  modified:
    - src/resources/extensions/gsd/workflow-reconcile.ts
    - src/resources/extensions/gsd/commands/handlers/ops.ts
    - src/resources/extensions/gsd/commands/handlers/core.ts
    - src/resources/extensions/gsd/commands/catalog.ts
decisions:
  - "CONFLICTS.md parsed with line-by-line regex (not structured JSON) — matches writeConflictsFile format exactly"
  - "parseEventBlock() private helper reads event lines with their params lines in a single pass"
  - "resolveConflict re-writes CONFLICTS.md with empty worktreePath string when partial conflicts remain — worktreePath is display-only"
  - "Dynamic import of resolveConflict/listConflicts in ops.ts consistent with existing migrate handler pattern"
metrics:
  duration: 3 min
  completed: 2026-03-22
  tasks_completed: 2
  files_created: 1
  files_modified: 4
---

# Phase 3 Plan 05: gsd resolve-conflict CLI Command Summary

**One-liner:** CONFLICTS.md parser + resolveConflict/listConflicts/removeConflictsFile functions wired into `gsd resolve-conflict` CLI for human-driven entity-level conflict resolution.

## What Was Built

Added three new functions to `workflow-reconcile.ts` (D-06):

- `listConflicts(basePath)` — parses CONFLICTS.md back into `ConflictEntry[]` using regex line-by-line parser
- `resolveConflict(basePath, entityKey, pick)` — picks winner side, replays events through engine, appends to event log, removes or rewrites CONFLICTS.md
- `removeConflictsFile(basePath)` — deletes CONFLICTS.md, no-op when absent

Wired into the `gsd resolve-conflict` CLI handler in `ops.ts` (dynamic import). No-args invocation lists current conflicts; `--entity TYPE:ID --pick main|worktree` resolves one conflict at a time. Help text added to `core.ts` and command registered in `catalog.ts`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | TDD conflict resolution functions (RED + GREEN) | 3ecade88 | resolve-conflict.test.ts, workflow-reconcile.ts |
| 2 | Register gsd resolve-conflict CLI command | 7df82b78 | ops.ts, core.ts, catalog.ts |

## Test Results

- `engine/resolve-conflict.test.ts`: 10/10 tests pass
- `engine/*.test.ts` full suite: 160/160 tests pass (no regressions)

## Key Exports Added to workflow-reconcile.ts

- `function listConflicts(basePath: string): ConflictEntry[]` — parses CONFLICTS.md
- `function resolveConflict(basePath: string, entityKey: string, pick: "main" | "worktree"): void` — resolves one conflict
- `function removeConflictsFile(basePath: string): void` — cleans up CONFLICTS.md

## CLI Behavior

```
/gsd resolve-conflict                              # lists all current conflicts
/gsd resolve-conflict --entity task:T01 --pick main      # picks main side, removes from CONFLICTS.md
/gsd resolve-conflict --entity task:T01 --pick worktree  # picks worktree side
```

After each resolution, remaining conflicts are reported. CONFLICTS.md is removed when all conflicts are resolved.

## Deviations from Plan

None — plan executed exactly as written. The `[projections] renderStateProjection failed` stderr messages seen during tests are non-fatal (pre-existing, from test environment lacking full filesystem context for projection writes).

## Self-Check

All created/modified files verified:
- `src/resources/extensions/gsd/workflow-reconcile.ts` — exists, contains all 3 exports
- `src/resources/extensions/gsd/engine/resolve-conflict.test.ts` — exists, min_lines met (220+ lines)
- `src/resources/extensions/gsd/commands/handlers/ops.ts` — contains resolve-conflict, resolveConflict(, listConflicts(
- `src/resources/extensions/gsd/commands/handlers/core.ts` — contains resolve-conflict help text
- `src/resources/extensions/gsd/commands/catalog.ts` — contains resolve-conflict entry

All commits verified:
- 3ecade88 — feat(3-05): add resolveConflict/listConflicts/removeConflictsFile + tests
- 7df82b78 — feat(3-05): register gsd resolve-conflict CLI command

## Self-Check: PASSED
