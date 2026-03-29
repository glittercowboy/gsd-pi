"use client"

import { useEffect, useRef, useCallback, useState } from "react"
import { useTheme } from "next-themes"
import { Plus, X, TerminalSquare, Loader2, ImagePlus } from "lucide-react"
import { cn } from "@/lib/utils"
import { validateImageFile } from "@/lib/image-utils"
import { filterInitialGsdHeader } from "@/lib/initial-gsd-header-filter"
import { buildProjectAbsoluteUrl, buildProjectPath } from "@/lib/project-url"
import { authFetch, appendAuthParam } from "@/lib/auth"
import { getXtermOptions, getXtermTheme } from "@/lib/xterm-theme"
import "@xterm/xterm/css/xterm.css"

type XTerminal = import("@xterm/xterm").Terminal
type XFitAddon = import("@xterm/addon-fit").FitAddon

const MIN_TERMINAL_ATTACH_WIDTH = 180
const MIN_TERMINAL_ATTACH_HEIGHT = 120
const MIN_TERMINAL_ATTACH_COLS = 20
const MIN_TERMINAL_ATTACH_ROWS = 8

// ─── Types ────────────────────────────────────────────────────────────────────

interface TerminalTab {
  id: string
  label: string
  connected: boolean
}

interface ShellTerminalProps {
  className?: string
  command?: string
  commandArgs?: string[]
  sessionPrefix?: string
  hideSidebar?: boolean
  fontSize?: number
  hideInitialGsdHeader?: boolean
  projectCwd?: string
}

function getRenderableTerminalSize(container: HTMLDivElement | null, terminal: XTerminal | null): { cols: number; rows: number } | null {
  if (!container || !terminal) return null

  const rect = container.getBoundingClientRect()
  if (rect.width < MIN_TERMINAL_ATTACH_WIDTH || rect.height < MIN_TERMINAL_ATTACH_HEIGHT) {
    return null
  }

  if (terminal.cols < MIN_TERMINAL_ATTACH_COLS || terminal.rows < MIN_TERMINAL_ATTACH_ROWS) {
    return null
  }

  return { cols: terminal.cols, rows: terminal.rows }
}

async function settleTerminalLayout(
  container: HTMLDivElement | null,
  terminal: XTerminal | null,
  fitAddon: XFitAddon | null,
  isDisposed: () => boolean,
): Promise<{ cols: number; rows: number } | null> {
  if (typeof document !== "undefined" && "fonts" in document) {
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ])
    } catch {
      // Ignore font loading failures and fall through to repeated fit attempts.
    }
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    if (isDisposed()) return null

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    if (isDisposed()) return null

    try {
      fitAddon?.fit()
    } catch {
      /* hidden or detached */
    }

    const size = getRenderableTerminalSize(container, terminal)
    if (size) {
      return size
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return getRenderableTerminalSize(container, terminal)
}

function deriveCommandLabel(command?: string): string {
  if (!command?.trim()) return "zsh"
  const token = command.trim().split(/\s+/)[0] || command
  const normalized = token.replace(/\\/g, "/")
  const parts = normalized.split("/")
  return parts[parts.length - 1] || token
}

// ─── Single terminal instance (internal) ──────────────────────────────────────

interface TerminalInstanceProps {
  sessionId: string
  visible: boolean
  command?: string
  commandArgs?: string[]
  isDark: boolean
  fontSize?: number
  hideInitialGsdHeader?: boolean
  projectCwd?: string
  onConnectionChange: (connected: boolean) => void
}

function TerminalInstance({
  sessionId,
  visible,
  command,
  commandArgs,
  isDark,
  fontSize,
  hideInitialGsdHeader = false,
  projectCwd,
  onConnectionChange,
}: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerminal | null>(null)
  const fitAddonRef = useRef<XFitAddon | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const inputQueueRef = useRef<string[]>([])
  const flushingRef = useRef(false)
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onConnectionChangeRef = useRef(onConnectionChange)
  const initialHeaderSettledRef = useRef(!hideInitialGsdHeader)
  const initialHeaderBufferRef = useRef("")
  const commandArgsKey = (commandArgs ?? []).join("\u0000")
  const [hasOutput, setHasOutput] = useState(false)

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current)
      resizeTimeoutRef.current = setTimeout(() => {
        void authFetch(buildProjectPath("/api/terminal/resize", projectCwd), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: sessionId, cols, rows }),
        })
      }, 100)
    },
    [projectCwd, sessionId],
  )

  const flushInputQueue = useCallback(async () => {
    if (flushingRef.current) return
    flushingRef.current = true
    while (inputQueueRef.current.length > 0) {
      const data = inputQueueRef.current.shift()!
      try {
        await authFetch(buildProjectPath("/api/terminal/input", projectCwd), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: sessionId, data }),
        })
      } catch {
        inputQueueRef.current.unshift(data)
        break
      }
    }
    flushingRef.current = false
  }, [projectCwd, sessionId])

  const sendInput = useCallback(
    (data: string) => {
      inputQueueRef.current.push(data)
      void flushInputQueue()
    },
    [flushInputQueue],
  )

  useEffect(() => {
    onConnectionChangeRef.current = onConnectionChange
  }, [onConnectionChange])

  useEffect(() => {
    initialHeaderSettledRef.current = !hideInitialGsdHeader
    initialHeaderBufferRef.current = ""
  }, [hideInitialGsdHeader, sessionId])

  // Update xterm theme when isDark changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getXtermTheme(isDark)
    }
  }, [isDark])

  // Update xterm font size when fontSize changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize ?? 13
      try {
        fitAddonRef.current?.fit()
        if (termRef.current) {
          sendResize(termRef.current.cols, termRef.current.rows)
        }
      } catch {
        /* not visible yet */
      }
    }
  }, [fontSize, sendResize])

  // Re-fit when visibility changes
  useEffect(() => {
    if (visible && fitAddonRef.current && termRef.current) {
      // Small delay to let the DOM settle
      const t = setTimeout(() => {
        try {
          fitAddonRef.current?.fit()
          if (termRef.current) {
            sendResize(termRef.current.cols, termRef.current.rows)
          }
        } catch {
          /* not visible yet */
        }
      }, 50)
      return () => clearTimeout(t)
    }
  }, [visible, sendResize])

  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    let terminal: XTerminal | null = null
    let fitAddon: XFitAddon | null = null
    let resizeObserver: ResizeObserver | null = null

    const init = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ])

      if (disposed) return

      terminal = new Terminal(getXtermOptions(isDark, fontSize))
      fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.open(containerRef.current!)

      termRef.current = terminal
      fitAddonRef.current = fitAddon

      await settleTerminalLayout(containerRef.current, terminal, fitAddon, () => disposed)
      if (disposed) return

      terminal.onData((data) => sendInput(data))
      terminal.onBinary((data) => sendInput(data))

      // SSE stream
      const streamUrl = buildProjectAbsoluteUrl(
        "/api/terminal/stream",
        window.location.origin,
        projectCwd,
      )
      streamUrl.searchParams.set("id", sessionId)
      if (command) streamUrl.searchParams.set("command", command)
      for (const arg of commandArgs ?? []) {
        streamUrl.searchParams.append("arg", arg)
      }
      const es = new EventSource(appendAuthParam(streamUrl.toString()))
      eventSourceRef.current = es

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type: string
            data?: string
          }
          if (msg.type === "connected") {
            onConnectionChangeRef.current(true)
            void settleTerminalLayout(containerRef.current, terminal, fitAddon, () => disposed).then((size) => {
              if (!size) return
              sendResize(size.cols, size.rows)
            })
          } else if (msg.type === "output" && msg.data) {
            let output = msg.data

            if (hideInitialGsdHeader && !initialHeaderSettledRef.current) {
              initialHeaderBufferRef.current += output
              const filtered = filterInitialGsdHeader(initialHeaderBufferRef.current)

              if (filtered.status === "needs-more") {
                return
              }

              initialHeaderSettledRef.current = true
              initialHeaderBufferRef.current = ""
              output = filtered.text
            }

            if (output) {
              terminal?.write(output)
              setHasOutput(true)
            }
          }
        } catch {
          /* malformed */
        }
      }

      es.onerror = () => onConnectionChangeRef.current(false)

      // Resize observer
      resizeObserver = new ResizeObserver(() => {
        if (disposed) return
        try {
          fitAddon?.fit()
          if (terminal) sendResize(terminal.cols, terminal.rows)
        } catch {
          /* not visible */
        }
      })
      resizeObserver.observe(containerRef.current!)
    }

    void init()

    return () => {
      disposed = true
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current)
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      resizeObserver?.disconnect()
      terminal?.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId, command, commandArgs, commandArgsKey, fontSize, hideInitialGsdHeader, isDark, projectCwd, sendInput, sendResize])

  // Focus on click
  const wrapperRef = useRef<HTMLDivElement>(null)
  const handleClick = useCallback(() => {
    termRef.current?.focus()
  }, [])

  // Shift+Enter → newline (native DOM, capture phase)
  // xterm.js sends \r for both Enter and Shift+Enter. The pi TUI editor
  // recognizes \n (LF) as "insert newline".
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        sendInput("\n")
      }
    }

    el.addEventListener("keydown", onKeyDown, true)
    return () => el.removeEventListener("keydown", onKeyDown, true)
  }, [sendInput])

  // Auto-focus when this tab becomes visible
  useEffect(() => {
    if (visible) {
      // Small delay to let layout settle
      const t = setTimeout(() => termRef.current?.focus(), 80)
      return () => clearTimeout(t)
    }
  }, [visible])

  return (
    <div
      ref={wrapperRef}
      className={cn("relative h-full w-full bg-terminal", !visible && "hidden")}
      onClick={handleClick}
    >
      {/* Loading overlay — visible until first output arrives */}
      {!hasOutput && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-terminal">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {command ? "Starting GSD…" : "Connecting…"}
          </span>
        </div>
      )}
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ padding: "8px 4px 4px 8px" }}
      />
    </div>
  )
}

// ─── Image upload helpers ─────────────────────────────────────────────────────

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/**
 * Upload an image file to the server's temp directory and inject the `@filepath`
 * text into the PTY session's stdin.
 *
 * Observability:
 * - console.warn on client-side validation failure
 * - console.error on upload or inject failure
 */
async function uploadAndInjectImage(file: File, sessionId: string, projectCwd?: string): Promise<void> {
  // Client-side validation
  const validation = validateImageFile(file)
  if (!validation.valid) {
    console.warn("[terminal-upload] validation failed:", validation.error)
    return
  }

  // Upload to temp dir
  const formData = new FormData()
  formData.append("file", file)

  let uploadPath: string
  try {
    const res = await authFetch(buildProjectPath("/api/terminal/upload", projectCwd), {
      method: "POST",
      body: formData,
    })
    const data = await res.json() as { ok?: boolean; path?: string; error?: string }
    if (!res.ok || !data.path) {
      console.error("[terminal-upload] upload failed:", data.error ?? `HTTP ${res.status}`)
      return
    }
    uploadPath = data.path
  } catch (err) {
    console.error("[terminal-upload] upload request failed:", err)
    return
  }

  // Inject @filepath into PTY stdin
  try {
    const res = await authFetch(buildProjectPath("/api/terminal/input", projectCwd), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, data: `@${uploadPath} ` }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      console.error("[terminal-upload] inject failed:", data.error ?? `HTTP ${res.status}`)
    }
  } catch (err) {
    console.error("[terminal-upload] inject request failed:", err)
  }
}

// ─── Multi-instance terminal panel ────────────────────────────────────────────

/**
 * Derive a session ID that is scoped to the project path.  This ensures
 * that switching projects creates a separate PTY session per project, and
 * switching back reconnects to the *same* server-side PTY instead of
 * spawning a new one (the server's getOrCreateSession returns the existing
 * live session when the ID matches).
 */
function deriveProjectScopedSessionId(
  projectCwd: string | undefined,
  sessionPrefix?: string,
  command?: string,
): string {
  const base = sessionPrefix ?? (command ? "gsd-default" : "default")
  if (!projectCwd) return base
  return `${base}:${projectCwd}`
}

export function ShellTerminal({
  className,
  command,
  commandArgs,
  sessionPrefix,
  hideSidebar = false,
  fontSize,
  hideInitialGsdHeader = false,
  projectCwd,
}: ShellTerminalProps) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme !== "light"
  const defaultId = deriveProjectScopedSessionId(projectCwd, sessionPrefix, command)
  const commandLabel = deriveCommandLabel(command)
  const [tabs, setTabs] = useState<TerminalTab[]>([
    { id: defaultId, label: commandLabel, connected: false },
  ])
  const [activeTabId, setActiveTabId] = useState(defaultId)
  const [isDragOver, setIsDragOver] = useState(false)
  const terminalAreaRef = useRef<HTMLDivElement>(null)

  // When the project changes, the defaultId changes.  Reset tabs so the
  // terminal reconnects to the project-scoped PTY session on the server.
  // The server's getOrCreateSession will return the existing live session
  // when the session ID matches, preserving terminal state.
  const prevDefaultIdRef = useRef(defaultId)
  useEffect(() => {
    if (prevDefaultIdRef.current !== defaultId) {
      prevDefaultIdRef.current = defaultId
      setTabs([{ id: defaultId, label: commandLabel, connected: false }])
      setActiveTabId(defaultId)
    }
  }, [defaultId, commandLabel])

  // ── Drag-and-drop handlers (native DOM, capture phase) ──────────────────
  // React synthetic events don't reliably fire through xterm's internal DOM.
  // Native capture-phase listeners intercept before xterm can swallow them —
  // same pattern used for paste below.

  useEffect(() => {
    const el = terminalAreaRef.current
    if (!el) return

    let counter = 0

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      counter += 1
      if (counter === 1) setIsDragOver(true)
    }

    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      counter -= 1
      if (counter <= 0) {
        counter = 0
        setIsDragOver(false)
      }
    }

    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      counter = 0
      setIsDragOver(false)

      if (!activeTabId) return
      const files = Array.from(e.dataTransfer?.files ?? [])
      const imageFile = files.find((f) => ALLOWED_IMAGE_TYPES.has(f.type))
      if (imageFile) {
        void uploadAndInjectImage(imageFile, activeTabId, projectCwd)
      }
    }

    el.addEventListener("dragenter", onDragEnter, true)
    el.addEventListener("dragover", onDragOver, true)
    el.addEventListener("dragleave", onDragLeave, true)
    el.addEventListener("drop", onDrop, true)
    return () => {
      el.removeEventListener("dragenter", onDragEnter, true)
      el.removeEventListener("dragover", onDragOver, true)
      el.removeEventListener("dragleave", onDragLeave, true)
      el.removeEventListener("drop", onDrop, true)
    }
  }, [activeTabId, projectCwd])

  // ── Paste handler for images ──────────────────────────────────────────────

  useEffect(() => {
    const el = terminalAreaRef.current
    if (!el) return

    const handlePaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return
      const files = Array.from(e.clipboardData.files)
      const imageFile = files.find((f) => ALLOWED_IMAGE_TYPES.has(f.type))
      if (imageFile) {
        e.preventDefault()
        e.stopPropagation()
        if (activeTabId) {
          void uploadAndInjectImage(imageFile, activeTabId, projectCwd)
        }
      }
      // If no image files, don't prevent default — let xterm.js handle text paste
    }

    el.addEventListener("paste", handlePaste, true) // capture phase to fire before xterm
    return () => el.removeEventListener("paste", handlePaste, true)
  }, [activeTabId, projectCwd])

  const createTab = useCallback(async () => {
    try {
      const res = await authFetch(buildProjectPath("/api/terminal/sessions", projectCwd), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command ? { command } : {}),
      })
      const data = (await res.json()) as { id: string }
      const newTab: TerminalTab = {
        id: data.id,
        label: commandLabel,
        connected: false,
      }
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(data.id)
    } catch {
      /* network error */
    }
  }, [command, commandLabel, projectCwd])

  const closeTab = useCallback(
    (id: string) => {
      // Don't close the last tab
      if (tabs.length <= 1) return
      const deleteUrl = buildProjectAbsoluteUrl("/api/terminal/sessions", window.location.origin, projectCwd)
      deleteUrl.searchParams.set("id", id)
      void authFetch(deleteUrl.toString(), {
        method: "DELETE",
      })
      const remaining = tabs.filter((t) => t.id !== id)
      setTabs(remaining)
      if (activeTabId === id) {
        setActiveTabId(remaining[remaining.length - 1]?.id ?? defaultId)
      }
    },
    [tabs, activeTabId, defaultId, projectCwd],
  )

  const updateConnection = useCallback(
    (id: string, connected: boolean) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, connected } : t)),
      )
    },
    [],
  )

  return (
    <div className={cn("flex bg-terminal", className)}>
      {/* Terminal area — receives drag/drop and paste for images */}
      <div
        ref={terminalAreaRef}
        className="relative flex-1 min-w-0"
      >
        {tabs.map((tab) => (
          <TerminalInstance
            key={tab.id}
            sessionId={tab.id}
            visible={tab.id === activeTabId}
            command={command}
            commandArgs={tab.id === defaultId ? commandArgs : undefined}
            isDark={isDark}
            fontSize={fontSize}
            hideInitialGsdHeader={hideInitialGsdHeader}
            projectCwd={projectCwd}
            onConnectionChange={(c) => updateConnection(tab.id, c)}
          />
        ))}

        {/* Drop overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background backdrop-blur-sm border-2 border-dashed border-primary rounded-md pointer-events-none">
            <ImagePlus className="h-8 w-8 text-primary" />
            <span className="text-sm font-medium text-primary">Drop image here</span>
          </div>
        )}
      </div>

      {!hideSidebar && (
        <div className="flex w-[34px] flex-shrink-0 flex-col border-l border-border/50 bg-terminal">
          {/* New terminal button */}
          <button
            onClick={createTab}
            className="flex h-[30px] w-full items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            title="New terminal"
          >
            <Plus className="h-3 w-3" />
          </button>

          <div className="h-px bg-border/50" />

          {/* Tab list */}
          <div className="flex-1 overflow-y-auto">
            {tabs.map((tab, index) => (
              <button
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={cn(
                  "group relative flex h-[30px] w-full items-center justify-center transition-colors",
                  tab.id === activeTabId
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                )}
                title={`${tab.label} ${index + 1}`}
              >
                {/* Active indicator bar */}
                {tab.id === activeTabId && (
                  <div className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-muted-foreground" />
                )}

                <div className="relative flex items-center">
                  <TerminalSquare className="h-3 w-3" />
                  {/* Connection dot */}
                  <span
                    className={cn(
                      "absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full border border-terminal",
                      tab.connected ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                </div>

                {/* Close button — shows on hover as small badge in corner */}
                {tabs.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                    className="absolute -right-0.5 -top-0.5 z-10 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:flex"
                    title="Kill terminal"
                  >
                    <X className="h-2 w-2" />
                  </button>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
