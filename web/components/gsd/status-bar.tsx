"use client"

import { GitBranch, Cpu, DollarSign, Clock, Zap, AlertTriangle, Wifi, Info } from "lucide-react"
import {
  formatCost,
  formatDuration,
  formatTokens,
  getCurrentBranch,
  getCurrentScopeLabel,
  getModelLabel,
  getStatusPresentation,
  getVisibleWorkspaceError,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"

function toneClass(tone: ReturnType<typeof getStatusPresentation>["tone"]): string {
  switch (tone) {
    case "success":
      return "text-success"
    case "warning":
      return "text-amber-300"
    case "danger":
      return "text-destructive"
    default:
      return "text-muted-foreground"
  }
}

export function StatusBar() {
  const workspace = useGSDWorkspaceState()
  const status = getStatusPresentation(workspace)
  const branch = getCurrentBranch(workspace.boot?.workspace) ?? "project scope"
  const model = getModelLabel(workspace.boot?.bridge)
  const auto = workspace.boot?.auto
  const unitLabel = auto?.currentUnit?.id ?? getCurrentScopeLabel(workspace.boot?.workspace)
  const visibleError = getVisibleWorkspaceError(workspace)
  const titleOverride = workspace.titleOverride?.trim() || null
  const statusTexts = workspace.statusTexts
  const statusTextEntries = Object.entries(statusTexts)
  const latestStatusText = statusTextEntries.length > 0 ? statusTextEntries[statusTextEntries.length - 1][1] : null

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-card px-3 text-xs">
      <div className="flex min-w-0 items-center gap-4">
        <div className={`flex items-center gap-1.5 ${toneClass(status.tone)}`}>
          <Wifi className="h-3 w-3" />
          <span>{status.label}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          <span className="font-mono">{branch}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Cpu className="h-3 w-3" />
          <span className="font-mono">{model}</span>
        </div>
        {visibleError && (
          <div className="hidden max-w-sm items-center gap-1.5 truncate text-destructive lg:flex" data-testid="status-bar-error">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">{visibleError}</span>
          </div>
        )}
        {titleOverride && (
          <div className="hidden max-w-xs items-center gap-1.5 truncate text-foreground/80 xl:flex" data-testid="status-bar-title-override">
            <Info className="h-3 w-3 shrink-0" />
            <span className="truncate" title={titleOverride}>{titleOverride}</span>
          </div>
        )}
        {latestStatusText && !visibleError && (
          <div className="hidden max-w-xs items-center gap-1.5 truncate text-muted-foreground lg:flex" data-testid="status-bar-extension-status">
            <Info className="h-3 w-3 shrink-0" />
            <span className="truncate">{latestStatusText}</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>{formatDuration(auto?.elapsed ?? 0)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Zap className="h-3 w-3" />
          <span>{formatTokens(auto?.totalTokens ?? 0)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <DollarSign className="h-3 w-3" />
          <span>{formatCost(auto?.totalCost ?? 0)}</span>
        </div>
        <span className="max-w-[20rem] truncate text-muted-foreground" data-testid="status-bar-unit">
          {unitLabel}
        </span>
      </div>
    </div>
  )
}
