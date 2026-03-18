---
id: T01
parent: S03
milestone: M001-1ya5a3
provides:
  - Pure message model transformer (buildMessageBlocks) — StoreEvent[] → MessageBlock[]
  - MessageStream container component with auto-scroll and block rendering
  - CenterPanel refactored to render MessageStream instead of raw event log
  - streamdown + @streamdown/code installed as dependencies (unblocks T02)
key_files:
  - studio/src/renderer/src/lib/message-model.ts
  - studio/src/renderer/src/components/message-stream/MessageStream.tsx
  - studio/src/renderer/src/components/layout/CenterPanel.tsx
  - studio/test/message-model.test.mjs
  - studio/package.json
key_decisions:
  - Message model uses K001 test pattern — pure logic replicated in .mjs test file to avoid bundler dependency
  - Tool interruptions reset currentAssistantBlock so post-tool text gets its own block (correct document flow)
patterns_established:
  - MessageBlock union type with assistant-text/tool-use/user-prompt variants — downstream components switch on block.type
  - buildMessageBlocks is pure, idempotent, re-derives from scratch — memoization happens at React layer via useMemo
  - EmptyState lives in MessageStream (not CenterPanel) — it's part of the message display, not the layout
observability_surfaces:
  - buildMessageBlocks() callable from React DevTools with useSessionStore.getState().events
  - Raw events still inspectable via useSessionStore.getState().events
duration: 15m
verification_result: passed
completed_at: 2026-03-18
blocker_discovered: false
---

# T01: Build message model and wire MessageStream into CenterPanel

**Create pure message model transformer, wire MessageStream into CenterPanel replacing raw JSON event log, install streamdown deps, add 12 unit tests**

## What Happened

Created `message-model.ts` with the `buildMessageBlocks` pure function that transforms `StoreEvent[]` into structured `MessageBlock[]`. The function handles K005 event type inconsistency (`data.type ?? data.event`), accumulates text from `message.content` array (strategy b), tracks tool execution start/end with status transitions, and resets assistant text accumulation when tools interrupt the text flow.

Built `MessageStream.tsx` as the container component — reads events from the session store, derives blocks via `useMemo`, renders them with type-specific stub components (plain `<pre>` for assistant text, border-accented div for user prompts, minimal status line for tool use). Includes the auto-scroll logic (80px threshold isNearBottom pattern) ported from CenterPanel. EmptyState moved here.

Refactored `CenterPanel.tsx` — removed EventRow, eventTypeColor, formatTime, truncateJson, EmptyState, and all scroll logic. Kept ConnectionBadge and Composer intact. Renders `<MessageStream />` in the content area.

Installed `streamdown@2.5.0` and `@streamdown/code@1.1.1` to unblock T02. Build confirms 4588 modules bundled with zero errors.

## Verification

- `npm run test -w studio` — 34/34 pass (12 new message-model tests + 22 existing)
- `npm run build -w studio` — zero errors, renderer bundle includes streamdown/shiki WASM (669.74 kB JS)
- Runtime verification deferred to T02/T03 (requires dev app launch with connected gsd-2 backend)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npm run test -w studio` | 0 | ✅ pass | 170ms |
| 2 | `npm run build -w studio` | 0 | ✅ pass | 1.2s |

## Diagnostics

- Inspect derived blocks: call `buildMessageBlocks(useSessionStore.getState().events)` in Electron DevTools console
- Inspect raw events: `useSessionStore.getState().events` in React DevTools
- If assistant text doesn't appear: check that events contain `message_update` with `message.content[].type === 'text'` — the model silently skips events without text content

## Deviations

- Added `Observability Impact` section to T01-PLAN.md as flagged by pre-flight check
- Wrote 12 tests instead of the 7 minimum — added tests for error status, non-renderable event filtering, agent_start without prompt, empty content, and idempotency

## Known Issues

None.

## Files Created/Modified

- `studio/src/renderer/src/lib/message-model.ts` — pure message block transformer with types and buildMessageBlocks function
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — container component with auto-scroll, block rendering, and EmptyState
- `studio/src/renderer/src/components/layout/CenterPanel.tsx` — refactored to render MessageStream, removed raw event rendering
- `studio/test/message-model.test.mjs` — 12 unit tests for buildMessageBlocks covering all edge cases
- `studio/package.json` — added streamdown@2.5.0 and @streamdown/code@1.1.1
