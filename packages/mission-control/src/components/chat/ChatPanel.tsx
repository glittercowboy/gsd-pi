/**
 * Chat panel container with message list and input.
 *
 * Split into ChatPanelView (pure, testable) and ChatPanel (stateful with auto-scroll).
 * Messages array and onSend callback are props -- no server coupling.
 *
 * overlay prop: when provided, dims the message list and hides ChatInput.
 * Used by discuss mode to render QuestionCard over the chat history.
 */
import { useEffect, useRef } from "react";
import type React from "react";
import { ChatMessage } from "./ChatMessage";
import { PhaseTransitionCard } from "./PhaseTransitionCard";
import { ToolUseCard } from "./ToolUseCard";
import { ChatInput } from "./ChatInput";
import { cn } from "@/lib/utils";
import type { ChatMessage as ChatMessageType } from "../../server/chat-types";

interface ChatPanelViewProps {
  messages: ChatMessageType[];
  onSend: (message: string) => void;
  isProcessing: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Optional overlay node. When present: message list dims, ChatInput is hidden. */
  overlay?: React.ReactNode;
  /** Builder mode — hides slash autocomplete, changes placeholder */
  builderMode?: boolean;
}

/** Pure render -- no hooks. Testable via direct function call. */
export function ChatPanelView({
  messages,
  onSend,
  isProcessing,
  scrollRef,
  overlay,
  builderMode = false,
}: ChatPanelViewProps) {
  return (
    <div className="flex flex-col h-full relative">
      <div
        className={cn("flex-1 overflow-y-auto", overlay && "opacity-30 pointer-events-none")}
        ref={scrollRef}
        data-testid="message-area"
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-slate-500 text-sm font-mono">
              Start a conversation with /gsd: commands
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {messages.map((msg) => {
              if (msg.role === "phase_transition") {
                return <PhaseTransitionCard key={msg.id} phase={msg.phaseTransition?.phase ?? msg.content} />;
              }
              if (msg.role === "tool_use") {
                return <ToolUseCard key={msg.id} toolName={msg.toolName ?? msg.content} toolInput={msg.toolInput} done={msg.toolDone ?? false} />;
              }
              return <ChatMessage key={msg.id} message={msg} />;
            })}
          </div>
        )}
      </div>
      {overlay ? (
        <div className="absolute inset-0 flex">
          {overlay}
        </div>
      ) : (
        <ChatInput onSend={onSend} disabled={isProcessing} builderMode={builderMode} />
      )}
    </div>
  );
}

interface ChatPanelProps {
  messages: ChatMessageType[];
  onSend: (message: string) => void;
  isProcessing: boolean;
  /** Optional overlay node forwarded to ChatPanelView (discuss mode QuestionCard). */
  overlay?: React.ReactNode;
  /** Builder mode — forwarded to ChatInput */
  builderMode?: boolean;
}

/** Stateful wrapper with auto-scroll on new messages. */
export function ChatPanel({ messages, onSend, isProcessing, overlay, builderMode = false }: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <ChatPanelView
      messages={messages}
      onSend={onSend}
      isProcessing={isProcessing}
      scrollRef={scrollRef}
      overlay={overlay}
      builderMode={builderMode}
    />
  );
}
