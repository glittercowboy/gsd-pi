---
phase: 10-typescript-strict-zero-any
plan: "05"
subsystem: gsd-agent-core, gsd-agent-modes, src
tags: [typescript, any-elimination, dual-module-path, vendor-seam]
dependency_graph:
  requires: [10-01, 10-02]
  provides: [zero-undocumented-any-agent-core, workspace-tsc-clean-INT-03]
  affects: [gsd-agent-core, gsd-agent-modes, cli.ts]
tech_stack:
  added: []
  patterns:
    - Export extension interfaces from fallback-resolver.ts for typed cross-module casts
    - Vendor-seam comments on unavoidable dual-module-path as-any casts
    - Move createAgentSession import from pi-coding-agent to agent-core to eliminate dual-module-path session type mismatch
key_files:
  created: []
  modified:
    - packages/gsd-agent-core/src/agent-session.ts
    - packages/gsd-agent-core/src/fallback-resolver.ts
    - packages/gsd-agent-core/src/blob-store.ts
    - packages/gsd-agent-core/src/image-overflow-recovery.ts
    - packages/gsd-agent-modes/src/main.ts
decisions:
  - "Exported SettingsManagerWithFallback/AuthStorageWithFallback/ModelRegistryWithFallback from fallback-resolver.ts so agent-session.ts can cast to proper extension interfaces instead of as-any"
  - "Fixed dual-module-path TS2345 by moving createAgentSession import in main.ts from @gsd/pi-coding-agent to @gsd/agent-core — cleaner than GSDAgentSession wrapper approach since the session type now naturally matches what mode functions expect"
metrics:
  duration: 25m
  completed: 2026-04-16
  tasks_completed: 2
  files_modified: 5
---

# Phase 10 Plan 05: Agent-Session Any Elimination + Dual-Module-Path Fix Summary

**One-liner:** Eliminated all undocumented `as any` in gsd-agent-core (5 sites) and fixed dual-module-path TS2345 in main.ts/cli.ts by moving `createAgentSession` import to `@gsd/agent-core`; workspace `tsc --noEmit` exits 0 (INT-03 gate passed).

## Tasks Completed

| Task | Name | Commit | Status |
|------|------|--------|--------|
| 1 | Eliminate any casts in agent-session.ts and gsd-agent-core | 6aeb598e4 | Done |
| 2 | Fix dual-module-path TS2345 in main.ts and cli.ts | 268d49b1f | Done |

## Verification Results

- `tsc --noEmit` exits 0 at workspace root (INT-03 gate: PASSED)
- `grep "as any\|: any" packages/gsd-agent-core/src/ | grep -v vendor-seam` — 0 matches
- `grep "session as any" packages/gsd-agent-modes/src/main.ts | grep -v vendor-seam` — 0 matches
- `tsc --noEmit 2>&1 | grep "TS2345.*cli.ts"` — 0 matches
- `tsc --noEmit -p packages/gsd-agent-core/tsconfig.json` — exits 0
- `tsc --noEmit -p packages/gsd-agent-modes/tsconfig.json` — exits 0

## Changes by File

### packages/gsd-agent-core/src/fallback-resolver.ts
- Changed `interface` → `export interface` for `SettingsManagerWithFallback`, `AuthStorageWithFallback`, `ModelRegistryWithFallback`
- Enables importing these extension interfaces in agent-session.ts for proper typed casts

### packages/gsd-agent-core/src/agent-session.ts
- Imported `SettingsManagerWithFallback`, `AuthStorageWithFallback`, `ModelRegistryWithFallback` from fallback-resolver.ts
- Replaced 3 `as any` FallbackResolver constructor casts with typed extension interface casts
- Added vendor-seam comment to `(this._runtime as any)["createRuntime"] = factory` (no public setter on AgentSessionRuntime)
- Added vendor-seam comment to `currentTheme as any` in `createToolHtmlRenderer` (Theme dist vs src dual-module-path)

### packages/gsd-agent-core/src/blob-store.ts
- `catch (err: any)` → `catch (err: unknown)` with proper narrowing via `NodeJS.ErrnoException`

### packages/gsd-agent-core/src/image-overflow-recovery.ts
- `(contentArr as any[])[contentIdx] = ...` → `(contentArr as Array<TextContent | ImageContent>)[contentIdx] = ...`

### packages/gsd-agent-modes/src/main.ts
- Moved `createAgentSession` and `type CreateAgentSessionOptions` imports from `@gsd/pi-coding-agent` to `@gsd/agent-core`
- Removed 3 `session as any` casts in `runRpcMode`, `new InteractiveMode`, `runPrintMode` calls
- Rebuilt dist so cli.ts resolves `AgentSession` from `@gsd/agent-core` (matching what mode functions expect)

## Deviations from Plan

### Auto-fixed Issues

None - plan executed with one strategic deviation documented below.

### Plan Deviation: GSDAgentSession not used in main.ts (D-02 alternative approach)

**Found during:** Task 2

**Plan intent:** Use `GSDAgentSession` structural interface as the session parameter type in `runRpcMode`, `runPrintMode`, `InteractiveMode` so both session variants (from pi-coding-agent and from agent-core) structurally satisfy the contract.

**Actual fix:** The root cause of the TS2345 errors was that `main.ts` imported `createAgentSession` from `@gsd/pi-coding-agent`, so `session` had type `AgentSession` from `pi-coding-agent`. Moving this import to `@gsd/agent-core` means `session` is now typed as `AgentSession` from `gsd-agent-core` — exactly matching what `runRpcMode`, `runPrintMode`, `InteractiveMode` already expect. The `session as any` casts were removed, all TS2345 errors resolved, INT-03 gate passed.

**Why this is better:** No need for a `GSDAgentSession` shim with a large surface of properties. The architectural source of truth is clear: `main.ts` uses GSD's session orchestration (`@gsd/agent-core`), not pi's.

**Acceptance criteria impact:** The literal criterion `grep "GSDAgentSession" main.ts` returns 0 (not 1+), but all functional criteria are met: `session as any` = 0, TS2345 errors = 0, `tsc --noEmit` exits 0. `GSDAgentSession` remains available in `@gsd/agent-types` for future use by cli.ts or other callers.

## Known Stubs

None.

## Threat Flags

None. The changes are type-level only (cast replacements, import reorganization). No new network endpoints, auth paths, or trust boundaries introduced.

## Self-Check: PASSED

- SUMMARY.md: FOUND
- Task 1 commit 6aeb598e4: FOUND
- Task 2 commit 268d49b1f: FOUND
- workspace tsc --noEmit: exits 0
- undocumented any in gsd-agent-core: 0
