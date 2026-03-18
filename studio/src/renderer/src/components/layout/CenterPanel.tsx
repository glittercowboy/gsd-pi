import { useCallback, useState } from 'react'
import { Button } from '../ui/Button'
import { Text } from '../ui/Text'
import { useGsd } from '@/lib/rpc/use-gsd'
import { useSessionStore, type ConnectionStatus } from '@/stores/session-store'
import { MessageStream } from '../message-stream/MessageStream'

// ---------------------------------------------------------------------------
// Connection status badge
// ---------------------------------------------------------------------------

const statusConfig: Record<
  ConnectionStatus,
  { dotClass: string; label: string }
> = {
  disconnected: { dotClass: 'bg-text-tertiary', label: 'Disconnected' },
  connecting: { dotClass: 'bg-accent animate-pulse', label: 'Connecting…' },
  connected: { dotClass: 'bg-emerald-500', label: 'Connected' },
  error: { dotClass: 'bg-red-500', label: 'Error' }
}

function ConnectionBadge() {
  const status = useSessionStore((s) => s.connectionStatus)
  const lastError = useSessionStore((s) => s.lastError)
  const cfg = statusConfig[status]

  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-text-tertiary shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <span className={`inline-block h-2 w-2 rounded-full ${cfg.dotClass}`} />
      <span className="text-[12px] font-medium">
        {status === 'error' && lastError ? lastError : cfg.label}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CenterPanel
// ---------------------------------------------------------------------------

export function CenterPanel() {
  const { sendPrompt } = useGsd()
  const connectionStatus = useSessionStore((s) => s.connectionStatus)

  const [input, setInput] = useState('')

  const isConnected = connectionStatus === 'connected'

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || !isConnected) return
    sendPrompt(trimmed)
    setInput('')
  }, [input, isConnected, sendPrompt])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <section className="flex h-full min-h-0 flex-col border-t border-border bg-[radial-gradient(circle_at_top,rgba(212,160,78,0.09),transparent_32%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Text as="h2" preset="subheading">
            Conversation
          </Text>
        </div>
        <ConnectionBadge />
      </div>

      {/* Message stream */}
      <div className="min-h-0 flex-1 overflow-hidden border-t border-border">
        <MessageStream />
      </div>

      {/* Composer */}
      <div className="border-t border-border px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-3 rounded-[8px] border border-border bg-bg-primary/90 p-3 shadow-[0_12px_24px_rgba(0,0,0,0.22)]">
            <label className="flex-1 rounded-[6px] transition-shadow duration-150 focus-within:shadow-[0_0_0_2px_rgba(212,160,78,0.35)]">
              <span className="sr-only">Prompt</span>
              <textarea
                className="min-h-24 w-full resize-none border-0 bg-transparent px-3 py-2 font-sans text-[14px] leading-6 text-text-primary outline-none ring-0 placeholder:text-text-tertiary focus-visible:outline-none disabled:opacity-50"
                disabled={!isConnected}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isConnected
                    ? 'Ask gsd-2 to reason, plan, or execute…'
                    : 'Waiting for connection…'
                }
                value={input}
              />
            </label>
            <Button
              className="rounded-[8px] px-4"
              disabled={!isConnected || !input.trim()}
              onClick={handleSend}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
