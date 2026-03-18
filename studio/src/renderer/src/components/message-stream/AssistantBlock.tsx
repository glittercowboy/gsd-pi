import { Streamdown } from 'streamdown'
import { codePlugin } from '../markdown/shiki-theme'
import { components } from '../markdown/components'
import { useSessionStore } from '@/stores/session-store'

type Props = {
  content: string
  isLastBlock: boolean
}

/**
 * Renders assistant text as styled markdown via Streamdown.
 *
 * Shiki code highlighting is handled by the code plugin.
 * Custom component overrides style all markdown elements to the dark amber
 * design system. The block caret only shows on the last block during streaming.
 */
export function AssistantBlock({ content, isLastBlock }: Props) {
  const isStreaming = useSessionStore((s) => s.isStreaming)

  return (
    <div className="prose-container">
      <Streamdown
        plugins={{ code: codePlugin }}
        components={components}
        caret="block"
        isAnimating={isStreaming && isLastBlock}
      >
        {content}
      </Streamdown>
    </div>
  )
}
