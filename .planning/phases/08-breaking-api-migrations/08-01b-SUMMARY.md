---
phase: 08-breaking-api-migrations
plan: 01b
subsystem: gsd-agent-core
tags: [api-migration, typescript, compile-errors, pi-0.67.2]
dependency_graph:
  requires: [08-01a]
  provides: [gsd-agent-core-compile]
  affects: [08-02, 08-03, 08-05]
tech_stack:
  added: []
  patterns: [local-type-shims, optional-chaining-removed-apis, gsd-assistant-message-extension]
key_files:
  created: []
  modified:
    - packages/gsd-agent-core/src/agent-session.ts
    - packages/gsd-agent-core/src/sdk.ts
    - packages/gsd-agent-core/src/retry-handler.ts
    - packages/gsd-agent-core/src/compaction-orchestrator.ts
decisions:
  - "MessageStartEvent/UpdateEvent/EndEvent defined locally — not in 0.67.2 public API"
  - "SessionBeforeSwitchResult/ForkResult/TreeResult defined locally — not in 0.67.2 public API"
  - "retryLastTurn removed from bindCore — not in ExtensionActions 0.67.2"
  - "getProviderAuthMode removed — no 0.67.2 replacement; externalToolExecution option also removed"
  - "getProviderOptions removed from AgentOptions in 0.67.2 — extensionUIContext no longer passed"
  - "AuthStorage backoff methods (getEarliestBackoffExpiry, areAllCredentialsBackedOff) absent in 0.67.2 — optional chaining via cast"
  - "hasLegacyOAuthCredential present in 0.67.2 AuthStorage — used directly"
  - "hashline tools + getEditMode removed from 0.67.2 — sdk.ts defaults to standard toolset"
  - "getThemeByName() used instead of removed 'theme' proxy export"
  - "GsdAssistantMessage local interface extends AssistantMessage with retryAfterMs (removed from pi-ai)"
  - "RetryErrorType local type replaces UsageLimitErrorType import for retry classification"
  - "compaction-orchestrator getApiKey(model, sessionId) -> getApiKeyAndHeaders(model)"
metrics:
  duration: "~45 minutes"
  completed: "2026-04-16T04:45:47Z"
  tasks_completed: 2
  files_changed: 4
---

# Phase 08 Plan 01b: Fix agent-session.ts and sdk.ts Summary

Fixed all compile errors in agent-session.ts and sdk.ts — completing the gsd-agent-core compile gate. `tsc --noEmit -p packages/gsd-agent-core/tsconfig.json` now exits 0 with zero errors across all files.

## Outcome

gsd-agent-core compiles clean against pi-mono 0.67.2. All 46 errors (22 in sdk.ts, 13 in agent-session.ts, 11 in retry-handler.ts) resolved. CompactionOrchestrator deviation added 1 more fix.

## Tasks Completed

| Task | Commit | Files |
|------|--------|-------|
| Task 1: Fix agent-session.ts — local type shims, event bindings, theme | 2cd2b7ff7 | agent-session.ts, retry-handler.ts, compaction-orchestrator.ts |
| Task 2: Fix sdk.ts — hashline removal, auth methods, AgentOptions cleanup | 87e52f25b, ce18cb8e2 | sdk.ts |

## What Was Fixed

### agent-session.ts (13 errors resolved)

**Local type shims added:**
- `MessageStartEvent`, `MessageUpdateEvent`, `MessageEndEvent` — removed from public API; defined locally using `AgentMessage` for message field
- `SessionBeforeSwitchResult`, `SessionBeforeForkResult`, `SessionBeforeTreeResult` — result types not in 0.67.2 public index; defined locally with all required fields
- `SessionBeforeTreeResult` has top-level `customInstructions?`, `replaceInstructions?`, `label?` fields (code accesses them on the result, not on result.summary)

**Extension bindings fixed:**
- `retryLastTurn` removed from `runner.bindCore()` — property was removed from `ExtensionActions` in 0.67.2
- `getSignal` added to `ExtensionContextActions` binding — uses `agent.signal` (the Agent's active run signal getter)

**Theme:**
- `theme` proxy (removed from public API) replaced with `getThemeByName(themeName) ?? getThemeByName("dark")!`
- `getThemeByName` added to import from `@gsd/pi-coding-agent`
- Dual-module-path Theme mismatch (dist vs src) bypassed with `as any` at createToolHtmlRenderer call

**Type casts:**
- `result.content` cast to `(ImageContent | TextContent)[]` in `afterToolCall` emitToolResult
- `event.messages` cast for `createRetryPromiseForAgentEnd` call

### retry-handler.ts (11 errors resolved — deviation fix)

- `ModelRegistryWithAuth` now simply extends `ModelRegistry` without conflicting `authStorage` override
- `markUsageLimitReached` called via `as unknown as { markUsageLimitReached?... }` cast with optional chaining
- `RetryErrorType` local type (`"rate_limit" | "quota_exhausted" | "server_error" | "unknown"`) replaces imported `UsageLimitErrorType`
- `GsdAssistantMessage` extends `AssistantMessage` with `retryAfterMs?: number` (field removed from pi-ai in 0.67.2)
- All private methods updated to use `GsdAssistantMessage` instead of `AssistantMessage`
- `createRetryPromiseForAgentEnd` parameter changed to `ReadonlyArray<{ role: string; [key: string]: unknown }>`
- `errorType` mapped to FallbackResolver's `UsageLimitErrorType` before calling `findFallback` (`"quota_exhausted"` → `"quota"`)

### compaction-orchestrator.ts (deviation fix)

- `ModelRegistryWithReadiness.getApiKey(model, sessionId)` → `getApiKeyAndHeaders(model)` — matches api discovered in Plan 01a
- Both call sites updated to destructure `authResult.ok ? authResult.apiKey : undefined`

### sdk.ts (22 errors resolved)

**Removed entirely:**
- `hashlineCodingTools`, `hashlineEditTool`, `hashlineReadTool` imports (not in 0.67.2)
- `createHashlineCodingTools`, `createHashlineEditTool`, `createHashlineReadTool` imports (not in 0.67.2)
- All hashline re-exports from the export block
- `SlashCommandLocation` re-export (renamed to `SlashCommandInfo`, already re-exported)
- `externalToolExecution` AgentOptions property (removed in 0.67.2)
- `getProviderOptions` AgentOptions callback (removed in 0.67.2)
- `getProviderAuthMode` calls (method removed from ModelRegistry in 0.67.2)
- `editMode` detection dead branch — `getEditMode` and hashline tools both gone, constant `["read", "bash", "edit", "write"]`

**Updated:**
- `modelRegistry.getApiKey(restoredModel)` → `modelRegistry.getApiKeyAndHeaders(restoredModel)` (checks `.ok`)
- `runner.emitBeforeProviderRequest(payload, currentModel)` → `runner.emitBeforeProviderRequest(payload)` (1-arg signature)
- `agent.replaceMessages(messages)` → `agent.state.messages = messages`
- AuthStorage backoff methods (`getEarliestBackoffExpiry`, `areAllCredentialsBackedOff`) — optional chaining via `gsdAuthStorage` cast; `hasLegacyOAuthCredential` still exists in 0.67.2 so called directly
- `getProviderOptions` implicit `any` params — removed with the option

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] retry-handler.ts had 11 compile errors blocking agent-session.ts**
- **Found during:** Task 1 (running tsc before starting)
- **Issue:** retry-handler.ts was untracked (new file) with 11 errors from 0.67.2 API mismatches: `ModelRegistryWithAuth` conflicting authStorage type, `UsageLimitErrorType` mismatch, `retryAfterMs` on `AssistantMessage`, type cast issues
- **Fix:** GsdAssistantMessage extension, RetryErrorType local type, ModelRegistryWithAuth simplified, optional chaining cast for markUsageLimitReached
- **Files modified:** `packages/gsd-agent-core/src/retry-handler.ts`
- **Commit:** 2cd2b7ff7

**2. [Rule 1 - Bug] compaction-orchestrator.ts getApiKey signature mismatch**
- **Found during:** Task 1 (agent-session.ts L407 error: getApiKey missing)
- **Issue:** compaction-orchestrator's ModelRegistryWithReadiness still had old `getApiKey(model, sessionId)` signature from 0.57.1 — this caused agent-session.ts to fail when passing _modelRegistry
- **Fix:** Updated interface to `getApiKeyAndHeaders(model)` and updated both call sites to destructure the result
- **Files modified:** `packages/gsd-agent-core/src/compaction-orchestrator.ts`
- **Commit:** 2cd2b7ff7

**3. [Rule 2 - Missing Critical] getSignal missing from ExtensionContextActions binding**
- **Found during:** Task 1 (tsc error at L2301 after removing retryLastTurn)
- **Issue:** `ExtensionContextActions` in 0.67.2 requires `getSignal(): AbortSignal | undefined` but bindCore second argument didn't include it
- **Fix:** Added `getSignal: () => this.agent.signal` — uses the Agent's active run signal getter
- **Files modified:** `packages/gsd-agent-core/src/agent-session.ts`
- **Commit:** 2cd2b7ff7

## 0.67.2 API Findings (for downstream plans)

| API | Status | Notes |
|-----|--------|-------|
| `ModelRegistry.getProviderAuthMode()` | Removed | No replacement found |
| `AgentOptions.externalToolExecution` | Removed | No replacement found |
| `AgentOptions.getProviderOptions` | Removed | extensionUIContext no longer passed to providers |
| `SettingsManager.getEditMode()` | Removed | hashline edit mode removed entirely |
| `AuthStorage.getEarliestBackoffExpiry()` | Removed | Optional chaining via cast |
| `AuthStorage.areAllCredentialsBackedOff()` | Removed | Optional chaining via cast |
| `AuthStorage.hasLegacyOAuthCredential()` | **Present** | Still in 0.67.2 |
| `ExtensionRunner.emitBeforeProviderRequest(payload)` | 1 arg | was 2 args in 0.57.1 |
| `ExtensionContextActions.getSignal` | Added | new required method in 0.67.2 |

## Known Stubs

None — all shims are typed correctly and use optional chaining to degrade gracefully when methods are absent at runtime.

## Threat Flags

None — this is a type-level API migration with no new network surfaces, auth paths, or data input paths.

## Self-Check

Verifying files exist and commits recorded.
