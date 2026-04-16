---
phase: 10-typescript-strict-zero-any
plan: 09
subsystem: gsd-agent-modes interactive mode components and controllers
tags: [typescript, any-elimination, vendor-seam, type-safety]
dependency_graph:
  requires: [10-01, 10-04]
  provides: [zero-any-gsd-agent-modes-production]
  affects: [gsd-agent-modes]
tech_stack:
  added: [RuntimeContentBlock type alias, GSDMarkdownExtension interface, GSDInputExtension interface]
  patterns: [vendor-seam dual-module-path casts, extension interfaces for optional method probes, structural type aliases for runtime-only content blocks]
key_files:
  created: []
  modified:
    - packages/gsd-agent-modes/src/modes/interactive/components/tool-execution.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/footer.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/assistant-message.ts
    - packages/gsd-agent-modes/src/modes/interactive/components/extension-input.ts
    - packages/gsd-agent-modes/src/modes/interactive/controllers/chat-controller.ts
    - packages/gsd-agent-modes/src/modes/interactive/controllers/model-controller.ts
    - packages/gsd-agent-modes/src/modes/interactive/controllers/extension-ui-controller.ts
    - packages/gsd-agent-modes/src/modes/interactive/controllers/input-controller.ts
    - packages/gsd-agent-modes/src/cli/session-picker.ts
decisions:
  - Used RuntimeContentBlock = { type: string; [key: string]: unknown } as structural alias for AssistantMessage content elements to avoid dual-module-path as-any casts throughout chat-controller.ts
  - Used extension interfaces (GSDSessionManager, GSDSessionState, GSDAgentSessionExt) for optional method probes in footer.ts rather than direct as-any casts
  - Used vendor-seam bracket-notation pattern for pi-coding-agent runtime-only block properties (serverToolUse, externalResult) rather than as-any
metrics:
  duration: ~45 minutes
  completed: "2026-04-16T18:19:41Z"
  tasks_completed: 2
  files_modified: 9
---

# Phase 10 Plan 09: Eliminate any in gsd-agent-modes Interactive Components and Controllers Summary

Eliminated all 49 undocumented `any` occurrences in gsd-agent-modes production files. Zero undocumented any in gsd-agent-modes/src/ production code with tsc --noEmit passing.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Eliminate any in components | 92a2557f9 | tool-execution.ts, footer.ts, assistant-message.ts, extension-input.ts |
| 2 | Eliminate any in controllers and session-picker | 92ee78f93 | chat-controller.ts, model-controller.ts, extension-ui-controller.ts, input-controller.ts, session-picker.ts |

## Changes by File

### tool-execution.ts
- `private args: any` → `private args: Record<string, unknown>`
- `details?: any` → `details?: Record<string, unknown>` (in result type and updateResult param)
- `args: any` constructor param → `args: Record<string, unknown>`
- `updateArgs(args: any)` → `updateArgs(args: Record<string, unknown>)`
- Filter/map callbacks `(c: any)`, `(img: any)` — removed `: any` annotations (inferred from typed array)
- `renderCall as any`, `renderResult as any` — replaced with `as unknown as (...a: unknown[]) => Container | undefined` with `vendor-seam:` comment

### footer.ts
- Added `GSDSessionManager`, `GSDSessionState`, `GSDAgentSessionExt` extension interfaces
- Three `as any` casts replaced with typed `as unknown as` casts using those interfaces

### assistant-message.ts
- `(c as any).type === "serverToolUse"` → `isServerToolUseBlock(c)` (imported from @gsd/agent-types)

### extension-input.ts
- `(this.input as any).secure` / `(this.input as any).placeholder` → `GSDInputExtension` interface with vendor-seam comment

### chat-controller.ts
- Introduced `RuntimeContentBlock = { type: string; [key: string]: unknown }` as structural type alias
- `getMarkdownThemeWithSettings: () => any` → `() => MarkdownTheme`
- `addMessageToChat: (message: any, options?: any)` → `(message: Record<string, unknown>, options?: { populateHistory?: boolean })`
- `getRegisteredToolDefinition: (toolName: string) => any` → `(toolName: string) => ToolDefinition | undefined`
- `innerEvent.toolCall as any` → `as unknown as Record<string, unknown>` with bracket-notation access
- `(innerEvent as any).type === "server_tool_use"` → `"type" in innerEvent && (innerEvent as { type: string }).type === "server_tool_use"`
- `(searchContent as any).type` → `"type" in searchContent && (searchContent as { type: unknown }).type`
- All `(b: any)` callbacks in segment walker → `blocks` cast once to `Array<Record<string, unknown>>`
- `(pinnedTextComponent as any).maxLines` → `(pinnedTextComponent as unknown as GSDMarkdownExtension).maxLines`
- `finalBlocks[i] as any`, `priorBlocks[...] as any`, `finalBlocks[...] as any` → `finalBlocks` cast once to `Array<Record<string, unknown>>`

### model-controller.ts
- All 4 `host: any` params → `host: InteractiveModeStateHost`
- `Model<any>` return types → `Model<Api>`
- `(scoped: any)` filter/map → `(scoped: ScopedModel)` (imported from @gsd/pi-coding-agent)

### extension-ui-controller.ts
- `host: any` → `host: InteractiveModeStateHost`
- `getAvailableThemesWithPaths() as any`, `getThemeByName(name) as any`, `setThemeInstance(themeOrName as any)` → `as unknown as` with `vendor-seam:` comments

### input-controller.ts
- `getSlashCommandContext: () => any` → `() => SlashCommandContext` (imported from slash-command-handlers.ts)

### session-picker.ts
- `keybindings as any` → `keybindings as unknown as PiKeybindingsManager` with `vendor-seam:` comment

## Verification Results

```
grep -rn ": any\b\|as any\b\| any;" packages/gsd-agent-modes/src/ | grep -v "vendor-seam" | grep -v "\.test\." | grep -v "__tests__"
# → 0 matches

./node_modules/.bin/tsc --noEmit
# → exits 0

grep -rn ": any\b\|as any\b\| any;" packages/gsd-agent-core/src/ packages/gsd-agent-types/src/ | grep -v vendor-seam
# → 0 matches (no regression)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RuntimeContentBlock type alias used instead of per-site any removal for chat-controller.ts content block loops**
- **Found during:** Task 2
- **Issue:** AssistantMessage.content typed as `(TextContent | ThinkingContent | ToolCall)[]` but pi-coding-agent appends serverToolUse/webSearchResult blocks at runtime. Per-site `as any` removal would require either accepting type errors or using `as unknown as Record<string, unknown>` on every single block access.
- **Fix:** Introduced `RuntimeContentBlock = { type: string; [key: string]: unknown }` structural alias and cast `blocks` once at the top of each loop. Cleaner and more readable than per-site casts.
- **Files modified:** chat-controller.ts
- **Commit:** 92ee78f93

**2. [Rule 2 - Missing] addMessageToChat message parameter typed as `Record<string, unknown>` instead of `AgentMessage`**
- **Found during:** Task 2
- **Issue:** `AgentMessage` from `@gsd/pi-agent-core` is not a direct dependency of `gsd-agent-modes`. Using the concrete type would require adding a new direct dependency.
- **Fix:** Used `Record<string, unknown>` as the message parameter type in the interface extension. This is accurate since the function only stores/forwards the object without destructuring typed fields.
- **Files modified:** chat-controller.ts
- **Commit:** 92ee78f93

## Known Stubs

None — all changes are type-only with no data stubs.

## Threat Flags

None — this plan is type annotation changes only; no new network endpoints, auth paths, or schema changes introduced.

## Self-Check: PASSED

- [x] packages/gsd-agent-modes/src/modes/interactive/components/tool-execution.ts — modified
- [x] packages/gsd-agent-modes/src/modes/interactive/components/footer.ts — modified
- [x] packages/gsd-agent-modes/src/modes/interactive/components/assistant-message.ts — modified
- [x] packages/gsd-agent-modes/src/modes/interactive/components/extension-input.ts — modified
- [x] packages/gsd-agent-modes/src/modes/interactive/controllers/chat-controller.ts — modified
- [x] packages/gsd-agent-modes/src/modes/interactive/controllers/model-controller.ts — modified
- [x] packages/gsd-agent-modes/src/modes/interactive/controllers/extension-ui-controller.ts — modified
- [x] packages/gsd-agent-modes/src/modes/interactive/controllers/input-controller.ts — modified
- [x] packages/gsd-agent-modes/src/cli/session-picker.ts — modified
- [x] Commit 92a2557f9 — Task 1 component fixes
- [x] Commit 92ee78f93 — Task 2 controller fixes
- [x] tsc --noEmit exits 0
- [x] grep gate for any (excluding vendor-seam, test files) returns 0 matches
