"use client"

import { useState, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { GripVertical, Wrench, Play, Loader2 } from "lucide-react"
import {
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
  buildPromptCommand,
  formatDuration,
  formatCost,
  formatTokens,
  getCurrentScopeLabel,
  getModelLabel,
} from "@/lib/gsd-workspace-store"
import { deriveWorkflowAction } from "@/lib/workflow-actions"
import { ScopeBadge } from "@/components/gsd/scope-badge"
import { Terminal } from "./terminal"

function AutoTerminal() {
  const state = useGSDWorkspaceState()
  const boot = state.boot
  const auto = boot?.auto ?? null
  const workspace = boot?.workspace ?? null
  const bridge = boot?.bridge ?? null
  const terminalLines = state.terminalLines ?? []

  const activeToolExecution = state.activeToolExecution

  const isActive = auto?.active ?? false
  const isPaused = auto?.paused ?? false
  const elapsed = auto?.elapsed ?? 0
  const totalCost = auto?.totalCost ?? 0
  const totalTokens = auto?.totalTokens ?? 0
  const currentUnit = auto?.currentUnit ?? null

  const scopeLabel = getCurrentScopeLabel(workspace)
  const model = getModelLabel(bridge)

  const statusLabel = isActive
    ? isPaused
      ? "PAUSED"
      : "RUNNING"
    : "INACTIVE"

  const statusColor = isActive
    ? isPaused
      ? "text-warning"
      : "text-success"
    : "text-muted-foreground"

  return (
    <div className="flex h-full flex-col bg-terminal font-mono text-sm">
      {/* Terminal header */}
      <div className="flex items-center justify-between border-b border-border/50 bg-card/50 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">gsd auto</span>
        <span className={cn("text-xs font-medium", statusColor)}>{statusLabel}</span>
      </div>

      {/* Terminal content */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* Terminal lines */}
        <div className="mb-4 text-xs space-y-0.5">
          {terminalLines.map((line) => (
            <div
              key={line.id}
              className={cn(
                "truncate",
                line.type === "error" && "text-destructive",
                line.type === "success" && "text-success",
                line.type === "system" && "text-muted-foreground/70",
                line.type === "output" && "text-terminal-foreground",
                line.type === "input" && "text-foreground",
              )}
            >
              <span className="mr-2 text-muted-foreground/50">{line.timestamp}</span>
              {line.content}
            </div>
          ))}
        </div>

        {/* Status bar */}
        <div className="mb-4 flex items-center justify-between border-t border-b border-border/30 py-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                isActive && !isPaused ? "bg-success" : "bg-muted-foreground/50",
              )}
            />
            <span className="font-bold text-foreground">GSD</span>
            <span className={cn("font-semibold", statusColor)}>
              {isActive ? "AUTO" : "IDLE"}
            </span>
          </div>
          <span className="text-muted-foreground">{formatDuration(elapsed)}</span>
        </div>

        {/* Current workflow */}
        {currentUnit && (
          <div className="mb-4">
            <div className="text-muted-foreground text-xs mb-1">Current Unit</div>
            <div className="mt-1">
              <ScopeBadge label={currentUnit.id} size="sm" />
            </div>
          </div>
        )}

        {/* Active tool execution */}
        {activeToolExecution && (
          <div className="mb-4" data-testid="auto-terminal-active-tool">
            <div className="text-muted-foreground text-xs mb-1">Tool</div>
            <div className="flex items-center gap-2 text-foreground">
              <Wrench className="h-3 w-3 text-muted-foreground" />
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              <span>{activeToolExecution.name}</span>
            </div>
          </div>
        )}

        {/* Scope */}
        <div className="mb-4">
          <div className="text-muted-foreground text-xs mb-1">Scope</div>
          <div className="text-foreground">{scopeLabel}</div>
        </div>
      </div>

      {/* Bottom status */}
      <div className="border-t border-border/50 bg-card/30 px-3 py-2 text-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className={cn("font-medium", isActive ? "text-success" : "text-muted-foreground")}>
              {formatCost(totalCost)}
            </span>
            <span className="text-muted-foreground">
              {formatTokens(totalTokens)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{model}</span>
          </div>
        </div>
        <div className="mt-1 text-muted-foreground/70">
          esc pause | Ctrl+Alt+G dashboard
        </div>
      </div>
    </div>
  )
}

export function DualTerminal() {
  const [splitPosition, setSplitPosition] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const state = useGSDWorkspaceState()
  const { sendCommand } = useGSDWorkspaceActions()

  const boot = state.boot
  const workspace = boot?.workspace ?? null
  const auto = boot?.auto ?? null
  const bridge = boot?.bridge ?? null

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

  const handleWorkflowAction = (command: string) => {
    void sendCommand(buildPromptCommand(command, bridge))
  }

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
        <div className="flex items-center gap-3">
          <span className="font-medium">Power User Mode</span>
          {/* Compact workflow action bar */}
          <div className="flex items-center gap-2" data-testid="power-mode-action-bar">
            {workflowAction.primary && (
              <button
                onClick={() => handleWorkflowAction(workflowAction.primary!.command)}
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
                ) : (
                  <Play className="h-3 w-3" />
                )}
                {workflowAction.primary.label}
              </button>
            )}
            {workflowAction.secondaries.map((action) => (
              <button
                key={action.command}
                onClick={() => handleWorkflowAction(action.command)}
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
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Left: Auto Mode</span>
          <span className="text-border">|</span>
          <span>Right: Live Terminal</span>
        </div>
      </div>

      {/* Split terminals */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left terminal - Auto mode */}
        <div style={{ width: `${splitPosition}%` }} className="h-full overflow-hidden">
          <AutoTerminal />
        </div>

        {/* Divider */}
        <div
          className="flex w-1 cursor-col-resize items-center justify-center bg-border hover:bg-muted-foreground/30 transition-colors"
          onMouseDown={handleMouseDown}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>

        {/* Right terminal - Live S03 Terminal */}
        <div style={{ width: `${100 - splitPosition}%` }} className="h-full overflow-hidden">
          <Terminal className="h-full" />
        </div>
      </div>
    </div>
  )
}
