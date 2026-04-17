---
phase: 09-agent-types-package
plan: "03"
subsystem: type-system
tags: [types, circular-dep, import-migration, gsd-agent-modes]
dependency_graph:
  requires: ["09-01"]
  provides: ["gsd-agent-modes zero type imports from @gsd/pi-coding-agent"]
  affects: ["packages/gsd-agent-modes/src/**/*.ts"]
tech_stack:
  added: []
  patterns: ["import type ... from @gsd/agent-types", "split mixed imports into separate value + type lines"]
key_files:
  created: []
  modified:
    - packages/gsd-agent-modes/src/theme.ts
    - packages/gsd-agent-modes/src/cli/args.ts
    - packages/gsd-agent-modes/src/cli/config-selector.ts
    - packages/gsd-agent-modes/src/cli/list-models.ts
    - packages/gsd-agent-modes/src/cli/session-picker.ts
    - packages/gsd-agent-modes/src/modes/rpc/rpc-client.ts
    - packages/gsd-agent-modes/src/modes/rpc/rpc-mode.ts
    - packages/gsd-agent-modes/src/modes/rpc/rpc-types.ts
    - packages/gsd-agent-modes/src/modes/shared/command-context-actions.ts
    - packages/gsd-agent-modes/src/modes/interactive/interactive-mode.ts
    - packages/gsd-agent-modes/src/modes/interactive/slash-command-handlers.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/bordered-loader.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/oauth-selector.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/footer.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/config-selector.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/custom-message.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/tool-execution.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/skill-invocation-message.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/session-selector-search.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/keybinding-hints.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/compaction-summary-message.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/branch-summary-message.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/provider-manager.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/custom-editor.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/model-selector.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/session-selector.ts
    - packages/gsd-agent-modes/src/modes/interactive/controllers/input-controller.ts
    - packages/gsd-agent-modes/src/modes/interactive/controllers/extension-ui-controller.ts
decisions:
  - "src/utils/theme.ts referenced in plan does not exist; src/theme.ts is the actual file — migrated correctly"
  - "gsd-agent-core type imports not in scope for this plan (handled by 09-02 in parallel)"
  - "Phase gate tsc for gsd-agent-core deferred until 09-02 merges — gsd-agent-modes compiles clean independently"
metrics:
  duration_minutes: 12
  completed_date: "2026-04-16"
  tasks_completed: 3
  files_created: 0
  files_modified: 28
  files_deleted: 0
---

# Phase 09 Plan 03: gsd-agent-modes Type Import Migration Summary

**One-liner:** Migrated all 28 gsd-agent-modes source files from `import type ... from "@gsd/pi-coding-agent"` to `import type ... from "@gsd/agent-types"`, splitting 5 mixed imports; gsd-agent-modes now compiles clean with zero circular type imports.

## Objective

Migrate all type-only imports in `gsd-agent-modes` from `@gsd/pi-coding-agent` to `@gsd/agent-types`. Value imports remain targeting `@gsd/pi-coding-agent`. Mixed import statements are split. This completes CIRC-02 for the gsd-agent-modes package.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migrate type imports in cli/, utils/, rpc/, shared/ | 4ce528fbb | theme.ts + 9 cli/rpc/shared files |
| 2 | Migrate type imports in interactive-mode.ts and slash-command-handlers.ts | d9079b624 | interactive-mode.ts, slash-command-handlers.ts |
| 3 | Migrate type imports in all components/ and controllers/ | 2054908d7 | 17 component and controller files |

## What Was Built

All 28 files in `gsd-agent-modes/src/` that had type-only imports from `@gsd/pi-coding-agent` have been updated to import from `@gsd/agent-types` instead.

**Pure type imports changed** (21 files): Single-line `import type { X } from "@gsd/pi-coding-agent"` → `import type { X } from "@gsd/agent-types"`.

**Mixed imports split** (5 files):
- `src/theme.ts`: `import { type Theme }` → `import type { Theme } from "@gsd/agent-types"`
- `interactive-mode.ts`: `import { FooterDataProvider, type ReadonlyFooterDataProvider }` → split to value + type
- `interactive-mode.ts`: `import { type AppAction }` → `import type { AppAction } from "@gsd/agent-types"`
- `interactive-mode.ts`: `import { type SessionContext, SessionManager }` → split to value + type
- `tool-execution.ts`: `import { computeEditDiff, type EditDiffError, type EditDiffResult }` → split to value + type

**Value imports preserved throughout**: All `@gsd/pi-coding-agent` value imports (functions, classes, constants) unchanged.

## Verification Results

- `tsc --noEmit -p packages/gsd-agent-types/tsconfig.json` → exits 0
- `tsc --noEmit -p packages/gsd-agent-modes/tsconfig.json` → exits 0
- `grep -rn "import type.*from.*@gsd/pi-coding-agent" packages/gsd-agent-modes/src/` → 0 matches

## Deviations from Plan

**1. [Rule 1 - Deviation] src/utils/theme.ts does not exist**
- **Found during:** Task 1
- **Issue:** Plan references `packages/gsd-agent-modes/src/utils/theme.ts` but the actual file is `packages/gsd-agent-modes/src/theme.ts` (no `utils/` subdirectory at the src root)
- **Fix:** Migrated `src/theme.ts` instead — the correct file containing `import { type Theme } from "@gsd/pi-coding-agent"`
- **Files modified:** packages/gsd-agent-modes/src/theme.ts
- **Commit:** 4ce528fbb

**2. [Scope note] Phase gate partially deferred**
- **Found during:** Task 3 verification
- **Issue:** The full phase gate `grep -rn "import type.*from.*@gsd/pi-coding-agent" packages/gsd-agent-core/src/ packages/gsd-agent-modes/src/` returns 26 matches from `gsd-agent-core/src/` which is plan 09-02's scope
- **Resolution:** Not a deviation — 09-02 runs in parallel wave 2. gsd-agent-modes itself has 0 remaining type imports from pi-coding-agent. Full zero-match result achieved after both plans merge.

## Known Stubs

None — all changes are import statement rewrites with no runtime behavior.

## Threat Flags

None — import source changes only; same types from the same workspace. No new network endpoints, auth paths, or trust boundaries.

## Self-Check: PASSED

- Commit 4ce528fbb: FOUND
- Commit d9079b624: FOUND
- Commit 2054908d7: FOUND
- `grep -rn "import type.*from.*@gsd/pi-coding-agent" packages/gsd-agent-modes/src/` → 0 matches (confirmed)
- `tsc --noEmit -p packages/gsd-agent-modes/tsconfig.json` → exits 0 (confirmed)
