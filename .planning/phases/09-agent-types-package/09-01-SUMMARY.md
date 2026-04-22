---
phase: 09-agent-types-package
plan: "01"
subsystem: type-system
tags: [types, circular-dep, scaffolding, build-chain]
dependency_graph:
  requires: []
  provides: ["@gsd/agent-types package", "LifecycleHook* types in shared package", "pi-originated type re-exports"]
  affects: ["packages/gsd-agent-core", "packages/gsd-agent-modes", "root build chain"]
tech_stack:
  added: ["@gsd/agent-types workspace package"]
  patterns: ["type-only package with zero runtime deps", "peerDependencies for pi-coding-agent"]
key_files:
  created:
    - packages/gsd-agent-types/package.json
    - packages/gsd-agent-types/tsconfig.json
    - packages/gsd-agent-types/src/index.ts
  modified:
    - package.json
    - packages/gsd-agent-core/package.json
    - packages/gsd-agent-modes/package.json
    - packages/gsd-agent-core/src/lifecycle-hooks.ts
  deleted:
    - packages/gsd-agent-core/src/lifecycle-hook-types.ts
decisions:
  - "Used peerDependencies for @gsd/pi-coding-agent (not dependencies) — type-only package, no runtime resolution needed"
  - "Built dist/ as part of task 2 verification to satisfy Node16 module resolution for gsd-agent-core tsc"
  - "Included ContextualTips re-export: it is re-exported through pi-coding-agent (from @gsd/agent-core), so export type works"
metrics:
  duration_minutes: 8
  completed_date: "2026-04-16"
  tasks_completed: 2
  files_created: 3
  files_modified: 5
  files_deleted: 1
---

# Phase 09 Plan 01: @gsd/agent-types Package Summary

**One-liner:** New `@gsd/agent-types` workspace package provides 5 GSD-originated LifecycleHook types and 50+ pi-originated re-exports, breaking the circular dependency by giving downstream packages a stable type import point.

## Objective

Create the `@gsd/agent-types` workspace package, populate it with the complete type inventory, wire it into the build chain, add it as a dependency of `gsd-agent-core` and `gsd-agent-modes`, and delete the temporary `lifecycle-hook-types.ts` shim.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Scaffold @gsd/agent-types package | 6e72e151a | packages/gsd-agent-types/{package.json,tsconfig.json,src/index.ts} |
| 2 | Wire build chain, add deps, delete shim | 689a1073c | package.json, gsd-agent-core/package.json, gsd-agent-modes/package.json, lifecycle-hooks.ts, lifecycle-hook-types.ts (deleted) |

## What Was Built

**packages/gsd-agent-types/src/index.ts** — 75 lines total:
- 5 GSD-originated types: `LifecycleHookPhase`, `LifecycleHookScope`, `LifecycleHookContext`, `LifecycleHookHandler`, `LifecycleHookMap`
- 50 pi-originated type re-exports via `export type { X } from "@gsd/pi-coding-agent"`

**Build chain** (root package.json):
- Added: `"build:agent-types": "npm run build -w @gsd/agent-types"`
- Updated: `build:gsd` now runs `build:pi → build:agent-types → build:agent-core → build:agent-modes`

**Dependency wiring:**
- `gsd-agent-core/package.json`: added `"@gsd/agent-types": "*"` to dependencies
- `gsd-agent-modes/package.json`: added `"@gsd/agent-types": "*"` to dependencies

**Shim deleted:** `packages/gsd-agent-core/src/lifecycle-hook-types.ts` removed; `lifecycle-hooks.ts` now imports from `@gsd/agent-types`.

## Verification Results

- `tsc --noEmit -p packages/gsd-agent-types/tsconfig.json` → exits 0
- `tsc --noEmit -p packages/gsd-agent-core/tsconfig.json` → exits 0
- `grep "build:agent-types" package.json` → found in both script definition and build:gsd chain
- `ls packages/gsd-agent-core/src/lifecycle-hook-types.ts` → file not found (deleted)

## Deviations from Plan

**1. [Rule 3 - Blocking] Built dist/ before verifying gsd-agent-core**
- **Found during:** Task 2 verification
- **Issue:** `tsc --noEmit -p packages/gsd-agent-core/tsconfig.json` failed with TS2307 "Cannot find module '@gsd/agent-types'" because the workspace symlink pointed to source but no `dist/index.d.ts` existed yet for Node16 module resolution
- **Fix:** Ran `tsc -p packages/gsd-agent-types/tsconfig.json` to generate `dist/` before re-running gsd-agent-core type check
- **Files modified:** packages/gsd-agent-types/dist/ (generated, not committed)
- **Commit:** N/A — build artifact, not tracked

## Known Stubs

None — all type exports are concrete and fully wired.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundaries introduced. Pure type definitions.

## Self-Check: PASSED

- packages/gsd-agent-types/package.json: FOUND
- packages/gsd-agent-types/tsconfig.json: FOUND
- packages/gsd-agent-types/src/index.ts: FOUND
- Commit 6e72e151a: FOUND
- Commit 689a1073c: FOUND
- packages/gsd-agent-core/src/lifecycle-hook-types.ts: deleted (confirmed)
