# S03 — Message Stream + Markdown Rendering — Research

**Date:** 2026-03-18

## Summary

S03 replaces the raw JSON event stream in CenterPanel with structured, beautifully-typeset markdown rendering that streams in real-time. The RPC pipe already delivers `message_update` events with `assistantMessageEvent.type === 'text_delta'` carrying incremental `delta: string` values, plus the partial `AssistantMessage` with accumulated `content` array. The session store already receives these events and tracks `isStreaming` via `agent_start`/`agent_end`. The work is: accumulate text deltas into a growing markdown string, render it with streaming-aware markdown + Shiki highlighting, and style the output components to match the dark amber design system.

The critical discovery is **Streamdown** (`streamdown` + `@streamdown/code`) — Vercel's purpose-built React component for streaming LLM markdown. Trust score 10/10, actively maintained (updated 2026-02-12), with built-in: incomplete markdown handling (remend), Shiki code highlighting via plugin, block-level memoization (only affected blocks re-render), GFM tables, custom component overrides for all elements, `isAnimating` prop, and streaming cursor. This eliminates the need to hand-roll a markdown parser, delta accumulator with RAF batching, or Shiki integration. The roadmap's risk concern about "Shiki highlighting in the render loop could cause jank" is retired by Streamdown's architecture — it memoizes completed blocks and lazy-loads languages on demand.

## Recommendation

Use `streamdown` + `@streamdown/code` for markdown rendering. Override all element components (h1-h6, p, code, pre, table, blockquote, lists, inline code) with custom styled components matching the dark amber design system. Build a thin message accumulation layer that extracts text from `message_update` events and feeds the growing string to `<Streamdown>`. Tool events and message lifecycle events (start/end, tool_execution_*) should be classified but not rendered by S03 — they are placeholders that S04 fills with bespoke tool cards.

The rendering architecture is: session store events → message model (accumulates text blocks per assistant turn, interleaved with tool event placeholders) → MessageStream component renders the sequence → each text block is a `<Streamdown>` instance → tool placeholders render as minimal stubs (S04 replaces them).

## Implementation Landscape

### Key Files

**Existing (consume, don't modify unless noted):**
- `studio/src/renderer/src/stores/session-store.ts` — Zustand store with `events`, `isStreaming`, `addEvent()`. S03 reads from here. May add a derived selector or small helper but the store shape stays.
- `studio/src/renderer/src/lib/rpc/use-gsd.ts` — Hook that routes events to store. Already handles `agent_start`/`agent_end` → `setStreaming`. No changes needed.
- `studio/src/renderer/src/styles/index.css` — Design tokens (CSS custom properties). May add markdown-specific typography classes.

**Modify:**
- `studio/src/renderer/src/components/layout/CenterPanel.tsx` — Currently renders raw JSON event rows. Replace the event log with a `<MessageStream>` component. Keep the connection badge and composer.

**Create:**
- `studio/src/renderer/src/lib/message-model.ts` — Pure function that transforms the flat `StoreEvent[]` array into a structured message list: `MessageBlock[]` where each block is either `{ type: 'assistant-text', content: string }` or `{ type: 'tool-use', toolCallId: string, toolName: string, args: unknown }` or `{ type: 'user-prompt', text: string }`. This is the seam between raw events and rendering.
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — Container that reads events from the store, derives the message model, and renders the block sequence. Handles auto-scroll.
- `studio/src/renderer/src/components/message-stream/AssistantBlock.tsx` — Wraps `<Streamdown>` with the code plugin and custom component overrides. Passes `isAnimating` from store's `isStreaming`.
- `studio/src/renderer/src/components/message-stream/UserBlock.tsx` — Renders the user's prompt text. Simple styled block.
- `studio/src/renderer/src/components/message-stream/ToolStub.tsx` — Minimal placeholder for tool_execution events. Shows tool name + collapsed indicator. S04 replaces this with bespoke cards.
- `studio/src/renderer/src/components/markdown/components.tsx` — Custom Streamdown component overrides: headings (h1-h6), paragraphs, code (inline), pre (code blocks), tables (th/td/table), blockquotes, lists (ul/ol/li), links, horizontal rules. All styled with Tailwind classes matching the dark amber design system.
- `studio/src/renderer/src/components/markdown/shiki-theme.ts` — Custom Shiki theme definition matching the app's dark amber palette, or selection of an existing dark theme that's close enough (e.g., `vitesse-dark`, `one-dark-pro`) with CSS overrides for the container.

### Build Order

**Task 1: Message model + MessageStream container.** Create the `message-model.ts` transformer and `MessageStream.tsx` container. Wire it into CenterPanel replacing the raw event log. At this stage, render assistant text as plain `<pre>` blocks (no markdown) to prove the accumulation pipeline works — text deltas arrive, accumulate, and display as a growing document. Verify with the live app: send a prompt, see text grow. This unblocks everything else.

**Task 2: Streamdown integration + custom markdown components.** Install `streamdown` and `@streamdown/code`. Create the custom component overrides in `components.tsx`. Create `AssistantBlock.tsx` wrapping `<Streamdown>` with plugins and overrides. Configure the Shiki theme/colors. Replace the plain `<pre>` from T1 with `<AssistantBlock>`. Verify: code blocks highlight, tables render, headings have proper hierarchy, inline code styled.

**Task 3: Typography polish + tool stubs + streaming UX.** Create `UserBlock.tsx` and `ToolStub.tsx`. Add the streaming cursor (Streamdown's `caret` prop). Polish spacing, line heights, max-width, and overall rhythm. Ensure auto-scroll works during streaming and respects manual scroll-up (reuse the `isNearBottom` pattern from S02). Add empty state. This is the final visual quality pass before S04 takes over for tool cards.

### Verification Approach

1. **Build check:** `npm run build -w studio` — zero errors, no Shiki/Streamdown bundle issues.
2. **Dev launch:** `npm run dev -w studio` — app launches, connection badge shows connected.
3. **Streaming test:** Send a prompt that produces markdown (headings, code blocks, lists, a table). Verify:
   - Text streams incrementally (not all-at-once)
   - Code blocks show syntax highlighting (Shiki)
   - Tables render as styled tables (not raw pipes)
   - Headings have proper sizing hierarchy
   - Inline code is styled differently from block code
   - No visible jank or flicker during streaming
4. **Scroll behavior:** Send a long prompt. Verify auto-scroll follows new content. Scroll up manually. Verify it stays put (doesn't snap back).
5. **Tool stubs:** Verify tool_execution events render as minimal placeholders (tool name visible) without breaking the document flow.
6. **Streaming cursor:** Verify cursor/caret appears during streaming and disappears when streaming ends (`isAnimating` tied to `isStreaming`).

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Streaming markdown with incomplete syntax | `streamdown` | Purpose-built for LLM streaming. Handles unclosed code fences, partial bold/italic, incomplete tables. Block-level memoization. React.memo'd. Vercel-maintained, trust 10/10. |
| Shiki syntax highlighting in streaming context | `@streamdown/code` | Plugin for Streamdown. Lazy-loads 200+ languages on demand. Token caching. Copy button on hover (disabled during streaming). Handles unterminated code blocks. |
| GFM tables, strikethrough, task lists | Built into Streamdown | No need for remark-gfm separately. |
| Delta accumulation + RAF batching | Not needed | Streamdown + React.memo handles this. Pass the growing string, only affected blocks re-render. |

## Constraints

- **Event type field inconsistency (K005):** Events use either `data.type` or `data.event` for the event type. The message model transformer must check both: `const eventType = data.type ?? data.event`.
- **StoreEvent shape:** Events in the session store are `{ id, timestamp, data: Record<string, unknown> }`. The `data` field is the raw AgentEvent. The message model must cast/narrow from `Record<string, unknown>`.
- **message_update event shape:** `{ type: 'message_update', message: AssistantMessage, assistantMessageEvent: AssistantMessageEvent }`. The `assistantMessageEvent` has sub-types: `text_delta` (with `delta: string`), `text_start`, `text_end`, `thinking_delta`, `toolcall_start/delta/end`, `done`, `error`. Only `text_delta` events carry renderable text. The `message.content` array accumulates `TextContent | ThinkingContent | ToolCall` items.
- **Two strategies for text accumulation:** Either (a) concatenate `text_delta` deltas incrementally, or (b) read `message.content` and extract text from the latest `TextContent` block. Strategy (b) is simpler — the partial `AssistantMessage` already has the accumulated text. Use that.
- **Electron + Vite + Shiki WASM:** Shiki uses WASM for the Oniguruma regex engine. In an Electron/Vite setup, the WASM file must be loadable. Streamdown's `@streamdown/code` handles this internally, but verify during build that the WASM asset is bundled correctly.
- **Tailwind v4:** The project uses `@tailwindcss/vite` v4.2.1 with the `@theme` directive in CSS (not a tailwind.config.js). Custom component classes use Tailwind utility classes directly.

## Common Pitfalls

- **Re-rendering the entire message list on every delta** — Each `message_update` adds an event to the store, triggering re-renders. The message model derivation should be memoized (useMemo on events array reference). Streamdown's internal block memoization handles the markdown-level stability, but the message list itself needs stable keys per block.
- **Extracting text from partial AssistantMessage** — The `message.content` array contains `TextContent`, `ThinkingContent`, and `ToolCall` entries mixed together. Only `TextContent` entries (where `type === 'text'`) should be concatenated for the markdown string. `ThinkingContent` (reasoning) should be hidden or separately indicated. `ToolCall` entries interleave and create the seams where tool stubs go.
- **Scroll fighting** — The S02 `isNearBottom` pattern (80px threshold) must be preserved. Move it to MessageStream. Use `useEffect` triggered by content changes, not by event count, to avoid issues with event batching.
- **Shiki theme must feel native** — Don't use a random bright theme. Pick a dark theme close to the app's palette (`vitesse-dark` or `one-dark-pro` are good starting points) or create a custom theme. The code block container styling (background, border-radius, padding) matters as much as the token colors.

## Open Risks

- **Streamdown + Electron/Vite WASM compatibility** — Shiki's WASM needs to load in the Electron renderer. This should work (Chromium has WASM support), but the Vite bundler config may need adjustment if the WASM file isn't found at runtime. Mitigated by testing early in T2.
- **Streamdown bundle size** — Streamdown + Shiki add to the renderer bundle. For a desktop Electron app this is acceptable (not a web perf concern), but verify the build doesn't balloon unreasonably.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Streamdown | `vercel/streamdown@streamdown` | available (635 installs) — streaming markdown renderer purpose-built for this use case |
| Shiki | `andrelandgraf/fullstackrecipes@shiki-code-blocks` | available (81 installs) — less relevant since @streamdown/code handles Shiki integration |

## Sources

- Streamdown handles incomplete markdown and block-level memoization (source: [Streamdown docs — memoization](https://github.com/vercel/streamdown/blob/main/apps/website/content/docs/memoization.mdx))
- `@streamdown/code` plugin provides Shiki highlighting with 200+ lazy-loaded languages and token caching (source: [Streamdown plugins reference](https://github.com/vercel/streamdown/blob/main/streamdown/references/plugins.md))
- Custom component overrides for all HTML elements supported via `components` prop (source: [Streamdown custom components](https://context7.com/vercel/streamdown/llms.txt))
- AgentEvent type definitions: `message_update` carries `AssistantMessage` + `AssistantMessageEvent` with `text_delta` sub-events (source: `packages/pi-agent-core/src/types.ts:277-292`, `packages/pi-ai/src/types.ts:241-263`)
