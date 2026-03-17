/**
 * PtyChatParser — ANSI stripper, message segmenter, and role classifier.
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
 */

// ─── Public Types ─────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system"

export interface TuiPrompt {
  kind: "select" | "text" | "password"
  /** For select prompts: the list of option labels */
  options: string[]
  /** For select prompts: the currently highlighted option index */
  selectedIndex: number
  /** The prompt label / question text */
  label: string
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
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  // DCS / PM / APC: \x1bP, \x1b^, \x1b_ ... \x1b\
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b[P^_][^\x1b]*\x1b\\/g, "")
  // CSI: \x1b[ ... final byte (0x40–0x7e)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g, "")
  // SS2 / SS3: \x1b(N|O) + one char
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b[NO]./g, "")
  // All remaining ESC + one char (e.g. \x1bM, \x1b7, \x1b8, \x1b=, etc.)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b./g, "")
  // Stray lone \x1b with no following char
  // eslint-disable-next-line no-control-regex
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
  /^>\s+/,     // Simple > prompt (some themes)
  /^\$\s+/,    // Shell prompt fallback
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

  constructor(source = "default") {
    this._source = source
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Feed a raw PTY chunk (may contain ANSI codes, partial lines, etc.)
   */
  feed(chunk: string): void {
    this._buffer += chunk
    this._process()
  }

  /** Return a shallow copy of the current message list */
  getMessages(): ChatMessage[] {
    return [...this._messages]
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
   * Subscribe to completion signals (GSD returned to idle prompt).
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

    // ── Prompt line → boundary ───────────────────────────────────────────────
    if (isPromptLine(trimmed)) {
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

      // Emit a completion signal — GSD is back at idle prompt
      const signal: CompletionSignal = {
        source: this._source,
        timestamp: Date.now(),
      }
      console.debug(
        "[pty-chat-parser] completion signal emitted source=%s",
        this._source,
      )
      for (const cb of this._completionSubscribers) {
        try { cb(signal) } catch { /* subscriber error */ }
      }

      // Start a new user message (the text after the prompt marker is user input)
      const userText = trimmed.replace(PROMPT_MARKERS[0], "")
        .replace(PROMPT_MARKERS[1], "")
        .replace(PROMPT_MARKERS[2], "")
        .replace(PROMPT_MARKERS[3], "")
        .trim()

      if (userText.length > 0) {
        const msg = this._startMessage("user", userText)
        this._completeMessage(msg) // user lines are typically single-line
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
