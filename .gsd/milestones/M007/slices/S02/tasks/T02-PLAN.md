# T02: ChatPane SSE Connection and Parser Integration

**Slice:** S02
**Milestone:** M007

## Goal

Build `ChatPane` — the component that connects to a PTY session via SSE (same `/api/terminal/stream` endpoint used by xterm.js), feeds raw output chunks to `PtyChatParser`, and exposes the resulting `ChatMessage[]` as React state. This is the data layer for all chat rendering.

## Must-Haves

### Truths

- `ChatPane` connects to the PTY session SSE stream on mount using the provided `sessionId`
- Raw PTY output chunks are fed to `PtyChatParser.feed()` as they arrive
- `ChatPane` re-renders when new/updated messages are emitted by the parser
- `ChatPane` disconnects SSE cleanly on unmount (no EventSource leaks)
- `ChatPane` accepts an `onSendInput(data: string): void` callback used by child components to write to the PTY
- `ChatPane` exposes `sendInput(data: string)` which POSTs to `/api/terminal/input` with the session ID

### Artifacts

- `web/components/gsd/chat-mode.tsx` — `ChatPane` component added (combined file grows to min 150 lines)

### Key Links

- `ChatPane` props: `{ sessionId: string; command?: string; className?: string }`
- SSE URL: `/api/terminal/stream?id=${sessionId}` (optionally `&command=${command}`)
- Input POST: `/api/terminal/input` with `{ id: sessionId, data: string }`
- `PtyChatParser` from `@/lib/pty-chat-parser`

## Steps

1. Read `web/components/gsd/shell-terminal.tsx` `TerminalInstance` component — understand exact SSE connection pattern, reconnect handling, and input queue flush pattern to replicate faithfully
2. Import `PtyChatParser`, `ChatMessage` from `@/lib/pty-chat-parser`
3. Build `ChatPane` component:
   - Create `PtyChatParser` instance in a ref (stable across renders)
   - Create `messages` state: `useState<ChatMessage[]>([])`
   - `useEffect` on mount: open `EventSource` to SSE stream URL, on message: parse JSON, on `type === "output"`: call `parserRef.current.feed(msg.data)`, update messages state
   - Subscribe to `parser.onMessage()` to get push updates; `setMessages([...parser.getMessages()])`
   - Cleanup: `es.close()`, unsubscribe from parser
4. Implement `sendInput(data: string)`: POST to `/api/terminal/input` with sessionId and data; use the same fire-and-forget queue pattern from `shell-terminal.tsx` to avoid concurrent requests
5. Connect the `ChatMode` component's main pane to use `ChatPane` with `sessionId="gsd-main"` and `command="pi"`
6. Log message count to console during development to verify parser is receiving data
7. Verify in browser: open Chat Mode, confirm SSE connects, confirm messages state updates as GSD outputs

## Observability Impact

**Signals added by this task:**
- `console.log("[ChatPane] SSE connected sessionId=%s", sessionId)` — fires when EventSource receives `type === "connected"`. Visible in browser DevTools Console. Confirms the SSE handshake succeeded.
- `console.log("[ChatPane] SSE error/disconnected sessionId=%s", sessionId)` — fires on `es.onerror`. Confirms the broken connection path.
- `console.debug("[ChatPane] messages=%d sessionId=%s", count, sessionId)` — fires every time the parser emits an update. Allows tracking whether the parser is receiving and segmenting PTY output.
- `PtyChatParser` itself emits `console.debug("[pty-chat-parser] ...")` for boundary detection, role classification, and completion signals.

**How to inspect at runtime:**
1. Open browser DevTools → Network → filter by `stream` → click the SSE request → EventStream tab shows raw chunks in real time.
2. Console tab filtered to `[ChatPane]` shows connection lifecycle and message count changes.
3. `window.__chatParser` is set in dev mode — call `window.__chatParser.getMessages()` in the console to inspect the parsed message array directly.
4. React DevTools → Components → `ChatPane` → props/state shows `messages` array and `connected` boolean.

**Failure visibility:**
- If SSE never connects: `[ChatPane] SSE connected` log never appears; `connected` state stays `false`; chat view shows a "Connecting…" indicator (rendered in T03, but the `connected` prop is wired here).
- If parser receives data but produces no messages: message count log stays at 0; check the raw EventStream chunks for unexpected format.

## Context

- The PTY session `"gsd-main"` is pre-initialized by the always-mounted DualTerminal component. When ChatPane connects to the same session ID, it subscribes to an already-running PTY. The first messages will be whatever GSD has output since session start.
- The SSE stream for a session delivers ALL output from the beginning if there's a buffer, or just new output from connection time. This means ChatPane may miss messages from before it mounted. This is acceptable for the MVP — the chat history will be incomplete but functional.
- Do NOT create a new PTY session in ChatPane — always connect to an existing session by ID. The `command` prop is passed to the SSE URL but only used if the session doesn't exist yet.
- The input queue pattern from shell-terminal.tsx (array + flush loop) prevents concurrent POSTs from corrupting the PTY input stream. Copy this pattern exactly.
