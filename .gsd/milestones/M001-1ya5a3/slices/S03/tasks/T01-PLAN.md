---
estimated_steps: 5
estimated_files: 5
---

# T01: Build message model and wire MessageStream into CenterPanel

**Slice:** S03 — Message Stream + Markdown Rendering
**Milestone:** M001-1ya5a3

## Description

Create the pure-logic message model that transforms raw `StoreEvent[]` from the session store into structured `MessageBlock[]`, then build the `MessageStream` container component and wire it into CenterPanel replacing the raw JSON event log. This task also installs `streamdown` and `@streamdown/code` as dependencies (unblocking T02). At this stage, assistant text renders as plain `<pre>` blocks — proving the accumulation pipeline works before adding markdown complexity.

**Relevant skills:** `vercel-react-best-practices` (React performance patterns)

## Steps

1. **Install dependencies.** Run `npm install streamdown @streamdown/code -w studio`. These are needed for T02 but installing now ensures the build still succeeds and catches any bundler compatibility issues early.

2. **Create `studio/src/renderer/src/lib/message-model.ts`.** Define the types and transformer:
   - `MessageBlock` union type with three variants:
     - `{ type: 'assistant-text'; id: string; content: string }` — accumulated text from message_update events
     - `{ type: 'tool-use'; id: string; toolName: string; toolCallId: string; status: 'running' | 'done' | 'error'; args?: unknown; result?: unknown }` — from tool_execution_start/end events
     - `{ type: 'user-prompt'; id: string; text: string }` — from the user's prompt
   - `buildMessageBlocks(events: StoreEvent[]): MessageBlock[]` — pure function that iterates events and:
     - Checks `const eventType = data.type ?? data.event` (K005 inconsistency)
     - For `message_update`: extract text from `data.message.content` array — find entries where `type === 'text'`, concatenate their `text` fields. This is the accumulated text from the partial AssistantMessage (strategy b from research). Each distinct assistant turn (bounded by `agent_start`/`agent_end`) should produce one `assistant-text` block. Use a stable id derived from the first event id in that turn.
     - For `tool_execution_start`: create a `tool-use` block with `toolName` and `toolCallId` from the event data. Set status to `'running'`.
     - For `tool_execution_end`: find the matching `tool-use` block by `toolCallId` and update status to `'done'` (or `'error'` if the event indicates failure).
     - For `agent_start`: if the event contains prompt/message info, create a `user-prompt` block.
     - Skip `agent_end`, `stderr`, `state_update`, and other non-renderable events.
   - The function must be idempotent — calling it with the same events array produces the same blocks. It re-derives from scratch each time (memoization happens at the React layer via useMemo).

3. **Create `studio/src/renderer/src/components/message-stream/MessageStream.tsx`.** Container component that:
   - Reads `events` and `isStreaming` from `useSessionStore` via selectors.
   - Derives `MessageBlock[]` via `useMemo(() => buildMessageBlocks(events), [events])`.
   - Renders the block sequence in a scrollable container: for now, `assistant-text` blocks render as `<pre className="...">` with the accumulated text, `tool-use` blocks render as a small `<div>` with the tool name, `user-prompt` blocks render as a `<div>` with the prompt text. (T02 and T03 replace these with proper components.)
   - Include auto-scroll logic: `scrollRef`, `isNearBottom` ref (80px threshold), `handleScroll` callback, `useEffect` that scrolls to bottom when events change and isNearBottom is true. Port the pattern from CenterPanel's existing implementation.
   - If no blocks, render the existing `EmptyState` component (move it from CenterPanel or import it).

4. **Modify `studio/src/renderer/src/components/layout/CenterPanel.tsx`.** Replace the event log section:
   - Remove `EventRow`, `eventTypeColor`, `formatTime`, `truncateJson` (no longer needed — the raw event rendering is gone).
   - Remove the `EmptyState` component (moved to MessageStream or shared).
   - Keep: `ConnectionBadge` (header), the composer (textarea + send button), the overall panel structure.
   - Import and render `<MessageStream />` in place of the old scrollable event list.
   - Remove the `scrollRef`, `isNearBottom`, `handleScroll`, and scroll `useEffect` from CenterPanel (these move to MessageStream).

5. **Write `studio/test/message-model.test.mjs`.** Unit tests for `buildMessageBlocks`:
   - Test: single message_update with text content → one assistant-text block with correct content
   - Test: multiple message_update events with growing content → single assistant-text block with latest accumulated text (not duplicated)
   - Test: interleaved tool_execution_start + tool_execution_end → tool-use block with correct status transitions
   - Test: agent_start event → user-prompt block (if prompt info present)
   - Test: K005 — events using `data.event` instead of `data.type` are handled correctly
   - Test: empty events array → empty blocks array
   - Test: mixed sequence (agent_start, message_update, tool_execution_start, message_update, tool_execution_end, agent_end) → correct block ordering

## Must-Haves

- [ ] `buildMessageBlocks` is a pure function with no React dependencies — importable in tests
- [ ] Handles both `data.type` and `data.event` for event type detection (K005)
- [ ] Text accumulation uses strategy (b) — reads from `message.content` array, not delta concatenation
- [ ] MessageStream renders in CenterPanel replacing raw event log
- [ ] Auto-scroll with isNearBottom (80px threshold) preserved
- [ ] ConnectionBadge and Composer remain functional in CenterPanel
- [ ] `npm run build -w studio` passes with streamdown installed
- [ ] All unit tests pass for the message model

## Verification

- `npm run test -w studio` — all tests pass (existing + new message-model tests)
- `npm run build -w studio` — zero errors
- Dev app: send a prompt → see accumulated text appear as plain text in the center panel (not JSON events)
- Dev app: ConnectionBadge still shows status, Composer still sends prompts

## Inputs

- `studio/src/renderer/src/stores/session-store.ts` — StoreEvent type definition, useSessionStore hook (events, isStreaming selectors)
- `studio/src/renderer/src/components/layout/CenterPanel.tsx` — current implementation to refactor (keep ConnectionBadge + Composer, remove EventRow)
- `studio/src/renderer/src/lib/rpc/use-gsd.ts` — useGsd hook (sendPrompt) used by CenterPanel
- S02 Forward Intelligence: events have type in `data.type` or `data.event`. `isStreaming` toggled by `agent_start`/`agent_end`. Event shape: `{ id, timestamp, data: Record<string, unknown> }`.

## Observability Impact

- **New inspection surface:** `buildMessageBlocks()` is a pure function exported from `message-model.ts`. In React DevTools, call `buildMessageBlocks(useSessionStore.getState().events)` to inspect the derived message model at any point.
- **Failure visibility:** If the message model produces unexpected blocks, the raw events remain inspectable via `useSessionStore.getState().events` in the console. The `MessageStream` component renders blocks directly — visual absence of expected content maps 1:1 to a missing/incorrect block in the model output.
- **No new runtime signals:** The message model is a pure derivation with no async behavior, no network calls, and no persistent state. Failures manifest as incorrect rendered output, not as runtime errors or silent data loss.

## Expected Output

- `studio/src/renderer/src/lib/message-model.ts` — pure message block transformer, fully typed, tested
- `studio/src/renderer/src/components/message-stream/MessageStream.tsx` — container with auto-scroll and block rendering (plain text for now)
- `studio/src/renderer/src/components/layout/CenterPanel.tsx` — refactored to render MessageStream instead of raw events
- `studio/test/message-model.test.mjs` — 7+ unit tests for the message model
- `studio/package.json` — streamdown + @streamdown/code added as dependencies
