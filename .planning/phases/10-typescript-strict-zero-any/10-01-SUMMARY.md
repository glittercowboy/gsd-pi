---
phase: 10-typescript-strict-zero-any
plan: "01"
subsystem: type-foundation
tags: [typescript, vendor-patch, type-guards, discriminated-unions]
dependency_graph:
  requires: []
  provides: [assertNever, isToolResultEventType, getEditorKeybindings, ServerToolUseBlock, WebSearchResultBlock, GSDAgentSession]
  affects: [packages/gsd-agent-core, packages/gsd-agent-modes, src/cli.ts]
tech_stack:
  added: []
  patterns: [discriminated-union-type-guards, structural-interface-pattern, function-overloads]
key_files:
  created: []
  modified:
    - packages/pi-coding-agent/src/core/extensions/types.ts
    - packages/pi-tui/src/index.ts
    - packages/gsd-agent-types/src/index.ts
decisions:
  - "Used CustomToolResultEvent (not ToolResultEvent & { toolName: TName }) for generic isToolResultEventType overload — matches the existing union member"
  - "GSDAgentSession uses import() type references to avoid circular deps while capturing actual AgentSession method signatures"
  - "WebSearchResultBlock.content typed as unknown (not string) to match runtime usage where it can be an array of search results or error object"
metrics:
  duration: "~20 minutes"
  completed: "2026-04-16T15:07:05Z"
  tasks_completed: 2
  files_modified: 3
---

# Phase 10 Plan 01: Type Foundation and Vendor Barrel Fixes Summary

Type foundation plan establishing three vendor patches and new type exports in @gsd/agent-types. Patches isToolResultEventType overloads into pi-coding-agent, adds getEditorKeybindings alias to pi-tui, and extends @gsd/agent-types with assertNever, ServerToolUseBlock/WebSearchResultBlock discriminated unions with type guards, and GSDAgentSession structural interface.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add isToolResultEventType and getEditorKeybindings alias | 299a577 | packages/pi-coding-agent/src/core/extensions/types.ts, packages/pi-tui/src/index.ts |
| 2 | Extend @gsd/agent-types with assertNever, discriminated unions, GSDAgentSession | 846bb31 | packages/gsd-agent-types/src/index.ts |

## What Was Built

### Task 1 — Vendor Barrel Patches

**pi-coding-agent `isToolResultEventType`:** Added 9 function overloads + implementation to `extensions/types.ts` (immediately after the existing `isToolCallEventType` block). The overloads cover all 7 built-in tool result event types (bash, read, edit, write, grep, find, ls) plus a generic overload for custom tools. The extensions barrel at `index.ts` already referenced `isToolResultEventType` in its re-exports — no barrel change needed.

**pi-tui `getEditorKeybindings`:** Added `export { getKeybindings as getEditorKeybindings } from "./keybindings.js"` to the pi-tui barrel. This is an alias so consumers importing either name get the same function.

### Task 2 — @gsd/agent-types Extensions

**`assertNever`:** Exported function that accepts `never` and throws at runtime. Used in switch exhaustiveness checks across subsequent plans.

**`ServerToolUseBlock` / `WebSearchResultBlock`:** Discriminated union interfaces for runtime content blocks that appear in pi-ai streaming responses but are absent from the public API. Type guards (`isServerToolUseBlock`, `isWebSearchResultBlock`) use structural narrowing on `unknown` input — no `as any` in guard bodies (satisfies T-10-01).

**`GSDAgentSession`:** Structural interface capturing the subset of `AgentSession` methods used at call sites in `src/cli.ts` and `packages/gsd-agent-modes/src/main.ts` (`setModel`, `setThinkingLevel`, `getAllTools`, `setActiveToolsByName`, `setScopedModels`, `model`, `thinkingLevel`, `agent.state.tools`). Uses `import()` type references to avoid circular dependency while staying accurate.

## Verification

- `npm run build -w @gsd/agent-types` exits 0
- `tsc --noEmit -p packages/gsd-agent-types/tsconfig.json` exits 0
- `isToolResultEventType` has 11 matches in types.ts (overloads + implementation + JSDoc)
- `getEditorKeybindings` has 1 match in pi-tui/src/index.ts
- Pre-existing build failures in pi-coding-agent and pi-tui (overlay-layout.js missing, Theme.sourceInfo missing, etc.) are unrelated to plan scope and were present before these changes

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — `isServerToolUseBlock` and `isWebSearchResultBlock` type guards use `unknown` input with structural narrowing as specified by T-10-01. No `as any` in guard bodies.

## Self-Check: PASSED

- packages/pi-coding-agent/src/core/extensions/types.ts — modified, committed 299a577
- packages/pi-tui/src/index.ts — modified, committed 299a577
- packages/gsd-agent-types/src/index.ts — modified, committed 846bb31
- 10-01-SUMMARY.md — this file
