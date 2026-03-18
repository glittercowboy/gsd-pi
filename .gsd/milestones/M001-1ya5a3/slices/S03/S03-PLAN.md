# S03: Message Stream + Markdown Rendering

**Goal:** Replace the raw JSON event stream with structured, beautifully-typeset markdown rendering that streams in real-time as a continuous document flow.
**Demo:** Send a prompt that produces markdown (headings, code blocks, tables, lists). Text streams incrementally with Shiki syntax highlighting, styled tables, proper heading hierarchy, inline code styling. No jank. Streaming cursor shows during generation. Auto-scroll follows content but respects manual scroll-up. Tool events render as minimal stubs (S04 fills them in). The message stream feels like reading a premium document, not debugging JSON.

## Must-Haves

- Message model transforms raw `StoreEvent[]` into structured `MessageBlock[]` (assistant text, tool use, user prompt)
- Assistant text renders via Streamdown with Shiki syntax highlighting for code blocks
- Custom component overrides for all markdown elements (h1-h6, p, code, pre, table, th/td, blockquote, ul/ol/li, a, hr, strong, em) styled to the dark amber design system
- Streaming cursor (block caret) visible during active streaming, hidden when done
- Auto-scroll follows new content when near bottom, preserves manual scroll-up position
- Tool events render as minimal placeholder stubs (tool name + collapsed indicator)
- User prompts render as styled blocks in the document flow
- No visible jank or flicker during high-frequency delta streaming (Streamdown memoization handles this)
- `npm run build -w studio` passes with zero errors

## Proof Level

- This slice proves: integration (event stream → structured model → rendered markdown with highlighting)
- Real runtime required: yes (Shiki WASM must load in Electron renderer, streaming must be smooth)
- Human/UAT required: yes (typography quality, visual rhythm, code block aesthetics)

## Verification

- `npm run test -w studio` — all existing tests pass + new message-model unit tests pass
- `npm run build -w studio` — zero errors, Shiki/Streamdown WASM bundled correctly
- `studio/test/message-model.test.mjs` — unit tests for the message model transformer covering: text delta accumulation, interleaved tool events, mixed content types, empty events, event type field inconsistency (K005)
- Runtime: launch dev app, send a markdown-heavy prompt → headings render with hierarchy, code blocks show Shiki highlighting, tables render as styled tables, inline code distinct from block code, streaming cursor appears during generation and disappears after
- Runtime: send a long prompt → auto-scroll follows, scroll up manually → stays put, new content doesn't yank scroll position

## Observability / Diagnostics

- Runtime signals: message model derivation is a pure function — no runtime signals needed. Streamdown handles its own block-level memoization internally.
- Inspection surfaces: `useSessionStore.getState().events` in React DevTools shows raw events; the derived message model can be inspected by calling the pure `buildMessageBlocks()` function from devtools with those events.
- Failure visibility: if Shiki WASM fails to load, code blocks fall back to unstyled `<pre>` — visible immediately. Console errors from Streamdown/Shiki surface in Electron DevTools.
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `session-store.ts` (events, isStreaming), `use-gsd.ts` (sendPrompt), `CenterPanel.tsx` (replaced event log), CSS design tokens from `index.css`
- New wiring introduced in this slice: CenterPanel renders `<MessageStream>` instead of raw EventRows. MessageStream derives structured blocks from store events and renders AssistantBlock (Streamdown), UserBlock, and ToolStub components.
- What remains before the milestone is truly usable end-to-end: S04 (bespoke tool cards replace ToolStubs), S05 (interactive prompt UI), S06 (file tree + editor), S07 (preview pane + final integration)

## Tasks

- [x] **T01: Build message model and wire MessageStream into CenterPanel** `est:30m`
  - Why: The raw event log must be replaced with a structured message pipeline. The message model is the pure-logic seam between raw events and rendering — it must be correct and tested before adding markdown complexity. This task also installs streamdown + @streamdown/code to unblock T02.
  - Files: `studio/src/renderer/src/lib/message-model.ts`, `studio/src/renderer/src/components/message-stream/MessageStream.tsx`, `studio/src/renderer/src/components/layout/CenterPanel.tsx`, `studio/test/message-model.test.mjs`, `studio/package.json`
  - Do: Create `message-model.ts` with a `buildMessageBlocks(events)` function that transforms `StoreEvent[]` into `MessageBlock[]`. Each block is typed: `assistant-text` (accumulated text from message_update text content), `tool-use` (from tool_execution_start), or `user-prompt` (from the sendPrompt command echo or agent_start context). Install `streamdown` and `@streamdown/code` into studio workspace. Build `MessageStream.tsx` that reads events from the store, derives blocks via useMemo, and renders them — assistant text as plain `<pre>` for now. Replace the event log in CenterPanel with `<MessageStream>`. Write unit tests for the message model covering key edge cases. Preserve the ConnectionBadge, EmptyState, and Composer from CenterPanel.
  - Verify: `npm run test -w studio` passes including new message-model tests. `npm run build -w studio` succeeds. Dev app shows accumulated text from message_update events as plain text (not JSON).
  - Done when: message model tested, MessageStream wired in, assistant text accumulates and displays as plain text in the center panel.

- [ ] **T02: Integrate Streamdown with Shiki highlighting and custom markdown components** `est:35m`
  - Why: This is the visual core of S03 — transforming plain accumulated text into beautifully rendered markdown with syntax-highlighted code blocks, styled tables, proper heading hierarchy, and all design-system-matched typography. Addresses R003 directly.
  - Files: `studio/src/renderer/src/components/message-stream/AssistantBlock.tsx`, `studio/src/renderer/src/components/markdown/components.tsx`, `studio/src/renderer/src/components/markdown/shiki-theme.ts`, `studio/src/renderer/src/components/message-stream/MessageStream.tsx`
  - Do: Create custom Streamdown component overrides in `components.tsx` for all markdown elements styled with Tailwind classes matching the dark amber design system. Create `shiki-theme.ts` that configures `createCodePlugin` with a dark theme (use `vitesse-dark` as base — closest to the app palette). Build `AssistantBlock.tsx` wrapping `<Streamdown>` with the code plugin, custom components, `caret="block"`, and `isAnimating` bound to store's `isStreaming`. Update MessageStream to render `<AssistantBlock>` instead of plain `<pre>`.
  - Verify: `npm run build -w studio` succeeds (confirms Shiki WASM bundles correctly in Electron/Vite). Dev app renders code blocks with syntax highlighting, tables as styled tables, headings with hierarchy, inline code styled differently from block code.
  - Done when: all markdown elements render with design-system styling, code blocks show Shiki highlighting, streaming cursor appears during generation.

- [ ] **T03: Add UserBlock, ToolStub, and polish streaming UX** `est:25m`
  - Why: Completes the message stream with all block types, polishes spacing/typography rhythm, and ensures scroll behavior is correct. This is the final quality pass that makes S03 demo-ready. Also imports `streamdown/styles.css` for caret animations.
  - Files: `studio/src/renderer/src/components/message-stream/UserBlock.tsx`, `studio/src/renderer/src/components/message-stream/ToolStub.tsx`, `studio/src/renderer/src/components/message-stream/MessageStream.tsx`, `studio/src/renderer/src/styles/index.css`
  - Do: Create `UserBlock.tsx` — styled display of the user's prompt text with subtle visual distinction (left border or icon). Create `ToolStub.tsx` — minimal placeholder for tool_execution events showing tool name + chevron indicator, collapsed appearance, muted styling. Wire both into MessageStream's block rendering switch. Import `streamdown/styles.css` in the main CSS for caret animations. Polish MessageStream spacing: gaps between blocks, max-width constraint, proper document rhythm. Ensure auto-scroll uses the isNearBottom pattern (80px threshold from S02) triggered by content changes. Add empty state when no messages.
  - Verify: `npm run build -w studio` succeeds. Dev app shows user prompts as styled blocks, tool events as collapsed stubs with tool name, streaming cursor appears/disappears correctly, auto-scroll works during streaming and respects manual scroll-up, empty state shows before first message.
  - Done when: all three block types render correctly in the document flow, typography has proper rhythm, scroll behavior is correct, the message stream looks premium.

## Files Likely Touched

- `studio/src/renderer/src/lib/message-model.ts` (new)
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` (new)
- `studio/src/renderer/src/components/message-stream/AssistantBlock.tsx` (new)
- `studio/src/renderer/src/components/message-stream/UserBlock.tsx` (new)
- `studio/src/renderer/src/components/message-stream/ToolStub.tsx` (new)
- `studio/src/renderer/src/components/markdown/components.tsx` (new)
- `studio/src/renderer/src/components/markdown/shiki-theme.ts` (new)
- `studio/src/renderer/src/components/layout/CenterPanel.tsx` (modify)
- `studio/src/renderer/src/styles/index.css` (modify — add streamdown styles import)
- `studio/test/message-model.test.mjs` (new)
- `studio/package.json` (modify — add streamdown deps)
