"use client"

import {
  Activity,
  Clock,
  DollarSign,
  Zap,
  CheckCircle2,
  Circle,
  Play,
  GitBranch,
  Cpu,
  Wrench,
  MessageSquare,
  Loader2,
  Plus,
  ArrowRightLeft,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
  buildPromptCommand,
  formatDuration,
  formatCost,
  formatTokens,
  getCurrentScopeLabel,
  getCurrentBranch,
  getCurrentSlice,
  getLiveAutoDashboard,
  getLiveResumableSessions,
  getLiveWorkspaceIndex,
  getModelLabel,
  type WorkspaceTerminalLine,
  type TerminalLineType,
  type BootResumableSession,
} from "@/lib/gsd-workspace-store"
import { getTaskStatus, type ItemStatus } from "@/lib/workspace-status"
import { deriveWorkflowAction } from "@/lib/workflow-actions"

interface MetricCardProps {
  label: string
  value: string
  subtext?: string
  icon: React.ReactNode
}

function MetricCard({ label, value, subtext, icon }: MetricCardProps) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 truncate text-2xl font-semibold tracking-tight">{value}</p>
          {subtext && <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtext}</p>}
        </div>
        <div className="shrink-0 rounded-md bg-accent p-2 text-muted-foreground">{icon}</div>
      </div>
    </div>
  )
}

function taskStatusIcon(status: ItemStatus) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-foreground/70" />
    case "in-progress":
      return <Play className="h-4 w-4 text-foreground" />
    case "pending":
      return <Circle className="h-4 w-4 text-muted-foreground/50" />
  }
}

function activityDotColor(type: TerminalLineType): string {
  switch (type) {
    case "success":
      return "bg-success"
    case "error":
      return "bg-destructive"
    default:
      return "bg-foreground/50"
  }
}

function formatRelativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then
  if (diffMs < 60_000) return "just now"
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function Dashboard() {
  const state = useGSDWorkspaceState()
  const {
    sendCommand,
    submitInput,
    switchSessionFromSurface,
    openCommandSurface,
    setCommandSurfaceSection,
  } = useGSDWorkspaceActions()
  const boot = state.boot
  const workspace = getLiveWorkspaceIndex(state)
  const auto = getLiveAutoDashboard(state)
  const bridge = boot?.bridge ?? null
  const resumableSessions = getLiveResumableSessions(state)
  const recoverySummary = state.live.recoverySummary
  const freshness = state.live.freshness

  const activeToolExecution = state.activeToolExecution
  const streamingAssistantText = state.streamingAssistantText

  const elapsed = auto?.elapsed ?? 0
  const totalCost = auto?.totalCost ?? 0
  const totalTokens = auto?.totalTokens ?? 0

  const currentSlice = getCurrentSlice(workspace)
  const doneTasks = currentSlice?.tasks.filter((t) => t.done).length ?? 0
  const totalTasks = currentSlice?.tasks.length ?? 0
  const progressPercent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0

  const scopeLabel = getCurrentScopeLabel(workspace)
  const branch = getCurrentBranch(workspace)
  const model = getModelLabel(bridge)
  const isAutoActive = auto?.active ?? false
  const currentUnitLabel = auto?.currentUnit?.id ?? scopeLabel
  const currentUnitFreshness = freshness.auto.stale ? "stale" : freshness.auto.status
  const recoveryFreshness = freshness.recovery.stale ? "stale" : freshness.recovery.status

  const workflowAction = deriveWorkflowAction({
    phase: workspace?.active.phase ?? "pre-planning",
    autoActive: auto?.active ?? false,
    autoPaused: auto?.paused ?? false,
    onboardingLocked: boot?.onboarding.locked ?? false,
    commandInFlight: state.commandInFlight,
    bootStatus: state.bootStatus,
    hasMilestones: (workspace?.milestones.length ?? 0) > 0,
  })

  const handleWorkflowAction = (command: string) => {
    void sendCommand(buildPromptCommand(command, bridge))
  }

  const handleSessionSwitch = async (session: BootResumableSession) => {
    await switchSessionFromSurface(session.path)
  }

  const handleNewSession = async () => {
    await submitInput("/new")
  }

  const openRecoverySummary = () => {
    openCommandSurface("settings", { source: "surface" })
    setCommandSurfaceSection("recovery")
  }

  const recentLines: WorkspaceTerminalLine[] = (state.terminalLines ?? []).slice(-6)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{scopeLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                isAutoActive ? "animate-pulse bg-success" : "bg-muted-foreground/50",
              )}
            />
            <span className="font-medium">
              {isAutoActive ? "Auto Mode Active" : "Auto Mode Inactive"}
            </span>
          </div>
          {branch && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <GitBranch className="h-4 w-4" />
              <span className="font-mono">{branch}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-6 flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3" data-testid="dashboard-action-bar">
          {workflowAction.primary && (
            <button
              onClick={() => handleWorkflowAction(workflowAction.primary!.command)}
              disabled={workflowAction.disabled}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
                workflowAction.primary.variant === "destructive"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
                workflowAction.disabled && "cursor-not-allowed opacity-50",
              )}
              title={workflowAction.disabledReason}
            >
              {state.commandInFlight ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
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
                "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-accent",
                workflowAction.disabled && "cursor-not-allowed opacity-50",
              )}
              title={workflowAction.disabledReason}
            >
              {action.label}
            </button>
          ))}
          {state.commandInFlight && (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Sending…
            </span>
          )}
          {workflowAction.disabledReason && !state.commandInFlight && (
            <span className="ml-auto text-xs text-muted-foreground">
              {workflowAction.disabledReason}
            </span>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-md border border-border bg-card p-4" data-testid="dashboard-current-unit">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Current Unit</p>
                <p className="mt-1 truncate text-lg font-semibold tracking-tight">{currentUnitLabel}</p>
                <p className="mt-0.5 text-xs text-muted-foreground" data-testid="dashboard-current-unit-freshness">
                  Auto freshness: {currentUnitFreshness}
                </p>
              </div>
              <div className="shrink-0 rounded-md bg-accent p-2 text-muted-foreground">
                <Activity className="h-5 w-5" />
              </div>
            </div>
          </div>
          <MetricCard
            label="Elapsed Time"
            value={formatDuration(elapsed)}
            icon={<Clock className="h-5 w-5" />}
          />
          <MetricCard
            label="Total Cost"
            value={formatCost(totalCost)}
            icon={<DollarSign className="h-5 w-5" />}
          />
          <MetricCard
            label="Tokens Used"
            value={formatTokens(totalTokens)}
            icon={<Zap className="h-5 w-5" />}
          />
          <MetricCard
            label="Progress"
            value={totalTasks > 0 ? `${progressPercent}%` : "—"}
            subtext={totalTasks > 0 ? `${doneTasks}/${totalTasks} tasks complete` : "No active slice"}
            icon={<Activity className="h-5 w-5" />}
          />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-md border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">
                {currentSlice
                  ? `Current Slice: ${currentSlice.id} — ${currentSlice.title}`
                  : "Current Slice"}
              </h2>
            </div>
            <div className="space-y-3 p-4">
              {currentSlice && currentSlice.tasks.length > 0 ? (
                currentSlice.tasks.map((task) => {
                  const status = getTaskStatus(
                    workspace!.active.milestoneId!,
                    currentSlice.id,
                    task,
                    workspace!.active,
                  )
                  return (
                    <div key={task.id} className="flex items-center gap-3">
                      {taskStatusIcon(status)}
                      <div className="flex-1">
                        <span
                          className={cn(
                            "text-sm",
                            status === "pending" && "text-muted-foreground",
                          )}
                        >
                          {task.id}: {task.title}
                        </span>
                      </div>
                    </div>
                  )
                })
              ) : (
                <p className="text-sm text-muted-foreground">
                  No active slice or no tasks defined yet.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-md border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Session</h2>
            </div>
            <div className="p-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Model</span>
                  </div>
                  <span className="font-mono text-xs">{model}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Cost</span>
                  </div>
                  <span className="font-medium">{formatCost(totalCost)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Tokens</span>
                  </div>
                  <span>{formatTokens(totalTokens)}</span>
                </div>
                {activeToolExecution && (
                  <div className="flex items-center justify-between text-sm" data-testid="dashboard-active-tool">
                    <div className="flex items-center gap-2">
                      <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">Running</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                      <span className="font-mono text-xs">{activeToolExecution.name}</span>
                    </div>
                  </div>
                )}
                {streamingAssistantText.length > 0 && (
                  <div className="flex items-center justify-between text-sm" data-testid="dashboard-streaming">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">Agent</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-foreground/60 animate-pulse" />
                      <span className="text-xs">Streaming…</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border bg-card" data-testid="dashboard-recovery-summary">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Recovery Summary</h2>
            </div>
            <div className="space-y-4 p-4">
              <div>
                <div className="text-sm font-medium" data-testid="dashboard-recovery-summary-state">{recoverySummary.label}</div>
                <p className="mt-1 text-xs text-muted-foreground">{recoverySummary.detail}</p>
              </div>
              <div className="grid gap-2 text-xs text-muted-foreground">
                <div data-testid="dashboard-retry-freshness">Recovery freshness: {recoveryFreshness}</div>
                <div>Validation issues: {recoverySummary.validationCount}</div>
                <div>
                  Retry: {recoverySummary.retryInProgress ? `attempt ${Math.max(1, recoverySummary.retryAttempt)}` : recoverySummary.autoRetryEnabled ? "enabled" : "idle"}
                </div>
                <div>Compaction: {recoverySummary.isCompacting ? "active" : "idle"}</div>
                {recoverySummary.lastError && <div className="text-destructive">Last error: {recoverySummary.lastError.message}</div>}
              </div>
              <button
                type="button"
                onClick={openRecoverySummary}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
                data-testid="dashboard-recovery-summary-entrypoint"
              >
                {recoverySummary.entrypointLabel}
              </button>
            </div>
          </div>
        </div>

        {resumableSessions.length > 0 && (
          <div className="mt-6 rounded-md border border-border bg-card" data-testid="dashboard-session-picker">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Sessions</h2>
              <button
                onClick={() => void handleNewSession()}
                disabled={workflowAction.disabled}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent",
                  workflowAction.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <Plus className="h-3 w-3" />
                New Session
              </button>
            </div>
            <div className="divide-y divide-border">
              {resumableSessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5",
                    session.isActive && "bg-accent/20",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {session.name || session.id}
                      </span>
                      {session.isActive && (
                        <span className="flex-shrink-0 rounded-full bg-success/20 px-2 py-0.5 text-[10px] font-medium text-success">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{session.messageCount} messages</span>
                      <span>{formatRelativeTime(session.modifiedAt)}</span>
                    </div>
                  </div>
                  {!session.isActive && (
                    <button
                      onClick={() => void handleSessionSwitch(session)}
                      disabled={workflowAction.disabled}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent",
                        workflowAction.disabled && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <ArrowRightLeft className="h-3 w-3" />
                      Switch
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Recent Activity</h2>
          </div>
          {recentLines.length > 0 ? (
            <div className="divide-y divide-border">
              {recentLines.map((line) => (
                <div key={line.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="w-16 flex-shrink-0 font-mono text-xs text-muted-foreground">
                    {line.timestamp}
                  </span>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                      activityDotColor(line.type),
                    )}
                  />
                  <span className="truncate text-sm">{line.content}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-4 text-sm text-muted-foreground">
              No activity yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
