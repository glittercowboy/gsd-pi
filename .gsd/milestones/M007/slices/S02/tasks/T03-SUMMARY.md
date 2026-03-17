---
id: T03
parent: S02
milestone: M007
provides:
  - ChatBubble component — renders ChatMessage as styled chat bubble (assistant/user/system roles)
  - MarkdownContent component — dynamic react-markdown + remark-gfm + shiki rendering for assistant bubbles
  - ChatMessageList component — scrollable list with scroll-lock (isNearBottom ref, 100px threshold)
  - ChatInputBar component — textarea with Enter-to-send, Shift+Enter newline, send button, Disconnected badge
  - chat-cursor keyframe animation in globals.css
  - chat-code-block and chat-markdown CSS classes in globals.css
key_files:
  - web/components/gsd/chat-mode.tsx
  - web/app/globals.css
key_decisions:
  - MarkdownContent uses a single useEffect with content in deps array (re-runs on streaming updates) rather than two effects; avoids stale closure and duplicate code
  - getChatHighlighter() is a module-level singleton in chat-mode.tsx (not imported from file-content-viewer.tsx since it is not exported there); same pattern means both singletons will resolve independently but are each cached on first call
  - StreamingCursor uses inline `style={{ animation: "chat-cursor..." }}` rather than Tailwind's `animate-[...]` to guarantee the keyframe name references the one defined in globals.css
  - ChatInputBar uses textarea (not input[type=text]) to support Shift+Enter multiline; auto-resizes via scrollHeight measurement capped at 160px
patterns_established:
  - Chat message rendering pattern: role switch at ChatBubble level → system/user are pure JSX, assistant delegates to MarkdownContent which owns all async module loading
  - Scroll-lock pattern: isNearBottomRef updated in onScroll handler; useEffect on messages compares prevMessageCount and scrolls only if isNearBottomRef.current === true
observability_surfaces:
  - console.log("[ChatPane] SSE connected sessionId=%s") — fires on SSE connect
  - console.log("[ChatPane] SSE error/disconnected sessionId=%s") — fires on SSE error
  - console.debug("[ChatPane] messages=%d sessionId=%s") — fires on every parser update
  - console.debug("[ChatBubble] markdown modules loaded") — fires once when react-markdown/shiki load
  - window.__chatParser (dev only) — exposes PtyChatParser for runtime inspection
  - ChatInputBar "Disconnected" badge — visual SSE failure indicator
duration: ~1.5h
verification_result: passed
completed_at: 2026-03-17
blocker_discovered: false
---

# T03: Chat Bubble Rendering and Markdown

**Built `ChatBubble`, `MarkdownContent`, `ChatMessageList`, and `ChatInputBar` — delivering fully styled, markdown-capable chat rendering with scroll-lock and live PTY input in `chat-mode.tsx` (619 lines).**

## What Happened

Pre-flight: added `## Observability Impact` section to T03-PLAN.md as required.

Step 1 (read file-content-viewer.tsx): confirmed the react-markdown + remark-gfm + shiki dynamic import pattern, the `getHighlighter()` singleton, and the `dangerouslySetInnerHTML` code block renderer. `getHighlighter` is not exported so I replicated the singleton as `getChatHighlighter()` in chat-mode.tsx.

Step 2 (`ChatBubble`): built role-dispatching component — system → centered muted italic line; user → right-aligned `bg-primary` bubble with plain text; assistant → left-aligned card bubble with `MessagesSquare` avatar, delegating to `MarkdownContent`. All roles show `StreamingCursor` when `complete === false`.

Step 3 (`MarkdownContent`): single `useEffect` with `[content]` dependency. Dynamic import of react-markdown + remark-gfm + getChatHighlighter() in parallel. Full component map: code blocks with shiki syntax highlighting (try/catch fallback), inline code, pre (unwrapped), table/th/td, a (opens in new tab), h1-h3, ul/ol, blockquote, hr, p, img (placeholder). Falls back to plain `whitespace-pre-wrap` text while modules load or if import fails.

Step 4 (`ChatMessageList`): scroll-lock via `isNearBottomRef` boolean ref, updated in `onScroll` handler using `scrollHeight - scrollTop - clientHeight < 100`. `useEffect([messages])` auto-scrolls to `scrollRef.current.scrollHeight` only when `isNearBottomRef.current === true`.

Step 5 (`ChatInputBar`): textarea with `rows={1}`, auto-resize via `scrollHeight` measurement capped at `160px`. Enter → `handleSend()` → `onSendInput(value + "\n")` + clear. Shift+Enter → native newline behavior. Send button lit when `hasContent && connected`. Disconnected badge shown when `!connected`.

Step 6 (CSS): appended `@keyframes chat-cursor`, `.chat-code-block`, and `.chat-markdown` to `web/app/globals.css`. `StreamingCursor` uses `style={{ animation: "chat-cursor 1s ease-in-out infinite" }}` to reference the keyframe by name.

Step 7 (wire): `ChatPane` renders `<ChatMessageList>` when messages exist, `<PlaceholderState>` when empty, `<ChatInputBar>` always. Deleted the intermediate `ChatInputBarScaffold` and `MessageList` stubs from T02.

## Verification

- `npm run build:web-host` exits 0 (ran twice — first after initial write, second after refactor)
- Browser: navigated to Chat Mode, confirmed "Chat Mode / Connected — waiting for GSD output…" placeholder
- Browser: `textarea[aria-label='Send message']` selector visible ✓
- Browser: "GSD session · Shift+Enter for newline" hint visible ✓
- Browser: console shows `[ChatPane] SSE connected sessionId=%s gsd-main` ✓
- Browser: no React errors in console ✓
- Artifact: 619 lines (>300 required) ✓

Slice-level verification status:
- `npm run build:web-host` exits 0 — ✅ PASS (this task)
- Manual: Chat nav item present, click switches view — ✅ PASS (T01)
- Manual: SSE connects, send message, user bubble appears, GSD response as assistant bubble — ⏳ requires live GSD session (human UAT)
- Manual: code block syntax highlighting — ⏳ requires live GSD session with markdown output (human UAT)
- Failure path: disconnect SSE → "Disconnected" badge appears in input bar — ✅ PASS (confirmed visible when dev server is not running)

## Diagnostics

- Browser DevTools Console → filter `[ChatPane]` for SSE lifecycle; `[ChatBubble]` for markdown module load
- Browser DevTools Network → filter `stream` → select gsd-main EventSource → EventStream sub-tab for raw SSE chunks
- `window.__chatParser.getMessages()` in dev console for current parsed messages
- React DevTools: ChatPane state `messages[]` and `connected`; ChatMessageList `isNearBottomRef`
- If chat is blank after SSE connects: check `window.__chatParser.getMessages()` — if empty, PtyChatParser is not classifying output (S01 issue, not S02)
- If markdown doesn't render: check for module import failures in console; `MarkdownContent` falls back silently to plain text

## Deviations

- T02 left `MessageList` and `ChatInputBarScaffold` as stubs. T03 replaced both with the final `ChatMessageList` and `ChatInputBar` implementations (as planned).
- `MarkdownContent` uses a single `useEffect([content])` rather than the two-effect approach initially drafted — this is cleaner and avoids a stale-closure issue where the first effect's `cancelled` flag would block content updates during streaming.

## Known Issues

- During fast streaming, `MarkdownContent` re-runs its `useEffect` on every content change — this fires multiple dynamic imports, but they all resolve instantly from the module cache after the first load. No visible performance issue observed.
- The `chat-cursor` keyframe is defined globally in `globals.css`. If another part of the app defines the same keyframe name differently, there would be a conflict. Low risk currently.

## Files Created/Modified

- `web/components/gsd/chat-mode.tsx` — 619 lines; added `MarkdownContent`, `StreamingCursor`, `ChatBubble`, `ChatMessageList`, `ChatInputBar`; replaced T02 stubs; preserved `ChatPane`, `ChatModeHeader`, `PlaceholderState`, `getChatHighlighter` singleton
- `web/app/globals.css` — appended `@keyframes chat-cursor`, `.chat-code-block` shiki styles, `.chat-markdown` overflow helpers
- `.gsd/milestones/M007/slices/S02/tasks/T03-PLAN.md` — added `## Observability Impact` section (pre-flight fix)
