---
id: S03
parent: M001-1ya5a3
milestone: M001-1ya5a3
provides:
  - Pure message model transformer (buildMessageBlocks) — StoreEvent[] → MessageBlock[]
  - AssistantBlock component wrapping Streamdown with Shiki code highlighting and streaming caret
  - 20+ custom markdown component overrides styled to the dark amber design system
  - UserBlock component with amber accent border and "You" label
  - ToolStub placeholder component with animated status icons (running/done/error) for S04 to replace
  - MessageStream container with auto-scroll, block rendering, and gap-6 document rhythm
  - Streamdown caret CSS (sd-fadeIn, sd-blurIn keyframes) bundled into production output
requires:
  - slice: S02
    provides: session-store.ts (events, isStreaming), useGsd hook, CenterPanel shell with ConnectionBadge and Composer
affects:
  - S04 (replaces ToolStub with bespoke tool cards, reuses MarkdownRenderer and Shiki highlighter)
  - S05 (renders interactive prompts inline in the MessageStream, consumes design system components)
key_files:
  - studio/src/renderer/src/lib/message-model.ts
  - studio/src/renderer/src/components/message-stream/MessageStream.tsx
  - studio/src/renderer/src/components/message-stream/AssistantBlock.tsx
  - studio/src/renderer/src/components/message-stream/UserBlock.tsx
  - studio/src/renderer/src/components/message-stream/ToolStub.tsx
  - studio/src/renderer/src/components/markdown/components.tsx
  - studio/src/renderer/src/components/markdown/shiki-theme.ts
  - studio/src/renderer/src/styles/index.css
  - studio/test/message-model.test.mjs
key_decisions:
  - Used ComponentPropsWithoutRef<T> instead of JSX.IntrinsicElements to avoid TS2503 namespace issue with react-jsx tsconfig
  - Shiki code plugin uses vitesse-dark for both light/dark theme slots — app is dark-only
  - Only the final assistant-text block shows the streaming caret (isLastBlock via backward scan)
  - Block components receive flat props, not entire MessageBlock union — UserBlock gets text, ToolStub gets toolName+status
  - Auto-scroll useEffect depends on derived blocks array, not raw events.length
  - Used Phosphor named icon exports (CaretRight, Check, XCircle, CircleNotch) for tree-shaking
patterns_established:
  - MessageBlock union type with assistant-text/tool-use/user-prompt variants — downstream components switch on block.type
  - buildMessageBlocks is pure, idempotent, re-derives from scratch — memoization at React layer via useMemo
  - Markdown component overrides use a P<T> helper type for consistent prop typing with ExtraProps destructuring
  - AssistantBlock is the single Streamdown composition point — no other component renders Streamdown directly
  - formatToolName utility converts snake_case to Title Case for display
observability_surfaces:
  - buildMessageBlocks() callable from React DevTools with useSessionStore.getState().events
  - Raw events still inspectable via useSessionStore.getState().events
  - Shiki WASM load failure falls back to unstyled <pre> — visible immediately, console errors in Electron DevTools
  - AssistantBlock isAnimating = isStreaming && isLastBlock — check both signals if caret misbehaves
  - Streamdown caret CSS presence verifiable by grepping sd-fadeIn in built CSS
drill_down_paths:
  - .gsd/milestones/M001-1ya5a3/slices/S03/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001-1ya5a3/slices/S03/tasks/T02-SUMMARY.md
  - .gsd/milestones/M001-1ya5a3/slices/S03/tasks/T03-SUMMARY.md
duration: 37m
verification_result: passed
completed_at: 2026-03-18
---

# S03: Message Stream + Markdown Rendering

**Replaced raw JSON event stream with structured, beautifully-typeset markdown rendering — Streamdown with Shiki syntax highlighting, 20+ custom component overrides, streaming caret, auto-scroll, and three block types (assistant text, user prompts, tool stubs)**

## What Happened

T01 created the pure message model layer. `buildMessageBlocks()` transforms the raw `StoreEvent[]` from the session store into a typed `MessageBlock[]` array with three variants: `assistant-text` (accumulated text from message_update content), `tool-use` (from tool_execution_start/end with status transitions), and `user-prompt` (from agent_start with prompt context). The function handles K005 event type inconsistency (`data.type ?? data.event`) and correctly resets assistant text accumulation when tools interrupt the flow, so post-tool text gets its own block. 12 unit tests cover all edge cases including error status, idempotency, and non-renderable event filtering. `streamdown@2.5.0` and `@streamdown/code@1.1.1` were installed.

T02 replaced the plain `<pre>` assistant text rendering with full Streamdown integration. `AssistantBlock` wraps `<Streamdown>` with the `@streamdown/code` plugin (vitesse-dark theme), custom component overrides, `caret="block"`, and `isAnimating` bound to `isStreaming && isLastBlock`. The markdown component overrides in `components.tsx` style every element to the dark amber design system: h1-h6 with proper size hierarchy (1.75rem → 1rem), paragraphs at 15px/leading-7 with `text-wrap: pretty`, inline code with `bg-bg-tertiary` and amber `text-accent`, code blocks with `bg-[#0c0c0c]` + inset shadow, styled tables with header backgrounds, blockquotes with accent left border, and links with hover underline. A `P<T>` helper type (`ComponentPropsWithoutRef<T> & ExtraProps`) solved the TS2503 namespace issue with the react-jsx tsconfig.

T03 built the UserBlock (amber left border, "You" label, styled body text) and ToolStub (tool name in monospace with animated status icons — spinning CircleNotch for running, emerald Check for done, red XCircle for error, plus CaretRight chevron for future expandability). MessageStream was polished with `gap-6` spacing, `py-6` padding, and auto-scroll keyed on derived blocks. `streamdown/styles.css` was imported for caret animations (sd-fadeIn, sd-blurIn keyframes).

## Verification

- `npm run test -w studio` — 34/34 pass (12 new message-model tests + 22 existing S02 tests)
- `npm run build -w studio` — zero errors, Shiki WASM bundled (622 kB), vitesse-dark theme included, streamdown CSS keyframes present in output
- `npx tsc --noEmit -p studio/tsconfig.web.json` — zero type errors
- Root `npm run test` — 1660/1665 pass. 2 remaining failures are pre-existing worktree infrastructure issues (app-smoke extension count, initResources sync) and 3 from mcp-server missing dist — none related to S03

## New Requirements Surfaced

- none

## Deviations

- T02 used `ComponentPropsWithoutRef<T>` instead of `JSX.IntrinsicElements[T]` for component overrides — the `react-jsx` tsconfig doesn't expose the global `JSX` namespace. Functionally equivalent.
- T03 used `XCircle` instead of `X` for error icon — `X` is aliased to `AlignBottomSimple` in the Phosphor bundle (naming collision). `XCircle` is semantically correct.
- T03 used `Sparkle` instead of `SparkleIcon` for empty state — both are valid Phosphor exports, shorter form is convention.

## Known Limitations

- **No runtime streaming test yet** — all verification is artifact-driven (tests + build). Smooth streaming under real high-frequency deltas requires a connected gsd-2 backend, which is a live runtime test deferred to UAT.
- **ToolStub is a placeholder** — shows tool name and status icon only. S04 replaces these with bespoke collapsed/expandable cards.
- **Auto-scroll not tested under long conversations** — the 80px isNearBottom threshold works for the pattern but hasn't been stress-tested with 1000+ blocks or rapid-fire tool events.

## Follow-ups

- S04 must replace ToolStub with bespoke tool cards — the stub passes `toolName` and `status` which S04 can use as the minimal data contract before expanding to full tool event data.
- S05 must render interactive prompts inline in MessageStream — the block rendering switch in MessageStream is the extension point.
- Consider virtual scrolling (react-window or similar) if long conversations cause performance issues — current implementation renders all blocks.

## Files Created/Modified

- `studio/src/renderer/src/lib/message-model.ts` — pure message block transformer with types and buildMessageBlocks function
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — container component with auto-scroll, block rendering, gap-6 spacing
- `studio/src/renderer/src/components/message-stream/AssistantBlock.tsx` — Streamdown wrapper with Shiki code plugin, components, streaming caret
- `studio/src/renderer/src/components/message-stream/UserBlock.tsx` — styled user prompt with amber accent border and "You" label
- `studio/src/renderer/src/components/message-stream/ToolStub.tsx` — minimal tool placeholder with status icons and formatToolName utility
- `studio/src/renderer/src/components/markdown/components.tsx` — 20+ custom Streamdown component overrides for all markdown elements
- `studio/src/renderer/src/components/markdown/shiki-theme.ts` — Shiki code plugin configured with vitesse-dark theme
- `studio/src/renderer/src/components/layout/CenterPanel.tsx` — refactored to render MessageStream, removed raw event rendering
- `studio/src/renderer/src/styles/index.css` — added streamdown/styles.css import for caret animations
- `studio/test/message-model.test.mjs` — 12 unit tests for buildMessageBlocks covering all edge cases
- `studio/package.json` — added streamdown@2.5.0 and @streamdown/code@1.1.1

## Forward Intelligence

### What the next slice should know
- `MessageStream.tsx` renders blocks via a switch on `block.type`. S04 should add a case for `tool-use` that renders the full ToolCard instead of ToolStub. S05 should add a new block type or render prompts within the existing flow.
- The `buildMessageBlocks()` function is the single source of truth for block derivation. If S04 needs richer tool data in the blocks, modify the `ToolUseBlock` type and the builder function — don't add a second derivation layer.
- `AssistantBlock` is the only Streamdown consumer. The code plugin and component overrides are configured there. If S04 tool cards need to render markdown content (e.g., inside expanded cards), import and reuse the `Components` object and `codePlugin` from their respective modules.

### What's fragile
- **isLastBlock backward scan** — the `lastAssistantIdx` computation scans the blocks array backward in `useMemo`. If block types change or new types are added, this scan still works (it only matches `assistant-text`). But if the block array identity changes on every render (breaking memoization), this becomes a perf issue.
- **Streamdown version coupling** — the component overrides in `components.tsx` depend on Streamdown's `ExtraProps` type shape (specifically the `node` property). If Streamdown's API changes, these overrides break. Pin `streamdown@2.5.0`.

### Authoritative diagnostics
- `buildMessageBlocks(useSessionStore.getState().events)` in Electron DevTools console — inspect the derived block array directly
- `grep sd-fadeIn studio/dist/renderer/assets/*.css` — confirm caret animations are bundled
- React DevTools → AssistantBlock component → check `isAnimating` and `content` props if streaming caret misbehaves

### What assumptions changed
- **Assumed Shiki WASM would be large** — it's 622 kB in the bundle, which is significant but acceptable for an Electron app. No lazy-loading needed.
- **Assumed root `npm run test` would pass** — the worktree is missing `dist/` builds for several packages (pi-ai, pi-agent-core, root project). Building these packages fixes most failures. The remaining 2 are environment-dependent tests that also fail or are fragile in the main repo.
