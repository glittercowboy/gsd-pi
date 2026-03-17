# S02: Chat Mode View — Main Pane

**Goal:** Add the "Chat" nav entry to the sidebar, wire it into the app shell, and build `ChatMode` with a live `ChatPane` that connects to the main GSD PTY session, feeds output through `PtyChatParser`, and renders the conversation as styled chat bubbles with react-markdown.

**Demo:** Click "Chat" in the sidebar nav (below Power Mode). The main GSD session appears as a scrolling chat conversation — assistant responses rendered as markdown bubbles, user messages as outgoing bubbles, a text input bar at the bottom. Typing a message and pressing Enter sends it to the PTY.

## Must-Haves

- "Chat" nav item present in sidebar NavRail immediately below Power Mode
- `activeView === "chat"` renders `ChatMode` and hides the bottom terminal panel
- `ChatPane` connects to the `"gsd-main"` PTY session via SSE and feeds output to `PtyChatParser`
- `ChatMessage[]` state updates reactively as GSD outputs arrive
- Assistant messages render styled markdown: headers, bold, lists, inline code, fenced code blocks (syntax-highlighted via shiki), tables
- User messages render as distinct outgoing bubbles (plain text)
- System/status messages render as muted inline lines (not bubbles)
- Streaming messages show a subtle indicator while `complete === false`
- Auto-scroll to bottom on new messages unless user has scrolled up (scroll-lock)
- Text input bar sends typed text + `\n` to PTY on Enter
- `npm run build:web-host` exits 0

## Proof Level

- This slice proves: integration — live PTY output rendered as chat in the browser
- Real runtime required: yes — must verify against a running GSD instance
- Human/UAT required: yes — visual inspection of chat bubble rendering and markdown quality

## Verification

- `npm run build:web-host` exits 0
- Manual: open Chat Mode in browser, verify nav item present, click switches to chat view
- Manual: start GSD in the session, send a message via the input bar, verify it appears as a user bubble and GSD's response appears as an assistant bubble with markdown rendered
- Manual: paste a GSD response containing a code block — verify syntax highlighting renders
- Failure path: disconnect the SSE stream (kill the terminal process or use DevTools → Network → block the SSE URL); verify the chat input bar displays a "Disconnected" state indicator and a reconnection attempt is visible in the console

## Observability / Diagnostics

- Runtime signals: `ChatPane` logs to console when SSE connects/disconnects and when `PtyChatParser` emits a message count change — allows diagnosing silent SSE failures
- Inspection surfaces: browser DevTools → Network tab → SSE stream for `sessionId=gsd-main` shows raw output; `parser.getMessages()` accessible via React DevTools if exposed on window during dev
- Failure visibility: if SSE disconnects, chat input bar should show a muted "Disconnected" state indicator
- Redaction constraints: none — chat renders what the terminal would show; same data already visible in Power Mode

## Integration Closure

- Upstream surfaces consumed: `PtyChatParser` from `web/lib/pty-chat-parser.ts` (S01); `/api/terminal/stream` SSE; `/api/terminal/input` POST; `web/components/gsd/sidebar.tsx` navItems; `web/components/gsd/app-shell.tsx` KNOWN_VIEWS + view routing
- New wiring introduced: `ChatMode` component mounted in app-shell; sidebar nav entry registered; bottom terminal panel hidden for `activeView === "chat"`
- What remains before the milestone is truly usable end-to-end: S03 (TUI prompt intercept), S04 (action toolbar + right panel)

## Tasks

- [x] **T01: Nav entry and view scaffold** `est:45m`
  - Why: Nothing is visible until the nav item exists and routes to the ChatMode component
  - Files: `web/components/gsd/sidebar.tsx`, `web/components/gsd/app-shell.tsx`, `web/components/gsd/chat-mode.tsx` (new)
  - Do: (1) Read `sidebar.tsx` — find navItems array; add `{ id: "chat", label: "Chat", icon: MessagesSquare }` after the `power` entry. (2) Read `app-shell.tsx` — add `"chat"` to KNOWN_VIEWS Set; import `ChatMode`; add `{activeView === "chat" && <ChatMode />}` in view routing; add `activeView === "chat"` to the condition that hides the bottom terminal panel (same condition as `activeView !== "power"`). (3) Create `chat-mode.tsx` with a `ChatMode` component: full-height flex column, header bar at top, main pane area below (placeholder text acceptable).
  - Verify: `npm run build:web-host` exits 0; open browser, verify "Chat" icon in sidebar, click routes to chat view, sessionStorage persists the view selection
  - Done when: nav item visible below Power Mode, clicking shows ChatMode, no build errors, no regressions in other views

- [x] **T02: ChatPane SSE connection and parser integration** `est:1.5h`
  - Why: Without live data flowing through the parser, the chat view has nothing to render
  - Files: `web/components/gsd/chat-mode.tsx`
  - Do: (1) Read `web/components/gsd/shell-terminal.tsx` — copy the SSE connection pattern (EventSource + onmessage + input queue flush) exactly; do not import xterm.js. (2) Build `ChatPane` component: props `{ sessionId: string; command?: string; initialCommand?: string; onCompletionSignal?: () => void; className?: string }`. (3) Create `PtyChatParser` instance in a ref (stable). (4) `useState<ChatMessage[]>([])` for messages. (5) `useEffect` on mount: open EventSource to `/api/terminal/stream?id=${sessionId}${command ? "&command="+command : ""}`; on `type === "output"` call `parserRef.current.feed(msg.data)`; subscribe `parser.onMessage(() => setMessages([...parser.getMessages()]))`; subscribe `parser.onCompletionSignal(() => onCompletionSignal?.())`; cleanup: `es.close()` + unsubscribes. (6) Implement `sendInput(data: string)` using the input-queue flush pattern from shell-terminal.tsx (POST to `/api/terminal/input` with `{ id: sessionId, data }`). (7) Wire `ChatMode` to use `ChatPane` with `sessionId="gsd-main"` and `command="pi"`.
  - Verify: open Chat Mode in browser; open DevTools Network tab; confirm SSE stream connects for `id=gsd-main`; add `window.__chatMessages = parser.getMessages()` and inspect in console — should show messages
  - Done when: SSE connects, parser receives output, `messages` state updates reactively

- [ ] **T03: Chat bubble rendering and markdown** `est:2h`
  - Why: Messages in state are useless until they render as a polished chat UI
  - Files: `web/components/gsd/chat-mode.tsx`
  - Do: (1) Read `web/components/gsd/file-content-viewer.tsx` `MarkdownViewer` — copy the react-markdown + remark-gfm + shiki pattern exactly (same dynamic imports, same `getHighlighter()` singleton). (2) Build `ChatBubble`: `role === 'assistant'` → left-aligned bubble with MarkdownViewer rendering `message.content`; `role === 'user'` → right-aligned or visually distinct outgoing bubble with plain text; `role === 'system'` → small centered muted line, no bubble chrome. While `complete === false` on an assistant message, show animated dots at end of content. (3) Build `ChatMessageList`: renders `ChatMessage[]` as scrollable list of `ChatBubble`; scroll-to-bottom behavior — only auto-scroll if user is within 100px of bottom (track with `isNearBottom` ref in scroll handler). (4) Build `ChatInputBar`: single-line text input; on Enter call `sendInput(value + "\n")` + clear; on Shift+Enter insert newline. Show subtle send button. (5) Wire: `ChatPane` renders `<ChatMessageList messages={messages} />` + `<ChatInputBar onSend={sendInput} />`. (6) Apply design: use existing CSS variables (`bg-card`, `bg-accent`, `text-foreground`, `text-muted-foreground`, `border-border`). Assistant bubble: card background with slight border. User bubble: accent background. Gap between messages. Comfortable padding.
  - Verify: send a message via input bar, verify user bubble appears; verify GSD response renders as assistant bubble; paste markdown-heavy text into PTY and verify headers/code blocks render; verify scroll-lock works (scroll up, new message arrives, page doesn't yank down)
  - Done when: all three message roles render correctly, markdown renders with syntax highlighting, scroll-lock works, input bar sends to PTY

## Files Likely Touched

- `web/components/gsd/sidebar.tsx`
- `web/components/gsd/app-shell.tsx`
- `web/components/gsd/chat-mode.tsx` (new)
