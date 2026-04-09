"use client"

import { useEffect, useState, useCallback } from "react"
import { GitBranch, Cpu, DollarSign, Clock, Zap, AlertTriangle, Wifi, Info, LifeBuoy } from "lucide-react"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import {
  buildProjectUrl,
  getCurrentBranch,
  getCurrentScopeLabel,
  getLiveAutoDashboard,
  getLiveWorkspaceIndex,
  getModelLabel,
  getStatusPresentation,
  getVisibleWorkspaceError,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"
import {
  formatCost as formatProjectCost,
  formatDuration as formatProjectDuration,
  formatTokenCount,
  type ProjectTotals,
} from "@/lib/visualizer-types"
import { ScopeBadgeInline } from "@/components/gsd/scope-badge"
import { authFetch } from "@/lib/auth"

function toneClass(tone: ReturnType<typeof getStatusPresentation>["tone"]): string {
  switch (tone) {
    case "success":
      return "text-success"
    case "warning":
      return "text-warning"
    case "danger":
      return "text-destructive"
    default:
      return "text-muted-foreground"
  }
}

export function StatusBar() {
  const workspace = useGSDWorkspaceState()
  const status = getStatusPresentation(workspace)
  const liveWorkspace = getLiveWorkspaceIndex(workspace)
  const auto = getLiveAutoDashboard(workspace)
  const branch = getCurrentBranch(liveWorkspace) ?? "project scope"
  const model = getModelLabel(workspace.boot?.bridge)
  const unitLabel = auto?.currentUnit?.id ?? getCurrentScopeLabel(liveWorkspace)
  const visibleError = getVisibleWorkspaceError(workspace)
  const titleOverride = workspace.titleOverride?.trim() || null
  const statusTexts = workspace.statusTexts
  const recoverySummary = workspace.live.recoverySummary
  const validationCount = getLiveWorkspaceIndex(workspace)?.validationIssues.length ?? 0
  const statusTextEntries = Object.entries(statusTexts)
  const latestStatusText = statusTextEntries.length > 0 ? statusTextEntries[statusTextEntries.length - 1][1] : null
  const isConnecting = workspace.bootStatus === "idle" || workspace.bootStatus === "loading"
  const projectCwd = workspace.boot?.project.cwd

  // ── Project-level totals from visualizer API ──
  const [projectTotals, setProjectTotals] = useState<ProjectTotals | null>(null)

  const fetchProjectTotals = useCallback(async () => {
    try {
      const resp = await authFetch(buildProjectUrl("/api/visualizer", projectCwd))
      if (!resp.ok) return
      const json = await resp.json()
      if (json.totals) setProjectTotals(json.totals)
    } catch {
      // Silently ignore — status bar is non-critical
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

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-card px-2 md:px-3 text-[10px] md:text-xs">
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <div className={`flex items-center gap-1.5 ${toneClass(status.tone)}`}>
          <Wifi className="h-3 w-3" />
          <span>{status.label}</span>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          {isConnecting ? (
            <Skeleton className="h-3 w-20" />
          ) : (
            <span className="font-mono">{branch}</span>
          )}
        </div>
        <div className="hidden lg:flex items-center gap-1.5 text-muted-foreground">
          <Cpu className="h-3 w-3" />
          {isConnecting ? (
            <Skeleton className="h-3 w-24" />
          ) : (
            <span className="font-mono">{model}</span>
          )}
        </div>
        {!isConnecting && (
          <div className="hidden max-w-xs items-center gap-1.5 truncate text-muted-foreground xl:flex" data-testid="status-bar-retry-compaction">
            <LifeBuoy className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {recoverySummary.retryInProgress ? `Retry ${Math.max(1, recoverySummary.retryAttempt)}` : recoverySummary.isCompacting ? "Compacting" : recoverySummary.freshness}
            </span>
          </div>
        )}
        {!isConnecting && (
          <div
            className={cn("hidden items-center gap-1.5 xl:flex", validationCount > 0 ? "text-warning" : "text-muted-foreground")}
            data-testid="status-bar-validation-count"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>{validationCount} issue{validationCount === 1 ? "" : "s"}</span>
          </div>
        )}
        {!isConnecting && visibleError && (
          <div className="hidden max-w-sm items-center gap-1.5 truncate text-destructive lg:flex" data-testid="status-bar-error">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">{visibleError}</span>
          </div>
        )}
        {!isConnecting && titleOverride && (
          <div className="hidden max-w-xs items-center gap-1.5 truncate text-foreground/80 xl:flex" data-testid="status-bar-title-override">
            <Info className="h-3 w-3 shrink-0" />
            <span className="truncate" title={titleOverride}>{titleOverride}</span>
          </div>
        )}
        {!isConnecting && latestStatusText && !visibleError && (
          <div className="hidden max-w-xs items-center gap-1.5 truncate text-muted-foreground lg:flex" data-testid="status-bar-extension-status">
            <Info className="h-3 w-3 shrink-0" />
            <span className="truncate">{latestStatusText}</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <div className="hidden sm:flex items-center gap-1.5 text-muted-foreground">
          <Clock className="h-3 w-3" />
          {isConnecting ? <Skeleton className="h-3 w-8" /> : <span>{formatProjectDuration(projectTotals?.duration ?? auto?.elapsed ?? 0)}</span>}
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-muted-foreground">
          <Zap className="h-3 w-3" />
          {isConnecting ? <Skeleton className="h-3 w-6" /> : <span>{formatTokenCount(projectTotals?.tokens.total ?? auto?.totalTokens ?? 0)}</span>}
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <DollarSign className="h-3 w-3" />
          {isConnecting ? <Skeleton className="h-3 w-10" /> : <span>{formatProjectCost(projectTotals?.cost ?? auto?.totalCost ?? 0)}</span>}
        </div>
        <span className="hidden sm:inline max-w-[20rem] truncate text-muted-foreground" data-testid="status-bar-unit">
          {isConnecting ? <Skeleton className="inline-block h-3 w-28 align-middle" /> : <ScopeBadgeInline label={unitLabel} />}
        </span>
      </div>
    </div>
  )
}
