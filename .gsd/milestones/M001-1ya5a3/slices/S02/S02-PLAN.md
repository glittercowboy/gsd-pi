# S02: gsd-2 RPC Connection + Event Stream

**Goal:** The Electron app spawns gsd-2 as a subprocess via `gsd --mode rpc`, communicates bidirectionally over JSONL stdin/stdout, bridges all events to the renderer through Electron IPC, and renders raw events in the center panel as proof the pipe works end-to-end.

**Demo:** Launch the app → connection status shows "connecting" then "connected" → type a prompt in the composer → click Send → raw JSON events stream into the center panel in real time → kill the gsd-2 process externally → status changes to "disconnected" → auto-reconnect fires and status returns to "connected."

## Must-Haves

- `GsdService` class in the main process that spawns `gsd --mode rpc`, implements LF-only JSONL framing (no `readline`), manages pending requests by ID with timeouts, and handles crash detection with exponential-backoff reconnection
- Self-contained RPC type declarations in `studio/src/main/rpc-types.ts` — no imports from `@gsd/pi-coding-agent`
- Auto-responder for interactive `extension_ui_request` events (`select`, `confirm`, `input`, `editor`) so the agent never blocks — with console warnings during auto-response
- Fire-and-forget detection for `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` (no response needed)
- Real preload bridge replacing stubs: `ipcRenderer.invoke` for commands, `ipcRenderer.on` for event forwarding
- IPC channels: `gsd:event` (main→renderer), `gsd:send-command` (renderer→main), `gsd:spawn` (renderer→main), `gsd:status` (renderer→main)
- Zustand `session-store.ts` holding connection status, raw event log, and session metadata
- `useGsd` hook that subscribes to `window.studio.onEvent`, dispatches to the store, and exposes `sendCommand`/`spawn`
- CenterPanel replaced with real UI: connection status indicator, scrolling raw event log, working composer that sends `prompt` commands
- Subprocess cleanup on `app.on('before-quit')` and `process.on('exit')`
- Configurable binary path via `GSD_BIN_PATH` env var, defaulting to `gsd`
- Unit tests for JSONL framing and event dispatch logic

## Proof Level

- This slice proves: integration
- Real runtime required: yes (gsd-2 subprocess must actually stream events)
- Human/UAT required: no (automated tests prove framing; manual dev launch proves integration)

## Verification

- `npm run test -w studio` — existing token tests still pass, plus new `gsd-service.test.mjs` covering JSONL framing (LF-only, CR+LF handling, multi-line buffer, Unicode U+2028/U+2029 passthrough), event dispatch (response routing to pending requests, event forwarding), pending request timeout, and fire-and-forget classification
- `npm run build -w studio` — TypeScript compilation succeeds for main, preload, and renderer with zero errors
- `npx electron-vite dev -w studio` runtime check: main process logs `[gsd-service] spawned gsd --mode rpc (pid: XXXX)`, renderer shows connection status transitioning to "connected", typing a prompt and clicking Send produces raw JSON events in the center panel
- LSP diagnostics clean on `studio/src/main/gsd-service.ts`, `studio/src/main/rpc-types.ts`, `studio/src/preload/index.ts`, `studio/src/renderer/src/stores/session-store.ts`

## Observability / Diagnostics

- Runtime signals: `[gsd-service]` prefixed console logs for spawn, exit, crash, reconnect, and auto-response events. Connection state transitions logged with timestamps.
- Inspection surfaces: `window.studio.getStatus()` returns live connection state from the main process. Zustand store holds full raw event log accessible from React DevTools. Main process stderr forwarded as `gsd:stderr` events.
- Failure visibility: GsdService tracks `restartCount`, `lastError`, and `lastExitCode`. Pending request timeouts include the command type in the rejection reason. Auto-response warnings include the extension UI request method and ID.
- Redaction constraints: none (no secrets flow through the RPC pipe)

## Integration Closure

- Upstream surfaces consumed: `studio/src/main/index.ts` (Electron main process boot), `studio/src/preload/index.ts` (contextBridge stub + `StudioBridge` type), `studio/src/preload/index.d.ts` (global Window typing), `studio/src/renderer/src/components/layout/CenterPanel.tsx` (placeholder content)
- New wiring introduced in this slice: GsdService lifecycle tied to app lifecycle in main process, IPC channel registration in main process, preload bridge wired to real ipcRenderer calls, Zustand store subscribed to IPC events, CenterPanel consuming live event data
- What remains before the milestone is truly usable end-to-end: S03 (markdown rendering of message content), S04 (bespoke tool cards), S05 (interactive prompt UI), S06 (file tree + editor), S07 (preview pane + final integration)

## Tasks

- [x] **T01: Build GsdService, RPC types, IPC bridge, and preload wiring in the main process** `est:45m`
  - Why: This is the entire backend pipe — without it, the renderer has nothing to consume. Creates the subprocess manager, JSONL framing, pending request tracking, crash recovery, auto-responder for extension UI, IPC channel handlers, and replaces preload stubs with real IPC calls. Also adds unit tests for the JSONL and dispatch logic since those are the highest-risk pieces.
  - Files: `studio/src/main/gsd-service.ts`, `studio/src/main/rpc-types.ts`, `studio/src/main/index.ts`, `studio/src/preload/index.ts`, `studio/src/preload/index.d.ts`, `studio/test/gsd-service.test.mjs`
  - Do: (1) Create `rpc-types.ts` with self-contained types for RpcCommand, RpcResponse, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState, AgentEvent, and the FIRE_AND_FORGET_METHODS set — copied/simplified from the canonical types. (2) Create `gsd-service.ts` following the VS Code extension's `GsdClient` pattern: spawn `gsd --mode rpc`, LF-only buffer drain (no `readline`), pending request map with 30s timeout, crash detection with exponential backoff (max 3 restarts in 60s), `before-quit` cleanup, configurable binary path via `GSD_BIN_PATH`, auto-responder for interactive extension UI requests with console warnings. The class should accept a `forwardEvent` callback for IPC bridging. (3) Update `main/index.ts` to instantiate GsdService, register `ipcMain.handle` for `gsd:spawn`, `gsd:send-command`, `gsd:status`, forward events via `webContents.send('gsd:event', event)`, and clean up on quit. (4) Replace preload stubs with real `ipcRenderer.invoke`/`ipcRenderer.on` calls. Update the `StudioBridge` type to match the real API shape (sendCommand should return Promise, onEvent should use ipcRenderer.on). (5) Write `gsd-service.test.mjs` testing JSONL framing edge cases, event dispatch, pending request timeout, and fire-and-forget classification.
  - Verify: `npm run test -w studio` passes all tests including new ones. `npm run build -w studio` succeeds with zero errors. LSP diagnostics clean on all new/modified main and preload files.
  - Done when: Build passes, all tests pass, and the main process has a complete GsdService that can spawn gsd-2, route JSONL events, handle IPC from the renderer, auto-respond to extension UI, and recover from crashes.

- [ ] **T02: Build renderer session store, useGsd hook, and raw event stream UI** `est:35m`
  - Why: Proves the full round-trip by consuming the IPC bridge from T01. Creates the Zustand store to hold connection/event state, a hook to wire IPC events into React, and replaces the CenterPanel placeholder with a live raw event display and working composer. This is the visual proof that the pipe works.
  - Files: `studio/src/renderer/src/stores/session-store.ts`, `studio/src/renderer/src/lib/rpc/use-gsd.ts`, `studio/src/renderer/src/components/layout/CenterPanel.tsx`
  - Do: (1) Create `session-store.ts` Zustand store with: `connectionStatus` (`'disconnected' | 'connecting' | 'connected' | 'error'`), `events` array (capped at 500 for memory), `lastError` string, `isStreaming` boolean, `sessionState` (model info, session name from `state_update` events), plus actions: `addEvent`, `setConnectionStatus`, `setError`, `clearEvents`. (2) Create `use-gsd.ts` hook that on mount calls `window.studio.onEvent` to subscribe, dispatches events to the store (route `state_update` to session state, everything else to the event log), and exposes `sendPrompt(message)`, `spawn()`, `getStatus()` functions. The hook should auto-spawn on first mount if status is disconnected. (3) Replace `CenterPanel.tsx` with real UI: a connection status badge at the top (color-coded: amber=connecting, green=connected, red=error, gray=disconnected), a scrollable event log showing each event as a styled JSON block with the event type as a colored label, and the existing composer wired to call `sendPrompt`. The event log should auto-scroll to bottom on new events. Use the existing design system (Text, Button components, amber accent, JetBrains Mono for JSON). (4) Verify the full pipeline works: type in composer → sendCommand via preload → GsdService routes to gsd-2 → events stream back → store updates → UI renders.
  - Verify: `npm run build -w studio` succeeds. `npm run dev -w studio` shows connection status transitioning through states, events streaming in real-time when a prompt is sent. LSP diagnostics clean on all new/modified renderer files.
  - Done when: Build passes, the renderer shows live connection status, raw events stream into the center panel when a prompt is sent, and the full main→preload→renderer pipeline is proven working.

## Files Likely Touched

- `studio/src/main/gsd-service.ts` (new — subprocess manager)
- `studio/src/main/rpc-types.ts` (new — self-contained RPC types)
- `studio/src/main/index.ts` (modified — IPC handlers, GsdService lifecycle)
- `studio/src/preload/index.ts` (modified — real IPC bridge replacing stubs)
- `studio/src/preload/index.d.ts` (modified — updated StudioBridge type)
- `studio/src/renderer/src/stores/session-store.ts` (new — Zustand connection/event store)
- `studio/src/renderer/src/lib/rpc/use-gsd.ts` (new — React hook for IPC subscription)
- `studio/src/renderer/src/components/layout/CenterPanel.tsx` (modified — raw event stream UI)
- `studio/test/gsd-service.test.mjs` (new — JSONL framing and dispatch tests)
