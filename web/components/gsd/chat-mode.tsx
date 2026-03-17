"use client"

import { useEffect, useRef, useCallback, useState } from "react"
import { MessagesSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { PtyChatParser, ChatMessage } from "@/lib/pty-chat-parser"

/**
 * ChatMode — main view for the Chat tab.
 *
 * T01 scaffold: header bar + left pane with placeholder content.
 * T02 wires in the live ChatPane (SSE + PtyChatParser).
 * T03 adds chat bubble rendering and the input bar.
 *
 * Observability:
 *   - This component mounts only when activeView === "chat" (no hidden pre-init).
 *   - Console will show any render errors here directly.
 *   - sessionStorage key "gsd-active-view:<cwd>" will equal "chat" when this view is active.
 *   - ChatPane logs SSE lifecycle to console under [ChatPane] prefix.
 *   - In dev mode, window.__chatParser exposes the PtyChatParser instance.
 */
export function ChatMode({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-full flex-col overflow-hidden bg-background", className)}>
      {/* ── Header bar ── */}
      <ChatModeHeader />

      {/* ── Main pane ── */}
      <div className="flex flex-1 overflow-hidden">
        <ChatPane sessionId="gsd-main" command="pi" className="flex-1" />
      </div>
    </div>
  )
}

/* ─── Header ─── */

function ChatModeHeader() {
  return (
    <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border bg-card px-4">
      <MessagesSquare className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-medium text-foreground">Chat</span>
      <span className="ml-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
        gsd-main
      </span>
    </div>
  )
}

/* ─── Chat Pane ─── */

interface ChatPaneProps {
  sessionId: string
  command?: string
  className?: string
}

/**
 * ChatPane — SSE connection + PtyChatParser integration.
 *
 * Connects to the PTY session SSE stream on mount, feeds raw output chunks
 * through PtyChatParser, and exposes the resulting ChatMessage[] as React state.
 *
 * Observability:
 *   - console.log("[ChatPane] SSE connected sessionId=%s") on successful connect
 *   - console.log("[ChatPane] SSE error/disconnected sessionId=%s") on error
 *   - console.debug("[ChatPane] messages=%d sessionId=%s") on every parser update
 *   - In dev mode: window.__chatParser exposes the parser for console inspection
 */
export function ChatPane({ sessionId, command, className }: ChatPaneProps) {
  const parserRef = useRef<PtyChatParser | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const inputQueueRef = useRef<string[]>([])
  const flushingRef = useRef(false)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [connected, setConnected] = useState(false)

  // ── Input queue flush — same pattern as shell-terminal.tsx ────────────────

  const flushInputQueue = useCallback(async () => {
    if (flushingRef.current) return
    flushingRef.current = true
    while (inputQueueRef.current.length > 0) {
      const data = inputQueueRef.current.shift()!
      try {
        await fetch("/api/terminal/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: sessionId, data }),
        })
      } catch {
        // On failure, put the data back and stop — try again next enqueue
        inputQueueRef.current.unshift(data)
        break
      }
    }
    flushingRef.current = false
  }, [sessionId])

  const sendInput = useCallback(
    (data: string) => {
      inputQueueRef.current.push(data)
      void flushInputQueue()
    },
    [flushInputQueue],
  )

  // ── SSE connection + parser lifecycle ────────────────────────────────────

  useEffect(() => {
    // Create a stable parser for this session
    const parser = new PtyChatParser(sessionId)
    parserRef.current = parser

    // Expose parser for dev-mode inspection
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__chatParser = parser
    }

    // Subscribe to parser message events — push updates to React state
    const unsubscribe = parser.onMessage(() => {
      const msgs = parser.getMessages()
      setMessages([...msgs])
      console.debug("[ChatPane] messages=%d sessionId=%s", msgs.length, sessionId)
    })

    // Open SSE stream
    const streamUrl = new URL("/api/terminal/stream", window.location.origin)
    streamUrl.searchParams.set("id", sessionId)
    if (command) streamUrl.searchParams.set("command", command)

    const es = new EventSource(streamUrl.toString())
    eventSourceRef.current = es

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string; data?: string }
        if (msg.type === "connected") {
          setConnected(true)
          console.log("[ChatPane] SSE connected sessionId=%s", sessionId)
        } else if (msg.type === "output" && msg.data) {
          parser.feed(msg.data)
        }
      } catch {
        /* malformed SSE message — ignore */
      }
    }

    es.onerror = () => {
      setConnected(false)
      console.log("[ChatPane] SSE error/disconnected sessionId=%s", sessionId)
    }

    // Cleanup on unmount — close SSE, unsubscribe parser
    return () => {
      es.close()
      eventSourceRef.current = null
      unsubscribe()
      parserRef.current = null
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window as any).__chatParser = undefined
      }
    }
  }, [sessionId, command])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={cn("flex flex-col overflow-hidden", className)}>
      {/* Message list area */}
      <div className="flex flex-1 flex-col overflow-y-auto p-6">
        {messages.length === 0 ? (
          <PlaceholderState connected={connected} />
        ) : (
          <MessageList messages={messages} />
        )}
      </div>

      {/* Input bar — functional shell; full input handling wired in T03 */}
      <ChatInputBarScaffold onSendInput={sendInput} connected={connected} />
    </div>
  )
}

/* ─── Message list (T02 raw preview — styled bubbles in T03) ─── */

interface MessageListProps {
  messages: ChatMessage[]
}

function MessageList({ messages }: MessageListProps) {
  return (
    <div className="flex flex-col gap-3">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={cn(
            "max-w-[85%] rounded-lg px-3 py-2 text-xs font-mono",
            msg.role === "user"
              ? "self-end bg-primary text-primary-foreground"
              : msg.role === "system"
                ? "self-start bg-muted text-muted-foreground italic"
                : "self-start bg-card border border-border text-foreground",
          )}
        >
          <span className="whitespace-pre-wrap">{msg.content}</span>
          {!msg.complete && (
            <span className="ml-1 animate-pulse text-muted-foreground">▊</span>
          )}
        </div>
      ))}
    </div>
  )
}

/* ─── Placeholder state ─── */

function PlaceholderState({ connected }: { connected: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
        <MessagesSquare className="h-6 w-6 text-muted-foreground/50" />
      </div>
      <div className="mt-3 space-y-1">
        <p className="text-sm font-medium text-foreground">Chat Mode</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {connected
            ? "Connected — waiting for GSD output…"
            : "Connecting to GSD session…"}
        </p>
      </div>
    </div>
  )
}

/* ─── Input bar scaffold (full wiring in T03) ─── */

interface ChatInputBarScaffoldProps {
  onSendInput: (data: string) => void
  connected: boolean
}

function ChatInputBarScaffold({ onSendInput, connected }: ChatInputBarScaffoldProps) {
  const [value, setValue] = useState("")

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && value.trim() && connected) {
      onSendInput(value + "\n")
      setValue("")
    }
  }

  return (
    <div className="flex-shrink-0 border-t border-border bg-card px-4 py-3">
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border bg-background px-3 py-2",
          connected ? "border-border" : "border-border/50 opacity-60",
        )}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
          placeholder={connected ? "Send a message… (Enter to send)" : "Connecting…"}
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground"
        />
        {!connected && (
          <span className="text-[10px] text-muted-foreground">Disconnected</span>
        )}
      </div>
    </div>
  )
}
