---
id: S01
parent: M007
milestone: M007
provides:
  - PtyChatParser class — stateful PTY output parser with feed(), getMessages(), onMessage(), onCompletionSignal(), reset()
  - stripAnsi() — ANSI/VT100 escape sequence stripper (CSI, OSC, DCS, SS2/SS3, bare ESC, CR overwrite)
  - ChatMessage interface — { id, role, content, complete, prompt?, timestamp }
  - TuiPrompt interface — { kind: 'select'|'text'|'password', label, options, selectedIndex }
  - CompletionSignal interface — { source, timestamp }
  - Select prompt detection — ink numbered option lists with header/label extraction
  - Text/password prompt detection — @clack/prompts ◆/▲/? prefix patterns
  - CompletionSignal emission — 2s debounced silence after main prompt reappearance
requires: []
affects:
  - S02
  - S03
  - S04
key_files:
  - web/lib/pty-chat-parser.ts
key_decisions:
  - Read PTY SSE directly in React (no xterm.js) — xterm.js cannot expose parsed text; custom parser is the only path to structured ChatMessage[]
  - TUI option detection must run BEFORE isPromptLine — GSD's cursor glyph "›" is also a PROMPT_MARKER; selected option lines like "  › 1. Describe it now" would be mishandled as prompt boundaries if isPromptLine ran first
  - Select block committed by hints line (↑/↓) or 300ms window timer — hints are the reliable commit signal; timer is the fallback
  - 2-second debounce on CompletionSignal — cancels if any new PTY input arrives; conservative to avoid premature panel close
  - Processing order: TUI option lines → checkbox → hints → prompt boundary → system lines → clack prompts → regular content
  - Debug logs use structural labels only (id, role, source) — never raw PTY content (secrets concern)
patterns_established:
  - Parser accumulates buffer until '\n' appears, then processes all complete lines, leaving partial line in buffer
  - Messages mutated in-place while complete=false; subscribers called on every append
  - SelectBlock accumulator: options upserted by 1-based index during window; committed and sorted on hints/timer; MIN_SELECT_OPTIONS=2 guard prevents false positives
  - reset() clears all state — intended for new session lifecycle
  - _completionEmitted flag prevents double-fire if timer fires before the feed() cancel path runs
observability_surfaces:
  - console.debug('[pty-chat-parser] ...') at: role boundary, message complete, tui prompt detected (kind/options/label), completion signal scheduled/emitted, reset
  - parser.getMessages() callable from browser DevTools console during development
  - parser.getMessages().filter(m => m.prompt) — inspect all TUI prompt states
  - window.__chatParser (ChatPane should assign this in dev mode for in-console inspection)
drill_down_paths:
  - .gsd/milestones/M007/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M007/slices/S01/tasks/T02-SUMMARY.md
duration: ~75min total (T01: ~30min, T02: ~45min)
verification_result: passed
completed_at: 2026-03-17
---

# S01: PTY Output Parser and Chat Message Model

**Shipped `web/lib/pty-chat-parser.ts` — a 758-line stateful PTY parser that accepts raw ANSI bytes, strips escape sequences, segments output into role-classified `ChatMessage[]`, detects ink/clack TUI prompts, and emits debounced `CompletionSignal`s. All fixture assertions pass; `npm run build:web-host` exits 0.**

## What Happened

**T01** established the foundation: `stripAnsi()`, the `ChatMessage`/`TuiPrompt`/`CompletionSignal` TypeScript interfaces, and the core `PtyChatParser` class. The parser accumulates raw PTY bytes in an internal buffer, drains complete lines on each `feed()` call, strips all ANSI escape categories (CSI, OSC, DCS, SS2/SS3, bare ESC, CR overwrite), and classifies each line by role:

- **user** — text following a GSD prompt marker (`❯`, `›`, `>`, `$`)
- **assistant** — bulk output between prompt boundaries
- **system** — bracket-wrapped status lines matching GSD lifecycle patterns

Messages are mutated in-place while streaming (`complete: false`), then sealed at the next turn boundary (`complete: true`). Message IDs are stable UUIDs via `crypto.randomUUID()` with a Math.random fallback. The `onMessage()` and `onCompletionSignal()` subscriptions both return typed unsubscribe functions.

**T02** extended the parser with full TUI prompt detection and debounced completion signals:

- **Select prompts** — GSD's shared UI renders `  › N. Label` (selected) and `    N. Label` (unselected) lines after ANSI stripping. A `SelectBlock` accumulator collects options by 1-based index during a 300ms window; the hints line (`↑/↓ to move`) is the primary commit trigger, the window timer is the fallback. Options are sorted by index; `selectedIndex` is derived from which option carries the `›` prefix at commit time. The separator bar line (`─────`) resets `_lastHeaderText` so question headers are correctly captured per-block.

- **Clack prompts** — GSD's onboarding uses `@clack/prompts` (`◆  Label:` style). Password kind is matched by labels containing `API key`, `password`, `token`, or `secret` (case-insensitive). Any other `◆`/`▲`/`?`-prefixed colon-terminated line becomes `kind:'text'`.

- **Completion debounce** — When the main GSD prompt reappears, a 2-second timer is set. Any `feed()` call during that window cancels the timer. If 2 seconds elapse with no new PTY input, `CompletionSignal` fires. An `_completionEmitted` flag prevents double-fire.

- **Critical ordering fix** — `isPromptLine` checks for `›`, but GSD's cursor glyph for selected options is also `›`. Moving TUI option line detection before `isPromptLine` prevents selected-option lines from being mishandled as turn boundaries. This finding is preserved in both `KNOWLEDGE.md` and the observability logs.

## Verification

```bash
# Build — zero new errors from S01 code:
npm run build:web-host
# Exit: 0

# TypeScript — zero errors from pty-chat-parser.ts:
cd web && npx tsc --noEmit 2>&1 | grep "pty-chat-parser"
# (no output)

# Fixture test (run via npx tsx during development):
# 23 passed, 0 failed — covering:
#   stripAnsi() regression (CSI colors, OSC sequences)
#   T01 segmentation regression (user/assistant roles, no ANSI leak)
#   Select prompt: 3 options, selectedIndex=0, label from header
#   selectedIndex: option B highlighted → selectedIndex=1
#   Password prompt: kind='password', label matches
#   Text prompt: kind='text', label matches
#   CompletionSignal: fires exactly once after 2s debounce
#   CompletionSignal: cancelled when new input arrives before 2s
#   Unsubscribe: no second signal after unsub()
#   No ANSI leak in any message content
```

Note: The fixture file (`pty-chat-parser.fixture.ts`) was deleted after verification per the KNOWLEDGE.md warning that test fixtures in `web/lib/` break `tsc --noEmit` when they use top-level `await` or `.ts` import extensions. Pre-existing `tsc --noEmit` errors in `src/web/*.ts` (TS5097, TS2339 etc.) are upstream issues unrelated to S01.

## Requirements Advanced

- R113 — S01 delivers the foundational data layer for Chat Mode: `PtyChatParser`, `ChatMessage`, `TuiPrompt`, and `CompletionSignal` are the contracts on which S02/S03/S04 will build.

## Requirements Validated

- None validated by this slice alone — R113 requires S02–S04 completion for full validation.

## New Requirements Surfaced

- None.

## Requirements Invalidated or Re-scoped

- None.

## Deviations

- **selectedIndex via rendered state, not keystroke tracking** (T02 plan step 9): ANSI cursor sequences are stripped before line processing, so raw arrow key sequences aren't visible. `selectedIndex` is derived from which option carries the `›` prefix at commit time — functionally equivalent since ink re-renders the full option list on each navigation step.
- **Checkbox detection uses `[x]`/`[ ]` patterns, not `◯`/`●`** (T02): GSD's actual UI uses bracket notation for checkboxes, not unicode bullets. The plan's reference to `◯`/`●` was based on initial assumptions about ink's render output.
- **Fixture file deleted after verification** (not in plan): KNOWLEDGE.md documents that `.ts` fixture files in `web/lib/` break `tsc --noEmit`. The fixture was deleted after the 23 assertions passed.
- **`_completionEmitted` flag added** (not in plan): An extra guard was needed to prevent rare double-fire when the window timer fires before the `feed()` cancel path. Conservative addition with no behavioral change in the normal path.

## Known Limitations

- Description lines below options that happen to start with a digit+dot (e.g., `     1. Some description`) would be misidentified as unselected options. In practice GSD option descriptions don't use this pattern.
- `_looksLikeQuestionHeader` captures header text only after a bar line (`─────`) — unusual prompts with question text not preceded by a bar won't populate `prompt.label`. The real GSD always precedes option lists with a bar, so this is not currently a gap.
- `onCompletionSignal` debounce is 2000ms — conservative. The real gap between a GSD action completing and the idle prompt appearing may be shorter. T04 (Action toolbar) should validate whether 2s is the right threshold or if a tuning mechanism is needed.
- The parser has no concept of session boundaries on reconnect — `reset()` must be called explicitly by the consuming component when a new session starts or the SSE stream reconnects.

## Follow-ups

- S02 (`ChatPane`): should call `parser.reset()` on SSE reconnect and assign `window.__chatParser = parser` in dev mode for in-console inspection.
- S02: verify that `MIN_SELECT_OPTIONS = 2` is sufficient — a GSD prompt that renders only 1 option would be silently discarded as content. If GSD ever has single-option selects, change to 1.
- S04 (`ActionPanel`): validate the 2s CompletionSignal debounce threshold against real GSD action timing. The constant `COMPLETION_DEBOUNCE_MS` is exported as a named constant for easy tuning.

## Files Created/Modified

- `web/lib/pty-chat-parser.ts` — new 758-line file: `PtyChatParser` class, `stripAnsi()`, `ChatMessage`/`TuiPrompt`/`CompletionSignal` interfaces, all TUI detection logic, completion debounce
- `.gsd/KNOWLEDGE.md` — two new entries: (1) select/promptLine ordering gotcha; (2) fixture files in web/lib break tsc --noEmit

## Forward Intelligence

### What the next slice should know

- **Import path**: `import { PtyChatParser, ChatMessage, TuiPrompt, CompletionSignal } from '@/lib/pty-chat-parser'` — all four public types are named exports.
- **SSE wiring pattern**: The parser expects raw `data` strings from `{ type: "output", data: string }` SSE payloads. Feed them with `parser.feed(payload.data)`. See `web/components/gsd/shell-terminal.tsx` for the EventSource subscription pattern to replicate.
- **`reset()` on reconnect**: Call `parser.reset()` when the EventSource reconnects or a new session starts — the parser has no auto-reset on reconnect.
- **Completion signal timing**: The 2s debounce is conservative. An action panel that auto-closes on `CompletionSignal` may feel slow. The constant `COMPLETION_DEBOUNCE_MS = 2000` in `pty-chat-parser.ts` is the tuning knob.
- **Dev mode inspection**: In `ChatPane`, assign `window.__chatParser = parser` (guarded by `process.env.NODE_ENV === 'development'`) so messages can be inspected from browser DevTools via `__chatParser.getMessages()`.

### What's fragile

- **Select window timer (300ms)**: If a slow PTY stream delivers option lines more than 300ms apart, the block commits early with incomplete options. This is unlikely for local PTY sessions but could happen on a high-latency connection. `SELECT_WINDOW_MS` is the tuning knob.
- **`_looksLikeQuestionHeader` timing**: The header capture depends on `_lastHeaderText === ""` being true right after a bar line. If the bar line and header line arrive in different `feed()` chunks that happen to be processed at different times, the header could be missed. In practice, GSD renders entire select blocks in one burst, so this is not currently a gap.
- **`isPromptLine` with `›`**: The ordering guard (TUI options before prompt boundary) is load-bearing. Do not reorder the line dispatch logic in `_handleLine()` without re-running the fixture suite.

### Authoritative diagnostics

- `[pty-chat-parser] tui prompt detected kind=...` — confirms detection fired, kind, and options count
- `[pty-chat-parser] completion signal scheduled/emitted` — shows timer behavior and debounce elapsed time
- `parser.getMessages().filter(m => m.prompt)` in DevTools — inspect all active TUI prompts
- `parser.getMessages().some(m => m.content.includes('\x1b'))` — ANSI leak check; should always return false

### What assumptions changed

- **T02 plan assumed `◯`/`●` select bullets** — GSD's actual UI uses `  › N. Label` (numbered + cursor glyph), not unicode circles. The implementation matches GSD's actual rendered output.
- **T02 plan assumed cursor-move ANSI sequences would be visible** — All ANSI is stripped before line processing, so arrow-key navigation must be inferred from rendered state (which option has `›`) rather than tracked via escape sequences. This is actually cleaner.
