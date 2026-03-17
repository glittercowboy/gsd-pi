# T01: ANSI Stripper, Message Segmenter, and Role Classifier

**Slice:** S01
**Milestone:** M007

## Goal

Build the core of `PtyChatParser`: a class that accepts raw PTY byte chunks, strips all ANSI escape sequences, segments the cleaned stream into discrete messages, and classifies each message as `user`, `assistant`, or `system` based on GSD's observable output patterns.

## Must-Haves

### Truths

- `PtyChatParser` class instantiates without error
- `feed(chunk: string)` accepts raw PTY bytes including ANSI escape sequences without throwing
- `getMessages()` returns `ChatMessage[]` where all `content` fields have ANSI codes stripped
- Messages have correct `role` assignment: user input → `'user'`, GSD agent response text → `'assistant'`, system/status lines → `'system'`
- `onMessage(cb)` fires when a message is added or its content updated; returns an unsubscribe function
- TypeScript compiles clean with no `any` escapes on the public interface

### Artifacts

- `web/lib/pty-chat-parser.ts` — PtyChatParser class (min 120 lines, exports: `PtyChatParser`, `ChatMessage`, `TuiPrompt`, `CompletionSignal`)

### Key Links

- `ChatMessage.id` is a stable UUID — same message updated in place (content appended) rather than replaced
- `ChatMessage.complete: boolean` — false while streaming, true when a message boundary is detected

## Steps

1. Read `web/components/gsd/shell-terminal.tsx` to understand SSE output format and how PTY bytes arrive
2. Read `web/app/api/terminal/stream/route.ts` to understand the exact `{ type: "output", data: string }` SSE payload shape
3. Write the `stripAnsi(s: string): string` function — handle all standard ANSI escape categories: CSI sequences `\x1b[...m`, cursor moves, OSC, title sequences, carriage returns + line overwrite patterns
4. Define `ChatMessage`, `TuiPrompt`, `CompletionSignal` TypeScript interfaces
5. Implement `PtyChatParser` class with internal buffer, message array, and subscriber set
6. Implement `feed()`: append to buffer, call `stripAnsi`, run segmentation logic
7. Implement message segmentation heuristics: GSD outputs a prompt marker (`❯` or `>`) before user input; assistant responses are the bulk text between prompts; system lines are short status messages (e.g., `[connecting…]`, `[Auto mode active]`)
8. Implement role classification based on the segmented output patterns
9. Implement `getMessages()`, `onMessage()`, and unsubscribe
10. Manually test with a hardcoded fixture string representing a realistic GSD session exchange

## Observability Impact

**Signals added by this task:**
- `PtyChatParser` emits `debug`-level `console.debug` calls (prefixed `[pty-chat-parser]`) at each structural boundary: role boundary detected, message completed, raw buffer flush — uses structural labels only, never raw content
- `getMessages()` is the primary in-browser inspection surface — callable from browser DevTools console during development: `window.__chatParser?.getMessages()`
- TypeScript compilation gate: `npx tsc --noEmit` in `web/` is the primary CI signal; type errors in this module block all downstream S02/S03/S04 work

**Failure visibility:**
- Wrong role: `content` and `role` fields in `getMessages()` are immediately visible; misclassified lines appear in the wrong bucket
- ANSI leakage: `content` fields containing `\x1b` characters are the failure signal — easy to spot in console output
- Subscriber fires too often or never: add a `console.debug('[pty-chat-parser] onMessage fired', msg.id, msg.role)` probe to diagnose

**Redaction constraint:** parser logs only boundary type and message IDs — never raw PTY content (may contain API keys or passwords typed by the user)

## Context

- PTY output arrives as raw bytes — xterm.js handles ANSI internally in Power Mode, but we're reading the SSE stream directly and need our own ANSI stripper
- GSD uses the Pi coding agent which outputs structured conversation turns: user sends a command, the agent streams a response, then a new prompt appears. This maps cleanly to user/assistant/system message roles.
- The key insight for segmentation: the presence of GSD's input prompt marker signals the boundary between an assistant response and the next user turn
- Keep the parser stateless-ish: it holds a buffer but is deterministic given the same input sequence
- Do NOT import xterm.js — it's a browser-only library with heavy dependencies. This parser runs in React component context, not in a terminal.
