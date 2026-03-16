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
  LayoutDashboard,
  Map as MapIcon,
  Activity,
  Columns2,
  LifeBuoy,
  LogOut,
  Loader2,
  Milestone,
  SkipForward,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import {
  getCurrentScopeLabel,
  getLiveWorkspaceIndex,
  getLiveAutoDashboard,
  buildPromptCommand,
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
} from "@/lib/gsd-workspace-store"
import { getMilestoneStatus, getSliceStatus, getTaskStatus, type ItemStatus } from "@/lib/workspace-status"
import { deriveWorkflowAction } from "@/lib/workflow-actions"
import { Skeleton } from "@/components/ui/skeleton"
import { NewMilestoneDialog } from "@/components/gsd/new-milestone-dialog"

const StatusIcon = ({ status }: { status: ItemStatus }) => {
  if (status === "done") {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
  }
  if (status === "in-progress") {
    return <Play className="h-4 w-4 shrink-0 text-amber-400" />
  }
  return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" />
}

/* ─── Nav Rail (left icon bar) ─── */

interface NavRailProps {
  activeView: string
  onViewChange: (view: string) => void
  isConnecting?: boolean
}

export function NavRail({ activeView, onViewChange, isConnecting = false }: NavRailProps) {
  const { openCommandSurface } = useGSDWorkspaceActions()

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "power", label: "Power Mode", icon: Columns2 },
    { id: "roadmap", label: "Roadmap", icon: MapIcon },
    { id: "files", label: "Files", icon: Folder },
    { id: "activity", label: "Activity", icon: Activity },
  ]

  return (
    <div className="flex w-12 flex-col items-center gap-1 border-r border-border bg-sidebar py-3">
      {navItems.map((item) => (
        <button
          key={item.id}
          onClick={() => onViewChange(item.id)}
          disabled={isConnecting}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md transition-colors",
            isConnecting
              ? "cursor-not-allowed text-muted-foreground/30"
              : activeView === item.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
          title={isConnecting ? "Connecting…" : item.label}
        >
          <item.icon className="h-5 w-5" />
        </button>
      ))}
      <div className="mt-auto flex flex-col gap-1">
        <button
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors",
            isConnecting
              ? "cursor-not-allowed opacity-30"
              : "hover:bg-accent/50 hover:text-foreground",
          )}
          title="Git"
          disabled={isConnecting}
          onClick={() => !isConnecting && openCommandSurface("git", { source: "sidebar" })}
          data-testid="sidebar-git-button"
        >
          <GitBranch className="h-5 w-5" />
        </button>
        <button
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors",
            isConnecting
              ? "cursor-not-allowed opacity-30"
              : "hover:bg-accent/50 hover:text-foreground",
          )}
          title="Settings"
          disabled={isConnecting}
          onClick={() => !isConnecting && openCommandSurface("settings", { source: "sidebar" })}
          data-testid="sidebar-settings-button"
        >
          <Settings className="h-5 w-5" />
        </button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors",
                isConnecting
                  ? "cursor-not-allowed opacity-30"
                  : "hover:bg-destructive/15 hover:text-destructive",
              )}
              title="Stop server"
              disabled={isConnecting}
              data-testid="sidebar-signoff-button"
            >
              <LogOut className="h-5 w-5" />
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop the GSD web server?</AlertDialogTitle>
              <AlertDialogDescription>
                This will shut down the server process and close this tab. Run{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">npm run gsd:web</code> again to restart.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={async () => {
                  await fetch("/api/shutdown", { method: "POST" }).catch(() => {})
                  setTimeout(() => {
                    try {
                      window.close()
                    } catch {
                      // ignore
                    }
                    setTimeout(() => {
                      window.location.href = "about:blank"
                    }, 300)
                  }, 400)
                }}
              >
                Stop server
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}

/* ─── Milestone Explorer (right sidebar) ─── */

export function MilestoneExplorer({ isConnecting = false }: { isConnecting?: boolean }) {
  const workspace = useGSDWorkspaceState()
  const { sendCommand, openCommandSurface, setCommandSurfaceSection } = useGSDWorkspaceActions()
  const [expandedMilestones, setExpandedMilestones] = useState<string[]>([])
  const [expandedSlices, setExpandedSlices] = useState<string[]>([])
  const [milestoneDialogOpen, setMilestoneDialogOpen] = useState(false)

  const liveWorkspace = getLiveWorkspaceIndex(workspace)
  const milestones = liveWorkspace?.milestones ?? []
  const activeScope = liveWorkspace?.active
  const auto = getLiveAutoDashboard(workspace)
  const bridge = workspace.boot?.bridge ?? null
  const recoverySummary = workspace.live.recoverySummary
  const validationCount = liveWorkspace?.validationIssues.length ?? 0
  const currentScopeLabel = getCurrentScopeLabel(liveWorkspace)
  const projectCwd = workspace.boot?.project.cwd ?? null

  const openTaskFile = (absolutePath: string | undefined) => {
    if (!absolutePath || !projectCwd) return
    const gsdPrefix = `${projectCwd}/.gsd/`
    if (!absolutePath.startsWith(gsdPrefix)) return
    const relativePath = absolutePath.slice(gsdPrefix.length)
    window.dispatchEvent(new CustomEvent("gsd:open-file", { detail: { root: "gsd", path: relativePath } }))
  }

  const workflowAction = deriveWorkflowAction({
    phase: liveWorkspace?.active.phase ?? "pre-planning",
    autoActive: auto?.active ?? false,
    autoPaused: auto?.paused ?? false,
    onboardingLocked: workspace.boot?.onboarding.locked ?? false,
    commandInFlight: workspace.commandInFlight,
    bootStatus: workspace.bootStatus,
    hasMilestones: milestones.length > 0,
    projectDetectionKind: workspace.boot?.projectDetection?.kind ?? null,
  })

  const handleCommand = (command: string) => {
    void sendCommand(buildPromptCommand(command, bridge))
  }

  const handlePrimaryAction = () => {
    if (!workflowAction.primary) return
    if (workflowAction.isNewMilestone) {
      setMilestoneDialogOpen(true)
    } else {
      handleCommand(workflowAction.primary.command)
    }
  }

  const handleOpenRecovery = () => {
    openCommandSurface("settings", { source: "sidebar" })
    setCommandSurfaceSection("recovery")
  }

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
    <div className="flex w-64 flex-col border-l border-border bg-sidebar">
      {isConnecting && (
        <div className="flex-1 overflow-y-auto px-1.5 py-1">
          <div className="px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Milestones
            </span>
          </div>
          <div className="space-y-0.5 px-1">
            {[1, 2].map((m) => (
              <div key={m}>
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <Skeleton className="h-4 w-4 shrink-0 rounded" />
                  <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
                  <Skeleton className={cn("h-4", m === 1 ? "w-40" : "w-32")} />
                </div>
                {m === 1 && (
                  <div className="ml-4 space-y-0.5">
                    {[1, 2, 3].map((s) => (
                      <div key={s} className="flex items-center gap-1.5 px-2 py-1.5">
                        <Skeleton className="h-4 w-4 shrink-0 rounded" />
                        <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
                        <Skeleton className={cn("h-3.5", s === 1 ? "w-32" : s === 2 ? "w-28" : "w-24")} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!isConnecting && (
        <div className="flex-1 overflow-y-auto px-1.5 py-1">
          <div className="px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Milestones
            </span>
            <div className="mt-1 text-xs text-foreground" data-testid="sidebar-current-scope">
              {currentScopeLabel}
            </div>
          </div>

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
                    "flex w-full items-center gap-1.5 px-2 py-1.5 text-sm transition-colors hover:bg-accent/50",
                    milestoneActive && "bg-accent/30",
                  )}
                >
                  {milestoneOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                              "flex w-full items-center gap-1.5 px-2 py-1.5 text-sm transition-colors hover:bg-accent/50",
                              sliceActive && "bg-accent/20",
                            )}
                          >
                            {sliceOpen ? (
                              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                                const hasFile = !!(task.planPath || task.summaryPath)
                                return (
                                  <button
                                    key={`${sliceKey}-${task.id}`}
                                    type="button"
                                    onClick={() => openTaskFile(task.summaryPath ?? task.planPath)}
                                    disabled={!hasFile}
                                    className={cn(
                                      "flex w-full items-center gap-1.5 px-2 py-1 text-xs transition-colors",
                                      hasFile ? "cursor-pointer hover:bg-accent/50" : "cursor-default opacity-70",
                                      activeScope?.taskId === task.id && sliceActive && "bg-accent/10",
                                    )}
                                  >
                                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    <StatusIcon status={taskStatus} />
                                    <span className={cn("truncate text-left", taskStatus === "pending" && "text-muted-foreground")}>
                                      {task.id}: {task.title}
                                    </span>
                                  </button>
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
      )}

      {/* Sticky action footer */}
      {!isConnecting && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
            <div className="min-w-0">
              <div className="font-medium text-foreground" data-testid="sidebar-validation-count">
                {validationCount} validation issue{validationCount === 1 ? "" : "s"}
              </div>
              <div className="truncate text-muted-foreground">{recoverySummary.label}</div>
            </div>
            <button
              type="button"
              onClick={handleOpenRecovery}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
              data-testid="sidebar-recovery-summary-entrypoint"
            >
              <LifeBuoy className="h-3.5 w-3.5" />
              Recovery
            </button>
          </div>
        </div>
      )}

      {!isConnecting && workflowAction.primary && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrimaryAction}
              disabled={workflowAction.disabled}
              className={cn(
                "inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
                workflowAction.primary.variant === "destructive"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
                workflowAction.disabled && "cursor-not-allowed opacity-50",
              )}
              title={workflowAction.disabledReason}
            >
              {workspace.commandInFlight ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : workflowAction.isNewMilestone ? (
                <Milestone className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {workflowAction.primary.label}
            </button>
            {workflowAction.secondaries.map((action) => (
              <button
                key={action.command}
                onClick={() => handleCommand(action.command)}
                disabled={workflowAction.disabled}
                className={cn(
                  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-accent",
                  workflowAction.disabled && "cursor-not-allowed opacity-50",
                )}
                title={action.label}
              >
                <SkipForward className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>
      )}

      <NewMilestoneDialog open={milestoneDialogOpen} onOpenChange={setMilestoneDialogOpen} />
    </div>
  )
}

/* ─── Legacy Sidebar export (back-compat) ─── */

interface SidebarProps {
  activeView: string
  onViewChange: (view: string) => void
  isConnecting?: boolean
}

export function Sidebar({ activeView, onViewChange, isConnecting = false }: SidebarProps) {
  return (
    <div className="flex h-full">
      <NavRail activeView={activeView} onViewChange={onViewChange} isConnecting={isConnecting} />
    </div>
  )
}
