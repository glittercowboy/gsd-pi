# S01: PTY Output Parser and Chat Message Model — UAT

**Milestone:** M007
**Written:** 2026-03-17

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S01 is a pure data-layer module with no UI surface. Correctness is proven by fixture assertions (23 cases covering all detection paths) and TypeScript compilation. Live PTY wiring belongs to S02 where the parser is consumed in `ChatPane`.

## Preconditions

1. Working directory is `/Users/sn0w/Documents/dev/GSD-2`
2. `web/lib/pty-chat-parser.ts` exists and is ~758 lines
3. `npm run build:web-host` exits 0 (already verified)
4. Node.js and `npx tsx` are available

## Smoke Test

Run TypeScript check scoped to the parser:

```bash
cd /Users/sn0w/Documents/dev/GSD-2/web && npx tsc --noEmit 2>&1 | grep "pty-chat-parser"
# Expected: no output (zero errors from this file)
```

## Test Cases

### 1. ANSI Stripping — CSI Color Sequences

Feed a chunk containing ANSI color codes and assert the content is clean.

```ts
import { PtyChatParser } from './web/lib/pty-chat-parser.ts'

const parser = new PtyChatParser('test')
// ESC[1;32m = bold green, ESC[0m = reset
parser.feed('> \x1b[1;32mHello World\x1b[0m\n')
parser.feed('\x1b[36mLine 2\x1b[0m\nNext\n❯\n')

const msgs = parser.getMessages()
const hasAnsi = msgs.some(m => m.content.includes('\x1b'))
```

**Expected:** `hasAnsi === false`. The user message contains `Hello World`, the assistant message contains `Line 2` and `Next` — no `\x1b` characters in any `content` field.

---

### 2. ANSI Stripping — OSC Title Sequences

```ts
parser.feed('\x1b]0;Window Title\x07Some content\n❯\n')
const msgs = parser.getMessages()
const hasAnsi = msgs.some(m => m.content.includes('\x1b'))
```

**Expected:** `hasAnsi === false`. OSC title sequences are stripped; `Some content` appears in the assistant message content.

---

### 3. CR Overwrite Pattern

```ts
const { stripAnsi } = require('./web/lib/pty-chat-parser')
const result = stripAnsi('old content\rnew text')
```

**Expected:** `result === 'new text'`. The CR overwrite replaces the prior content on the same line.

---

### 4. Role Classification — User Input After Prompt

```ts
const parser = new PtyChatParser('test')
parser.feed('❯ What is 2+2?\n')
parser.feed('The answer is 4.\n')
parser.feed('❯\n')

const msgs = parser.getMessages()
const userMsg = msgs.find(m => m.role === 'user')
const assistantMsg = msgs.find(m => m.role === 'assistant')
```

**Expected:**
- `userMsg.content === 'What is 2+2?'`
- `assistantMsg.content === 'The answer is 4.'`
- Both have `complete === true` (boundary crossed)
- No `\x1b` in any content

---

### 5. Role Classification — System Status Line

```ts
const parser = new PtyChatParser('test')
parser.feed('[connecting...]\n')
parser.feed('[connected]\n')
parser.feed('❯\n')

const msgs = parser.getMessages()
const systemMsgs = msgs.filter(m => m.role === 'system')
```

**Expected:** Two system messages: `[connecting...]` and `[connected]`. Both `complete === true`.

---

### 6. onMessage Subscription and Unsubscribe

```ts
const parser = new PtyChatParser('test')
const received: string[] = []
const unsub = parser.onMessage(msg => received.push(msg.id))

parser.feed('❯ Hello\n')
const countBeforeUnsub = received.length

unsub()
parser.feed('Some more output\n')
const countAfterUnsub = received.length
```

**Expected:**
- `countBeforeUnsub > 0` — at least one notification fired
- `countAfterUnsub === countBeforeUnsub` — no notifications after unsubscribe

---

### 7. Select Prompt Detection

Feed a GSD-style select list with a bar separator, header, options, and hints line:

```ts
const parser = new PtyChatParser('test')
parser.feed('Some preceding text\n')
parser.feed('─────────────────────\n')
parser.feed('What would you like to do?\n')
parser.feed('  › 1. Option A\n')
parser.feed('    2. Option B\n')
parser.feed('    3. Option C\n')
parser.feed('  ↑/↓ to move  |  enter to select\n')

const msgs = parser.getMessages()
const promptMsg = msgs.find(m => m.prompt?.kind === 'select')
```

**Expected:**
- `promptMsg` exists
- `promptMsg.prompt.kind === 'select'`
- `promptMsg.prompt.options.length === 3`
- `promptMsg.prompt.options[0] === 'Option A'`
- `promptMsg.prompt.selectedIndex === 0` (option 1 had `›`)
- `promptMsg.prompt.label === 'What would you like to do?'` (captured after bar)

---

### 8. Select Prompt — Non-Default selectedIndex

```ts
const parser = new PtyChatParser('test')
parser.feed('─────────────────────\n')
parser.feed('  1. Option A\n')      // unselected — no ›
parser.feed('  › 2. Option B\n')   // selected
parser.feed('  3. Option C\n')      // unselected
parser.feed('  ↑/↓ to move\n')

const msgs = parser.getMessages()
const prompt = msgs.find(m => m.prompt?.kind === 'select')?.prompt
```

**Expected:** `prompt.selectedIndex === 1` (Option B is at 0-based index 1 in the sorted array).

---

### 9. Password Prompt Detection

```ts
const parser = new PtyChatParser('test')
parser.feed('◆  Paste your Anthropic API key:\n')

const msgs = parser.getMessages()
const promptMsg = msgs.find(m => m.prompt?.kind === 'password')
```

**Expected:**
- `promptMsg.prompt.kind === 'password'`
- `promptMsg.prompt.label` contains `'Anthropic API key'`

---

### 10. Text Prompt Detection

```ts
const parser = new PtyChatParser('test')
parser.feed('◆  Enter project name:\n')

const msgs = parser.getMessages()
const promptMsg = msgs.find(m => m.prompt?.kind === 'text')
```

**Expected:**
- `promptMsg.prompt.kind === 'text'`
- `promptMsg.prompt.label` contains `'Enter project name'`

---

### 11. CompletionSignal — Fires After 2s Silence

```ts
const parser = new PtyChatParser('test')
const signals: CompletionSignal[] = []
parser.onCompletionSignal(sig => signals.push(sig))

parser.feed('❯\n')  // main prompt reappears

// Wait 2.1 seconds
await new Promise(r => setTimeout(r, 2100))
```

**Expected:** `signals.length === 1`. The signal fires exactly once after the 2s debounce.

---

### 12. CompletionSignal — Cancelled by New Input

```ts
const parser = new PtyChatParser('test')
const signals: CompletionSignal[] = []
parser.onCompletionSignal(sig => signals.push(sig))

parser.feed('❯\n')  // prompt appears — starts 2s timer

// New input arrives within the debounce window
await new Promise(r => setTimeout(r, 500))
parser.feed('More output from GSD\n')

// Wait past original 2s mark
await new Promise(r => setTimeout(r, 1800))
```

**Expected:** `signals.length === 0`. The new `feed()` cancelled the timer. (A new 2s timer would start on the next `❯` line.)

---

### 13. reset() Clears All State

```ts
const parser = new PtyChatParser('test')
parser.feed('Some content\n')
parser.feed('❯ User input\n')
parser.reset()

const msgs = parser.getMessages()
```

**Expected:** `msgs.length === 0`. All state cleared. Parser is ready for a new session.

---

### 14. Message ID Stability

```ts
const parser = new PtyChatParser('test')
const ids: string[] = []
parser.onMessage(msg => ids.push(msg.id))

parser.feed('Line 1\n')
parser.feed('Line 2\n')
```

**Expected:** The same message ID appears in multiple notifications (the message is mutated in-place while streaming, not replaced). Verify `new Set(ids).size < ids.length` — the same ID fires multiple times as content accumulates.

---

### 15. TypeScript Build — No New Errors

```bash
cd /Users/sn0w/Documents/dev/GSD-2
npm run build:web-host
```

**Expected:** Exit code 0. No errors attributable to `pty-chat-parser.ts`.

## Edge Cases

### No Newline in Feed

```ts
const parser = new PtyChatParser('test')
parser.feed('partial line without newline')
const msgs = parser.getMessages()
```

**Expected:** `msgs.length === 0`. The partial line stays in the buffer; no messages emitted until a `\n` arrives.

---

### Fewer Than 2 Options — Not a Select Prompt

```ts
const parser = new PtyChatParser('test')
parser.feed('─────────────────────\n')
parser.feed('  › 1. Only option\n')
parser.feed('  ↑/↓ to move\n')

const msgs = parser.getMessages()
const hasSelectPrompt = msgs.some(m => m.prompt?.kind === 'select')
```

**Expected:** `hasSelectPrompt === false`. Single-option blocks do not meet `MIN_SELECT_OPTIONS = 2` and are treated as regular content.

---

### Empty Lines in Assistant Content

```ts
const parser = new PtyChatParser('test')
parser.feed('Line 1\n\n\nLine 4\n❯\n')

const msgs = parser.getMessages()
const assistantMsg = msgs.find(m => m.role === 'assistant')
```

**Expected:** Assistant message contains `Line 1` and `Line 4`; blank lines add `\n` spacing to `content` while it's active.

---

### ANSI in Prompt Line — Still Detected

```ts
const parser = new PtyChatParser('test')
parser.feed('\x1b[1m❯\x1b[0m User typed this\n')

const msgs = parser.getMessages()
const userMsg = msgs.find(m => m.role === 'user')
```

**Expected:** `userMsg.content === 'User typed this'`. ANSI stripping runs before role classification; the bold `❯` is correctly recognised as a prompt boundary even when wrapped in color codes.

## Failure Signals

- `msgs.some(m => m.content.includes('\x1b'))` returns true → ANSI leak; check stripAnsi() against the specific escape sequence category
- `msgs.find(m => m.prompt?.kind === 'select')` is undefined despite feeding option lines → check SELECT_OPTION_SELECTED_RE / SELECT_OPTION_UNSELECTED_RE match; verify lines arrive with the expected leading spaces
- `signals.length === 0` after 2.1 seconds → verify `❯` / `›` appears at the start of the line (trimmed); check that PROMPT_MARKERS cover the actual prompt character
- `signals.length > 1` → the `_completionEmitted` flag should prevent this; if it fires twice, check that `reset()` was not called between the feeds
- `promptMsg.prompt.label === ''` for a select prompt → the bar line (`─────`) must appear before the question header; verify `_lastHeaderText` is populated when options arrive
- `parser.getMessages().length === 0` when content was fed → check that each `feed()` call contained at least one `\n`

## Requirements Proved By This UAT

- R113 (partially) — S01 proves the data layer contract that Chat Mode depends on: structured `ChatMessage[]` output, TUI prompt classification, and `CompletionSignal` emission. Full R113 validation requires S02–S04 (UI rendering, TUI intercept, panel lifecycle).

## Not Proven By This UAT

- Live PTY stream wiring — requires S02 `ChatPane` consuming the SSE endpoint
- Visual correctness of chat bubbles — requires S02 rendering layer
- TUI intercept UI (native select/text/password components) — requires S03
- Action panel auto-close on CompletionSignal — requires S04
- No session leaks after panel close — requires S04

## Notes for Tester

- The fixture file (`pty-chat-parser.fixture.ts`) was deleted after development verification — do not look for it; run the test cases above manually or with `npx tsx`.
- The 23 fixture assertions from development covered all the test cases above and passed. Re-running them is a sanity check, not a new investigation.
- Pre-existing `tsc --noEmit` errors in `src/web/*.ts` (bridge-service.ts TS5097 etc.) are upstream issues that predate S01. The verification target is `| grep pty-chat-parser` showing no output, not a clean tsc across the whole repo.
- `SELECT_WINDOW_MS = 300` is the accumulation window for select options. If testing with synthetic slow-fed input, ensure all option lines arrive within 300ms or increase the constant.
- `COMPLETION_DEBOUNCE_MS = 2000` means test cases 11 and 12 require `await`ing > 2 seconds. Use fake timers (Jest `useFakeTimers`) if running in a test harness to avoid slow tests.
