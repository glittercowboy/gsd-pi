# S01: PTY Output Parser and Chat Message Model

**Goal:** Build `web/lib/pty-chat-parser.ts` — a stateful parser that accepts raw PTY byte chunks, strips ANSI, segments output into role-classified `ChatMessage[]`, detects ink TUI prompts, and emits completion signals. This is the foundational data model all chat rendering and TUI intercept logic depends on.

**Demo:** Connect `PtyChatParser` to a live GSD SSE stream (via a temporary debug harness or direct consumption in ChatPane); verify that `getMessages()` returns clean role-classified messages with ANSI stripped, that ink select prompts produce `prompt.kind === 'select'` with options populated, and that returning to the GSD idle prompt emits a `CompletionSignal`.

## Must-Haves

- `PtyChatParser` class instantiates, `feed()` accepts raw PTY bytes without throwing, `getMessages()` returns ANSI-stripped `ChatMessage[]`
- Messages are role-classified: user input → `'user'`, agent response text → `'assistant'`, status/system lines → `'system'`
- `onMessage(cb)` fires on new/updated messages and returns an unsubscribe function
- `onCompletionSignal(cb)` fires when GSD returns to idle prompt after an action; returns unsubscribe
- `TuiPrompt` detected: select lists → `kind:'select'` with `options[]`; text prompts → `kind:'text'`; password prompts → `kind:'password'`
- `npm run build:web-host` exits 0 (no TypeScript errors from the new module)

## Proof Level

- This slice proves: contract (parser logic verified against fixture strings and live SSE output)
- Real runtime required: yes — must be fed real GSD PTY output to validate segmentation heuristics
- Human/UAT required: no

## Verification

- `cd web && npx tsc --noEmit` exits 0 — no type errors in `pty-chat-parser.ts`
- Manual: connect `PtyChatParser` to live SSE stream and `console.log(parser.getMessages())` — inspect that messages are role-classified and ANSI-free
- Manual: trigger a GSD select prompt and verify `getMessages()` returns a message with `prompt.kind === 'select'` and non-empty `options`

## Observability / Diagnostics

- Runtime signals: `PtyChatParser` should log (debug-level) when it detects a role boundary, a TUI prompt, or a completion signal — helps diagnose misclassification during development
- Inspection surfaces: `parser.getMessages()` is the primary inspection surface; can be called from browser console during dev
- Failure visibility: if segmentation produces empty messages or wrong roles, `content` and `role` fields will reveal the mismatch immediately
- Redaction constraints: PTY output may contain API keys typed by the user — do not log raw content in production; log structural signals only

## Integration Closure

- Upstream surfaces consumed: `/api/terminal/stream` SSE (`{ type: "output", data: string }` payloads), `/api/terminal/input` POST — read `web/components/gsd/shell-terminal.tsx` and `web/app/api/terminal/stream/route.ts` before implementing
- New wiring introduced: none — this module is consumed by S02's `ChatPane`
- What remains before the milestone is truly usable end-to-end: S02 (chat rendering), S03 (TUI UI), S04 (toolbar + panel lifecycle)

## Tasks

- [x] **T01: ANSI stripper, message segmenter, and role classifier** `est:2h`
  - Why: Core parser infrastructure — without clean ANSI-stripped, role-classified messages there is nothing to render
  - Files: `web/lib/pty-chat-parser.ts` (new)
  - Do: (1) Read `web/components/gsd/shell-terminal.tsx` and `web/app/api/terminal/stream/route.ts` — understand SSE payload shape `{ type: "output", data: string }`. (2) Write `stripAnsi(s: string): string` — handle CSI sequences `\x1b[...m`, cursor moves `\x1b[H/A/B/C/D/J/K`, OSC sequences `\x1b]...\x07`, title sequences, and `\r` overwrite patterns. (3) Define `ChatMessage`, `TuiPrompt`, `CompletionSignal` TypeScript interfaces. (4) Implement `PtyChatParser` class: internal buffer, `ChatMessage[]`, subscriber set. (5) Implement `feed()`: append to buffer, call `stripAnsi`, run segmentation — GSD prompt marker (`❯` or `>` at line start) signals boundary between turns; assistant responses are bulk text between prompts; short status lines are `'system'`. (6) Implement `getMessages()`, `onMessage()` with unsubscribe. (7) Assign stable UUIDs to messages (`crypto.randomUUID()`); append-in-place while `complete === false`, flip to `complete: true` on boundary.
  - Verify: `npx tsc --noEmit` exits 0; feed a fixture string containing ANSI codes and assert `getMessages()[0].content` has no `\x1b` characters
  - Done when: parser instantiates, `feed()` accepts ANSI bytes, `getMessages()` returns clean role-classified messages, TypeScript clean

- [ ] **T02: TUI prompt detector and completion signal emitter** `est:2h`
  - Why: Without prompt detection, TUI interactions stay as raw terminal noise; without completion signals, action panels never auto-close
  - Files: `web/lib/pty-chat-parser.ts` (extend T01 output)
  - Do: (1) Inspect real GSD PTY output for ink prompt patterns — ink select lists render as multiple lines prefixed with `◯`/`●` or `›`/` ` after ANSI stripping; text prompts end with `: ` + cursor; password prompts match `API key:`, `password:`, `Enter.*key` (case-insensitive). (2) Implement select detector: after stripping, scan for 2+ consecutive lines starting with bullet-like prefix — extract options array and `selectedIndex` from highlighted line. (3) Implement text prompt detector: line ending with `: ` or `? ` not followed by a bullet pattern. (4) Implement password detector: line matching password/key patterns. (5) Define `CompletionSignal: { source: string; timestamp: number }`. (6) Implement completion heuristic: 2s debounce — if no new output arrives AND the last stripped line contains the GSD input prompt marker, emit `CompletionSignal`. (7) Add `onCompletionSignal(cb)` with subscriber/unsubscribe. (8) Set `message.prompt` on the active message when a prompt is detected; clear it when input is received.
  - Verify: feed fixture strings for each prompt type; assert correct `prompt.kind` and `options` populated; assert `onCompletionSignal` fires after simulated idle + prompt reappearance
  - Done when: all three prompt kinds detected correctly from fixture strings, `onCompletionSignal` fires reliably, T01 behavior unchanged

## Files Likely Touched

- `web/lib/pty-chat-parser.ts` (new)
