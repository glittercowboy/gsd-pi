/**
 * PtyChatParser — ANSI stripper, message segmenter, role classifier,
 * TUI prompt detector, and completion signal emitter.
 *
 * Accepts raw PTY byte chunks from the /api/terminal/stream SSE feed
 * ({ type: "output", data: string } payloads) and produces a structured
 * ChatMessage[] that downstream chat rendering components can consume.
 *
 * Design principles:
 * - No xterm.js dependency — pure string processing
 * - Deterministic given the same input sequence
 * - Logs structural signals only — never raw PTY content (may contain secrets)
 * - Debug-level console.debug under [pty-chat-parser] prefix
 *
 * TUI detection patterns (after ANSI stripping):
 * - Select list: lines starting with "  › N." (selected) or "    N." (unselected)
 *   Uses GSD's shared UI cursor glyph "›"
 * - Checkbox: lines starting with "  › [x]" or "  › [ ]" (multi-select)
 * - Password/text: @clack/prompts "◆  " or "?" prefix + label ending with ":"
 * - Completion: main prompt (❯ / › / > / $) reappears after ≥2s of no output
 */

// ─── Public Types ─────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system"

export interface TuiPrompt {
  kind: "select" | "text" | "password"
  /** The prompt label / question text */
  label: string
  /** For select prompts: the list of option labels */
  options: string[]
  /** For select prompts: optional per-option descriptions */
  descriptions?: string[]
  /** For select prompts: the currently highlighted option index (0-based) */
  selectedIndex: number
}

export interface CompletionSignal {
  /** The session or context source this signal came from */
  source: string
  /** Unix timestamp (ms) when the signal was emitted */
  timestamp: number
}

export interface ChatMessage {
  /** Stable UUID — same object mutated in place while streaming */
  id: string
  role: MessageRole
  /** ANSI-stripped content */
  content: string
  /** false while streaming, true when a boundary has been detected */
  complete: boolean
  /** Set when a TUI prompt is detected inside this message */
  prompt?: TuiPrompt
  /** Unix timestamp (ms) of first content */
  timestamp: number
  /** Optional images attached by the user (chat mode only — PTY parser never sets this) */
  images?: { data: string; mimeType: string }[]
}

// ─── Subscriber Types ─────────────────────────────────────────────────────────

type MessageCallback = (message: ChatMessage) => void
type CompletionCallback = (signal: CompletionSignal) => void
type Unsubscribe = () => void

// ─── ANSI Stripper ────────────────────────────────────────────────────────────

/**
 * stripAnsi — remove all ANSI/VT100 escape sequences from a string.
 *
 * Handles:
 * - CSI sequences: \x1b[ ... final-byte (params + optional intermediates)
 * - OSC sequences: \x1b] ... \x07 or \x1b\\
 * - SS2/SS3: \x1bN, \x1bO + one char
 * - DCS/PM/APC: \x1bP/\x1b^/\x1b_ ... \x1b\\
 * - Simple ESC + one char (e.g. \x1bM reverse index)
 * - Bare \r at line start (overwrite pattern) → normalised to \n
 */
export function stripAnsi(s: string): string {
  // OSC: \x1b] ... (\x07 or \x1b\)
   
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  // DCS / PM / APC: \x1bP, \x1b^, \x1b_ ... \x1b\
   
  s = s.replace(/\x1b[P^_][^\x1b]*\x1b\\/g, "")
  // CSI: \x1b[ ... final byte (0x40–0x7e)
   
  s = s.replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g, "")
  // SS2 / SS3: \x1b(N|O) + one char
   
  s = s.replace(/\x1b[NO]./g, "")
  // All remaining ESC + one char (e.g. \x1bM, \x1b7, \x1b8, \x1b=, etc.)
   
  s = s.replace(/\x1b./g, "")
  // Stray lone \x1b with no following char
   
  s = s.replace(/\x1b/g, "")
  // \r followed by content overwrites the current line — keep the tail only
  // e.g. "old content\rnew content" → "new content"
  s = s.replace(/[^\n]*\r([^\n])/g, "$1")
  // Remaining bare \r → strip
  s = s.replace(/\r/g, "")
  return s
}

// ─── Role / Boundary Heuristics ───────────────────────────────────────────────

/**
 * GSD prompt markers that signal the boundary between turns.
 * After ANSI stripping, GSD's Pi agent shows one of these at the start
 * of a line when waiting for user input.
 */
const PROMPT_MARKERS = [
  /^❯\s*/,     // Pi default primary prompt
  /^›\s*/,     // Pi alternate prompt
  /^>(\s+|$)/,  // Simple > prompt (some themes) — bare ">" or "> text"
  /^\$(\s+|$)/, // Shell prompt fallback — bare "$" or "$ text"
]

/**
 * System/status lines: short, bracket-wrapped messages that GSD emits
 * at well-known lifecycle points.
 */
const SYSTEM_LINE_PATTERNS = [
  /^\[connecting[.\u2026]*/i,
  /^\[connected\]/i,
  /^\[disconnected\]/i,
  /^\[auto\s+mode/i,
  /^\[auto-mode/i,
  /^\[thinking[.\u2026]*/i,
  /^\[done\]/i,
  /^\[error/i,
  /^gsd\s+v[\d.]+/i,       // version banner
  /^✓\s/,                   // short success lines
  /^✗\s/,                   // short failure lines
]

/** Returns true if the (stripped) line looks like a GSD input prompt */
function isPromptLine(line: string): boolean {
  const trimmed = line.trim()
  return PROMPT_MARKERS.some((r) => r.test(trimmed))
}

/** Returns true if the (stripped) line looks like a system status message */
function isSystemLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  // Short bracket-wrapped lines
  if (/^\[.*\]$/.test(trimmed) && trimmed.length < 80) return true
  return SYSTEM_LINE_PATTERNS.some((r) => r.test(trimmed))
}

// ─── TUI Prompt Detection ─────────────────────────────────────────────────────

/**
 * GSD's shared UI uses "›" as cursor glyph (GLYPH.cursor = "›")
 * After ANSI stripping, a selected option renders as:
 *   "  › N. Label"  (with leading spaces from INDENT.option)
 * An unselected option renders as:
 *   "    N. Label"  (4 spaces instead of cursor)
 * Description lines render indented (5 spaces): "     Some description"
 *
 * Checkbox selected:  "  › [x] Label"
 * Checkbox unselected: "  › [ ] Label" or "    [ ] Label"
 *
 * A select block starts with a bar line (──────) or header line and
 * contains ≥2 numbered option lines within a short time window.
 */

/** Matches a GSD selected option line: "  › N. Label" */
const SELECT_OPTION_SELECTED_RE = /^\s{0,4}›\s+(\d+)\.\s+(.+)/

/** Matches a GSD unselected option line: "    N. Label" */
const SELECT_OPTION_UNSELECTED_RE = /^\s{3,6}(\d+)\.\s+(.+)/

/** Matches a GSD checkbox option: "  › [x] Label" or "  › [ ] Label" */
const CHECKBOX_SELECTED_RE = /^\s{0,4}›\s+\[([x ])\]\s+(.+)/i

/** Matches a GSD separator bar line: all ─ characters */
const BAR_LINE_RE = /^[─━─\-─]+$/

/**
 * Matches @clack/prompts password prompt lines:
 * - "◆  Some label:" (clack uses ◆ as question marker)
 * - "?  Some label:" (alternative clack style)
 * - "▲  Some label:" (another clack variant)
 */
const CLACK_PASSWORD_RE = /^[◆▲?]\s{1,3}(.+(?:API\s*key|password|token|secret)[^:]*):?\s*$/i

/**
 * Matches GSD text input prompts — @clack style or bare labeled prompts:
 * - "◆  Enter project name:"
 * - "?  What is your name?"
 */
const CLACK_TEXT_RE = /^[◆▲?]\s{1,3}(.+[?:])\s*$/

/**
 * Matches hints line rendered by GSD's shared UI:
 * "  ↑/↓ to move  |  enter to select"
 * These appear below select lists and help confirm a select block is active.
 */
const HINTS_RE = /↑|↓|arrow|enter to select|space to toggle/i

/** Minimum option lines needed to recognise a select block */
const MIN_SELECT_OPTIONS = 2

/** Max ms to accumulate select option lines before committing the block */
const SELECT_WINDOW_MS = 300

/**
 * Minimum milliseconds of silence (no PTY output) after the main prompt
 * re-appears before a CompletionSignal is emitted.
 * Conservative: false positives (premature close) are worse than negatives.
 */
const COMPLETION_DEBOUNCE_MS = 2000

// ─── UUID Utility ─────────────────────────────────────────────────────────────

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ─── Select Block Accumulator ─────────────────────────────────────────────────

interface SelectOption {
  index: number    // 1-based as rendered by GSD
  label: string
  selected: boolean
}

interface SelectBlock {
  label: string           // question/header text above the options
  options: SelectOption[]
  windowTimer: ReturnType<typeof setTimeout> | null
  firstLineAt: number
}

// ─── PtyChatParser ────────────────────────────────────────────────────────────

/**
 * PtyChatParser — stateful parser for raw PTY output.
 *
 * Usage:
 *   const parser = new PtyChatParser()
 *   parser.onMessage((msg) => console.log(msg))
 *   // Feed SSE output chunks:
 *   es.onmessage = (e) => {
 *     const { type, data } = JSON.parse(e.data)
 *     if (type === 'output') parser.feed(data)
 *   }
 */
export class PtyChatParser {
  /** Raw byte buffer — accumulates across chunks until a boundary is found */
  private _buffer = ""
  /** Stable ordered message list */
  private _messages: ChatMessage[] = []
  /** Subscribers for message events */
  private _subscribers = new Set<MessageCallback>()
  /** Subscribers for completion signals */
  private _completionSubscribers = new Set<CompletionCallback>()
  /** Source label for CompletionSignal */
  private _source: string
  /** The message currently being built (not yet complete) */
  private _activeMessage: ChatMessage | null = null

  // ── TUI state ────────────────────────────────────────────────────────────────

  /**
   * Pending select block accumulator.
   * Lives until either: enough options arrive and the window closes,
   * or the window timer fires with too few options.
   */
  private _pendingSelect: SelectBlock | null = null

  /**
   * The last "question / header" line text seen before option lines start.
   * Reset when a new bar line appears.
   */
  private _lastHeaderText = ""

  /**
   * Timestamp of the last PTY input received — used for completion debounce.
   */
  private _lastInputAt = 0

  /**
   * Set to true when main prompt line appears; cleared if more output arrives
   * before COMPLETION_DEBOUNCE_MS expires. Timer fires the signal.
   */
  private _completionTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Whether we have already emitted a completion signal since the last
   * non-trivial output — guards against double-fire.
   */
  private _completionEmitted = false

  /**
   * True when the parser has seen a prompt boundary and is waiting for user
   * input.  The next non-system, non-prompt, non-TUI content line after the
   * prompt is classified as role="user" instead of "assistant".
   * Reset to false once that user line arrives (or when a new assistant
   * message explicitly starts via a different signal).
   */
  private _awaitingInput = false

  constructor(source = "default") {
    this._source = source
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Feed a raw PTY chunk (may contain ANSI codes, partial lines, etc.)
   */
  feed(chunk: string): void {
    this._lastInputAt = Date.now()
    // Any new content resets pending completion — we're still receiving output
    if (this._completionTimer) {
      clearTimeout(this._completionTimer)
      this._completionTimer = null
    }
    this._buffer += chunk
    this._process()
  }

  /** Return a shallow copy of the current message list */
  getMessages(): ChatMessage[] {
    return [...this._messages]
  }

  /**
   * Returns true when the parser has detected a prompt boundary and is
   * waiting for user input.  Chat UIs can use this to show an "awaiting
   * input" indicator so the session does not appear stuck.
   */
  isAwaitingInput(): boolean {
    return this._awaitingInput
  }

  /**
   * Flush any trailing partial buffer even if it does not end with a newline.
   * Useful for terminal UIs that leave the final status line unterminated.
   */
  flush(): void {
    if (this._buffer.length === 0) return

    const stripped = stripAnsi(this._buffer)
    this._buffer = ""

    for (const rawLine of stripped.split("\n")) {
      const line = rawLine.trimEnd()
      if (line.length === 0) continue
      this._handleLine(line)
    }
  }

  /**
   * Subscribe to message events (new message or content appended).
   * Returns an unsubscribe function.
   */
  onMessage(cb: MessageCallback): Unsubscribe {
    this._subscribers.add(cb)
    return () => this._subscribers.delete(cb)
  }

  /**
   * Subscribe to completion signals (GSD returned to idle prompt after ≥2s silence).
   * Returns an unsubscribe function.
   */
  onCompletionSignal(cb: CompletionCallback): Unsubscribe {
    this._completionSubscribers.add(cb)
    return () => this._completionSubscribers.delete(cb)
  }

  /** Reset all state — useful when a new session starts */
  reset(): void {
    this._buffer = ""
    this._messages = []
    this._activeMessage = null
    this._pendingSelect = null
    this._lastHeaderText = ""
    this._lastInputAt = 0
    this._completionEmitted = false
    this._awaitingInput = false
    if (this._completionTimer) {
      clearTimeout(this._completionTimer)
      this._completionTimer = null
    }
    console.debug("[pty-chat-parser] reset source=%s", this._source)
  }

  // ── Internal Processing ─────────────────────────────────────────────────────

  private _process(): void {
    // Accumulate until we have at least one complete line
    // Process all complete lines; leave the last partial line in the buffer
    const lastNewline = this._buffer.lastIndexOf("\n")
    if (lastNewline === -1) return // no complete line yet

    const toProcess = this._buffer.slice(0, lastNewline + 1)
    this._buffer = this._buffer.slice(lastNewline + 1)

    const stripped = stripAnsi(toProcess)
    const lines = stripped.split("\n")

    for (const rawLine of lines) {
      const line = rawLine.trimEnd()
      this._handleLine(line)
    }
  }

  private _handleLine(line: string): void {
    const trimmed = line.trim()

    // Blank lines — append to active assistant message as spacing
    if (trimmed.length === 0) {
      if (this._activeMessage?.role === "assistant") {
        this._appendToActive("\n")
      }
      return
    }

    // ── Separator bar (─────) — signals UI block boundary ───────────────────
    if (BAR_LINE_RE.test(trimmed)) {
      // Commit any pending select block
      this._commitSelectBlock()
      // Reset header text — next non-bar line may be a new question
      this._lastHeaderText = ""
      // Append to active assistant content
      if (this._activeMessage && !this._activeMessage.complete && this._activeMessage.role === "assistant") {
        this._appendToActive(line + "\n")
      }
      return
    }

    // ── TUI option lines — must be checked BEFORE isPromptLine ─────────────
    // Reason: the GSD UI cursor glyph "›" is also a PROMPT_MARKER, so a
    // selected-option line like "  › 1. Describe it now" would be mistakenly
    // handled as a prompt boundary if isPromptLine ran first.

    // Checkbox option line: "  › [x] Label" / "  › [ ] Label"
    const checkboxMatch = CHECKBOX_SELECTED_RE.exec(line)
    if (checkboxMatch) {
      this._handleCheckboxOption(checkboxMatch[1], checkboxMatch[2])
      return
    }

    // Selected option line: "  › N. Label"
    const selectedMatch = SELECT_OPTION_SELECTED_RE.exec(line)
    if (selectedMatch) {
      this._handleSelectOption(parseInt(selectedMatch[1], 10), selectedMatch[2], true)
      return
    }

    // Unselected option line: "    N. Label" (3–6 leading spaces, no ›)
    // Guard: must look like a numbered option — not a description indent line
    const unselectedMatch = SELECT_OPTION_UNSELECTED_RE.exec(line)
    if (unselectedMatch && !SELECT_OPTION_SELECTED_RE.test(line)) {
      this._handleSelectOption(parseInt(unselectedMatch[1], 10), unselectedMatch[2], false)
      return
    }

    // Hints line (↑/↓ navigation hints) — end of a select block
    if (HINTS_RE.test(trimmed)) {
      this._commitSelectBlock()
      if (this._activeMessage && !this._activeMessage.complete && this._activeMessage.role === "assistant") {
        this._appendToActive(line + "\n")
      }
      return
    }

    // ── Prompt line → boundary ───────────────────────────────────────────────
    if (isPromptLine(trimmed)) {
      // Commit any pending select block before closing this turn
      this._commitSelectBlock()

      // Complete any active message
      if (this._activeMessage) {
        this._completeActive()
        console.debug(
          "[pty-chat-parser] boundary: prompt detected, completed msg=%s role=%s source=%s",
          this._activeMessage?.id ?? "(none)",
          this._activeMessage?.role ?? "(none)",
          this._source,
        )
      }

      // Schedule completion signal with debounce
      this._scheduleCompletionSignal()

      // Start a new user message (the text after the prompt marker is user input)
      const userText = trimmed.replace(PROMPT_MARKERS[0], "")
        .replace(PROMPT_MARKERS[1], "")
        .replace(PROMPT_MARKERS[2], "")
        .replace(PROMPT_MARKERS[3], "")
        .trim()

      if (userText.length > 0) {
        const msg = this._startMessage("user", userText)
        this._completeMessage(msg) // user lines are typically single-line
        this._awaitingInput = false
      } else {
        // Bare prompt with no inline user text — mark as awaiting input
        // so the next content line is classified as user input.
        this._awaitingInput = true
      }
      return
    }

    // ── System / status line ─────────────────────────────────────────────────
    if (isSystemLine(trimmed)) {
      // Complete any active non-system message first
      if (this._activeMessage && this._activeMessage.role !== "system") {
        this._completeActive()
      }
      // System messages are always self-contained single lines
      const msg = this._startMessage("system", trimmed)
      this._completeMessage(msg)
      console.debug(
        "[pty-chat-parser] system line detected id=%s source=%s",
        msg.id,
        this._source,
      )
      return
    }

    // ── @clack/prompts TUI prompts ───────────────────────────────────────────

    // Password prompt: @clack/prompts "◆  Paste your Anthropic API key:"
    const passwordMatch = CLACK_PASSWORD_RE.exec(trimmed)
    if (passwordMatch) {
      this._handlePasswordPrompt(passwordMatch[1])
      return
    }

    // Text prompt: @clack/prompts "◆  Enter project name:"
    const textMatch = CLACK_TEXT_RE.exec(trimmed)
    if (textMatch) {
      this._handleTextPrompt(textMatch[1])
      return
    }

    // ── Question/header line (before options) ────────────────────────────────
    // GSD renders a header line or question text above select options.
    // Capture it so we can use it as the TuiPrompt.label when options arrive.
    if (this._looksLikeQuestionHeader(line)) {
      this._lastHeaderText = trimmed
    }

    // ── Awaiting input → classify as user ──────────────────────────────────
    // After a bare prompt line (e.g. "❯ \n"), the next content line is
    // the user's typed input echoed back by the PTY (without prompt prefix).
    if (this._awaitingInput) {
      this._awaitingInput = false
      const msg = this._startMessage("user", trimmed)
      this._completeMessage(msg)
      console.debug(
        "[pty-chat-parser] user input detected (post-prompt echo) id=%s source=%s",
        msg.id,
        this._source,
      )
      return
    }

    // ── Regular content line → assistant ────────────────────────────────────
    if (
      this._activeMessage === null ||
      this._activeMessage.complete ||
      this._activeMessage.role !== "assistant"
    ) {
      // Start a new assistant message
      this._activeMessage = this._startMessage("assistant", "")
      console.debug(
        "[pty-chat-parser] role boundary: started assistant msg=%s source=%s",
        this._activeMessage.id,
        this._source,
      )
    }
    this._appendToActive(line + "\n")
  }

  // ── TUI Prompt Handlers ─────────────────────────────────────────────────────

  private _handleSelectOption(num: number, label: string, isSelected: boolean): void {
    const cleanLabel = label.trim()

    if (!this._pendingSelect) {
      // Start a new accumulation block
      this._pendingSelect = {
        label: this._lastHeaderText,
        options: [],
        windowTimer: null,
        firstLineAt: Date.now(),
      }
      // Set window timer — if not enough options arrive, discard
      this._pendingSelect.windowTimer = setTimeout(() => {
        this._commitSelectBlock()
      }, SELECT_WINDOW_MS)
    }

    // Upsert option by its 1-based index
    const block = this._pendingSelect
    const existing = block.options.find((o) => o.index === num)
    if (existing) {
      existing.label = cleanLabel
      existing.selected = isSelected
    } else {
      block.options.push({ index: num, label: cleanLabel, selected: isSelected })
    }
  }

  private _handleCheckboxOption(checked: string, label: string): void {
    const isSelected = checked.toLowerCase() === "x"
    // Reuse select option logic — checkboxes map to select with multiple selection
    // For simplicity, we detect checkbox as a variant of select
    this._handleSelectOption(this._pendingSelect?.options.length ?? 0 + 1, label, isSelected)
  }

  private _handlePasswordPrompt(label: string): void {
    // Ensure there's an active assistant message to attach the prompt to
    if (!this._activeMessage || this._activeMessage.complete || this._activeMessage.role !== "assistant") {
      this._activeMessage = this._startMessage("assistant", "")
    }
    const prompt: TuiPrompt = {
      kind: "password",
      label: label.trim(),
      options: [],
      selectedIndex: 0,
    }
    this._activeMessage.prompt = prompt
    this._notify(this._activeMessage)
    console.debug(
      "[pty-chat-parser] tui prompt detected kind=password source=%s",
      this._source,
    )
  }

  private _handleTextPrompt(label: string): void {
    // Ensure there's an active assistant message to attach the prompt to
    if (!this._activeMessage || this._activeMessage.complete || this._activeMessage.role !== "assistant") {
      this._activeMessage = this._startMessage("assistant", "")
    }
    const prompt: TuiPrompt = {
      kind: "text",
      label: label.trim(),
      options: [],
      selectedIndex: 0,
    }
    this._activeMessage.prompt = prompt
    this._notify(this._activeMessage)
    console.debug(
      "[pty-chat-parser] tui prompt detected kind=text label=%s source=%s",
      label.trim(),
      this._source,
    )
  }

  private _commitSelectBlock(): void {
    if (!this._pendingSelect) return

    const block = this._pendingSelect
    this._pendingSelect = null

    if (block.windowTimer) {
      clearTimeout(block.windowTimer)
    }

    if (block.options.length < MIN_SELECT_OPTIONS) {
      // Not enough options — treat as regular content, not a select prompt
      return
    }

    // Sort options by their 1-based index
    block.options.sort((a, b) => a.index - b.index)

    const selectedOpt = block.options.find((o) => o.selected)
    const selectedIndex = selectedOpt
      ? block.options.indexOf(selectedOpt)
      : 0

    const prompt: TuiPrompt = {
      kind: "select",
      label: block.label,
      options: block.options.map((o) => o.label),
      selectedIndex,
    }

    // Ensure there's an active assistant message to attach the prompt to
    if (!this._activeMessage || this._activeMessage.complete || this._activeMessage.role !== "assistant") {
      this._activeMessage = this._startMessage("assistant", "")
    }
    this._activeMessage.prompt = prompt
    this._notify(this._activeMessage)

    console.debug(
      "[pty-chat-parser] tui prompt detected kind=select options=%d selectedIndex=%d source=%s",
      prompt.options.length,
      selectedIndex,
      this._source,
    )
  }

  /**
   * Returns true if a stripped line looks like a question/header text that
   * precedes a select list. Criteria: non-empty, not a system line, not an
   * option line, and appeared after a bar separator.
   */
  private _looksLikeQuestionHeader(line: string): boolean {
    const trimmed = line.trim()
    if (trimmed.length === 0) return false
    if (BAR_LINE_RE.test(trimmed)) return false
    if (isSystemLine(trimmed)) return false
    if (SELECT_OPTION_SELECTED_RE.test(line)) return false
    if (SELECT_OPTION_UNSELECTED_RE.test(line)) return false
    if (CHECKBOX_SELECTED_RE.test(line)) return false
    // Only capture as header if we just saw a bar (header text is fresh)
    // — otherwise this rule would capture any assistant content
    return this._lastHeaderText === "" || this._pendingSelect !== null
  }

  // ── Completion Signal ────────────────────────────────────────────────────────

  /**
   * Schedule a CompletionSignal to fire after COMPLETION_DEBOUNCE_MS of silence.
   * Any subsequent PTY input in feed() cancels and resets the timer (see feed()).
   */
  private _scheduleCompletionSignal(): void {
    if (this._completionTimer) {
      clearTimeout(this._completionTimer)
    }
    this._completionEmitted = false

    const scheduledAt = Date.now()
    this._completionTimer = setTimeout(() => {
      this._completionTimer = null
      if (this._completionEmitted) return

      const elapsed = Date.now() - scheduledAt
      this._completionEmitted = true

      const signal: CompletionSignal = {
        source: this._source,
        timestamp: Date.now(),
      }
      console.debug(
        "[pty-chat-parser] completion signal emitted source=%s debounce=%dms",
        this._source,
        elapsed,
      )
      for (const cb of this._completionSubscribers) {
        try { cb(signal) } catch { /* subscriber error */ }
      }
    }, COMPLETION_DEBOUNCE_MS)

    console.debug(
      "[pty-chat-parser] completion signal scheduled (debounce=%dms) source=%s",
      COMPLETION_DEBOUNCE_MS,
      this._source,
    )
  }

  // ── Message Lifecycle ───────────────────────────────────────────────────────

  private _startMessage(role: MessageRole, content: string): ChatMessage {
    const msg: ChatMessage = {
      id: newId(),
      role,
      content,
      complete: false,
      timestamp: Date.now(),
    }
    this._messages.push(msg)
    this._activeMessage = msg
    this._notify(msg)
    return msg
  }

  private _appendToActive(text: string): void {
    if (!this._activeMessage || this._activeMessage.complete) return
    this._activeMessage.content += text
    this._notify(this._activeMessage)
  }

  private _completeActive(): void {
    if (!this._activeMessage || this._activeMessage.complete) return
    this._completeMessage(this._activeMessage)
  }

  private _completeMessage(msg: ChatMessage): void {
    // Trim trailing whitespace from completed messages
    msg.content = msg.content.trimEnd()
    msg.complete = true
    if (this._activeMessage === msg) this._activeMessage = null
    this._notify(msg)
    console.debug(
      "[pty-chat-parser] message complete id=%s role=%s source=%s",
      msg.id,
      msg.role,
      this._source,
    )
  }

  private _notify(msg: ChatMessage): void {
    for (const cb of this._subscribers) {
      try { cb(msg) } catch { /* subscriber error */ }
    }
  }
}
