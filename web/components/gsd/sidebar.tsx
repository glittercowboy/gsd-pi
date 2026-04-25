"use client"

import { useMemo, useState, useSyncExternalStore } from "react"
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
  BarChart3,
  Columns2,
  MessagesSquare,
  LifeBuoy,
  LogOut,
  FolderKanban,
  Loader2,
  Milestone,
  SkipForward,
  Monitor,
  Sun,
  Moon,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useTheme } from "next-themes"
import {
  getCurrentScopeLabel,
  getLiveWorkspaceIndex,
  getLiveAutoDashboard,
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
  buildPromptCommand,
} from "@/lib/gsd-workspace-store"
import { getMilestoneStatus, getSliceStatus, getTaskStatus, type ItemStatus } from "@/lib/workspace-status"
import { deriveWorkflowAction } from "@/lib/workflow-actions"
import { executeWorkflowActionInPowerMode } from "@/lib/workflow-action-execution"
import { useProjectStoreManager } from "@/lib/project-store-manager"
import { Skeleton } from "@/components/ui/skeleton"
import { authFetch } from "@/lib/auth"

const StatusIcon = ({ status }: { status: ItemStatus }) => {
  if (status === "done") {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
  }
  if (status === "in-progress") {
    return <Play className="h-4 w-4 shrink-0 text-warning" />
  }
  if (status === "parked") {
    return <SkipForward className="h-4 w-4 shrink-0 text-muted-foreground" />
  }
  return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
}

/* ─── Nav Rail (left icon bar) ─── */

interface NavRailProps {
  activeView: string
  onViewChange: (view: string) => void
  isConnecting?: boolean
}

export function NavRail({ activeView, onViewChange, isConnecting = false }: NavRailProps) {
  const { openCommandSurface } = useGSDWorkspaceActions()
  const manager = useProjectStoreManager()
  const activeProjectCwd = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)
  const [exitDialogOpen, setExitDialogOpen] = useState(false)
  const { theme, setTheme } = useTheme()

  const cycleTheme = () => {
    if (theme === "system") setTheme("light")
    else if (theme === "light") setTheme("dark")
    else setTheme("system")
  }

  const themeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor
  const themeLabel = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"
  const ThemeIcon = themeIcon

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "power", label: "Power Mode", icon: Columns2 },
    { id: "chat", label: "Chat", icon: MessagesSquare },
    { id: "roadmap", label: "Roadmap", icon: MapIcon },
    { id: "files", label: "Files", icon: Folder },
    { id: "activity", label: "Activity", icon: Activity },
    { id: "visualize", label: "Visualize", icon: BarChart3 },
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
              ? "cursor-not-allowed text-muted-foreground/50"
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
          onClick={() => window.dispatchEvent(new CustomEvent("gsd:open-projects"))}
          disabled={isConnecting}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md transition-colors",
            isConnecting
              ? "cursor-not-allowed text-muted-foreground/50"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
          title={isConnecting ? "Connecting…" : "Projects"}
        >
          <FolderKanban className="h-5 w-5" />
        </button>
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
        <button
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors",
            isConnecting
              ? "cursor-not-allowed opacity-30"
              : "hover:bg-accent/50 hover:text-foreground",
          )}
          title={`Theme: ${themeLabel}`}
          disabled={isConnecting}
          onClick={() => !isConnecting && cycleTheme()}
          data-testid="sidebar-theme-toggle"
        >
          <ThemeIcon className="h-5 w-5" />
        </button>
        <button
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors",
            isConnecting
              ? "cursor-not-allowed opacity-30"
              : "hover:bg-destructive/15 hover:text-destructive",
          )}
          title="Exit"
          disabled={isConnecting}
          onClick={() => !isConnecting && setExitDialogOpen(true)}
          data-testid="sidebar-signoff-button"
        >
          <LogOut className="h-5 w-5" />
        </button>
        <ExitDialog
          open={exitDialogOpen}
          onOpenChange={setExitDialogOpen}
          projectCount={manager.getProjectCount()}
          activeProjectCwd={activeProjectCwd}
          onCloseProject={(cwd) => {
            manager.closeProject(cwd)
            onViewChange("dashboard")
            setExitDialogOpen(false)
          }}
          onStopServer={async () => {
            await authFetch("/api/shutdown", { method: "POST" }).catch(() => {})
            setTimeout(() => {
              try { window.close() } catch { /* ignore */ }
              setTimeout(() => { window.location.href = "about:blank" }, 300)
            }, 400)
          }}
        />
      </div>
    </div>
  )
}

/* ─── Exit Dialog (multi-project aware) ─── */

function ExitDialog({
  open,
  onOpenChange,
  projectCount,
  activeProjectCwd,
  onCloseProject,
  onStopServer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectCount: number
  activeProjectCwd: string | null
  onCloseProject: (cwd: string) => void
  onStopServer: () => void
}) {
  const hasMultipleProjects = projectCount > 1
  const projectName = activeProjectCwd ? activeProjectCwd.split("/").pop() ?? activeProjectCwd : null

  if (!hasMultipleProjects) {
    // Single project — simple stop server dialog
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stop the GSD web server?</DialogTitle>
            <DialogDescription>
              This will shut down the server process and close this tab. Run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">gsd --web</code> again to restart.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onStopServer}
            >
              Stop server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  // Multiple projects — offer close project vs stop server
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Close project or stop server?</DialogTitle>
          <DialogDescription>
            You have {projectCount} projects open. You can close just the current project or stop the entire server.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          {activeProjectCwd && (
            <Button
              variant="outline"
              className="h-auto justify-start gap-3 px-4 py-3 text-left"
              onClick={() => onCloseProject(activeProjectCwd)}
            >
              <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Close {projectName}</div>
                <div className="text-xs text-muted-foreground">
                  Disconnect this project and switch to another
                </div>
              </div>
            </Button>
          )}
          <Button
            variant="outline"
            className="h-auto justify-start gap-3 px-4 py-3 text-left border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            onClick={onStopServer}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium">Stop server</div>
              <div className="text-xs text-muted-foreground">
                Shut down all {projectCount} projects and close the tab
              </div>
            </div>
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── Milestone Explorer (right sidebar) ─── */

export function MilestoneExplorer({ isConnecting = false, width, onCollapse }: { isConnecting?: boolean; width?: number; onCollapse?: () => void }) {
  const workspace = useGSDWorkspaceState()
  const { openCommandSurface, setCommandSurfaceSection, sendCommand } = useGSDWorkspaceActions()
  const [expandedMilestones, setExpandedMilestones] = useState<string[]>([])
  const [expandedSlices, setExpandedSlices] = useState<string[]>([])

  const liveWorkspace = getLiveWorkspaceIndex(workspace)
  const milestones = useMemo(() => liveWorkspace?.milestones ?? [], [liveWorkspace?.milestones])
  const activeScope = liveWorkspace?.active
  const auto = getLiveAutoDashboard(workspace)
  const recoverySummary = workspace.live.recoverySummary
  const validationCount = liveWorkspace?.validationIssues.length ?? 0
  const currentScopeLabel = getCurrentScopeLabel(liveWorkspace)
  const projectCwd = workspace.boot?.project.cwd ?? null
  const bridge = workspace.boot?.bridge ?? null

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
    executeWorkflowActionInPowerMode({
      dispatch: () => sendCommand(buildPromptCommand(command, bridge)),
    })
  }

  const handlePrimaryAction = () => {
    if (!workflowAction.primary) return
    handleCommand(workflowAction.primary.command)
  }

  const handleOpenRecovery = () => {
    openCommandSurface("settings", { source: "sidebar" })
    setCommandSurfaceSection("recovery")
  }

  const effectiveExpandedMilestones =
    activeScope?.milestoneId && !expandedMilestones.includes(activeScope.milestoneId)
      ? [...expandedMilestones, activeScope.milestoneId]
      : expandedMilestones

  const effectiveExpandedSlices =
    activeScope?.milestoneId && activeScope.sliceId
      ? (() => {
          const sliceKey = `${activeScope.milestoneId}-${activeScope.sliceId}`
          return expandedSlices.includes(sliceKey) ? expandedSlices : [...expandedSlices, sliceKey]
        })()
      : expandedSlices

  const milestoneStatus = new Map(
    milestones.map((milestone) => [milestone.id, getMilestoneStatus(milestone, activeScope ?? {})]),
  )

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
    <div className="flex flex-col bg-sidebar" style={{ width: width ?? 256, flexShrink: 0 }}>
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
          <div className="flex items-start justify-between px-2 py-1.5">
            <div className="min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Milestones
              </span>
              <div className="mt-1 text-xs text-foreground" data-testid="sidebar-current-scope">
                {currentScopeLabel}
              </div>
            </div>
            {onCollapse && (
              <button
                onClick={onCollapse}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="Collapse sidebar"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {workspace.bootStatus === "error" && milestones.length === 0 && (
            <div className="px-3 py-2 text-xs text-destructive">Workspace boot failed before the explorer could load.</div>
          )}

          {workspace.bootStatus === "ready" && milestones.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No milestones found for this project.</div>
          )}

          {milestones.map((milestone) => {
            const milestoneOpen = effectiveExpandedMilestones.includes(milestone.id)
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
                  <span className={cn("truncate", (status === "pending" || status === "parked") && "text-muted-foreground")}>
                    {milestone.id}: {milestone.title}
                  </span>
                </button>

                {milestoneOpen && (
                  <div className="ml-4">
                    {milestone.slices.map((slice) => {
                      const sliceKey = `${milestone.id}-${slice.id}`
                      const sliceOpen = effectiveExpandedSlices.includes(sliceKey)
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
    </div>
  )
}

/* ─── Collapsed Milestone Sidebar (icon-only rail) ─── */

export function CollapsedMilestoneSidebar({ onExpand }: { onExpand: () => void }) {
  const workspace = useGSDWorkspaceState()
  const { sendCommand } = useGSDWorkspaceActions()

  const liveWorkspace = getLiveWorkspaceIndex(workspace)
  const milestones = liveWorkspace?.milestones ?? []
  const auto = getLiveAutoDashboard(workspace)
  const bridge = workspace.boot?.bridge ?? null

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
    executeWorkflowActionInPowerMode({
      dispatch: () => sendCommand(buildPromptCommand(command, bridge)),
    })
  }

  const handlePrimaryAction = () => {
    if (!workflowAction.primary) return
    handleCommand(workflowAction.primary.command)
  }

  return (
    <div className="flex h-full w-10 flex-col items-center border-l border-border bg-sidebar py-3">
      <button
        onClick={onExpand}
        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Expand milestone sidebar"
      >
        <PanelRightOpen className="h-4 w-4" />
      </button>

      {workflowAction.primary && (
        <div className="mt-auto pb-0.5">
          <button
            onClick={handlePrimaryAction}
            disabled={workflowAction.disabled}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
              workflowAction.primary.variant === "destructive"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
              workflowAction.disabled && "cursor-not-allowed opacity-50",
            )}
            title={workflowAction.disabledReason ?? workflowAction.primary.label}
          >
            {workspace.commandInFlight ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : workflowAction.isNewMilestone ? (
              <Milestone className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
    </div>
  )
}

/* ─── Legacy Sidebar export (back-compat) ─── */

interface SidebarProps {
  activeView: string
  onViewChange: (view: string) => void
  isConnecting?: boolean
  mobile?: boolean
}

export function Sidebar({ activeView, onViewChange, isConnecting = false, mobile = false }: SidebarProps) {
  if (mobile) {
    return <MobileNavPanel activeView={activeView} onViewChange={onViewChange} isConnecting={isConnecting} />
  }
  return (
    <div className="flex h-full">
      <NavRail activeView={activeView} onViewChange={onViewChange} isConnecting={isConnecting} />
    </div>
  )
}

/* ─── Mobile Nav Panel (full-width labels for touch) ─── */

function MobileNavPanel({ activeView, onViewChange, isConnecting = false }: NavRailProps) {
  const { openCommandSurface } = useGSDWorkspaceActions()
  const { theme, setTheme } = useTheme()

  const cycleTheme = () => {
    if (theme === "system") setTheme("light")
    else if (theme === "light") setTheme("dark")
    else setTheme("system")
  }

  const themeLabel = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "power", label: "Power Mode", icon: Columns2 },
    { id: "chat", label: "Chat", icon: MessagesSquare },
    { id: "roadmap", label: "Roadmap", icon: MapIcon },
    { id: "files", label: "Files", icon: Folder },
    { id: "activity", label: "Activity", icon: Activity },
    { id: "visualize", label: "Visualize", icon: BarChart3 },
  ]

  return (
    <div className="flex h-full flex-col bg-sidebar pt-14" data-testid="mobile-nav-panel">
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            disabled={isConnecting}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm font-medium transition-colors min-h-[44px]",
              isConnecting
                ? "cursor-not-allowed text-muted-foreground/50"
                : activeView === item.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <item.icon className="h-5 w-5 shrink-0" />
            {item.label}
          </button>
        ))}
      </div>
      <div className="border-t border-border px-2 py-2 space-y-1">
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("gsd:open-projects"))}
          disabled={isConnecting}
          className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors min-h-[44px]"
        >
          <FolderKanban className="h-5 w-5 shrink-0" />
          Projects
        </button>
        <button
          onClick={() => !isConnecting && openCommandSurface("git", { source: "sidebar" })}
          disabled={isConnecting}
          className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors min-h-[44px]"
        >
          <GitBranch className="h-5 w-5 shrink-0" />
          Git
        </button>
        <button
          onClick={() => !isConnecting && openCommandSurface("settings", { source: "sidebar" })}
          disabled={isConnecting}
          className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors min-h-[44px]"
        >
          <Settings className="h-5 w-5 shrink-0" />
          Settings
        </button>
        <button
          onClick={() => !isConnecting && cycleTheme()}
          disabled={isConnecting}
          className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors min-h-[44px]"
        >
          <ThemeIcon className="h-5 w-5 shrink-0" />
          Theme: {themeLabel}
        </button>
      </div>
    </div>
  )
}
