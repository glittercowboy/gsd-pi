"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTheme } from "next-themes"
import { Loader2, ImagePlus } from "lucide-react"
import { cn } from "@/lib/utils"
import { validateImageFile } from "@/lib/image-utils"
import { buildProjectAbsoluteUrl, buildProjectPath } from "@/lib/project-url"
import { authFetch, appendAuthParam } from "@/lib/auth"
import { getXtermOptions, getXtermTheme } from "@/lib/xterm-theme"
import "@xterm/xterm/css/xterm.css"

type XTerminal = import("@xterm/xterm").Terminal
type XFitAddon = import("@xterm/addon-fit").FitAddon

interface MainSessionTerminalProps {
  className?: string
  fontSize?: number
  projectCwd?: string
}

const MIN_INITIAL_ATTACH_WIDTH = 180
const MIN_INITIAL_ATTACH_HEIGHT = 120
const MIN_INITIAL_ATTACH_COLS = 20
const MIN_INITIAL_ATTACH_ROWS = 8

function getAttachableTerminalSize(container: HTMLDivElement | null, terminal: XTerminal | null): { cols: number; rows: number } | null {
  if (!container || !terminal) return null

  const rect = container.getBoundingClientRect()
  if (rect.width < MIN_INITIAL_ATTACH_WIDTH || rect.height < MIN_INITIAL_ATTACH_HEIGHT) {
    return null
  }

  if (terminal.cols < MIN_INITIAL_ATTACH_COLS || terminal.rows < MIN_INITIAL_ATTACH_ROWS) {
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
      // Hidden or detached.
    }

    const size = getAttachableTerminalSize(container, terminal)
    if (size) {
      return size
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return getAttachableTerminalSize(container, terminal)
}

export function MainSessionTerminal({ className, fontSize, projectCwd }: MainSessionTerminalProps) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme !== "light"
  const wrapperRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerminal | null>(null)
  const fitAddonRef = useRef<XFitAddon | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputQueueRef = useRef<string[]>([])
  const flushingRef = useRef(false)
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "error">("connecting")
  const [hasOutput, setHasOutput] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  const flushInputQueue = useCallback(async () => {
    if (flushingRef.current) return
    flushingRef.current = true
    while (inputQueueRef.current.length > 0) {
      const data = inputQueueRef.current.shift()!
      try {
        const res = await authFetch(buildProjectPath("/api/bridge-terminal/input", projectCwd), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data }),
        })
        if (!res.ok) {
          if (res.status >= 500) inputQueueRef.current.unshift(data)
          setConnectionState("error")
          termRef.current?.writeln(`\r\nInput failed (${res.status}). Reconnect the terminal and retry.`)
          break
        }
      } catch {
        inputQueueRef.current.unshift(data)
        setConnectionState("error")
        break
      }
    }
    flushingRef.current = false
  }, [projectCwd])

  const sendInput = useCallback((data: string) => {
    inputQueueRef.current.push(data)
    void flushInputQueue()
  }, [flushInputQueue])

  const sendResize = useCallback((cols: number, rows: number) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current)
    resizeTimeoutRef.current = setTimeout(() => {
      void authFetch(buildProjectPath("/api/bridge-terminal/resize", projectCwd), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      })
    }, 75)
  }, [projectCwd])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getXtermTheme(isDark)
    }
  }, [isDark])

  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.fontSize = fontSize ?? 13
    try {
      fitAddonRef.current?.fit()
      sendResize(termRef.current.cols, termRef.current.rows)
    } catch {
      // Hidden or not mounted yet.
    }
  }, [fontSize, sendResize])

  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    let terminal: XTerminal | null = null
    let fitAddon: XFitAddon | null = null

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

      const initialSize = await settleTerminalLayout(containerRef.current, terminal, fitAddon, () => disposed)
      if (disposed) return

      terminal.onData((data) => {
        sendInput(data)
      })
      terminal.onBinary((data) => {
        sendInput(data)
      })

      const connectStream = (preferredSize: { cols: number; rows: number } | null) => {
        const streamUrl = buildProjectAbsoluteUrl(
          "/api/bridge-terminal/stream",
          window.location.origin,
          projectCwd,
        )
        if (preferredSize) {
          streamUrl.searchParams.set("cols", String(preferredSize.cols))
          streamUrl.searchParams.set("rows", String(preferredSize.rows))
        }

        const es = new EventSource(appendAuthParam(streamUrl.toString()))
        eventSourceRef.current = es
        setConnectionState((current) => (current === "connected" ? current : "connecting"))

        es.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as { type: string; data?: string }
            if (message.type === "connected") {
              setConnectionState("connected")
              void settleTerminalLayout(containerRef.current, termRef.current, fitAddonRef.current, () => disposed).then((size) => {
                if (!size) return
                sendResize(size.cols, size.rows)
              })
              return
            }

            if (message.type === "output" && typeof message.data === "string") {
              termRef.current?.write(message.data)
              setHasOutput(true)
            }
          } catch {
            setConnectionState("error")
          }
        }

        es.onerror = () => {
          setConnectionState("error")
        }
      }

      connectStream(initialSize)

      resizeObserver = new ResizeObserver(() => {
        if (disposed) return
        try {
          fitAddon?.fit()
          if (terminal) {
            sendResize(terminal.cols, terminal.rows)
          }
        } catch {
          // Hidden or detached.
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
  }, [fontSize, isDark, projectCwd, sendInput, sendResize])

  const handleClick = useCallback(() => {
    termRef.current?.focus()
  }, [])

  // ── Shift+Enter → newline (native DOM, capture phase) ────────────────────
  // xterm.js sends \r for both Enter and Shift+Enter. The pi TUI editor
  // recognizes \n (LF) as "insert newline". Capture-phase keydown intercepts
  // before xterm's internal textarea processes the event.
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

  // ── Drag-and-drop image upload (native DOM, capture phase) ──────────────
  // React synthetic events don't reliably fire through xterm's internal DOM.
  // Native capture-phase listeners intercept before xterm can swallow them —
  // same pattern used for paste in ShellTerminal.

  useEffect(() => {
    const el = wrapperRef.current
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

      const files = Array.from(e.dataTransfer?.files ?? [])
      const imageFile = files.find((f) => f.type.startsWith("image/"))
      if (!imageFile) return

      const validation = validateImageFile(imageFile)
      if (!validation.valid) {
        console.warn("[main-terminal-upload] validation failed:", validation.error)
        return
      }

      const formData = new FormData()
      formData.append("file", imageFile)

      void (async () => {
        try {
          const res = await authFetch(buildProjectPath("/api/terminal/upload", projectCwd), {
            method: "POST",
            body: formData,
          })
          const data = (await res.json()) as { ok?: boolean; path?: string; error?: string }
          if (!res.ok || !data.path) {
            console.error("[main-terminal-upload] upload failed:", data.error ?? `HTTP ${res.status}`)
            return
          }
          console.log("[main-terminal-upload] injecting path:", data.path)
          sendInput(`@${data.path} `)
        } catch (err) {
          console.error("[main-terminal-upload] upload request failed:", err)
        }
      })()
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
  }, [projectCwd, sendInput])

  useEffect(() => {
    const timer = setTimeout(() => termRef.current?.focus(), 80)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      ref={wrapperRef}
      className={cn("relative h-full w-full bg-terminal", className)}
      onClick={handleClick}
      data-testid="main-session-native-terminal"
    >
      {!hasOutput && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-terminal">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {connectionState === "error" ? "Reconnecting main session terminal…" : "Connecting to main session…"}
          </span>
        </div>
      )}
      {/* Drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background backdrop-blur-sm border-2 border-dashed border-primary rounded-md pointer-events-none">
          <ImagePlus className="h-8 w-8 text-primary" />
          <span className="text-sm font-medium text-primary">Drop image here</span>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" style={{ padding: "8px 4px 4px 8px" }} />
    </div>
  )
}
