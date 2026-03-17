# T03: Chat Bubble Rendering and Markdown

**Slice:** S02
**Milestone:** M007

## Goal

Build `ChatBubble` — renders a `ChatMessage` as a visually styled bubble. Assistant bubbles render markdown via react-markdown (with syntax-highlighted code blocks). User bubbles are plain outgoing-style. System messages are muted inline. Add the text input bar at the bottom of the ChatPane.

## Must-Haves

### Truths

- Assistant messages render as chat bubbles with markdown: bold, italics, headers, lists, code (inline + block), tables all display correctly
- Code blocks in assistant messages are syntax-highlighted via shiki (reusing the pattern from `file-content-viewer.tsx`)
- User messages render as outgoing bubbles (right-aligned or visually distinct from assistant)
- System messages render as small muted inline lines (not as bubbles)
- The bottom input bar accepts typed text and sends it to the PTY on Enter
- The message list scrolls to the bottom on new messages; scrolling up to read history does not get overridden while the user is scrolled up
- The entire chat area is visually polished — not a raw list dump

### Artifacts

- `web/components/gsd/chat-mode.tsx` — `ChatBubble`, `ChatMessageList`, `ChatInputBar` components added (file grows to min 300 lines)

### Key Links

- `ChatBubble` consumes `ChatMessage` from `@/lib/pty-chat-parser`
- Markdown rendering: dynamic import `react-markdown` + `remark-gfm` + `getHighlighter()` from shiki — matching the pattern in `file-content-viewer.tsx`
- `ChatInputBar` calls `ChatPane`'s `sendInput()` via prop callback

## Steps

1. Read `web/components/gsd/file-content-viewer.tsx` `MarkdownViewer` component — understand the react-markdown + remark-gfm + shiki pattern to replicate
2. Build `ChatBubble` component:
   - Props: `{ message: ChatMessage }`
   - For `role === 'assistant'`: render a left-aligned bubble with markdown content (use dynamic import for react-markdown, same as file-content-viewer)
   - For `role === 'user'`: render a right-aligned or visually distinct outgoing bubble with plain text
   - For `role === 'system'`: render a small centered muted line (no bubble chrome)
   - For incomplete messages (`complete === false`): show a subtle streaming indicator (animated dots or cursor blink) at the end of the content
3. Build `ChatMessageList` component:
   - Renders `ChatMessage[]` as a scrollable list of `ChatBubble` components
   - Auto-scroll-to-bottom behavior: scroll to bottom when new messages arrive ONLY if the user is already near the bottom (within 100px); if user has scrolled up, don't override
   - Implement "scroll lock" detection with a `useRef` tracking scroll position
4. Build `ChatInputBar` component:
   - Single-line text input at the bottom of the pane
   - On Enter: call `sendInput(value + "\n")`, clear the input
   - On Shift+Enter: insert newline (multi-line input)
   - Show a subtle send button
5. Wire everything together in `ChatPane`: render `ChatMessageList` + `ChatInputBar`
6. Apply design: use a clean, modern chat aesthetic consistent with the existing GSD dark/light theme. Bubbles should feel like a premium chat app — not a generic ChatGPT clone, not raw terminal text. Use the existing CSS variables (bg-card, bg-accent, text-foreground, text-muted-foreground, border-border) for theme consistency.
7. Verify: open Chat Mode in browser, confirm markdown renders, code blocks are highlighted, messages scroll correctly

## Context

- The design goal is "craft feel" — a non-technical user should feel like they're in a modern chat app, not looking at terminal output. The visual treatment should be intentionally different from Power Mode.
- Shiki `getHighlighter()` is expensive — the singleton from file-content-viewer.tsx is already cached globally. Import it from there if it's exported, or replicate the same singleton pattern in chat-mode.tsx.
- The streaming indicator (dots/cursor) matters because GSD responses can take seconds to stream. Users need feedback that something is happening.
- The markdown code block renderer uses `dangerouslySetInnerHTML` for shiki output — this is fine since shiki escapes everything and we're only rendering code, not user content. Match the pattern exactly from file-content-viewer.tsx.
- Scroll lock: track `isNearBottom` with a boolean ref updated in the scroll handler. Only auto-scroll if `isNearBottom === true`. This is the standard pattern for chat UIs.

## Observability Impact

**Signals added by this task:**

- `[ChatPane] SSE connected sessionId=%s` — console.log on successful SSE connect (preserved from T02)
- `[ChatPane] SSE error/disconnected sessionId=%s` — console.log on SSE error/disconnect
- `[ChatPane] messages=%d sessionId=%s` — console.debug on every parser update (fires during streaming)
- `[ChatBubble] markdown modules loaded` — console.debug once when react-markdown + remark-gfm + shiki are first loaded
- `window.__chatParser` — in dev mode, exposes PtyChatParser for `window.__chatParser.getMessages()` inspection

**Failure visibility:**

- If `connected === false`: `ChatInputBar` shows a "Disconnected" badge and disables the input field
- If markdown modules fail to load: `ChatBubble` falls back to plain `whitespace-pre-wrap` text rendering
- If shiki highlighting fails for a code block: falls back to plain `<pre><code>` rendering (try/catch)
- Scroll behavior inspectable via `scrollRef.current.scrollTop` in React DevTools

**How to inspect this task's runtime state:**

1. Browser DevTools Console → filter `[ChatPane]` for SSE lifecycle; filter `[ChatBubble]` for markdown load
2. Browser DevTools Network → filter `stream` → select gsd-main EventSource → EventStream sub-tab
3. `window.__chatParser.getMessages()` in console for current parsed message array
4. React DevTools: `ChatPane` state shows `messages[]` and `connected` boolean
