import { useCallback, useEffect, useMemo, useRef } from 'react'
import { SparkleIcon } from '@phosphor-icons/react'
import { Text } from '../ui/Text'
import { useSessionStore } from '@/stores/session-store'
import { buildMessageBlocks, type MessageBlock } from '@/lib/message-model'

// ---------------------------------------------------------------------------
// Empty state — shown when no messages yet
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <SparkleIcon size={32} weight="duotone" className="text-accent/50" />
        <Text className="text-text-tertiary">
          Send a prompt to start a session
        </Text>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Block renderers (plain text for now — T02/T03 upgrade these)
// ---------------------------------------------------------------------------

function AssistantTextBlock({ block }: { block: Extract<MessageBlock, { type: 'assistant-text' }> }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-[8px] bg-[#0b0b0b]/60 px-5 py-4 font-mono text-[13px] leading-6 text-[#e7d4b0]">
      {block.content}
    </pre>
  )
}

function ToolUseBlockStub({ block }: { block: Extract<MessageBlock, { type: 'tool-use' }> }) {
  return (
    <div className="flex items-center gap-2 rounded-[8px] border border-border bg-bg-secondary/40 px-4 py-2 text-[12px] text-text-tertiary">
      <span className="font-medium text-text-secondary">{block.toolName}</span>
      <span className="text-[11px]">
        {block.status === 'running' ? '⟳ running…' : block.status === 'error' ? '✕ error' : '✓ done'}
      </span>
    </div>
  )
}

function UserPromptBlock({ block }: { block: Extract<MessageBlock, { type: 'user-prompt' }> }) {
  return (
    <div className="rounded-[8px] border-l-2 border-accent/40 bg-accent/5 px-4 py-3 text-[14px] leading-6 text-text-primary">
      {block.text}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Block dispatcher
// ---------------------------------------------------------------------------

function BlockRenderer({ block }: { block: MessageBlock }) {
  switch (block.type) {
    case 'assistant-text':
      return <AssistantTextBlock block={block} />
    case 'tool-use':
      return <ToolUseBlockStub block={block} />
    case 'user-prompt':
      return <UserPromptBlock block={block} />
  }
}

// ---------------------------------------------------------------------------
// MessageStream — scrollable container with auto-scroll
// ---------------------------------------------------------------------------

export function MessageStream() {
  const events = useSessionStore((s) => s.events)
  const blocks = useMemo(() => buildMessageBlocks(events), [events])

  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 80
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  // Auto-scroll when content changes, but only if user hasn't scrolled up.
  useEffect(() => {
    if (isNearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events.length])

  if (blocks.length === 0) {
    return <EmptyState />
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-auto"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-4">
        {blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} />
        ))}
      </div>
    </div>
  )
}
