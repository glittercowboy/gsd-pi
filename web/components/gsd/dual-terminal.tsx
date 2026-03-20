"use client"

import { useState, useRef, useEffect } from "react"
import { GripVertical, Loader2 } from "lucide-react"
import { MainSessionTerminal } from "@/components/gsd/main-session-terminal"
import { ShellTerminal } from "@/components/gsd/shell-terminal"
import { useTerminalFontSize } from "@/lib/use-terminal-font-size"
import { useGSDWorkspaceState } from "@/lib/gsd-workspace-store"
import { derivePendingWorkflowCommandLabel } from "@/lib/workflow-action-execution"

export function DualTerminal() {
  const [splitPosition, setSplitPosition] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const [terminalFontSize] = useTerminalFontSize()
  const workspace = useGSDWorkspaceState()
  const projectCwd = workspace.boot?.project.cwd
  const pendingCommandLabel = derivePendingWorkflowCommandLabel({
    commandInFlight: workspace.commandInFlight,
    terminalLines: workspace.terminalLines,
  })

  const handleMouseDown = () => {
    isDragging.current = true
  }

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percent = (x / rect.width) * 100
    setSplitPosition(Math.max(20, Math.min(80, percent)))
  }

  const handleMouseUp = () => {
    isDragging.current = false
  }

  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <span className="font-medium">Power User Mode</span>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {pendingCommandLabel && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-primary"
              data-testid="power-mode-pending-command"
              title={pendingCommandLabel}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Sending {pendingCommandLabel}
            </span>
          )}
          <span>Left: Main Session TUI</span>
          <span className="text-border">|</span>
          <span>Right: Interactive GSD</span>
        </div>
      </div>

      {/* Split terminals */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left terminal - Main bridge native TUI */}
        <div style={{ width: `${splitPosition}%` }} className="flex h-full min-w-0 flex-col overflow-hidden bg-terminal">
          <MainSessionTerminal className="min-h-0 flex-1" fontSize={terminalFontSize} projectCwd={projectCwd} />
        </div>

        {/* Divider */}
        <div
          className="flex w-1 cursor-col-resize items-center justify-center bg-border hover:bg-muted-foreground/30 transition-colors"
          onMouseDown={handleMouseDown}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>

        {/* Right terminal - Interactive GSD instance */}
        <div style={{ width: `${100 - splitPosition}%` }} className="h-full min-w-0 overflow-hidden bg-terminal">
          <ShellTerminal
            className="h-full"
            command="gsd"
            sessionPrefix="gsd-interactive"
            fontSize={terminalFontSize}
            hideInitialGsdHeader
            projectCwd={projectCwd}
          />
        </div>
      </div>
    </div>
  )
}
