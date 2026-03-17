---
id: T02
parent: S02
milestone: M007
provides:
  - ChatPane component with live SSE connection to gsd-main PTY session
  - PtyChatParser integration — raw PTY chunks fed through parser to produce ChatMessage[] React state
  - Input queue pattern (fire-and-forget with flush loop) for /api/terminal/input POST
  - connected boolean state wired to placeholder text and input bar enabled state
  - window.__chatParser dev-mode inspection surface
key_files:
  - web/components/gsd/chat-mode.tsx
key_decisions:
  - ChatPane is a named export (not default) so T03 can import it independently if needed
  - messages state is updated via parser.onMessage() subscription rather than polling — avoids unnecessary renders
  - sendInput function exposed via prop to ChatInputBarScaffold — no additional context needed for T03
  - PlaceholderState and ChatInputBarScaffold both receive connected bool so UI reflects SSE state
patterns_established:
  - SSE connection pattern: EventSource created in useEffect, cleaned up in return, mirrors TerminalInstance exactly
  - Parser subscription pattern: onMessage callback calls parser.getMessages() and spreads into state — avoids stale closure
  - Input queue flush: copied verbatim from shell-terminal.tsx — array + flushing ref guards concurrent POSTs
observability_surfaces:
  - console.log "[ChatPane] SSE connected sessionId=..." fires on type==="connected" event
  - console.log "[ChatPane] SSE error/disconnected sessionId=..." fires on es.onerror
  - console.debug "[ChatPane] messages=N sessionId=..." fires on every parser.onMessage() update
  - window.__chatParser (dev only) — call .getMessages() in console to inspect parsed message array
  - browser DevTools Network tab → filter "stream" → EventStream sub-tab shows raw SSE chunks
duration: ~45m
verification_result: passed
completed_at: 2026-03-17
blocker_discovered: false
---

# T02: ChatPane SSE Connection and Parser Integration

**Wired live SSE connection from `ChatPane` to the `gsd-main` PTY session, feeding raw output through `PtyChatParser` to produce `ChatMessage[]` React state — SSE connect confirmed in browser.**

## What Happened

Read `shell-terminal.tsx` `TerminalInstance` to understand the exact SSE connection and input queue flush pattern. Replicated the pattern faithfully in a new `ChatPane` component added to `chat-mode.tsx`.

`ChatPane` creates a `PtyChatParser` instance in a stable ref on mount, subscribes to `parser.onMessage()` to push state updates, opens an `EventSource` to `/api/terminal/stream?id=gsd-main&command=pi`, and feeds `type === "output"` SSE chunks to `parser.feed()`. On unmount it closes the EventSource and unsubscribes.

The `sendInput(data: string)` function uses the input queue pattern from `shell-terminal.tsx` — a `string[]` ref and a `flushingRef` boolean guard prevent concurrent POSTs to `/api/terminal/input`.

`ChatMode` was updated to render `<ChatPane sessionId="gsd-main" command="pi" />` instead of the T01 placeholder `ChatPane`.

The T01 `PlaceholderState` was updated to receive `connected: boolean` and shows context-appropriate text: "Connecting to GSD session…" vs "Connected — waiting for GSD output…". `ChatInputBarScaffold` is also updated to receive `connected` and `onSendInput`, enabling/disabling the input and POSTing to the PTY on Enter.

A `MessageList` component renders raw `ChatMessage[]` in a minimal styled list (styled chat bubbles are T03's job — this is just data-layer verification scaffolding).

The T02-PLAN.md was updated with the missing `## Observability Impact` section before implementation.

## Verification

**Build:** `npm run build:web-host` exits 0. No type errors. No new warnings.

**Browser (standalone dist, port 3000):**
- Chat nav button `button[title="Chat"]` present ✅
- Clicking it renders ChatMode view ✅
- Header shows "Chat" + "GSD-MAIN" badge ✅
- Console log `[ChatPane] SSE connected sessionId=%s gsd-main` appeared within ~3s of mount ✅
- Placeholder text changed to "Connected — waiting for GSD output…" confirming `connected=true` state ✅
- Input bar enabled with "Send a message… (Enter to send)" placeholder ✅

**Explicit assertions (all 5 PASS):**
- `text_visible: "Chat Mode"` ✅
- `text_visible: "Connected — waiting for GSD output"` ✅
- `text_visible: "GSD-MAIN"` ✅
- `selector_visible: button[title='Chat']` ✅
- `console_message_matches: "[ChatPane] SSE connected"` ✅

## Diagnostics

- Console (browser DevTools): filter by `[ChatPane]` — shows SSE lifecycle and message count
- Console: filter by `[pty-chat-parser]` — shows parser boundary detection, role classification, completion signals
- Network tab: filter by `stream` → select the gsd-main EventSource → EventStream sub-tab shows raw SSE chunks
- `window.__chatParser.getMessages()` in dev console (production builds: not available)
- React DevTools → ChatPane → state shows `messages` array and `connected` boolean

## Deviations

`MessageList` component was added as a minimal raw-text rendering list to confirm messages state is wired correctly (T03 will replace it with styled markdown bubbles). This was a minor deviation but consistent with the plan's step 6 intent to "log message count to verify parser is receiving data" — rendering provides stronger visual verification than console logging alone.

## Known Issues

None. The GSD workspace had a boot failure during testing (unrelated `/api/boot 500`) but the SSE terminal stream and ChatPane connection worked correctly regardless.

## Files Created/Modified

- `web/components/gsd/chat-mode.tsx` — Replaced T01 stub ChatPane with live ChatPane (SSE + PtyChatParser + sendInput queue). Added MessageList, updated PlaceholderState with connected prop, updated ChatInputBarScaffold with connected + onSendInput. 279 lines total.
- `.gsd/milestones/M007/slices/S02/tasks/T02-PLAN.md` — Added missing `## Observability Impact` section (pre-flight fix).
