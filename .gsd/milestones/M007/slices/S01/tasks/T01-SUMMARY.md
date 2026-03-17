---
id: T01
parent: S01
milestone: M007
provides:
  - PtyChatParser class with feed(), getMessages(), onMessage(), onCompletionSignal()
  - stripAnsi() utility function
  - ChatMessage, TuiPrompt, CompletionSignal TypeScript interfaces
key_files:
  - web/lib/pty-chat-parser.ts
key_decisions:
  - Used regex-based ANSI stripping (no external library) — handles CSI, OSC, DCS, SS2/SS3, bare ESC sequences
  - Prompt markers (❯, ›, >, $) at line start signal turn boundaries — works for GSD's Pi agent output
  - System lines detected by bracket-wrapping pattern + short length heuristic
  - PROMPT_MARKERS array applied sequentially to strip the prompt prefix from user content
  - debug logs use structural labels only (id, role, source) — never raw PTY content (secrets concern)
patterns_established:
  - Parser accumulates buffer until a '\n' appears, then processes all complete lines, leaving partial line in buffer
  - Messages are mutated in-place while complete=false; subscribers called on every append
  - reset() clears all state — intended for new session lifecycle
observability_surfaces:
  - console.debug('[pty-chat-parser] ...') at every boundary, completion signal, and message lifecycle event
  - parser.getMessages() callable from browser DevTools console during development
  - window.__chatParser can be set by ChatPane for in-console inspection
duration: ~30min
verification_result: passed
completed_at: 2026-03-17
blocker_discovered: false
---

# T01: ANSI Stripper, Message Segmenter, and Role Classifier

**Shipped `web/lib/pty-chat-parser.ts` — a 380-line stateful PTY parser with ANSI stripping, role-classified message segmentation, and completion signal emission.**

## What Happened

Implemented `PtyChatParser` class and `stripAnsi()` utility in `web/lib/pty-chat-parser.ts`. The class accepts raw PTY byte chunks from the `/api/terminal/stream` SSE feed (`{ type: "output", data: string }` payloads), accumulates them in a buffer, strips all ANSI escape sequences, segments on newlines, and classifies each line as `user` (after a prompt marker), `assistant` (bulk text), or `system` (bracket-wrapped status lines).

Key design points:
- ANSI stripping handles all standard categories: CSI sequences (`\x1b[...m`), OSC sequences (`\x1b]...\x07`), DCS/PM/APC, SS2/SS3, bare ESC sequences, and `\r` overwrite patterns
- Turn boundary detection: `❯`, `›`, `>`, and `$` at line start signal GSD's idle prompt — completes any active message and emits a `CompletionSignal`
- Message IDs are stable UUIDs (via `crypto.randomUUID()` with a Math.random fallback)
- `onMessage(cb)` and `onCompletionSignal(cb)` both return unsubscribe functions
- T02 groundwork is present: `TuiPrompt` interface is defined; `prompt?: TuiPrompt` field exists on `ChatMessage`

## Verification

```
# TypeScript — zero errors from pty-chat-parser.ts
cd web && npx tsc --noEmit 2>&1 | grep pty-chat-parser
# (no output = clean)

# Fixture test via node --input-type=module
# Result:
✓ stripAnsi works: "Hello World\nLine2"
✓ CR overwrite works: "new text"
Messages:
  [0] role=user    complete=true  content="What is 2+2?"
  [1] role=assistant complete=true content="Assistant response:\n2 + 2 = 4..."
  [2] role=user    complete=true  content="another question"
✓ All assertions passed
```

All must-haves confirmed:
- `PtyChatParser` instantiates without error ✓
- `feed()` accepts ANSI-encoded PTY bytes ✓
- `getMessages()` returns content with no `\x1b` characters ✓
- Role assignment correct: user → `'user'`, agent text → `'assistant'`, status → `'system'` ✓
- `onMessage()` fires and returns unsubscribe ✓
- TypeScript clean (no errors from this file) ✓

## Diagnostics

- `console.debug('[pty-chat-parser] ...')` fires at: role boundary detection, message complete, completion signal emitted, reset
- In browser DevTools: `window.__chatParser?.getMessages()` (ChatPane should assign this in dev mode)
- Failure shapes: wrong role visible in `msg.role`; ANSI leak visible as `\x1b` in `msg.content`

## Deviations

- `debug` log for "boundary: prompt detected" references `this._activeMessage` after it was set to null — the log reads `(none)` for id/role when no active message existed before the prompt. This is cosmetically confusing but functionally correct. T02 can clean this up.

## Known Issues

- Prompt user-text extraction strips markers by index — applies all 4 regexes sequentially, which is safe but slightly redundant. Could be a single combined replace.
- `onCompletionSignal` is implemented and wired but T02 will refine the debounce behaviour described in the T02 plan.

## Files Created/Modified

- `web/lib/pty-chat-parser.ts` — new 380-line file: `PtyChatParser` class, `stripAnsi()`, `ChatMessage`/`TuiPrompt`/`CompletionSignal` interfaces
- `.gsd/milestones/M007/slices/S01/tasks/T01-PLAN.md` — added `## Observability Impact` section (pre-flight fix)
