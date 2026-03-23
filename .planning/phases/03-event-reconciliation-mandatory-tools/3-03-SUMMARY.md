---
phase: 03-event-reconciliation-mandatory-tools
plan: 03
subsystem: workflow-migration
tags: [migration, legacy, markdown-to-engine, tdd, auto-migration]
dependency_graph:
  requires: [workflow-engine.ts, workflow-manifest.ts, workflow-events.ts, gsd-db.ts, files.ts]
  provides: [workflow-migration.ts, engine/migration.test.ts]
  affects: [state.ts, commands/handlers/ops.ts, commands/handlers/core.ts]
tech_stack:
  added: []
  patterns: [markdown-to-engine migration, auto-trigger on empty tables, fork-point baseline event]
key_files:
  created:
    - src/resources/extensions/gsd/workflow-migration.ts
    - src/resources/extensions/gsd/engine/migration.test.ts
  modified:
    - src/resources/extensions/gsd/state.ts
    - src/resources/extensions/gsd/commands/handlers/ops.ts
    - src/resources/extensions/gsd/commands/handlers/core.ts
decisions:
  - "tasks table has no created_at column — INSERT uses description/estimate/files/seq only (auto-fixed from schema)"
  - "Empty IN() clause is invalid SQLite — added guard before transaction to return early when migratedMilestoneIds is empty"
  - "needsAutoMigration() called inside inner try/catch (not outer engine try) per Pitfall #4 — migration failure non-fatal"
requirements: [MIG-01, MIG-02, MIG-03]
metrics:
  duration: 4 min
  completed: 2026-03-22
  tasks_completed: 3
  files_created: 2
  files_modified: 3
---

# Phase 3 Plan 03: Markdown-to-Engine Migration Summary

**One-liner:** Auto-migration converts legacy markdown .gsd/ projects to engine SQLite state via ROADMAP.md/PLAN.md parsing, with `gsd migrate --engine` as explicit failsafe and D-14 validation.

## What Was Built

`workflow-migration.ts` module with three exports: `needsAutoMigration()` (detects empty tables + markdown present), `migrateFromMarkdown()` (parses all milestone dirs, inserts atomically, writes migrate event + manifest), and `validateMigration()` (D-14 count comparison). Wired into `deriveState()` as auto-trigger before engine path. `gsd migrate --engine` CLI command registered as explicit failsafe (D-12). `_deriveStateImpl` renamed to `_deriveStateLegacy` with disaster recovery comment (D-15).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | TDD migration module — failing tests | a3b146f0 | engine/migration.test.ts |
| 1 (GREEN) | TDD migration module — implementation | 52b888dd | workflow-migration.ts |
| 2 | Wire auto-migration into deriveState() | 365abd37 | state.ts |
| 3 | Register `gsd migrate --engine` CLI command | 36b0d4e3 | ops.ts, core.ts |

## Test Results

- `engine/migration.test.ts`: 13/13 tests pass
- `engine/*.test.ts` full suite: 160/160 tests pass (no regressions)

## Key Exports from workflow-migration.ts

- `function needsAutoMigration(basePath: string): boolean` — returns true if milestones table empty AND .gsd/milestones/ exists
- `function migrateFromMarkdown(basePath: string): void` — parses markdown dirs, atomic transaction inserts, writes event + manifest
- `function validateMigration(basePath: string): { discrepancies: string[] }` — D-14 count comparison engine vs markdown

## Migration Algorithm

1. Read `.gsd/milestones/` — list milestone dirs
2. For each milestone: check for `SUMMARY.md` (milestone done flag)
3. Parse `ROADMAP.md` → extract slices with IDs, titles, statuses
4. Per Pitfall #5: if milestone done, force ALL child slices + tasks to `status='done'`
5. For each slice: parse `{sliceId}-PLAN.md` → extract tasks
6. Detect orphaned summary files (summary for slice not in ROADMAP) → log warning, skip
7. Wrap all DELETEs + INSERTs in `transaction()` for atomicity
8. Write synthetic `migrate` event with `actor="system"` for fork-point baseline
9. Call `writeManifest()` to snapshot DB state

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] tasks table has no `created_at` column**

The plan's INSERT statement for tasks included `created_at` but the schema (workflow-engine-schema.ts) only defines `started_at` and `completed_at` for tasks. Fixed the INSERT to use the correct column set: `(id, slice_id, milestone_id, title, description, status, estimate, files, seq)`.

- **Found during:** Task 1 GREEN phase (first test run)
- **Fix:** Removed `created_at` from tasks INSERT, kept only schema-defined columns
- **Files modified:** src/resources/extensions/gsd/workflow-migration.ts

**2. [Rule 1 - Bug] Empty IN() clause causes SQLite error**

When `migratedMilestoneIds` is empty, `DELETE FROM tasks WHERE milestone_id IN ()` is invalid SQLite. Added an early return guard: if no milestone IDs were collected, log warning and return before the transaction.

- **Found during:** Task 1 GREEN phase (first test run)
- **Fix:** Added `if (migratedMilestoneIds.length === 0) return;` before transaction
- **Files modified:** src/resources/extensions/gsd/workflow-migration.ts

## Self-Check

All created files verified:
- `src/resources/extensions/gsd/workflow-migration.ts` — exists
- `src/resources/extensions/gsd/engine/migration.test.ts` — exists

All commits verified:
- a3b146f0 — test(3-03): RED phase
- 52b888dd — feat(3-03): GREEN phase
- 365abd37 — feat(3-03): state.ts wiring
- 36b0d4e3 — feat(3-03): CLI command

## Self-Check: PASSED
