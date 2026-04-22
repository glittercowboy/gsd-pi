---
phase: 10-typescript-strict-zero-any
plan: "04"
subsystem: gsd-agent-modes/interactive
tags: [typescript, any-elimination, type-guards, extension-interfaces]
dependency_graph:
  requires: ["10-01", "10-02"]
  provides: ["typed-interactive-mode-state", "typed-interactive-mode"]
  affects: ["gsd-agent-modes"]
tech_stack:
  added: []
  patterns:
    - "Extension interface pattern (GSDSettingsManager, GSDResourceLoader, etc.) for optional runtime methods"
    - "isServerToolUseBlock/isWebSearchResultBlock type guards for content discrimination"
    - "unknown[] with blockType narrowing for heterogeneous content arrays"
    - "Parameters<typeof fn>[0] cast for private-field-to-interface structural casts"
    - "vendor-seam comments for dual-module-path AgentSession/Theme nominal mismatches"
key_files:
  created: []
  modified:
    - packages/gsd-agent-modes/src/modes/interactive/interactive-mode-state.ts
    - packages/gsd-agent-modes/src/modes/interactive/interactive-mode.ts
decisions:
  - "Category 3 vendor-seam: FooterComponent(session as any) retained — AgentSession dual-module-path cannot be fixed without pi-mono upstream changes"
  - "Category 3 vendor-seam: setRegisteredThemes(themes as any) retained at 3 sites — Theme dual-module-path"
  - "this as unknown as Parameters<typeof fn>[0] used for controller casts (setupEditorSubmitHandler, handleAgentEvent) to avoid any while preserving private-field structural compatibility"
  - "buildAssistantReplaySegments changed to Array<unknown> with blockType narrowing to handle runtime-only ServerToolUseBlock in typed content arrays"
metrics:
  duration: "~25 minutes"
  completed: "2026-04-16"
  tasks_completed: 2
  files_modified: 2
---

# Phase 10 Plan 04: Interactive Mode State + interactive-mode.ts any Elimination Summary

Eliminated all `any` from the two largest any-concentration files in gsd-agent-modes. InteractiveModeStateHost now has zero any fields with 15+ concrete types. interactive-mode.ts has zero undocumented as-any casts with 4 documented vendor-seam sites.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Type all InteractiveModeStateHost fields (D-06) | 0d0208a84 |
| 2 | Eliminate as-any casts in interactive-mode.ts (D-01 categories 1, 2, 3) | f3044c427 |

## Task 1: InteractiveModeStateHost Typing

Replaced all 15+ `any` fields in `interactive-mode-state.ts` with concrete types:

| Field | Type | Source |
|-------|------|--------|
| `session` | `AgentSession` | `@gsd/agent-core` |
| `ui` | `TUI` | `@gsd/pi-tui` |
| `editor` | `EditorComponent` | `@gsd/pi-tui` |
| `chatContainer`, `statusContainer`, `pinnedMessageContainer`, `editorContainer` | `Container` | `@gsd/pi-tui` |
| `loadingAnimation`, `retryLoader`, `autoCompactionLoader` | `Loader` | `@gsd/pi-tui` |
| `footer` | `FooterComponent` | `./components/footer.js` (local — not `@gsd/pi-coding-agent`) |
| `keybindings`, `keybindingsManager` | `KeybindingsManager` | `@gsd/agent-core` |
| `settingsManager` | `SettingsManager` | `@gsd/agent-types` |
| `pendingTools` | `Map<string, ToolExecutionComponent>` | local component |
| `streamingComponent` | `AssistantMessageComponent` | local component |
| `streamingMessage` | `AssistantMessage` | `@gsd/pi-ai` |
| `extensionSelector` | `ExtensionSelectorComponent` | local component |
| `extensionInput` | `ExtensionInputComponent` | local component |
| `extensionEditor` | `ExtensionEditorComponent` | local component |

## Task 2: interactive-mode.ts Cast Elimination

### Category 1 — Runtime content type guards (6 type guard call-sites)

- `(content as any).type === "serverToolUse"` → `isServerToolUseBlock(content)` with full narrowing
- `(resultBlock as any).type === "webSearchResult"` → `isWebSearchResultBlock(resultBlock)` 
- `hasToolBlocks` check → `content.some((c) => c.type === "toolCall" || isServerToolUseBlock(c))`
- `(content[i] as any).type` → `block.type || isServerToolUseBlock(block)`
- `c: any` callbacks in `.some`/`.find` → properly typed with type guards
- `formatWebSearchResult`: `content as any` → structural narrowing with `{ type: unknown }` shape
- `buildAssistantReplaySegments`: `Array<any>` → `Array<unknown>` with `blockType` extraction

### Category 2 — Extension interfaces (8 extension interfaces defined)

| Interface | Methods | Target |
|-----------|---------|--------|
| `GSDSettingsManager` | `getTimestampFormat`, `setTimestampFormat`, `getRespectGitignoreInPicker`, `setRespectGitignoreInPicker` | `this.settingsManager` |
| `GSDAutocompleteProvider` | `setRespectGitignore` | `this.autocompleteProvider` |
| `GSDResourceLoader` | `getPathMetadata` | `this.session.resourceLoader` |
| `GSDSessionManager` | `wasInterrupted` | `this.session.sessionManager` |
| `GSDExtensionUIDialogOptions` | `secure` | `opts` in `showExtensionInput` |
| `GSDExtensionCallbackError` | `stack` | `error` in `onError` callback |
| `GSDContainer` | `detachChildren` | `widgetContainerAbove`, `container` in `renderWidgetContainer` |
| `GSDModelRegistry` | `discoverModels`, `getApiKeyForProvider` | `this.session.modelRegistry` |

All casts use `as unknown as GSDInterface` pattern (no `as any`).

### Category 3 — Vendor-seam documented (4 sites)

| Site | Reason |
|------|--------|
| `FooterComponent(session as any /* vendor-seam... */)` | AgentSession dual-module-path: `@gsd/pi-coding-agent` vs `@gsd/agent-core` |
| `setRegisteredThemes(themes as any /* vendor-seam... */)` (3 sites) | Theme dual-module-path through ResourceLoader vs direct import |

### Other fixes

- `cmd: any` in `getRegisteredCommands().filter/map` → `RegisteredCommand` type (imported from `@gsd/pi-coding-agent`)
- `this as any` in `setupEditorSubmitHandler` → `this as unknown as Parameters<typeof setupEditorSubmitHandlerController>[0]`
- `this as any` in `handleEvent` → `this as unknown as Parameters<typeof handleAgentEvent>[0]`

## Deviations from Plan

### Auto-added: GSDModelRegistry extension interface (Rule 2)

**Found during:** Task 2
**Issue:** Two `as any` casts for `discoverModels` and `getApiKeyForProvider` on `modelRegistry` were not mentioned in the plan but found during systematic scan
**Fix:** Added `GSDModelRegistry` extension interface following the same pattern as other extension interfaces
**Files modified:** `interactive-mode.ts`
**Commit:** f3044c427

## Verification Results

```
grep -c ": any" interactive-mode-state.ts  → 0
grep "as any" interactive-mode.ts | grep -v "vendor-seam" | wc -l  → 0
grep ": any" interactive-mode.ts | wc -l  → 0
grep "isServerToolUseBlock\|isWebSearchResultBlock" interactive-mode.ts  → 6 matches
grep "GSDSettingsManager\|GSDResourceLoader" interactive-mode.ts  → 9 matches
tsc --noEmit -p packages/gsd-agent-modes/tsconfig.json  → exit 0
```

## Self-Check: PASSED

- FOUND: packages/gsd-agent-modes/src/modes/interactive/interactive-mode-state.ts
- FOUND: packages/gsd-agent-modes/src/modes/interactive/interactive-mode.ts
- FOUND: .planning/phases/10-typescript-strict-zero-any/10-04-SUMMARY.md
- FOUND commit 0d0208a84 (task 1)
- FOUND commit f3044c427 (task 2)
- tsc --noEmit: exit 0
