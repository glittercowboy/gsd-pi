"use client"

import { useEffect, useRef, useState } from "react"
import { Compass, Loader2, OctagonX, Wrench } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  getOnboardingPresentation,
  getSessionLabelFromBridge,
  getStatusPresentation,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"

interface TerminalProps {
  className?: string
}

type InputMode = "prompt" | "follow_up" | "steer"
type WidgetPlacement = "aboveEditor" | "belowEditor"

const MAX_VISIBLE_WIDGET_LINES = 6

function getInputMode(state: ReturnType<typeof useGSDWorkspaceState>): InputMode {
  const session = state.boot?.bridge.sessionState
  if (!session) return "prompt"
  if (session.isStreaming) return "follow_up"
  return "prompt"
}

function inputModePlaceholder(mode: InputMode, state: ReturnType<typeof useGSDWorkspaceState>): string {
  if (state.bootStatus === "loading") return "Loading workspace…"
  if (state.bootStatus === "error") return "Workspace boot failed — check the visible error state"
  if (state.commandInFlight) return `Sending ${state.commandInFlight}…`
  if (state.boot?.onboarding.locked) {
    return getOnboardingPresentation(state).detail
  }
  switch (mode) {
    case "steer":
      return "Type a steering message to redirect the agent…"
    case "follow_up":
      return "Agent is active — type a follow-up or /state"
    case "prompt":
      return "Type a prompt, /state, /new, or /clear"
  }
}

function inputModeLabel(mode: InputMode): string {
  switch (mode) {
    case "steer":
      return "steer"
    case "follow_up":
      return "follow-up"
    case "prompt":
      return "$"
  }
}

function getWidgetsForPlacement(
  widgetContents: Record<string, { lines: string[] | undefined; placement?: WidgetPlacement }>,
  placement: WidgetPlacement,
): Array<{ key: string; placement: WidgetPlacement; visibleLines: string[]; hiddenLineCount: number; fullText: string }> {
  return Object.entries(widgetContents)
    .filter(([, widget]) => {
      const widgetPlacement = widget.placement ?? "aboveEditor"
      return widgetPlacement === placement && Array.isArray(widget.lines) && widget.lines.length > 0
    })
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, widget]) => {
      const lines = widget.lines ?? []
      return {
        key,
        placement,
        visibleLines: lines.slice(0, MAX_VISIBLE_WIDGET_LINES),
        hiddenLineCount: Math.max(0, lines.length - MAX_VISIBLE_WIDGET_LINES),
        fullText: lines.join("\n"),
      }
    })
}

function TerminalWidgetBand({
  placement,
  widgets,
}: {
  placement: WidgetPlacement
  widgets: Array<{ key: string; placement: WidgetPlacement; visibleLines: string[]; hiddenLineCount: number; fullText: string }>
}) {
  if (widgets.length === 0) return null

  return (
    <div
      className="border-t border-border/50 bg-card/50 px-4 py-2"
      data-testid={placement === "aboveEditor" ? "terminal-widgets-above-editor" : "terminal-widgets-below-editor"}
    >
      <div className="space-y-2">
        {widgets.map((widget) => (
          <div
            key={`${widget.placement}:${widget.key}`}
            className="rounded-md border border-border bg-background/50 px-3 py-2"
            data-testid="terminal-widget"
            data-widget-key={widget.key}
            data-widget-placement={widget.placement}
            title={widget.fullText}
          >
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <span className="truncate">{widget.key}</span>
              <span>{widget.placement === "aboveEditor" ? "Above editor" : "Below editor"}</span>
            </div>
            <div className="space-y-1 text-xs text-foreground">
              {widget.visibleLines.map((line, index) => (
                <div key={`${widget.key}:${index}`} className="whitespace-pre-wrap break-words">
                  {line}
                </div>
              ))}
              {widget.hiddenLineCount > 0 && (
                <div className="text-[11px] text-muted-foreground" data-testid="terminal-widget-overflow">
                  +{widget.hiddenLineCount} more line{widget.hiddenLineCount === 1 ? "" : "s"}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Terminal({ className }: TerminalProps) {
  const workspace = useGSDWorkspaceState()
  const { submitInput, sendAbort, sendSteer, consumeEditorTextBuffer } = useGSDWorkspaceActions()
  const [input, setInput] = useState("")
  const [steerMode, setSteerMode] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const autoMode = getInputMode(workspace)
  const isStreaming = Boolean(workspace.boot?.bridge.sessionState?.isStreaming)
  const inputMode: InputMode = steerMode && isStreaming ? "steer" : autoMode
  const widgetsAboveEditor = getWidgetsForPlacement(workspace.widgetContents, "aboveEditor")
  const widgetsBelowEditor = getWidgetsForPlacement(workspace.widgetContents, "belowEditor")

  useEffect(() => {
    if (workspace.editorTextBuffer === null) return
    const buffer = workspace.editorTextBuffer
    const updateTimer = window.setTimeout(() => {
      setInput(buffer)
      consumeEditorTextBuffer()
      inputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(updateTimer)
  }, [consumeEditorTextBuffer, workspace.editorTextBuffer])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [workspace.terminalLines, workspace.streamingAssistantText, workspace.liveTranscript])

  const status = getStatusPresentation(workspace)
  const sessionLabel = getSessionLabelFromBridge(workspace.boot?.bridge)
  const isInputDisabled =
    workspace.bootStatus !== "ready" ||
    workspace.commandInFlight === "refresh" ||
    Boolean(workspace.boot?.onboarding.locked)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = input.trim()
    if (!trimmed) return

    if (inputMode === "steer") {
      await sendSteer(trimmed)
      setInput("")
      setSteerMode(false)
      return
    }

    await submitInput(trimmed)
    setInput("")
  }

  return (
    <div
      className={cn("flex flex-col bg-terminal font-mono text-sm", className)}
      onClick={() => inputRef.current?.focus()}
    >
      {/* Terminal header */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2 text-[11px] text-muted-foreground">
        <div className="min-w-0 flex items-center gap-2 truncate">
          <span data-testid="terminal-session-banner">
            {sessionLabel || "Waiting for live session…"}
          </span>
          {/* Active tool execution badge */}
          {workspace.activeToolExecution && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-foreground/15 bg-accent/60 px-2 py-0.5 text-[10px] font-medium text-foreground/80"
              data-testid="terminal-tool-badge"
            >
              <Wrench className="h-3 w-3" />
              {workspace.activeToolExecution.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Abort button */}
          {isStreaming && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation()
                void sendAbort()
              }}
              disabled={workspace.commandInFlight === "abort"}
              data-testid="terminal-abort-button"
            >
              <OctagonX className="h-3 w-3" />
              Abort
            </Button>
          )}
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              status.tone === "success"
                ? "bg-success"
                : status.tone === "warning"
                  ? "bg-warning"
                  : status.tone === "danger"
                    ? "bg-destructive"
                    : "bg-muted-foreground/60",
              status.tone === "success" && "animate-pulse",
            )}
          />
          <span>{status.label}</span>
        </div>
      </div>

      {/* Terminal lines + streaming content */}
      <div className="flex-1 overflow-y-auto p-4">
        {workspace.terminalLines.map((line) => (
          <div key={line.id} className="flex" data-testid="terminal-line">
            <span className="mr-2 select-none text-muted-foreground">{line.timestamp}</span>
            <span
              className={cn(
                "whitespace-pre-wrap",
                line.type === "input" && "text-foreground before:content-['$_'] before:text-muted-foreground",
                line.type === "output" && "text-terminal-foreground",
                line.type === "system" && "text-muted-foreground",
                line.type === "success" && "text-success",
                line.type === "error" && "text-destructive",
              )}
            >
              {line.content}
            </span>
          </div>
        ))}

        {/* Completed transcript blocks from previous turns */}
        {workspace.liveTranscript.length > 0 && (
          <div className="mt-2 space-y-2" data-testid="terminal-transcript">
            {workspace.liveTranscript.map((block, i) => (
              <div
                key={`transcript-${i}`}
                className="whitespace-pre-wrap rounded border border-border/50 bg-accent/20 px-3 py-2 text-foreground"
              >
                {block}
              </div>
            ))}
          </div>
        )}

        {/* Live streaming assistant text */}
        {workspace.streamingAssistantText && (
          <div className="mt-2" data-testid="terminal-streaming-text">
            <div className="whitespace-pre-wrap rounded border border-foreground/10 bg-foreground/[0.03] px-3 py-2 text-foreground">
              {workspace.streamingAssistantText}
              <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/60" />
            </div>
          </div>
        )}

        {/* Streaming indicator when active but no text yet */}
        {isStreaming && !workspace.streamingAssistantText && !workspace.activeToolExecution && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Agent is thinking…
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <TerminalWidgetBand placement="aboveEditor" widgets={widgetsAboveEditor} />

      {/* Input area with steer toggle */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border/50 px-4 py-2">
        {/* Steer toggle — only visible when agent is streaming */}
        {isStreaming && (
          <Button
            type="button"
            variant={steerMode ? "default" : "ghost"}
            size="sm"
            className={cn(
              "h-6 gap-1 px-2 text-[11px]",
              steerMode
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={(e) => {
              e.stopPropagation()
              setSteerMode(!steerMode)
            }}
            data-testid="terminal-steer-toggle"
          >
            <Compass className="h-3 w-3" />
            Steer
          </Button>
        )}
        <span
          className={cn(
            "text-muted-foreground",
            inputMode === "steer" && "font-semibold text-foreground",
          )}
        >
          {inputModeLabel(inputMode)}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground"
          placeholder={inputModePlaceholder(inputMode, workspace)}
          disabled={isInputDisabled}
          data-testid="terminal-command-input"
          autoFocus
        />
        {workspace.commandInFlight && (
          <span className="text-xs text-muted-foreground">{workspace.commandInFlight}…</span>
        )}
      </form>

      <TerminalWidgetBand placement="belowEditor" widgets={widgetsBelowEditor} />
    </div>
  )
}
