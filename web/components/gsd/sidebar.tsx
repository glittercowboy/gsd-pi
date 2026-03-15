"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Circle,
  Play,
  Folder,
  FileText,
  GitBranch,
  Settings,
  Terminal,
  LayoutDashboard,
  Map as MapIcon,
  Activity,
  Columns2,
  AlertTriangle,
  Loader2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  getCurrentScopeLabel,
  getProjectDisplayName,
  getSessionLabelFromBridge,
  getVisibleWorkspaceError,
  shortenPath,
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
  buildPromptCommand,
} from "@/lib/gsd-workspace-store"
import { getMilestoneStatus, getSliceStatus, getTaskStatus, type ItemStatus } from "@/lib/workspace-status"
import { deriveWorkflowAction } from "@/lib/workflow-actions"

const StatusIcon = ({ status }: { status: ItemStatus }) => {
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-foreground/70" />
  }
  if (status === "in-progress") {
    return <Play className="h-3.5 w-3.5 text-foreground" />
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
}

interface SidebarProps {
  activeView: string
  onViewChange: (view: string) => void
}

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  const workspace = useGSDWorkspaceState()
  const { sendCommand, openCommandSurface } = useGSDWorkspaceActions()
  const [expandedMilestones, setExpandedMilestones] = useState<string[]>([])
  const [expandedSlices, setExpandedSlices] = useState<string[]>([])

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "terminal", label: "Terminal", icon: Terminal },
    { id: "power", label: "Power Mode", icon: Columns2 },
    { id: "roadmap", label: "Roadmap", icon: MapIcon },
    { id: "files", label: "Files", icon: Folder },
    { id: "activity", label: "Activity", icon: Activity },
  ]

  const milestones = workspace.boot?.workspace.milestones ?? []
  const activeScope = workspace.boot?.workspace.active
  const projectLabel = getProjectDisplayName(workspace.boot?.project.cwd)
  const currentScope = getCurrentScopeLabel(workspace.boot?.workspace)
  const sessionLabel = getSessionLabelFromBridge(workspace.boot?.bridge)
  const validationCount = workspace.boot?.workspace.validationIssues.length ?? 0
  const visibleError = getVisibleWorkspaceError(workspace)

  useEffect(() => {
    if (!activeScope?.milestoneId) return
    setExpandedMilestones((previous) =>
      previous.includes(activeScope.milestoneId!) ? previous : [...previous, activeScope.milestoneId!],
    )
    if (activeScope.sliceId) {
      const sliceKey = `${activeScope.milestoneId}-${activeScope.sliceId}`
      setExpandedSlices((previous) => (previous.includes(sliceKey) ? previous : [...previous, sliceKey]))
    }
  }, [activeScope?.milestoneId, activeScope?.sliceId])

  const milestoneStatus = useMemo(() => {
    return new Map(milestones.map((milestone) => [milestone.id, getMilestoneStatus(milestone, activeScope ?? {})]))
  }, [milestones, activeScope])

  const toggleMilestone = (id: string) => {
    setExpandedMilestones((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id],
    )
  }

  const toggleSlice = (id: string) => {
    setExpandedSlices((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id],
    )
  }

  return (
    <div className="flex h-full">
      <div className="flex w-12 flex-col items-center gap-1 border-r border-border bg-sidebar py-3">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-md transition-colors",
              activeView === item.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
            title={item.label}
          >
            <item.icon className="h-5 w-5" />
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-1">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            title="Git"
            onClick={() => openCommandSurface("git", { source: "sidebar" })}
            data-testid="sidebar-git-button"
          >
            <GitBranch className="h-5 w-5" />
          </button>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            title="Settings"
            onClick={() => openCommandSurface("settings", { source: "sidebar" })}
            data-testid="sidebar-settings-button"
          >
            <Settings className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="flex w-64 flex-col border-r border-border bg-sidebar">
        <div className="border-b border-border px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Explorer
            </span>
            <span className="truncate text-[11px] text-muted-foreground" title={workspace.boot?.project.cwd || projectLabel}>
              {projectLabel}
            </span>
          </div>
          <div
            className="mt-2 truncate font-mono text-[11px] text-muted-foreground/80"
            title={workspace.boot?.project.cwd || "Project path pending"}
          >
            {workspace.boot?.project.cwd ? shortenPath(workspace.boot.project.cwd, 5) : "Resolving current project…"}
          </div>
        </div>

        <div className="border-b border-border px-3 py-3 text-xs">
          <div className="space-y-1.5">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Active scope</div>
              <div className="font-mono text-[11px] text-foreground" data-testid="sidebar-current-scope">
                {currentScope}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Session</div>
              <div className="truncate text-[11px] text-muted-foreground">{sessionLabel || "Waiting for live session…"}</div>
            </div>
            {validationCount > 0 && (
              <div className="flex items-center gap-1.5 text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>{validationCount} workspace validation issue{validationCount === 1 ? "" : "s"}</span>
              </div>
            )}
            {visibleError && (
              <div
                className="rounded border border-destructive/20 bg-destructive/10 px-2 py-1.5 text-destructive"
                data-testid="sidebar-bridge-error"
              >
                {visibleError}
              </div>
            )}
          </div>
        </div>

        {/* Quick Action Button */}
        {(() => {
          const wa = deriveWorkflowAction({
            phase: workspace.boot?.workspace.active.phase ?? "pre-planning",
            autoActive: workspace.boot?.auto.active ?? false,
            autoPaused: workspace.boot?.auto.paused ?? false,
            onboardingLocked: workspace.boot?.onboarding.locked ?? false,
            commandInFlight: workspace.commandInFlight,
            bootStatus: workspace.bootStatus,
            hasMilestones: (workspace.boot?.workspace.milestones.length ?? 0) > 0,
          })
          if (!wa.primary) return null
          return (
            <div className="border-b border-border px-3 py-2.5" data-testid="sidebar-quick-action">
              <button
                onClick={() => void sendCommand(buildPromptCommand(wa.primary!.command, workspace.boot?.bridge ?? null))}
                disabled={wa.disabled}
                className={cn(
                  "flex w-full items-center justify-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  wa.primary.variant === "destructive"
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                  wa.disabled && "cursor-not-allowed opacity-50",
                )}
                title={wa.disabledReason}
              >
                {workspace.commandInFlight ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {wa.primary.label}
              </button>
            </div>
          )
        })()}

        <div className="flex-1 overflow-y-auto py-1">
          <div className="px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Milestones
            </span>
          </div>

          {workspace.bootStatus === "loading" && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading workspace index…</div>
          )}

          {workspace.bootStatus === "error" && milestones.length === 0 && (
            <div className="px-3 py-2 text-xs text-destructive">Workspace boot failed before the explorer could load.</div>
          )}

          {workspace.bootStatus === "ready" && milestones.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No milestones found for this project.</div>
          )}

          {milestones.map((milestone) => {
            const milestoneOpen = expandedMilestones.includes(milestone.id)
            const milestoneActive = activeScope?.milestoneId === milestone.id
            const status = milestoneStatus.get(milestone.id) ?? "pending"

            return (
              <div key={milestone.id}>
                <button
                  onClick={() => toggleMilestone(milestone.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-2 py-1 text-sm transition-colors hover:bg-accent/50",
                    milestoneActive && "bg-accent/30",
                  )}
                >
                  {milestoneOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <StatusIcon status={status} />
                  <span className={cn("truncate", status === "pending" && "text-muted-foreground")}>
                    {milestone.id}: {milestone.title}
                  </span>
                </button>

                {milestoneOpen && (
                  <div className="ml-4">
                    {milestone.slices.map((slice) => {
                      const sliceKey = `${milestone.id}-${slice.id}`
                      const sliceOpen = expandedSlices.includes(sliceKey)
                      const sliceStatus = getSliceStatus(milestone.id, slice, activeScope ?? {})
                      const sliceActive = activeScope?.milestoneId === milestone.id && activeScope.sliceId === slice.id

                      return (
                        <div key={sliceKey}>
                          <button
                            onClick={() => toggleSlice(sliceKey)}
                            className={cn(
                              "flex w-full items-center gap-1.5 px-2 py-1 text-sm transition-colors hover:bg-accent/50",
                              sliceActive && "bg-accent/20",
                            )}
                          >
                            {sliceOpen ? (
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            )}
                            <StatusIcon status={sliceStatus} />
                            <span className={cn("truncate text-[13px]", sliceStatus === "pending" && "text-muted-foreground")}>
                              {slice.id}: {slice.title}
                            </span>
                          </button>

                          {sliceOpen && (
                            <div className="ml-5">
                              {slice.branch && (
                                <div className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                                  {slice.branch}
                                </div>
                              )}
                              {slice.tasks.map((task) => {
                                const taskStatus = getTaskStatus(milestone.id, slice.id, task, activeScope ?? {})
                                return (
                                  <div
                                    key={`${sliceKey}-${task.id}`}
                                    className={cn(
                                      "flex cursor-pointer items-center gap-1.5 px-2 py-0.5 text-xs transition-colors hover:bg-accent/50",
                                      activeScope?.taskId === task.id && sliceActive && "bg-accent/10",
                                    )}
                                  >
                                    <FileText className="h-3 w-3 text-muted-foreground" />
                                    <StatusIcon status={taskStatus} />
                                    <span className={cn("truncate", taskStatus === "pending" && "text-muted-foreground")}>
                                      {task.id}: {task.title}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
