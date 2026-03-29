"use client"

import Image from "next/image"
import { useEffect, useRef, useCallback, useState, useMemo, KeyboardEvent, DragEvent, ClipboardEvent } from "react"
import { MessagesSquare, SendHorizonal, Check, Eye, EyeOff, Play, Loader2, Milestone, X, MessageCircle, FileEdit, FilePlus, Terminal, ChevronDown, ChevronRight, MoreHorizontal, Zap, Square, Pause, BarChart3, LayoutGrid, ListOrdered, History, Compass, PenLine, Inbox, SkipForward, Undo2, BookOpen, Settings, SlidersHorizontal, Stethoscope, FileOutput, Trash2, Globe, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { ChatMessage, TuiPrompt } from "@/lib/pty-chat-parser"
import { PendingImage, processImageFile, generateImageId, MAX_PENDING_IMAGES } from "@/lib/image-utils"
import {
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
  buildPromptCommand,
  type CompletedToolExecution,
  type ActiveToolExecution,
  type PendingUiRequest,
  type TurnSegment,
} from "@/lib/gsd-workspace-store"
import { deriveWorkflowAction } from "@/lib/workflow-actions"
import { useTerminalFontSize } from "@/lib/use-terminal-font-size"

/* ─── ActionPanel types ─── */

// ActionPanelConfig removed — all commands now route through the main bridge.

/* ─── GSD Action Definitions ─── */

/**
 * Defines every /gsd subcommand available in the chat input bar.
 * Top 3 are shown as standalone buttons; the rest live in the overflow menu.
 * All commands dispatch through the main bridge session.
 */
interface GSDActionDef {
  label: string
  command: string
  icon: LucideIcon
  description: string
  category: "workflow" | "visibility" | "correction" | "knowledge" | "config" | "maintenance"
  /** When true, this command is disabled while auto-mode is active (injects competing LLM prompt) */
  disabledDuringAuto?: boolean
}

const GSD_ACTIONS: GSDActionDef[] = [
  // ── Top 3 (standalone buttons) ──
  { label: "Discuss",   command: "/gsd discuss",   icon: MessageCircle,     description: "Start guided milestone/slice discussion",                    category: "workflow",    disabledDuringAuto: true },
  { label: "Next",      command: "/gsd next",      icon: Play,              description: "Execute next task, then pause",                              category: "workflow" },
  { label: "Auto",      command: "/gsd auto",      icon: Zap,               description: "Run all queued units continuously",                         category: "workflow" },
  // ── Overflow: Workflow ──
  { label: "Stop",      command: "/gsd stop",      icon: Square,            description: "Stop auto-mode gracefully",                                  category: "workflow" },
  { label: "Pause",     command: "/gsd pause",     icon: Pause,             description: "Pause auto-mode (preserves state)",                          category: "workflow" },
  // ── Overflow: Visibility ──
  { label: "Status",    command: "/gsd status",    icon: BarChart3,         description: "Show progress dashboard",                                    category: "visibility" },
  { label: "Visualize", command: "/gsd visualize", icon: LayoutGrid,        description: "Interactive TUI (progress, deps, metrics, timeline)",        category: "visibility" },
  { label: "Queue",     command: "/gsd queue",     icon: ListOrdered,       description: "Show queued/dispatched units and execution order",            category: "visibility" },
  { label: "History",   command: "/gsd history",   icon: History,           description: "View execution history with cost/phase/model details",        category: "visibility" },
  // ── Overflow: Course correction ──
  { label: "Steer",     command: "/gsd steer",     icon: Compass,           description: "Apply user override to active work",                         category: "correction" },
  { label: "Capture",   command: "/gsd capture",   icon: PenLine,           description: "Quick-capture a thought to CAPTURES.md",                     category: "correction" },
  { label: "Triage",    command: "/gsd triage",    icon: Inbox,             description: "Classify and route pending captures",                        category: "correction",  disabledDuringAuto: true },
  { label: "Skip",      command: "/gsd skip",      icon: SkipForward,       description: "Prevent a unit from auto-mode dispatch",                     category: "correction" },
  { label: "Undo",      command: "/gsd undo",      icon: Undo2,             description: "Revert last completed unit",                                 category: "correction" },
  // ── Overflow: Knowledge ──
  { label: "Knowledge", command: "/gsd knowledge", icon: BookOpen,          description: "Add rule, pattern, or lesson to KNOWLEDGE.md",               category: "knowledge" },
  // ── Overflow: Configuration ──
  { label: "Mode",      command: "/gsd mode",      icon: SlidersHorizontal, description: "Set workflow mode (solo/team)",                               category: "config" },
  { label: "Prefs",     command: "/gsd prefs",     icon: Settings,          description: "Manage preferences (global/project)",                        category: "config" },
  // ── Overflow: Maintenance ──
  { label: "Doctor",    command: "/gsd doctor",    icon: Stethoscope,       description: "Diagnose and repair .gsd/ state",                            category: "maintenance" },
  { label: "Export",    command: "/gsd export",    icon: FileOutput,        description: "Export milestone/slice results (JSON or Markdown)",           category: "maintenance" },
  { label: "Cleanup",   command: "/gsd cleanup",   icon: Trash2,            description: "Remove merged branches or snapshots",                        category: "maintenance" },
  { label: "Remote",    command: "/gsd remote",    icon: Globe,             description: "Control remote auto-mode (Slack/Discord)",                    category: "maintenance" },
]

/** Top 3 shown as standalone buttons next to chat input */
const TOP_ACTIONS = GSD_ACTIONS.slice(0, 3)
/** Remaining actions in the overflow menu */
const OVERFLOW_ACTIONS = GSD_ACTIONS.slice(3)

const CATEGORY_LABELS: Record<GSDActionDef["category"], string> = {
  workflow: "Workflow",
  visibility: "Visibility",
  correction: "Course Correction",
  knowledge: "Knowledge",
  config: "Configuration",
  maintenance: "Maintenance",
}

function groupByCategory(actions: GSDActionDef[]): Array<{ category: GSDActionDef["category"]; label: string; items: GSDActionDef[] }> {
  const seen = new Map<GSDActionDef["category"], GSDActionDef[]>()
  for (const a of actions) {
    let group = seen.get(a.category)
    if (!group) {
      group = []
      seen.set(a.category, group)
    }
    group.push(a)
  }
  return Array.from(seen.entries()).map(([cat, items]) => ({ category: cat, label: CATEGORY_LABELS[cat], items }))
}

/**
 * ChatMode — main view for the Chat tab.
 *
 * All /gsd commands dispatch through the main bridge session.
 * Commands that inject competing LLM prompts (discuss, triage)
 * are disabled while auto-mode is active.
 *
 * Observability:
 *   - This component mounts only when activeView === "chat" (no hidden pre-init).
 *   - sessionStorage key "gsd-active-view:<cwd>" equals "chat" when this view is active.
 *   - Header toolbar: data-testid="chat-mode-action-bar" confirms toolbar rendered.
 *   - Primary button: data-testid="chat-primary-action" reflects current workflowAction label.
 *   - Secondary buttons: data-testid="chat-secondary-action-{command}".
 */
export function ChatMode({ className }: { className?: string }) {
  const state = useGSDWorkspaceState()
  const { sendCommand } = useGSDWorkspaceActions()

  const bridge = state.boot?.bridge ?? null

  const handleAction = useCallback(
    (command: string) => {
      void sendCommand(buildPromptCommand(command, bridge))
    },
    [sendCommand, bridge],
  )

  return (
    <div className={cn("flex h-full flex-col overflow-hidden bg-background", className)}>
      {/* ── Header bar ── */}
      <ChatModeHeader
        onPrimaryAction={handleAction}
        onSecondaryAction={handleAction}
      />

      {/* ── Main chat pane ── */}
      <ChatPane
        sessionId="gsd-main"
        command="gsd"
        className="flex-1"
        onOpenAction={(action) => handleAction(action.command)}
      />
    </div>
  )
}

/* ─── Header ─── */

interface ChatModeHeaderProps {
  onPrimaryAction: (command: string) => void
  onSecondaryAction: (command: string) => void
}

/**
 * ChatModeHeader — action toolbar for Chat Mode.
 *
 * Single-row layout matching the Power User Mode header: title + badge left-aligned,
 * workflow action buttons immediately to the right (no second row).
 *
 * Observability:
 *   - data-testid="chat-mode-action-bar" on the workflow button row
 *   - data-testid="chat-primary-action" on the primary button
 *   - data-testid="chat-secondary-action-{command}" on each secondary button
 */
function ChatModeHeader({ onPrimaryAction, onSecondaryAction }: ChatModeHeaderProps) {
  const state = useGSDWorkspaceState()

  const boot = state.boot
  const workspace = boot?.workspace ?? null
  const auto = boot?.auto ?? null

  const workflowAction = deriveWorkflowAction({
    phase: workspace?.active.phase ?? "pre-planning",
    autoActive: auto?.active ?? false,
    autoPaused: auto?.paused ?? false,
    onboardingLocked: boot?.onboarding.locked ?? false,
    commandInFlight: state.commandInFlight,
    bootStatus: state.bootStatus,
    hasMilestones: (workspace?.milestones.length ?? 0) > 0,
    projectDetectionKind: boot?.projectDetection?.kind ?? null,
  })

  const handlePrimary = () => {
    if (!workflowAction.primary) return
    onPrimaryAction(workflowAction.primary.command)
  }

  // Derive a short GSD state badge label
  const stateBadge = (() => {
    if (state.bootStatus !== "ready") return state.bootStatus
    const phase = workspace?.active.phase
    if (!phase) return "idle"
    if (auto?.active && !auto?.paused) return "auto"
    if (auto?.paused) return "paused"
    return phase
  })()

  return (
    <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
      {/* Left: title + state badge */}
      <div className="flex items-center gap-2">
        <MessagesSquare className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">Chat Mode</span>
        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          {stateBadge}
        </span>
      </div>

      {/* Right: workflow action buttons */}
      <div className="flex items-center gap-2" data-testid="chat-mode-action-bar">
          {workflowAction.primary && (
            <button
              data-testid="chat-primary-action"
              onClick={handlePrimary}
              disabled={workflowAction.disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
                workflowAction.primary.variant === "destructive"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
                workflowAction.disabled && "cursor-not-allowed opacity-50",
              )}
              title={workflowAction.disabledReason}
            >
              {state.commandInFlight ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : workflowAction.isNewMilestone ? (
                <Milestone className="h-3 w-3" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {workflowAction.primary.label}
            </button>
          )}
          {workflowAction.secondaries.map((action) => (
            <button
              key={action.command}
              data-testid={`chat-secondary-action-${action.command}`}
              onClick={() => onSecondaryAction(action.command)}
              disabled={workflowAction.disabled}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium transition-colors hover:bg-accent",
                workflowAction.disabled && "cursor-not-allowed opacity-50",
              )}
              title={workflowAction.disabledReason}
            >
              {action.label}
            </button>
          ))}
          {state.commandInFlight && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
            </span>
          )}
        </div>
    </div>
  )
}


type ShikiHighlighter = {
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string
}

let chatHighlighterPromise: Promise<ShikiHighlighter> | null = null

function getChatHighlighter(): Promise<ShikiHighlighter> {
  if (!chatHighlighterPromise) {
    chatHighlighterPromise = import("shiki")
      .then((mod) =>
        mod.createHighlighter({
          themes: ["github-dark-default", "github-light-default"],
          langs: [
            "typescript", "tsx", "javascript", "jsx",
            "json", "jsonc", "markdown", "mdx",
            "css", "scss", "less", "html", "xml",
            "yaml", "toml", "bash", "python", "ruby",
            "rust", "go", "java", "kotlin", "swift",
            "c", "cpp", "csharp", "php", "sql",
            "graphql", "dockerfile", "makefile",
            "lua", "diff", "ini", "dotenv",
          ],
        }),
      )
      .catch((err) => {
        chatHighlighterPromise = null
        throw err
      })
  }
  return chatHighlighterPromise
}

/* ─── Markdown renderer for assistant bubbles ─── */

/**
 * Renders markdown content using react-markdown + remark-gfm + shiki code blocks.
 * Dynamic imports keep the main bundle lean.
 * Falls back to plain text if modules fail to load.
 *
 * Observability:
 *   - console.debug("[ChatBubble] markdown modules loaded") fires once on first render
 */
function MarkdownContent({ content }: { content: string }) {
  const [rendered, setRendered] = useState<React.ReactNode | null>(null)
  const [ready, setReady] = useState(false)
  const isDark = useIsDark()

  useEffect(() => {
    let cancelled = false

    Promise.all([
      import("react-markdown"),
      import("remark-gfm"),
      getChatHighlighter(),
    ])
      .then(([ReactMarkdownMod, remarkGfmMod, highlighter]) => {
        if (cancelled) return
        console.debug("[ChatBubble] markdown modules loaded")

        const ReactMarkdown = ReactMarkdownMod.default
        const remarkGfm = remarkGfmMod.default

        const shikiTheme = isDark ? "github-dark-default" : "github-light-default"

        const buildComponents = (h: typeof highlighter) => ({
          code({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
            const match = /language-(\w+)/.exec(className || "")
            const codeStr = String(children).replace(/\n$/, "")

            if (match) {
              try {
                const highlighted = h.codeToHtml(codeStr, {
                  lang: match[1],
                  theme: shikiTheme,
                })
                return (
                  <div
                    className="chat-code-block my-3 rounded-xl overflow-x-auto text-sm shadow-sm border border-border/50"
                    dangerouslySetInnerHTML={{ __html: highlighted }}
                  />
                )
              } catch { /* unsupported language — fall through */ }
            }

            const isInline = !className && !String(children).includes("\n")
            if (isInline) {
              return (
                <code
                  className="rounded-md bg-muted px-1.5 py-0.5 text-[0.85em] font-mono text-foreground"
                  {...props}
                >
                  {children}
                </code>
              )
            }

            return (
              <pre className={cn("my-3 overflow-x-auto rounded-xl p-4 text-sm border border-border/50", isDark ? "bg-[#0d1117]" : "bg-[#f6f8fa]")}>
                <code className="font-mono">{children}</code>
              </pre>
            )
          },
          pre({ children }: { children?: React.ReactNode }) {
            return <>{children}</>
          },
          table({ children }: { children?: React.ReactNode }) {
            return (
              <div className="my-4 overflow-x-auto rounded-lg border border-border">
                <table className="min-w-full border-collapse text-sm">{children}</table>
              </div>
            )
          },
          th({ children }: { children?: React.ReactNode }) {
            return (
              <th className="border-b border-border bg-muted/50 px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {children}
              </th>
            )
          },
          td({ children }: { children?: React.ReactNode }) {
            return (
              <td className="border-b border-border/50 px-3 py-2 text-sm last:border-0">
                {children}
              </td>
            )
          },
          a({ href, children }: { href?: string; children?: React.ReactNode }) {
            return (
              <a
                href={href}
                className="text-info underline underline-offset-2 hover:text-info transition-colors"
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            )
          },
          h1({ children }: { children?: React.ReactNode }) {
            return <h1 className="mt-4 mb-2 text-base font-semibold text-foreground first:mt-0">{children}</h1>
          },
          h2({ children }: { children?: React.ReactNode }) {
            return <h2 className="mt-3 mb-1.5 text-sm font-semibold text-foreground first:mt-0">{children}</h2>
          },
          h3({ children }: { children?: React.ReactNode }) {
            return <h3 className="mt-2 mb-1 text-sm font-medium text-foreground first:mt-0">{children}</h3>
          },
          ul({ children }: { children?: React.ReactNode }) {
            return <ul className="my-2 ml-4 list-disc space-y-0.5 text-sm [&>li]:text-foreground">{children}</ul>
          },
          ol({ children }: { children?: React.ReactNode }) {
            return <ol className="my-2 ml-4 list-decimal space-y-0.5 text-sm [&>li]:text-foreground">{children}</ol>
          },
          blockquote({ children }: { children?: React.ReactNode }) {
            return <blockquote className="my-3 border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground italic">{children}</blockquote>
          },
          hr() {
            return <hr className="my-4 border-border/50" />
          },
          p({ children }: { children?: React.ReactNode }) {
            return <p className="mb-2 text-sm leading-relaxed last:mb-0 text-foreground">{children}</p>
          },
          img({ alt, src }: { alt?: string; src?: string }) {
            return (
              <span className="my-2 block rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground italic">
                🖼 {alt || src || "image"}
              </span>
            )
          },
        })

        setRendered(
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildComponents(highlighter) as import("react-markdown").Components}>
            {content}
          </ReactMarkdown>,
        )
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setReady(true)
      })

    return () => { cancelled = true }
   
  }, [content, isDark]) // re-render when content changes (streaming) or theme toggles

  if (!ready) {
    // Plain text fallback while modules load
    return (
      <span className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {content}
      </span>
    )
  }

  if (!rendered) {
    return (
      <span className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {content}
      </span>
    )
  }

  return <div className="chat-markdown min-w-0">{rendered}</div>
}

/* ─── TuiSelectPrompt ─── */

/**
 * Renders a GSD arrow-key select prompt as a native clickable list.
 *
 * Clicking an option calculates the arrow-key delta from the current
 * PTY-tracked selection, sends that many \x1b[A/\x1b[B + \r to the PTY,
 * and transitions to a static post-submission state.
 *
 * Observability:
 *   - Logs "[TuiSelectPrompt] mounted kind=select label=%s" on mount
 *   - Logs "[TuiSelectPrompt] submit delta=%d keystrokes=%j" on submit
 *   - data-testid="tui-select-prompt" on container
 *   - data-testid="tui-select-option-{i}" on each option button
 *   - data-testid="tui-prompt-submitted" on post-submission element
 */
function TuiSelectPrompt({
  prompt,
  onSubmit,
}: {
  prompt: TuiPrompt
  onSubmit: (data: string) => void
}) {
  const [localIndex, setLocalIndex] = useState(prompt.selectedIndex ?? 0)
  const [submitted, setSubmitted] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    console.log("[TuiSelectPrompt] mounted kind=select label=%s", prompt.label)
    // Auto-focus the container so keyboard events are captured immediately
    containerRef.current?.focus()
  }, [prompt.label])

  const submitIndex = useCallback(
    (clickedIndex: number) => {
      const delta = clickedIndex - localIndex
      let keystrokes = ""
      if (delta > 0) {
        keystrokes = "\x1b[B".repeat(delta)
      } else if (delta < 0) {
        keystrokes = "\x1b[A".repeat(Math.abs(delta))
      }
      keystrokes += "\r"

      console.log(
        "[TuiSelectPrompt] submit delta=%d keystrokes=%j",
        delta,
        keystrokes,
      )

      setLocalIndex(clickedIndex)
      setSubmitted(true)
      onSubmit(keystrokes)
    },
    [localIndex, onSubmit],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (submitted) return
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setLocalIndex((i) => Math.max(0, i - 1))
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        setLocalIndex((i) => Math.min(prompt.options.length - 1, i + 1))
      } else if (e.key === "Enter") {
        e.preventDefault()
        submitIndex(localIndex)
      }
    },
    [submitted, localIndex, prompt.options.length, submitIndex],
  )

  if (submitted) {
    const selectedLabel = prompt.options[localIndex] ?? ""
    return (
      <div
        data-testid="tui-prompt-submitted"
        className="mt-2 flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary"
      >
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">{selectedLabel}</span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-testid="tui-select-prompt"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="mt-2 rounded-xl border border-border bg-background p-1.5 shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-border"
      aria-label={`Select: ${prompt.label}`}
      role="listbox"
      aria-activedescendant={`tui-select-option-${localIndex}`}
    >
      {prompt.label && (
        <p className="mb-1.5 px-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {prompt.label}
        </p>
      )}
      {prompt.options.map((option, i) => {
        const isSelected = i === localIndex
        const description = prompt.descriptions?.[i]
        return (
          <button
            key={i}
            id={`tui-select-option-${i}`}
            data-testid={`tui-select-option-${i}`}
            role="option"
            aria-selected={isSelected}
            onClick={() => submitIndex(i)}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors",
              isSelected
                ? "bg-primary/15 text-primary font-medium"
                : "text-foreground hover:bg-muted",
            )}
          >
            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {isSelected ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block">{option}</span>
              {description && (
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {description}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ─── TuiTextPrompt ─── */

/**
 * Renders a GSD text prompt as a native labeled input field.
 *
 * Submitting sends the typed value + "\r" to the PTY (carriage return = Enter).
 * After submission shows a static "✓ Submitted" confirmation (value not echoed).
 *
 * Observability:
 *   - Logs "[TuiTextPrompt] mounted kind=text label=%s" on mount
 *   - Logs "[TuiTextPrompt] submitted label=%s" on submit
 *   - data-testid="tui-text-prompt" on container
 *   - data-testid="tui-prompt-submitted" on post-submission element
 */
function TuiTextPrompt({
  prompt,
  onSubmit,
}: {
  prompt: TuiPrompt
  onSubmit: (data: string) => void
}) {
  const [value, setValue] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    console.log("[TuiTextPrompt] mounted kind=text label=%s", prompt.label)
    inputRef.current?.focus()
  }, [prompt.label])

  const handleSubmit = useCallback(() => {
    if (submitted) return
    console.log("[TuiTextPrompt] submitted label=%s", prompt.label)
    setSubmitted(true)
    onSubmit(value + "\r")
  }, [submitted, value, prompt.label, onSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit],
  )

  if (submitted) {
    return (
      <div
        data-testid="tui-prompt-submitted"
        className="mt-2 flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary"
      >
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">✓ Submitted</span>
      </div>
    )
  }

  return (
    <div
      data-testid="tui-text-prompt"
      className="mt-2 rounded-xl border border-border bg-background p-3 shadow-sm"
    >
      {prompt.label && (
        <p className="mb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {prompt.label}
        </p>
      )}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your answer…"
          className="flex-1 h-8 text-sm"
          aria-label={prompt.label || "Text input"}
        />
        <button
          onClick={handleSubmit}
          disabled={!value.trim()}
          className={cn(
            "flex h-8 items-center justify-center rounded-lg px-3 text-xs font-medium transition-all",
            value.trim()
              ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 shadow-sm"
              : "bg-muted text-muted-foreground cursor-not-allowed",
          )}
        >
          Submit
        </button>
      </div>
    </div>
  )
}

/* ─── TuiPasswordPrompt ─── */

/**
 * Renders a GSD password/API-key prompt as a native masked input field.
 *
 * Submitting sends the typed value + "\r" to the PTY.
 * The entered value is NEVER shown in the DOM, logs, or post-submission text.
 * After submission shows "{label} — entered ✓" with no value echo.
 *
 * Observability:
 *   - Logs "[TuiPasswordPrompt] mounted kind=password label=%s" on mount
 *   - Logs "[TuiPasswordPrompt] submitted label=%s" on submit (value not logged)
 *   - data-testid="tui-password-prompt" on container
 *   - data-testid="tui-prompt-submitted" on post-submission element
 */
function TuiPasswordPrompt({
  prompt,
  onSubmit,
}: {
  prompt: TuiPrompt
  onSubmit: (data: string) => void
}) {
  const [value, setValue] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    console.log("[TuiPasswordPrompt] mounted kind=password label=%s", prompt.label)
    inputRef.current?.focus()
  }, [prompt.label])

  const handleSubmit = useCallback(() => {
    if (submitted) return
    // Value intentionally not logged — redaction constraint
    console.log("[TuiPasswordPrompt] submitted label=%s", prompt.label)
    setSubmitted(true)
    onSubmit(value + "\r")
  }, [submitted, value, prompt.label, onSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit],
  )

  if (submitted) {
    const displayLabel = prompt.label || "Value"
    return (
      <div
        data-testid="tui-prompt-submitted"
        className="mt-2 flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary"
      >
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">{displayLabel} — entered ✓</span>
      </div>
    )
  }

  return (
    <div
      data-testid="tui-password-prompt"
      className="mt-2 rounded-xl border border-border bg-background p-3 shadow-sm"
    >
      {prompt.label && (
        <p className="mb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {prompt.label}
        </p>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            ref={inputRef}
            type={showPassword ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter value…"
            className="h-8 pr-9 text-sm"
            aria-label={prompt.label || "Password input"}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            tabIndex={-1}
            aria-label={showPassword ? "Hide input" : "Show input"}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground transition-colors"
          >
            {showPassword ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <button
          onClick={handleSubmit}
          disabled={!value}
          className={cn(
            "flex h-8 items-center justify-center rounded-lg px-3 text-xs font-medium transition-all",
            value
              ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 shadow-sm"
              : "bg-muted text-muted-foreground cursor-not-allowed",
          )}
        >
          Submit
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        Value is transmitted securely and not stored in chat history.
      </p>
    </div>
  )
}

/* ─── StreamingCursor ─── */

function StreamingCursor() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-3.5 w-0.5 translate-y-0.5 rounded-full bg-current opacity-70"
      style={{ animation: "chat-cursor 1s ease-in-out infinite" }}
    />
  )
}


function createLocalMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/* ─── Theme detection hook ─── */

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  )
  useEffect(() => {
    if (typeof document === "undefined") return
    const el = document.documentElement
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains("dark"))
    })
    observer.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return isDark
}

/* ─── PlatformLogoIcon ─── */

/**
 * Renders the platform logo icon, dynamically switching between
 * light and dark variants based on the current theme.
 */
function PlatformLogoIcon({ className }: { className?: string }) {
  const isDark = useIsDark()
  return (
    <Image
      src={isDark ? "/logo-icon-white.svg" : "/logo-icon-black.svg"}
      alt=""
      width={24}
      height={32}
      unoptimized
      className={cn("h-4 w-auto", className)}
    />
  )
}

/* ─── InlineThinking ─── */

/**
 * Thinking indicator rendered inline inside an assistant bubble.
 * Shows a collapsible preview of the LLM's reasoning with a visible,
 * well-styled block that shows more context lines.
 */
function InlineThinking({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lines = content.split("\n").filter((l) => l.trim())
  const previewLines = lines.slice(-5)
  const hasMore = lines.length > 5

  // Auto-scroll the expanded view to the bottom when streaming
  useEffect(() => {
    if (expanded && isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [expanded, isStreaming, content])

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          "group w-full rounded-xl border px-3.5 py-2.5 text-left transition-all",
          "border-border/50 bg-muted/50 hover:bg-muted/50",
        )}
      >
        {/* Header row */}
        <div className="flex items-center gap-2">
          {isStreaming ? (
            <span className="relative flex h-2 w-2 flex-shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground/30" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground/50" />
            </span>
          ) : (
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded bg-muted-foreground/10">
              <span className="text-[9px] text-muted-foreground">💭</span>
            </span>
          )}
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {isStreaming ? "Thinking…" : "Thought process"}
          </span>
          {hasMore && !expanded && (
            <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {lines.length} lines
            </span>
          )}
          <span className="ml-auto flex-shrink-0">
            {expanded
              ? <ChevronDown className="h-3 w-3 text-muted-foreground transition-transform" />
              : <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-hover:text-muted-foreground" />
            }
          </span>
        </div>

        {/* Collapsed preview — show 5 lines */}
        {!expanded && (
          <div className="mt-2 space-y-0.5 border-l-2 border-muted-foreground/10 pl-3">
            {previewLines.map((line, i) => (
              <p key={i} className="text-[12px] leading-relaxed text-muted-foreground line-clamp-1">
                {line}
              </p>
            ))}
            {isStreaming && <StreamingCursor />}
          </div>
        )}

        {/* Expanded view — scrollable with more space */}
        {expanded && (
          <div
            ref={scrollRef}
            className="mt-2 max-h-[400px] overflow-y-auto overscroll-contain rounded-lg border border-border/50 bg-background/50 p-3 text-[12px] leading-[1.7] text-muted-foreground whitespace-pre-wrap scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
          >
            {content}
            {isStreaming && <StreamingCursor />}
          </div>
        )}
      </button>
    </div>
  )
}

/* ─── ChatBubble ─── */

/**
 * Renders a single ChatMessage as a styled bubble.
 *
 * - assistant: left-aligned bubble with full markdown rendering + syntax-highlighted code blocks
 * - user: right-aligned outgoing bubble with plain text
 * - system: small centered muted line (no bubble chrome)
 * - incomplete messages show an animated streaming cursor
 * - when message.prompt.kind === 'select', TuiSelectPrompt renders below content
 */
function ChatBubble({
  message,
  onSubmitPrompt,
  isThinking,
}: {
  message: ChatMessage
  onSubmitPrompt?: (data: string) => void
  isThinking?: boolean
}) {
  if (message.role === "system") {
    return (
      <div className="flex items-center justify-center py-1">
        <span className="text-[11px] text-muted-foreground italic px-3">
          {message.content}
        </span>
      </div>
    )
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[72%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow-sm">
          {message.images && message.images.length > 0 && (
            <div className="flex gap-1.5 mb-2 flex-wrap">
              {message.images.map((img, idx) => (
                <Image
                  key={idx}
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={`Attached image ${idx + 1}`}
                  width={32}
                  height={32}
                  unoptimized
                  className="h-8 w-8 rounded object-cover border border-primary-foreground/20"
                />
              ))}
            </div>
          )}
          <span className="whitespace-pre-wrap leading-relaxed">{message.content}</span>
          {!message.complete && <StreamingCursor />}
        </div>
      </div>
    )
  }

  // assistant
  const hasSelectPrompt =
    message.prompt?.kind === "select" &&
    !message.complete &&
    onSubmitPrompt != null

  const hasTextPrompt =
    message.prompt?.kind === "text" &&
    !message.complete &&
    onSubmitPrompt != null

  const hasPasswordPrompt =
    message.prompt?.kind === "password" &&
    !message.complete &&
    onSubmitPrompt != null

  const hasAnyPrompt = hasSelectPrompt || hasTextPrompt || hasPasswordPrompt

  return (
    <div className="flex justify-start gap-3">
      <div className="mt-1 flex-shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-card border border-border">
        <PlatformLogoIcon className="h-3.5 w-auto" />
      </div>
      <div className="max-w-[82%] min-w-0 rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3 shadow-sm">
        {/* Minimal waiting indicator — shown when streaming starts but no content yet */}
        {isThinking && !message.content && (
          <div className="flex items-center gap-2 py-1">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground/30" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground/50" />
            </span>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Thinking…
            </span>
          </div>
        )}
        {message.content && <MarkdownContent content={message.content} />}
        {!message.complete && !hasAnyPrompt && <StreamingCursor />}
        {hasSelectPrompt && (
          <TuiSelectPrompt
            prompt={message.prompt!}
            onSubmit={onSubmitPrompt!}
          />
        )}
        {hasTextPrompt && (
          <TuiTextPrompt
            prompt={message.prompt!}
            onSubmit={onSubmitPrompt!}
          />
        )}
        {hasPasswordPrompt && (
          <TuiPasswordPrompt
            prompt={message.prompt!}
            onSubmit={onSubmitPrompt!}
          />
        )}
      </div>
    </div>
  )
}

/* ─── ChatMessageList ─── */

/**
 * Renders ChatMessage[] as a scrollable list of ChatBubble components.
 *
 * Scroll behavior:
 *   - Auto-scrolls to bottom on new messages ONLY when the user is within 100px of bottom
 *   - If the user has scrolled up to read history, auto-scroll is suppressed
 */
function ChatMessageList({
  messages,
  onSubmitPrompt,
  fontSize,
}: {
  messages: ChatMessage[]
  onSubmitPrompt: (data: string) => void
  fontSize?: number
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const prevMessageCountRef = useRef(messages.length)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isNearBottomRef.current = distanceFromBottom < 100
  }, [])

  // Scroll to bottom on new messages (if user is near bottom)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const isNewMessage = messages.length !== prevMessageCountRef.current
    prevMessageCountRef.current = messages.length

    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }

    // If a new message arrives while scrolled up, still update the count but don't scroll
    void isNewMessage
  }, [messages])

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
      style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
    >
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} onSubmitPrompt={onSubmitPrompt} />
      ))}
      {/* Bottom spacer for scroll anchor */}
      <div className="h-2" />
    </div>
  )
}

/* ─── ChatInputBar ─── */

/**
 * Text input bar at the bottom of ChatPane.
 *
 * - Enter: send input + "\r" and clear
 * - Shift+Enter: insert newline (multiline)
 * - Disabled when disconnected; shows "Disconnected" badge
 * - Send button visible when input has content and connected
 * - Top 3 action buttons (Discuss, Next, Auto) shown standalone
 * - Overflow menu (⋯) contains all remaining /gsd subcommands grouped by category
 * - Every action has a tooltip with description on hover
 */
function ChatInputBar({
  onSendInput,
  connected,
  onOpenAction,
}: {
  onSendInput: (data: string, images?: PendingImage[]) => void
  connected: boolean
  onOpenAction?: (action: GSDActionDef) => void
}) {
  const autoActive = useGSDWorkspaceState().boot?.auto?.active ?? false
  const [value, setValue] = useState("")
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [imageNotice, setImageNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragCounterRef = useRef(0)

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addImages = useCallback(async (files: File[]) => {
    setImageNotice(null)

    const imageFiles = files.filter((f) => f.type.startsWith("image/"))
    if (imageFiles.length === 0) return

    setPendingImages((prev) => {
      const remaining = MAX_PENDING_IMAGES - prev.length
      if (remaining <= 0) {
        setImageNotice(`Maximum ${MAX_PENDING_IMAGES} images per message`)
        return prev
      }
      return prev // return current, processing happens below
    })

    // Process files outside setState to handle async
    const currentCount = pendingImages.length
    const toProcess = imageFiles.slice(0, MAX_PENDING_IMAGES - currentCount)

    if (toProcess.length < imageFiles.length) {
      setImageNotice(`Maximum ${MAX_PENDING_IMAGES} images per message`)
    }

    const newImages: PendingImage[] = []
    for (const file of toProcess) {
      try {
        const result = await processImageFile(file)
        const previewUrl = URL.createObjectURL(file)
        newImages.push({
          id: generateImageId(),
          data: result.data,
          mimeType: result.mimeType,
          previewUrl,
        })
      } catch (err) {
        console.warn("[chat-input] image processing failed:", err instanceof Error ? err.message : err)
        setImageNotice(err instanceof Error ? err.message : "Failed to process image")
      }
    }

    if (newImages.length > 0) {
      setPendingImages((prev) => {
        const combined = [...prev, ...newImages]
        if (combined.length > MAX_PENDING_IMAGES) {
          // Revoke excess
          combined.slice(MAX_PENDING_IMAGES).forEach((img) => URL.revokeObjectURL(img.previewUrl))
          setImageNotice(`Maximum ${MAX_PENDING_IMAGES} images per message`)
          return combined.slice(0, MAX_PENDING_IMAGES)
        }
        return combined
      })
    }
  }, [pendingImages.length])

  const removeImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const removed = prev.find((img) => img.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((img) => img.id !== id)
    })
    setImageNotice(null)
  }, [])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    dragCounterRef.current = 0
    const files = Array.from(e.dataTransfer.files)
    void addImages(files)
  }, [addImages])

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current -= 1
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }, [])

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.files
    if (items && items.length > 0) {
      const imageFiles = Array.from(items).filter((f) => f.type.startsWith("image/"))
      if (imageFiles.length > 0) {
        e.preventDefault()
        void addImages(imageFiles)
      }
      // If no image files in clipboard, let normal text paste proceed (no-regression)
    }
  }, [addImages])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed && pendingImages.length === 0) return
    if (!connected) return
    onSendInput(value + "\r", pendingImages.length > 0 ? pendingImages : undefined)
    setValue("")
    // Don't revoke URLs here — they'll be used in the chat bubble for the sent message
    setPendingImages([])
    setImageNotice(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [value, connected, onSendInput, pendingImages])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const el = e.target
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  const hasContent = value.trim().length > 0 || pendingImages.length > 0
  const overflowGroups = useMemo(() => groupByCategory(OVERFLOW_ACTIONS), [])

  return (
    <div className="flex-shrink-0 border-t border-border bg-card px-4 py-3 backdrop-blur-sm">
      <div
        className="flex items-end gap-2"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
      >
        {/* Input + send button */}
        <div
          className={cn(
            "flex flex-1 flex-col rounded-xl border bg-background transition-colors",
            connected
              ? "border-border focus-within:ring-1 focus-within:ring-border/30"
              : "border-border/50 opacity-80",
            isDragging && connected && "border-primary/60 ring-2 ring-primary/20 bg-primary/5",
          )}
        >
          {/* Thumbnail preview row */}
          {pendingImages.length > 0 && (
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 flex-wrap">
              {pendingImages.map((img) => (
                <div key={img.id} className="relative group flex-shrink-0">
                  <Image
                    src={img.previewUrl}
                    alt="Pending image"
                    width={48}
                    height={48}
                    unoptimized
                    className="h-12 w-12 rounded-lg object-cover border border-border/50"
                  />
                  <button
                    onClick={() => removeImage(img.id)}
                    aria-label="Remove image"
                    className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[10px] opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
              {imageNotice && (
                <span className="text-[10px] text-muted-foreground italic">{imageNotice}</span>
              )}
            </div>
          )}
          <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={!connected}
            rows={1}
            aria-label="Send message"
            placeholder={
              connected
                ? "Message…"
                : "Connecting…"
            }
            className="min-h-[40px] flex-1 resize-none bg-transparent px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground"
            style={{ height: "40px", maxHeight: "160px", overflowY: "auto" }}
          />
          <div className="flex flex-shrink-0 items-end pb-1.5 pr-1.5 gap-1">
            {!connected && (
              <span className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Disconnected
              </span>
            )}
            <button
              onClick={handleSend}
              disabled={!connected || !hasContent}
              aria-label="Send"
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-lg transition-all",
                hasContent && connected
                  ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:scale-95"
                  : "bg-muted text-muted-foreground cursor-not-allowed",
              )}
            >
              <SendHorizonal className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        </div>

        {/* ── Top 3 action buttons with tooltips ── */}
        {onOpenAction && (
          <TooltipProvider delayDuration={300}>
            {TOP_ACTIONS.map((action) => {
              const Icon = action.icon
              const isDisabled = action.disabledDuringAuto && autoActive
              return (
                <Tooltip key={action.command}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => onOpenAction(action)}
                      disabled={isDisabled}
                      aria-label={action.description}
                      className={cn(
                        "flex flex-shrink-0 items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent",
                        isDisabled && "cursor-not-allowed opacity-40",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      {action.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    <p className="font-medium">{action.label}</p>
                    <p className="text-[10px] opacity-80">
                      {isDisabled ? "Disabled while auto-mode is running" : action.description}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )
            })}

            {/* ── Overflow menu ── */}
            <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      aria-label="More GSD commands"
                      className={cn(
                        "flex flex-shrink-0 items-center justify-center rounded-xl border border-border bg-background p-2.5 text-foreground transition-colors hover:bg-accent",
                        overflowOpen && "bg-accent",
                      )}
                    >
                      <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                {!overflowOpen && (
                  <TooltipContent side="top" sideOffset={6}>
                    More commands
                  </TooltipContent>
                )}
              </Tooltip>

              <PopoverContent
                side="top"
                align="end"
                sideOffset={8}
                className="w-64 max-h-[420px] overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-lg"
              >
                {overflowGroups.map((group, gi) => (
                  <div key={group.category}>
                    {gi > 0 && <div className="my-1.5 border-t border-border/50" />}
                    <p className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {group.label}
                    </p>
                    {group.items.map((action) => {
                      const Icon = action.icon
                      const isDisabled = action.disabledDuringAuto && autoActive
                      return (
                        <Tooltip key={action.command}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => {
                                if (isDisabled) return
                                setOverflowOpen(false)
                                onOpenAction(action)
                              }}
                              disabled={isDisabled}
                              className={cn(
                                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent",
                                isDisabled && "cursor-not-allowed opacity-40",
                              )}
                            >
                              <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                              <span className="flex-1 truncate">{action.label}</span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left" sideOffset={8}>
                            <p className="font-medium">{action.label}</p>
                            <p className="text-[10px] opacity-80">
                              {isDisabled ? "Disabled while auto-mode is running" : action.description}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                ))}
              </PopoverContent>
            </Popover>
          </TooltipProvider>
        )}
      </div>
    </div>
  )
}

/* ─── Placeholder state ─── */

function PlaceholderState({
  connected,
  runningLabel,
  notice,
  primaryAction,
  onPrimaryAction,
}: {
  connected: boolean
  runningLabel?: string
  notice?: string | null
  primaryAction?: { label: string; icon: LucideIcon } | null
  onPrimaryAction?: () => void
}) {
  const showSpinner = connected && Boolean(runningLabel)

  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center py-16">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
        {showSpinner ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <MessagesSquare className="h-6 w-6 text-muted-foreground" />
        )}
      </div>
      <div className="mt-3 space-y-1">
        <p className="text-sm font-medium text-foreground">Chat Mode</p>
        {showSpinner ? (
          <p className="max-w-xs text-xs text-muted-foreground">
            Running {runningLabel}…
          </p>
        ) : notice ? (
          <p className="max-w-xs text-xs text-muted-foreground">{notice}</p>
        ) : !connected ? (
          <p className="max-w-xs text-xs text-muted-foreground">
            Connecting to GSD session…
          </p>
        ) : primaryAction && onPrimaryAction ? (
          <div className="mt-4">
            <button
              onClick={onPrimaryAction}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent active:scale-[0.98]"
            >
              <primaryAction.icon className="h-4 w-4 text-muted-foreground" />
              {primaryAction.label}
            </button>
          </div>
        ) : (
          <p className="max-w-xs text-xs text-muted-foreground">
            Connected — waiting for GSD output…
          </p>
        )}
      </div>
    </div>
  )
}


/* ─── InlineUiRequest ─── */

/**
 * Renders a bridge-level PendingUiRequest inline in the chat message flow.
 * Supports select (single + multi), confirm, input, and editor requests.
 * After submission, transitions to a static confirmation state.
 *
 * The FocusedPanel (Sheet overlay in app-shell) is the fallback surface for
 * these same requests in non-chat views. Whichever the user interacts with
 * first resolves the request — the store deduplicates.
 */
function InlineUiRequest({ request }: { request: PendingUiRequest }) {
  const { respondToUiRequest, dismissUiRequest } = useGSDWorkspaceActions()
  const isSubmitting = useGSDWorkspaceState().commandInFlight === "extension_ui_response"

  const handleSubmit = useCallback((value: Record<string, unknown>) => {
    void respondToUiRequest(request.id, value)
  }, [respondToUiRequest, request.id])

  const handleDismiss = useCallback(() => {
    void dismissUiRequest(request.id)
  }, [dismissUiRequest, request.id])

  return (
    <div className="flex justify-start gap-3" data-testid="inline-ui-request" data-request-id={request.id}>
      <div className="mt-1 flex-shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-card border border-border">
        <PlatformLogoIcon className="h-3.5 w-auto" />
      </div>
      <div className="max-w-[82%] min-w-0 rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3 shadow-sm">
        {request.title && (
          <p className="mb-2.5 text-sm font-medium text-foreground">{request.title}</p>
        )}
        {request.method === "select" && (
          <InlineSelect request={request} onSubmit={handleSubmit} disabled={isSubmitting} />
        )}
        {request.method === "confirm" && (
          <InlineConfirm request={request} onSubmit={handleSubmit} onDismiss={handleDismiss} disabled={isSubmitting} />
        )}
        {request.method === "input" && (
          <InlineInput request={request} onSubmit={handleSubmit} disabled={isSubmitting} />
        )}
        {request.method === "editor" && (
          <InlineEditor request={request} onSubmit={handleSubmit} disabled={isSubmitting} />
        )}
      </div>
    </div>
  )
}

function InlineSelect({
  request,
  onSubmit,
  disabled,
}: {
  request: Extract<PendingUiRequest, { method: "select" }>
  onSubmit: (value: Record<string, unknown>) => void
  disabled: boolean
}) {
  const isMulti = Boolean(request.allowMultiple)
  const [singleValue, setSingleValue] = useState("")
  const [multiValues, setMultiValues] = useState<Set<string>>(new Set())
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = useCallback(() => {
    setSubmitted(true)
    onSubmit({ value: isMulti ? Array.from(multiValues) : singleValue })
  }, [isMulti, singleValue, multiValues, onSubmit])

  if (submitted) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">{isMulti ? `${multiValues.size} selected` : singleValue}</span>
      </div>
    )
  }

  const canSubmit = isMulti ? multiValues.size > 0 : singleValue !== ""

  return (
    <div className="space-y-1.5">
      {request.options.map((option, i) => {
        if (isMulti) {
          const checked = multiValues.has(option)
          return (
            <button
              key={i}
              onClick={() => {
                const next = new Set(multiValues)
                if (checked) next.delete(option); else next.add(option)
                setMultiValues(next)
              }}
              disabled={disabled}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                checked ? "bg-primary/15 text-primary font-medium" : "text-foreground hover:bg-muted",
              )}
            >
              <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border border-border">
                {checked && <Check className="h-2.5 w-2.5 text-primary" />}
              </span>
              <span>{option}</span>
            </button>
          )
        }
        const selected = singleValue === option
        return (
          <button
            key={i}
            onClick={() => setSingleValue(option)}
            disabled={disabled}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              selected ? "bg-primary/15 text-primary font-medium" : "text-foreground hover:bg-muted",
            )}
          >
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {selected ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
              )}
            </span>
            <span>{option}</span>
          </button>
        )
      })}
      <button
        onClick={handleSubmit}
        disabled={disabled || !canSubmit}
        className={cn(
          "mt-2 flex w-full items-center justify-center rounded-lg px-3 py-2 text-xs font-medium transition-all",
          canSubmit && !disabled
            ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98] shadow-sm"
            : "bg-muted text-muted-foreground cursor-not-allowed",
        )}
      >
        {isMulti ? `Submit (${multiValues.size})` : "Submit"}
      </button>
    </div>
  )
}

function InlineConfirm({
  request,
  onSubmit,
  onDismiss,
  disabled,
}: {
  request: Extract<PendingUiRequest, { method: "confirm" }>
  onSubmit: (value: Record<string, unknown>) => void
  onDismiss: () => void
  disabled: boolean
}) {
  const [resolved, setResolved] = useState<boolean | null>(null)

  if (resolved !== null) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">{resolved ? "Confirmed" : "Cancelled"}</span>
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      <p className="text-sm text-foreground leading-relaxed">{request.message}</p>
      <div className="flex gap-2">
        <button
          onClick={() => { setResolved(true); onSubmit({ value: true }) }}
          disabled={disabled}
          className="flex-1 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 active:scale-[0.98] shadow-sm transition-all"
        >
          Confirm
        </button>
        <button
          onClick={() => { setResolved(false); onDismiss() }}
          disabled={disabled}
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function InlineInput({
  request,
  onSubmit,
  disabled,
}: {
  request: Extract<PendingUiRequest, { method: "input" }>
  onSubmit: (value: Record<string, unknown>) => void
  disabled: boolean
}) {
  const [value, setValue] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  if (submitted) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">Submitted</span>
      </div>
    )
  }

  const handleSubmit = () => {
    if (!value.trim() || disabled) return
    setSubmitted(true)
    onSubmit({ value })
  }

  return (
    <div className="flex gap-2">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSubmit() } }}
        placeholder={request.placeholder || "Type your answer…"}
        disabled={disabled}
        className="flex-1 h-8 text-sm"
      />
      <button
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
        className={cn(
          "flex h-8 items-center justify-center rounded-lg px-3 text-xs font-medium transition-all",
          value.trim() && !disabled
            ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 shadow-sm"
            : "bg-muted text-muted-foreground cursor-not-allowed",
        )}
      >
        Submit
      </button>
    </div>
  )
}

function InlineEditor({
  request,
  onSubmit,
  disabled,
}: {
  request: Extract<PendingUiRequest, { method: "editor" }>
  onSubmit: (value: Record<string, unknown>) => void
  disabled: boolean
}) {
  const [value, setValue] = useState(request.prefill || "")
  const [submitted, setSubmitted] = useState(false)

  if (submitted) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">Submitted</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        className="w-full min-h-[120px] rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-border/30 resize-y"
        autoFocus
      />
      <button
        onClick={() => { setSubmitted(true); onSubmit({ value }) }}
        disabled={disabled}
        className="flex w-full items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 active:scale-[0.98] shadow-sm transition-all"
      >
        Submit
      </button>
    </div>
  )
}

/* ─── Chat Pane ─── */

interface ChatPaneProps {
  sessionId?: string
  command?: string
  commandArgs?: string[]
  className?: string
  initialCommand?: string
  onCompletionSignal?: () => void
  onOpenAction?: (action: GSDActionDef) => void
  activityLabel?: string
  suppressTerminalChrome?: boolean
  suppressInitialEcho?: boolean
}

/* ─── ToolExecutionBlock ─── */

/**
 * Renders a completed tool execution as a collapsible block.
 * Edit tool shows a syntax-highlighted unified diff.
 * Write tool shows the file path and a preview.
 * Bash tool shows the command and output.
 * Other tools show a compact summary.
 */
function ToolExecutionBlock({ tool }: { tool: CompletedToolExecution }) {
  const [expanded, setExpanded] = useState(false)

  const path = typeof tool.args?.path === "string" ? tool.args.path : typeof tool.args?.file_path === "string" ? tool.args.file_path : null
  const shortPath = path ? (path.startsWith(process.env.HOME ?? "/Users") ? "~" + path.slice((process.env.HOME ?? "").length) : path) : null
  const isError = tool.result?.isError ?? false
  const diff = tool.result?.details?.diff as string | undefined

  // Choose icon and label
  const icon = tool.name === "edit" ? <FileEdit className="h-3.5 w-3.5" />
    : tool.name === "write" ? <FilePlus className="h-3.5 w-3.5" />
    : <Terminal className="h-3.5 w-3.5" />

  const label = tool.name === "edit" ? "Edit"
    : tool.name === "write" ? "Write"
    : tool.name === "bash" ? "$"
    : tool.name

  // For bash, show the command
  const bashCommand = tool.name === "bash" && typeof tool.args?.command === "string" ? tool.args.command : null

  // Result text (for bash output, read result, etc.)
  const resultText = tool.result?.content
    ?.filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n") ?? ""

  return (
    <div className="flex justify-start gap-3">
      <div className="w-7 flex-shrink-0" />
      <div className="max-w-[82%] min-w-0 w-full">
        <button
          onClick={() => setExpanded((e) => !e)}
          className={cn(
            "w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors",
            isError
              ? "border-destructive/30 bg-destructive/5 hover:bg-destructive/10"
              : "border-border/50 bg-muted/50 hover:bg-muted/50",
          )}
        >
          {/* Header */}
          <div className="flex items-center gap-2">
            <span className={cn("flex-shrink-0", isError ? "text-destructive" : "text-muted-foreground")}>
              {icon}
            </span>
            <span className={cn("font-mono font-medium", isError ? "text-destructive" : "text-muted-foreground")}>
              {label}
            </span>
            {shortPath && (
              <span className="truncate font-mono text-info/80">{shortPath}</span>
            )}
            {bashCommand && !shortPath && (
              <span className="truncate font-mono text-muted-foreground">{bashCommand.length > 60 ? bashCommand.slice(0, 60) + "…" : bashCommand}</span>
            )}
            <span className="ml-auto flex-shrink-0 text-muted-foreground">
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </span>
          </div>

          {/* Expanded content */}
          {expanded && diff && (
            <div className="mt-2 overflow-x-auto rounded-md border border-border/50 bg-background p-2 font-mono text-[11px] leading-relaxed">
              {diff.split("\n").map((line, i) => {
                const isAdd = line.startsWith("+")
                const isRemove = line.startsWith("-")
                const isContext = line.startsWith(" ")
                return (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre",
                      isAdd && "bg-success/10 text-success",
                      isRemove && "bg-destructive/10 text-destructive",
                      isContext && "text-muted-foreground",
                      !isAdd && !isRemove && !isContext && "text-muted-foreground",
                    )}
                  >
                    {line}
                  </div>
                )
              })}
            </div>
          )}

          {/* Expanded: bash output or other result */}
          {expanded && !diff && resultText && (
            <div className="mt-2 max-h-[200px] overflow-y-auto rounded-md border border-border/50 bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {resultText.length > 2000 ? resultText.slice(0, 2000) + "\n…" : resultText}
            </div>
          )}

          {/* Error message */}
          {expanded && isError && resultText && (
            <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 p-2 text-[11px] text-destructive whitespace-pre-wrap">
              {resultText}
            </div>
          )}
        </button>
      </div>
    </div>
  )
}

/**
 * ChatPane — bridge event-driven chat rendering.
 *
 * Consumes structured agent events from the workspace store:
 * - streamingAssistantText: live text deltas from the LLM
 * - streamingThinkingText: live thinking/reasoning deltas
 * - liveTranscript: completed text blocks from previous turns
 * - activeToolExecution: currently running tool call
 *
 * User messages are tracked locally and sent via submitInput().
 * No terminal buffer parsing — all data comes from the bridge event stream.
 *
 * Observability:
 *   - data-testid="chat-pane-store-driven" on the root element
 *   - ChatInputBar shows "Disconnected" badge when bridge is not connected
 */
export function ChatPane({ className, onOpenAction }: ChatPaneProps) {
  const state = useGSDWorkspaceState()
  const { submitInput, sendCommand, pushChatUserMessage } = useGSDWorkspaceActions()
  const [terminalFontSize] = useTerminalFontSize()

  const connected = state.connectionState === "connected"
  const isStreaming = state.boot?.bridge.sessionState?.isStreaming ?? false
  const bridge = state.boot?.bridge ?? null

  // ── Derive smart CTA for the placeholder state ──
  const workflowAction = deriveWorkflowAction({
    phase: state.boot?.workspace?.active.phase ?? "pre-planning",
    autoActive: state.boot?.auto?.active ?? false,
    autoPaused: state.boot?.auto?.paused ?? false,
    onboardingLocked: state.boot?.onboarding.locked ?? false,
    commandInFlight: state.commandInFlight,
    bootStatus: state.bootStatus,
    hasMilestones: (state.boot?.workspace?.milestones.length ?? 0) > 0,
    projectDetectionKind: state.boot?.projectDetection?.kind ?? null,
  })

  const placeholderCTA = useMemo((): { label: string; icon: LucideIcon } | null => {
    if (!workflowAction.primary || workflowAction.disabled) return null
    const phase = state.boot?.workspace?.active.phase ?? "pre-planning"
    const autoActive = state.boot?.auto?.active ?? false
    const autoPaused = state.boot?.auto?.paused ?? false

    if (autoActive && !autoPaused) {
      return { label: "Stop Auto", icon: Square }
    }
    if (autoPaused) {
      return { label: "Resume Auto", icon: Play }
    }
    if (phase === "complete") {
      return { label: "New Milestone", icon: Milestone }
    }
    if (phase === "planning") {
      return { label: "Plan", icon: Play }
    }
    if (phase === "executing" || phase === "summarizing") {
      return { label: "Start Auto", icon: Zap }
    }
    if (phase === "pre-planning") {
      return { label: "Initialize Project", icon: Play }
    }
    return { label: "Continue", icon: Play }
  }, [workflowAction, state.boot?.workspace?.active.phase, state.boot?.auto?.active, state.boot?.auto?.paused])

  const handlePlaceholderCTA = useCallback(() => {
    if (!workflowAction.primary) return
    void sendCommand(buildPromptCommand(workflowAction.primary.command, bridge))
  }, [workflowAction, sendCommand, bridge])

  /** Send user text — adds a user bubble and dispatches via the store */
  const handleUserInput = useCallback((data: string, images?: PendingImage[]) => {
    const text = data.replace(/\r$/, "").trim()
    if (!text && (!images || images.length === 0)) return

    const userMsg: ChatMessage = {
      id: createLocalMessageId(),
      role: "user",
      content: text,
      complete: true,
      timestamp: Date.now(),
      images: images?.map((i) => ({ data: i.data, mimeType: i.mimeType })),
    }
    pushChatUserMessage(userMsg)
    void submitInput(text, images)
  }, [submitInput, pushChatUserMessage])

  // Build unified timeline from store state.
  // Uses the segment-ordered data to render thinking/text/tool blocks
  // in their actual chronological order within each turn.
  type TimelineItem =
    | { kind: "thinking"; content: string; id: string }
    | { kind: "message"; message: ChatMessage }
    | { kind: "tool"; tool: CompletedToolExecution }
    | { kind: "active-tool"; tool: ActiveToolExecution }
    | { kind: "streaming-thinking"; content: string }
    | { kind: "streaming-message"; content: string; isThinking: boolean }
    | { kind: "ui-request"; request: PendingUiRequest }

  const timeline = useMemo((): TimelineItem[] => {
    const items: TimelineItem[] = []
    const transcriptBlocks = state.liveTranscript
    const segmentBlocks = state.completedTurnSegments
    const userMsgs = state.chatUserMessages

    // Interleave: user messages alternate with assistant turns.
    // For completed turns, render from segments to preserve chronological order.
    for (let i = 0; i < Math.max(userMsgs.length, transcriptBlocks.length); i++) {
      if (i < userMsgs.length) {
        items.push({ kind: "message", message: userMsgs[i] })
      }
      if (i < segmentBlocks.length && segmentBlocks[i].length > 0) {
        // Render each segment in order
        for (const seg of segmentBlocks[i]) {
          if (seg.kind === "thinking") {
            items.push({ kind: "thinking", content: seg.content, id: `turn-${i}-thinking-${items.length}` })
          } else if (seg.kind === "text") {
            items.push({
              kind: "message",
              message: {
                id: `turn-${i}-text-${items.length}`,
                role: "assistant",
                content: seg.content,
                complete: true,
                timestamp: i + 1,
              },
            })
          } else if (seg.kind === "tool") {
            items.push({ kind: "tool", tool: seg.tool })
          }
        }
      } else if (i < transcriptBlocks.length && transcriptBlocks[i].trim()) {
        // Fallback: no segments stored yet (shouldn't happen for new turns, but safe)
        items.push({
          kind: "message",
          message: {
            id: `transcript-${i}`,
            role: "assistant",
            content: transcriptBlocks[i],
            complete: true,
            timestamp: i + 1,
          },
        })
      }
    }

    // Current turn: render finalized segments, then any in-flight content
    for (const seg of state.currentTurnSegments) {
      if (seg.kind === "thinking") {
        items.push({ kind: "thinking", content: seg.content, id: `current-thinking-${items.length}` })
      } else if (seg.kind === "text") {
        items.push({
          kind: "message",
          message: {
            id: `current-text-${items.length}`,
            role: "assistant",
            content: seg.content,
            complete: true,
            timestamp: Date.now(),
          },
        })
      } else if (seg.kind === "tool") {
        items.push({ kind: "tool", tool: seg.tool })
      }
    }

    // Active tool execution indicator
    if (state.activeToolExecution) {
      items.push({ kind: "active-tool", tool: state.activeToolExecution })
    }

    // Currently streaming thinking (live, not yet finalized into a segment)
    if (state.streamingThinkingText.length > 0) {
      items.push({ kind: "streaming-thinking", content: state.streamingThinkingText })
    }

    // Currently streaming text (live)
    if (state.streamingAssistantText.length > 0) {
      items.push({
        kind: "streaming-message",
        content: state.streamingAssistantText,
        isThinking: false,
      })
    }

    // If only thinking is happening (no text yet, no tool), show a minimal indicator
    if (
      state.streamingThinkingText.length === 0 &&
      state.streamingAssistantText.length === 0 &&
      !state.activeToolExecution &&
      isStreaming &&
      state.currentTurnSegments.length === 0
    ) {
      // Pure waiting state — streaming started but nothing produced yet
      items.push({ kind: "streaming-message", content: "", isThinking: true })
    }

    // Pending UI requests — at the end
    for (const req of state.pendingUiRequests) {
      items.push({ kind: "ui-request", request: req })
    }

    return items
  }, [state.liveTranscript, state.completedTurnSegments, state.currentTurnSegments, state.streamingAssistantText, state.streamingThinkingText, state.activeToolExecution, state.pendingUiRequests, state.chatUserMessages, isStreaming])

  // Prompt submit handler for TUI prompts (select/text/password)
  const handlePromptSubmit = useCallback((data: string) => {
    void submitInput(data.replace(/\r$/, ""))
  }, [submitInput])

  const showPlaceholder = timeline.length === 0 && !isStreaming

  // Show an "awaiting input" indicator when the session is idle (connected,
  // not streaming, has timeline content) so the UI does not appear stuck (#2707).
  const showAwaitingInput = connected && !isStreaming && timeline.length > 0
    && !state.activeToolExecution
    && state.pendingUiRequests.length === 0

  // Auto-scroll ref
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [timeline])

  return (
    <div
      data-testid="chat-pane-store-driven"
      className={cn("flex flex-col overflow-hidden", className)}
    >
      <div className="flex flex-1 flex-col overflow-hidden">
        {showPlaceholder ? (
          <PlaceholderState
            connected={connected}
            runningLabel={isStreaming ? "responding" : undefined}
            primaryAction={placeholderCTA}
            onPrimaryAction={handlePlaceholderCTA}
          />
        ) : (
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
            style={terminalFontSize !== 13 ? { fontSize: `${terminalFontSize}px` } : undefined}
          >
            {timeline.map((item, idx) => {
              switch (item.kind) {
                case "message":
                  return (
                    <ChatBubble
                      key={item.message.id}
                      message={item.message}
                      onSubmitPrompt={handlePromptSubmit}
                    />
                  )
                case "thinking":
                  return (
                    <div key={item.id} className="flex justify-start gap-3">
                      <div className="w-7 flex-shrink-0" />
                      <div className="max-w-[82%] min-w-0">
                        <InlineThinking content={item.content} isStreaming={false} />
                      </div>
                    </div>
                  )
                case "streaming-thinking":
                  return (
                    <div key="streaming-thinking" className="flex justify-start gap-3">
                      <div className="w-7 flex-shrink-0" />
                      <div className="max-w-[82%] min-w-0">
                        <InlineThinking content={item.content} isStreaming={true} />
                      </div>
                    </div>
                  )
                case "streaming-message":
                  return (
                    <ChatBubble
                      key="streaming-message"
                      message={{
                        id: "streaming-current",
                        role: "assistant",
                        content: item.content,
                        complete: false,
                        timestamp: Date.now(),
                      }}
                      isThinking={item.isThinking}
                    />
                  )
                case "tool":
                  return <ToolExecutionBlock key={item.tool.id} tool={item.tool} />
                case "active-tool":
                  return (
                    <div key={`active-${item.tool.id}`} className="flex justify-start gap-3">
                      <div className="w-7 flex-shrink-0" />
                      <div className="max-w-[82%] min-w-0">
                        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/50 px-3.5 py-2">
                          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                          <span className="font-mono text-xs text-muted-foreground">
                            {item.tool.name}
                          </span>
                          {Boolean(item.tool.args?.path) && (
                            <span className="font-mono text-xs text-info/80 truncate">
                              {String(item.tool.args?.path)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                case "ui-request":
                  return <InlineUiRequest key={item.request.id} request={item.request} />
              }
            })}
            {showAwaitingInput && (
              <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground animate-in fade-in duration-500">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500/70 animate-pulse" />
                Ready for your input
              </div>
            )}
            <div className="h-2" />
          </div>
        )}
      </div>

      <ChatInputBar
        onSendInput={handleUserInput}
        connected={connected}
        onOpenAction={onOpenAction}
      />
    </div>
  )
}
