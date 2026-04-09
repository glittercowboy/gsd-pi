"use client"

import { useEffect, useState, useCallback } from "react"
import {
  Activity,
  Clock,
  DollarSign,
  Zap,
  CheckCircle2,
  Circle,
  Play,
  GitBranch,
  TrendingDown,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
  buildPromptCommand,
  buildProjectUrl,
  formatDuration,
  formatCost,
  formatTokens,
  getCurrentScopeLabel,
  getCurrentBranch,
  getCurrentSlice,
  getLiveAutoDashboard,
  getLiveWorkspaceIndex,
  type WorkspaceTerminalLine,
  type TerminalLineType,
} from "@/lib/gsd-workspace-store"
import { getTaskStatus, type ItemStatus } from "@/lib/workspace-status"
import { deriveWorkflowAction } from "@/lib/workflow-actions"
import { executeWorkflowActionInPowerMode } from "@/lib/workflow-action-execution"
import { Skeleton } from "@/components/ui/skeleton"
import {
  CurrentSliceCardSkeleton,
  ActivityCardSkeleton,
} from "@/components/gsd/loading-skeletons"
import { ScopeBadge } from "@/components/gsd/scope-badge"
import { ProjectWelcome } from "@/components/gsd/project-welcome"
import { authFetch } from "@/lib/auth"
import { type ProjectTotals } from "@/lib/visualizer-types"

/** Interpolate progress bar color from red (0%) through yellow (50%) to green (100%) using oklch. */
function getProgressColor(percent: number): string {
  const p = Math.max(0, Math.min(100, percent))
  // Hue: 25 (red) → 85 (yellow) at 50% → 145 (green) at 100%
  const hue = 25 + (p / 100) * 120
  return `oklch(0.65 0.16 ${hue.toFixed(1)})`
}

interface MetricCardProps {
  label: string
  value: string | null
  subtext?: string | null
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
          {value === null ? (
            <>
              <Skeleton className="mt-2 h-7 w-20" />
              <Skeleton className="mt-1.5 h-3 w-16" />
            </>
          ) : (
            <>
              <p className="mt-1 truncate text-2xl font-semibold tracking-tight">{value}</p>
              {subtext && <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtext}</p>}
            </>
          )}
        </div>
        <div className="shrink-0 rounded-md bg-accent p-2 text-muted-foreground">{icon}</div>
      </div>
    </div>
  )
}

function taskStatusIcon(status: ItemStatus) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
    case "in-progress":
      return <Play className="h-4 w-4 text-foreground" />
    case "pending":
      return <Circle className="h-4 w-4 text-muted-foreground" />
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

interface DashboardProps {
  onSwitchView?: (view: string) => void
  onExpandTerminal?: () => void
}

export function Dashboard({ onSwitchView, onExpandTerminal }: DashboardProps = {}) {
  const state = useGSDWorkspaceState()
  const { sendCommand } = useGSDWorkspaceActions()
  const boot = state.boot
  const workspace = getLiveWorkspaceIndex(state)
  const auto = getLiveAutoDashboard(state)
  const bridge = boot?.bridge ?? null
  const freshness = state.live.freshness
  const projectCwd = boot?.project.cwd

  // ── Project-level totals from visualizer API ──
  // Provides fallback metrics when auto-mode is not active (#2709).
  // Same polling pattern as status-bar.tsx.
  const [projectTotals, setProjectTotals] = useState<ProjectTotals | null>(null)

  const fetchProjectTotals = useCallback(async () => {
    try {
      const resp = await authFetch(buildProjectUrl("/api/visualizer", projectCwd))
      if (!resp.ok) return
      const json = await resp.json()
      if (json.totals) setProjectTotals(json.totals)
    } catch {
      // Silently ignore — dashboard metrics are non-critical
    }
  }, [projectCwd])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchProjectTotals()
    }, 0)
    const interval = window.setInterval(() => {
      void fetchProjectTotals()
    }, 30_000)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(interval)
    }
  }, [fetchProjectTotals])

  const elapsed = projectTotals?.duration ?? auto?.elapsed ?? 0
  const totalCost = projectTotals?.cost ?? auto?.totalCost ?? 0
  const totalTokens = projectTotals?.tokens.total ?? auto?.totalTokens ?? 0
  const rtkSavings = auto?.rtkSavings ?? null
  const rtkEnabled = auto?.rtkEnabled === true

  const currentSlice = getCurrentSlice(workspace)
  const doneTasks = currentSlice?.tasks.filter((t) => t.done).length ?? 0
  const totalTasks = currentSlice?.tasks.length ?? 0
  const progressPercent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0

  const scopeLabel = getCurrentScopeLabel(workspace)
  const branch = getCurrentBranch(workspace)
  const isAutoActive = auto?.active ?? false
  const currentUnitLabel = auto?.currentUnit?.id ?? scopeLabel
  const currentUnitFreshness = freshness.auto.stale ? "stale" : freshness.auto.status

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
    executeWorkflowActionInPowerMode({
      dispatch: () => sendCommand(buildPromptCommand(command, bridge)),
    })
  }

  const handlePrimaryAction = () => {
    if (!workflowAction.primary) return
    handleWorkflowAction(workflowAction.primary.command)
  }

  const recentLines: WorkspaceTerminalLine[] = (state.terminalLines ?? []).slice(-6)
  const isConnecting = state.bootStatus === "idle" || state.bootStatus === "loading"

  const rtkValue = isConnecting ? null : formatTokens(rtkSavings?.savedTokens ?? 0)
  const rtkSubtext = isConnecting
    ? null
    : rtkSavings && rtkSavings.commands > 0
      ? `${Math.round(rtkSavings.savingsPct)}% saved • ${rtkSavings.commands} cmd${rtkSavings.commands === 1 ? "" : "s"}`
      : "Waiting for shell usage"

  // ─── Project Welcome Gate ───────────────────────────────────────────
  // Show welcome screen for projects that aren't initialized with GSD yet
  const detection = boot?.projectDetection
  const showWelcome =
    !isConnecting &&
    detection &&
    detection.kind !== "active-gsd" &&
    detection.kind !== "empty-gsd"

  if (showWelcome) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <ProjectWelcome
          detection={detection}
          onCommand={(cmd) => handleWorkflowAction(cmd)}
          onSwitchView={(view) => onSwitchView?.(view)}
          disabled={!!state.commandInFlight || boot?.onboarding.locked}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 md:px-6 md:py-3">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-base md:text-lg font-semibold shrink-0">Dashboard</h1>
          {!isConnecting && scopeLabel && (
            <>
              <span className="hidden sm:inline text-lg font-thin text-muted-foreground select-none">/</span>
              <span className="hidden sm:inline"><ScopeBadge label={scopeLabel} size="sm" /></span>
            </>
          )}
          {isConnecting && <Skeleton className="h-4 w-40" />}
        </div>
        <div className="flex items-center gap-2 md:gap-3" data-testid="dashboard-action-bar">
          {isConnecting ? (
            <>
              <Skeleton className="h-8 w-40 rounded-md" />
            </>
          ) : null}
          {!isConnecting && (
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
          )}
          {!isConnecting && branch && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <GitBranch className="h-4 w-4" />
              <span className="font-mono">{branch}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">
          <div className="rounded-md border border-border bg-card p-4" data-testid="dashboard-current-unit">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Current Unit</p>
                {isConnecting ? (
                  <>
                    <Skeleton className="mt-2 h-7 w-20" />
                    <Skeleton className="mt-1.5 h-3 w-16" />
                  </>
                ) : (
                  <>
                    <div className="mt-2">
                      <ScopeBadge label={currentUnitLabel} />
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground" data-testid="dashboard-current-unit-freshness">
                      Auto freshness: {currentUnitFreshness}
                    </p>
                  </>
                )}
              </div>
              <div className="shrink-0 rounded-md bg-accent p-2 text-muted-foreground">
                <Activity className="h-5 w-5" />
              </div>
            </div>
          </div>
          <MetricCard
            label="Elapsed Time"
            value={isConnecting ? null : formatDuration(elapsed)}
            icon={<Clock className="h-5 w-5" />}
          />
          <MetricCard
            label="Total Cost"
            value={isConnecting ? null : formatCost(totalCost)}
            icon={<DollarSign className="h-5 w-5" />}
          />
          <MetricCard
            label="Tokens Used"
            value={isConnecting ? null : formatTokens(totalTokens)}
            icon={<Zap className="h-5 w-5" />}
          />
          {rtkEnabled && (
            <MetricCard
              label="RTK Saved"
              value={rtkValue}
              subtext={rtkSubtext}
              icon={<TrendingDown className="h-5 w-5" />}
            />
          )}

        </div>

        <div className="mt-6">
          {/* Current Slice */}
          {isConnecting ? (
            <CurrentSliceCardSkeleton />
          ) : (
            <div className="flex flex-col rounded-md border border-border bg-card">
              {/* Header */}
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Current Slice</h2>
                    {currentSlice ? (
                      <p className="mt-0.5 truncate text-sm font-medium text-foreground">
                        {currentSlice.id} — {currentSlice.title}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-sm text-muted-foreground">No active slice</p>
                    )}
                  </div>
                  {currentSlice && totalTasks > 0 && (
                    <div className="shrink-0 text-right">
                      <span className="text-2xl font-bold tabular-nums leading-none">{progressPercent}</span>
                      <span className="text-xs text-muted-foreground">%</span>
                    </div>
                  )}
                </div>
                {currentSlice && totalTasks > 0 && (
                  <div className="mt-3">
                    <div className="h-1 w-full overflow-hidden rounded-full bg-accent">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${progressPercent}%`, backgroundColor: getProgressColor(progressPercent) }}
                      />
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">{doneTasks} of {totalTasks} tasks complete</p>
                  </div>
                )}
              </div>
              {/* Task list */}
              <div className="flex-1 p-3">
                {currentSlice && currentSlice.tasks.length > 0 ? (
                  <div className="space-y-0.5">
                    {currentSlice.tasks.map((task) => {
                      const status = getTaskStatus(
                        workspace!.active.milestoneId!,
                        currentSlice.id,
                        task,
                        workspace!.active,
                      )
                      return (
                        <div
                          key={task.id}
                          className={cn(
                            "flex items-center gap-2.5 rounded px-2 py-1.5 transition-colors",
                            status === "in-progress" && "bg-accent",
                          )}
                        >
                          {taskStatusIcon(status)}
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-xs",
                              status === "done" && "text-muted-foreground line-through decoration-muted-foreground/40",
                              status === "pending" && "text-muted-foreground",
                              status === "in-progress" && "font-medium text-foreground",
                            )}
                          >
                            <span className="font-mono text-muted-foreground">{task.id}</span>
                            <span className="mx-1.5 text-border">·</span>
                            {task.title}
                          </span>
                          {status === "in-progress" && (
                            <span className="shrink-0 rounded-sm bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              active
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    No active slice or no tasks defined yet.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {isConnecting ? (
          <div className="mt-6">
            <ActivityCardSkeleton />
          </div>
        ) : (
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
        )}
      </div>
    </div>
  )
}
