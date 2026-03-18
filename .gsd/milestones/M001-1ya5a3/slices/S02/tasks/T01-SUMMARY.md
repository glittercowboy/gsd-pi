---
id: T01
parent: S02
milestone: M001-1ya5a3
provides:
  - GsdService subprocess manager with LF-only JSONL framing
  - Self-contained RPC type declarations (zero agent package imports)
  - IPC channel handlers (gsd:spawn, gsd:send-command, gsd:status, gsd:event, gsd:connection-change, gsd:stderr)
  - Real preload bridge replacing S01 stubs
  - Unit tests for JSONL framing, event dispatch, timeout, and fire-and-forget classification
key_files:
  - studio/src/main/rpc-types.ts
  - studio/src/main/gsd-service.ts
  - studio/src/main/index.ts
  - studio/src/preload/index.ts
  - studio/src/preload/index.d.ts
  - studio/test/gsd-service.test.mjs
key_decisions:
  - Replicated JSONL parser and dispatch logic in test file as pure functions to avoid importing Electron-dependent GsdService module in Node test runner
  - GsdService singleton is app-scoped, created after app.whenReady(), events forwarded to all BrowserWindow instances
patterns_established:
  - LF-only JSONL buffer drain pattern (indexOf('\n'), not readline)
  - IPC channel naming convention: gsd:{action} for invoke, gsd:{event-name} for send
  - Preload bridge returns cleanup functions from subscription methods (onEvent, onConnectionChange, onStderr)
  - Extension UI auto-responder pattern: fire-and-forget methods forwarded as events, interactive methods auto-responded with defaults and console.warn
observability_surfaces:
  - "[gsd-service]" prefixed console logs for spawn (with PID), exit (code+signal), crash detection, restart attempts, auto-response warnings, dispose
  - "[studio]" prefixed logs for connection state changes, before-quit cleanup
  - window.studio.getStatus() returns live { connected: boolean } from main process
  - GsdService.lastError, lastExitCode, restartCount tracked for diagnostic access
duration: 15m
verification_result: passed
completed_at: 2026-03-18
blocker_discovered: false
---

# T01: Build GsdService, RPC types, IPC bridge, and preload wiring in the main process

**Implement complete main-process backend for gsd-2 RPC: GsdService subprocess manager with LF-only JSONL framing, self-contained RPC types, IPC handlers, real preload bridge, and 19 unit tests.**

## What Happened

Created all six files specified in the task plan:

1. **rpc-types.ts** — Self-contained RPC protocol types (RpcCommand, RpcResponse, RpcSessionState, AgentEvent, RpcExtensionUIRequest, RpcExtensionUIResponse, FIRE_AND_FORGET_METHODS). Zero imports from agent packages. Simplified union types cover the command subset the studio needs.

2. **gsd-service.ts** — Subprocess manager following the VS Code GsdClient pattern. Spawns `gsd --mode rpc --no-session`, implements manual `buffer + indexOf('\n')` JSONL splitting, tracks pending requests by ID with configurable timeout (30s default), auto-responds to interactive extension UI requests (`select` → first option, `confirm` → true, `input` → empty, `editor` → prefill), crash recovery with exponential backoff (1s/2s/3s, max 3 in 60s window), SIGTERM with 2s SIGKILL fallback on stop.

3. **main/index.ts** — Updated with GsdService singleton creation after app.whenReady(), three ipcMain.handle registrations (gsd:spawn, gsd:send-command, gsd:status), event forwarding to all windows, and before-quit disposal.

4. **preload/index.ts** — Replaced all stubs with real ipcRenderer.invoke/on calls. Subscription methods return cleanup functions. Handler strips IPC event arg before passing data to callbacks.

5. **preload/index.d.ts** — Updated StudioBridge type with onConnectionChange, onStderr, Record-based sendCommand, Promise-based spawn/getStatus.

6. **gsd-service.test.mjs** — 19 new tests covering JSONL framing (single line, multi-line, partial chunks, CR+LF, empty lines, U+2028/U+2029 passthrough, invalid JSON, incomplete buffer), event dispatch (pending resolution, unmatched ID forwarding, non-response forwarding), fire-and-forget classification, pending request timeout, and auto-response logic for all four interactive methods.

## Verification

- `npm run test -w studio` — 21/21 tests pass (19 new + 2 existing token tests)
- `npm run build -w studio` — zero TypeScript errors, all three targets built (main 11.8KB, preload 1.1KB, renderer 672KB)
- No `@gsd/` imports in rpc-types.ts (grep confirms 0 matches)
- No `readline` usage in gsd-service.ts (only appears in a "no readline" comment)
- `contextIsolation: true` and `nodeIntegration: false` preserved in main window config

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npm run test -w studio` | 0 | ✅ pass | 4.5s |
| 2 | `npm run build -w studio` | 0 | ✅ pass | 4.5s |

Slice-level checks status (T01 is first of two tasks):
- ✅ `npm run test -w studio` — all pass including new gsd-service tests
- ✅ `npm run build -w studio` — zero TypeScript errors
- ⏳ `npx electron-vite dev` runtime check — requires T02 (renderer UI) to demonstrate full pipeline
- ⏳ LSP diagnostics — LSP not available in worktree; TypeScript build serves as equivalent verification

## Diagnostics

- Main process logs `[gsd-service] spawned gsd --mode rpc (pid: XXXX)` on start
- Auto-response warnings: `[gsd-service] auto-responding to extension_ui_request (method=X, id=Y)`
- Crash recovery: `[gsd-service] crash detected, restarting in Xms (attempt N/3)`
- `window.studio.getStatus()` from renderer devtools returns `{ connected: boolean }`
- `GsdService.lastError` / `lastExitCode` available for inspection in main process

## Deviations

None. All six files created exactly as specified.

## Known Issues

None.

## Files Created/Modified

- `studio/src/main/rpc-types.ts` — new: self-contained RPC protocol types (commands, responses, session state, extension UI, fire-and-forget set)
- `studio/src/main/gsd-service.ts` — new: subprocess manager with JSONL framing, pending requests, crash recovery, auto-responder
- `studio/src/main/index.ts` — modified: GsdService lifecycle, IPC handlers, event forwarding, before-quit cleanup
- `studio/src/preload/index.ts` — modified: real IPC bridge replacing all stubs
- `studio/src/preload/index.d.ts` — modified: updated StudioBridge type with onConnectionChange, onStderr, Promise-based API
- `studio/test/gsd-service.test.mjs` — new: 19 unit tests for JSONL framing, dispatch, timeout, fire-and-forget, auto-response
