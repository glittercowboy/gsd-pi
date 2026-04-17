---
phase: 09-agent-types-package
plan: "02"
subsystem: type-system
tags: [types, circular-dep, import-migration, gsd-agent-core]
dependency_graph:
  requires: ["09-01"]
  provides: ["gsd-agent-core type imports routed through @gsd/agent-types"]
  affects: ["packages/gsd-agent-core/src/*.ts"]
tech_stack:
  added: []
  patterns: ["import type from @gsd/agent-types", "split mixed imports into value + type lines"]
key_files:
  created: []
  modified:
    - packages/gsd-agent-core/src/fallback-resolver.ts
    - packages/gsd-agent-core/src/compaction-orchestrator.ts
    - packages/gsd-agent-core/src/retry-handler.ts
    - packages/gsd-agent-core/src/bash-executor.ts
    - packages/gsd-agent-core/src/export-html/tool-renderer.ts
    - packages/gsd-agent-core/src/export-html/index.ts
    - packages/gsd-agent-core/src/compaction/compaction.ts
    - packages/gsd-agent-core/src/compaction/utils.ts
    - packages/gsd-agent-core/src/compaction/branch-summarization.ts
    - packages/gsd-agent-core/src/system-prompt.ts
    - packages/gsd-agent-core/src/agent-session.ts
    - packages/gsd-agent-core/src/sdk.ts
    - packages/gsd-agent-core/src/lifecycle-hooks.ts
decisions:
  - "Split Theme import in agent-session.ts: only used as type annotation (getThemeByName returns value), not as class — moved to import type from @gsd/agent-types"
  - "Fixed lifecycle-hooks.ts PackageManager: missed in plan file list but required by success criteria (zero type imports from pi-coding-agent)"
metrics:
  duration_minutes: 12
  completed_date: "2026-04-16"
  tasks_completed: 2
  files_created: 0
  files_modified: 13
  files_deleted: 0
---

# Phase 09 Plan 02: gsd-agent-core Type Import Migration Summary

**One-liner:** All 13 gsd-agent-core source files migrated from `import type ... from "@gsd/pi-coding-agent"` to `@gsd/agent-types`; zero type-import references to pi-coding-agent remain; tsc exits 0.

## Objective

Migrate all type-only imports in `gsd-agent-core` from `@gsd/pi-coding-agent` to `@gsd/agent-types`. Value imports (functions, classes, constants) remain targeting `@gsd/pi-coding-agent`. Mixed import statements split into two separate lines.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migrate type imports in 10 smaller gsd-agent-core files | 1bf54a3bb | fallback-resolver.ts, compaction-orchestrator.ts, retry-handler.ts, bash-executor.ts, export-html/tool-renderer.ts, export-html/index.ts, compaction/compaction.ts, compaction/utils.ts, compaction/branch-summarization.ts, system-prompt.ts |
| 2 | Migrate type imports in agent-session.ts, sdk.ts, lifecycle-hooks.ts | 156b2f250 | agent-session.ts, sdk.ts, lifecycle-hooks.ts |

## What Was Built

**Task 1 (10 files):** Pure type imports changed from `@gsd/pi-coding-agent` to `@gsd/agent-types`:
- `fallback-resolver.ts`: AuthStorage, ModelRegistry, SettingsManager
- `compaction-orchestrator.ts`: ExtensionRunner, ModelRegistry, CompactionEntry, SessionManager, SettingsManager (value import `getLatestCompactionEntry` preserved)
- `retry-handler.ts`: ModelRegistry, SettingsManager
- `bash-executor.ts`: BashOperations
- `export-html/tool-renderer.ts`: Theme, ToolDefinition
- `export-html/index.ts`: ToolInfo, SessionEntry (value imports APP_NAME, getExportTemplateDir etc preserved)
- `compaction/compaction.ts`: CompactionEntry, SessionEntry (value import `convertToLlm` preserved)
- `compaction/utils.ts`: SessionEntry
- `compaction/branch-summarization.ts`: SessionEntry
- `system-prompt.ts`: split `{ formatSkillsForPrompt, type Skill }` → value + type on separate lines

**Task 2 (3 files):**
- `agent-session.ts`: 8 type imports migrated; `Theme` split from value bundle (only used as type); `expandPromptTemplate`/`BUILTIN_SLASH_COMMANDS` value imports preserved
- `sdk.ts`: 2 type imports (ExtensionRunner/LoadExtensionsResult/ToolDefinition, ResourceLoader) + 4 type re-exports migrated to `@gsd/agent-types`; value imports (AuthStorage, ModelRegistry, SessionManager, SettingsManager classes) preserved
- `lifecycle-hooks.ts`: PackageManager migrated (not in original plan file list — see Deviations)

## Verification Results

- `grep -rn "import type.*from.*@gsd/pi-coding-agent" packages/gsd-agent-core/src/` → zero matches
- `tsc --noEmit -p packages/gsd-agent-core/tsconfig.json` → exits 0
- Value imports from `@gsd/pi-coding-agent` (getLatestCompactionEntry, convertToLlm, BUILTIN_SLASH_COMMANDS, AuthStorage class, ModelRegistry class, etc.) preserved unchanged

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing] lifecycle-hooks.ts PackageManager not in plan file list**
- **Found during:** Task 2 — final grep verification `grep -rn "import type.*from.*@gsd/pi-coding-agent" packages/gsd-agent-core/src/` revealed one remaining match
- **Issue:** `lifecycle-hooks.ts` had `import type { PackageManager } from "@gsd/pi-coding-agent"` — not listed in plan's `<files>` but required by success criteria ("Zero import type ... from @gsd/pi-coding-agent remain in gsd-agent-core/src/")
- **Fix:** Changed to `import type { PackageManager } from "@gsd/agent-types"` (PackageManager is exported at line 22 of @gsd/agent-types/src/index.ts)
- **Files modified:** packages/gsd-agent-core/src/lifecycle-hooks.ts
- **Commit:** 156b2f250

**2. [Rule 1 - Bug] Theme import split in agent-session.ts**
- **Found during:** Task 2 — plan noted "if Theme is only used as a type annotation, change to import type"
- **Issue:** `import { Theme, getThemeByName, stripFrontmatter }` — `Theme` is never instantiated (`new Theme`) or accessed as `.property`; only used as a type annotation. Keeping it as a value import would leave an incorrect classification.
- **Fix:** Split to `import { getThemeByName, stripFrontmatter } from "@gsd/pi-coding-agent"` + `import type { Theme } from "@gsd/agent-types"`
- **Files modified:** packages/gsd-agent-core/src/agent-session.ts
- **Commit:** 156b2f250

**3. [Rule 3 - Blocking] @gsd/agent-types symlink missing from main repo node_modules**
- **Found during:** Task 1 tsc verification
- **Issue:** `tsc --noEmit` run from main repo against worktree tsconfig returned TS2307 "Cannot find module '@gsd/agent-types'" because `node_modules/@gsd/agent-types` symlink was absent (npm install not run since Plan 01 added the package)
- **Fix:** Created symlink `node_modules/@gsd/agent-types -> ../../packages/gsd-agent-types` in main repo; built agent-types dist from worktree (outputs to worktree path, used by tsc for resolution)
- **Files modified:** (symlink only — not committed)
- **Commit:** N/A — runtime environment fix

## Known Stubs

None — all changes are import path redirections; no runtime behavior affected.

## Threat Flags

None — import source changes only; no new network endpoints, auth paths, or trust boundaries introduced.

## Self-Check: PASSED

- Commit 1bf54a3bb: FOUND
- Commit 156b2f250: FOUND
- `grep -rn "import type.*from.*@gsd/pi-coding-agent" packages/gsd-agent-core/src/` → zero matches: VERIFIED
- `tsc --noEmit -p packages/gsd-agent-core/tsconfig.json` exits 0: VERIFIED
