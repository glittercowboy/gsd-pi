"use client"

import { useState, useEffect, useCallback } from "react"
import { Sidebar, MilestoneExplorer } from "@/components/gsd/sidebar"
import { Terminal } from "@/components/gsd/terminal"
import { Dashboard } from "@/components/gsd/dashboard"
import { Roadmap } from "@/components/gsd/roadmap"
import { FilesView } from "@/components/gsd/files-view"
import { ActivityView } from "@/components/gsd/activity-view"
import { StatusBar } from "@/components/gsd/status-bar"
import { DualTerminal } from "@/components/gsd/dual-terminal"
import { FocusedPanel } from "@/components/gsd/focused-panel"
import { OnboardingGate } from "@/components/gsd/onboarding-gate"
import { CommandSurface } from "@/components/gsd/command-surface"
import { DevOverridesProvider } from "@/lib/dev-overrides"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  GSDWorkspaceProvider,
  getCurrentScopeLabel,
  getProjectDisplayName,
  getSessionLabelFromBridge,
  getStatusPresentation,
  getVisibleWorkspaceError,
  shortenPath,
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
} from "@/lib/gsd-workspace-store"
import { ScopeBadge } from "@/components/gsd/scope-badge"

function statusPillClass(tone: ReturnType<typeof getStatusPresentation>["tone"]): string {
  switch (tone) {
    case "success":
      return "border-success/30 bg-success/10 text-success"
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-300"
    case "danger":
      return "border-destructive/30 bg-destructive/10 text-destructive"
    case "info":
      return "border-foreground/15 bg-accent/60 text-foreground"
    default:
      return "border-border bg-card text-muted-foreground"
  }
}

function connectionDotClass(tone: ReturnType<typeof getStatusPresentation>["tone"]): string {
  switch (tone) {
    case "success":
      return "bg-success"
    case "warning":
      return "bg-amber-400"
    case "danger":
      return "bg-destructive"
    case "info":
      return "bg-foreground/70"
    default:
      return "bg-muted-foreground/50"
  }
}

const KNOWN_VIEWS = new Set(["dashboard", "power", "roadmap", "files", "activity"])

function viewStorageKey(projectCwd: string): string {
  return `gsd-active-view:${projectCwd}`
}

function WorkspaceChrome() {
  const [activeView, setActiveView] = useState("dashboard")
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(false)
  const [viewRestored, setViewRestored] = useState(false)
  const workspace = useGSDWorkspaceState()
  const { refreshBoot } = useGSDWorkspaceActions()

  const status = getStatusPresentation(workspace)
  const projectPath = workspace.boot?.project.cwd
  const projectLabel = getProjectDisplayName(projectPath)
  const sessionLabel = getSessionLabelFromBridge(workspace.boot?.bridge)
  const titleOverride = workspace.titleOverride?.trim() || null
  const scopeLabel = getCurrentScopeLabel(workspace.boot?.workspace)
  const runtimeLabel = workspace.boot?.auto.active
    ? workspace.boot.auto.paused
      ? "PAUSED"
      : workspace.boot.auto.stepMode
        ? "STEP"
        : "AUTO"
    : "LIVE"
  const visibleError = getVisibleWorkspaceError(workspace)

  // Restore persisted view once boot provides projectCwd
  useEffect(() => {
    if (viewRestored || !projectPath) return
    try {
      const stored = sessionStorage.getItem(viewStorageKey(projectPath))
      if (stored && KNOWN_VIEWS.has(stored)) {
        setActiveView(stored)
      }
    } catch {
      // sessionStorage may be unavailable (e.g. SSR, iframe sandbox)
    }
    setViewRestored(true)
  }, [projectPath, viewRestored])

  // Persist view changes to sessionStorage
  useEffect(() => {
    if (!projectPath) return
    try {
      sessionStorage.setItem(viewStorageKey(projectPath), activeView)
    } catch {
      // sessionStorage may be unavailable
    }
  }, [activeView, projectPath])

  useEffect(() => {
    if (typeof document === "undefined") return
    document.title = titleOverride ? `${titleOverride} · GSD 2` : `${projectLabel} · GSD 2`
  }, [projectLabel, titleOverride])

  const handleViewChange = useCallback((view: string) => {
    setActiveView(view)
  }, [])

  const retryDisabled = !!workspace.commandInFlight || workspace.onboardingRequestState !== "idle"
  const isConnecting = workspace.bootStatus === "idle" || workspace.bootStatus === "loading"

  // Persistent loading toast — dismissed the moment boot completes
  useEffect(() => {
    if (!isConnecting) return
    const id = toast.loading("Connecting to workspace…", {
      description: "Establishing the live bridge session",
      duration: Infinity,
    })
    return () => {
      toast.dismiss(id)
    }
  }, [isConnecting])

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border bg-card px-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-foreground text-xs font-bold text-background">
              G
            </div>
            <span className="font-semibold tracking-tight">GSD 2</span>
          </div>
          <span className="text-2xl font-thin text-muted-foreground/50 leading-none select-none">/</span>
          <span className="text-sm text-muted-foreground" data-testid="workspace-project-cwd">
            {isConnecting ? (
              <Skeleton className="inline-block h-4 w-28 align-middle" />
            ) : (
              <>
                {projectLabel}
                {titleOverride && (
                  <span
                    className="ml-2 inline-flex items-center rounded-full border border-foreground/15 bg-accent/60 px-2 py-0.5 text-[10px] font-medium text-foreground"
                    data-testid="workspace-title-override"
                    title={titleOverride}
                  >
                    {titleOverride}
                  </span>
                )}
              </>
            )}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span
            className="text-xs text-muted-foreground"
            data-testid="workspace-scope-label"
          >
            {isConnecting ? <Skeleton className="inline-block h-3.5 w-40 align-middle" /> : <ScopeBadge label={scopeLabel} size="sm" />}
          </span>
        </div>
      </header>

      {!isConnecting && visibleError && (
        <div
          className="flex items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive"
          data-testid="workspace-error-banner"
        >
          <span className="flex-1">{visibleError}</span>
          <button
            onClick={() => void refreshBoot()}
            disabled={retryDisabled}
            className={cn(
              "flex-shrink-0 rounded border border-destructive/30 bg-background px-2 py-0.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10",
              retryDisabled && "cursor-not-allowed opacity-50",
            )}
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar activeView={activeView} onViewChange={isConnecting ? () => {} : handleViewChange} isConnecting={isConnecting} />

        <div className="flex flex-1 flex-col overflow-hidden">
          <div
            className={cn(
              "flex-1 overflow-hidden transition-all",
              isTerminalExpanded && "h-1/3",
            )}
          >
            {isConnecting ? (
              <Dashboard />
            ) : (
              <>
                {activeView === "dashboard" && (
                  <Dashboard
                    onSwitchView={handleViewChange}
                    onExpandTerminal={() => setIsTerminalExpanded(true)}
                  />
                )}
                {activeView === "power" && <DualTerminal />}
                {activeView === "roadmap" && <Roadmap />}
                {activeView === "files" && <FilesView />}
                {activeView === "activity" && <ActivityView />}
              </>
            )}
          </div>

          {activeView !== "power" && (
            <div className="border-t border-border">
              <button
                onClick={() => !isConnecting && setIsTerminalExpanded(!isTerminalExpanded)}
                disabled={isConnecting}
                className={cn(
                  "flex h-8 w-full items-center justify-between bg-card px-3 text-xs",
                  !isConnecting && "transition-colors hover:bg-accent/50",
                  isConnecting && "cursor-default",
                )}
              >
                <span className="min-w-0 flex items-center gap-2 text-muted-foreground">
                  <span className="font-medium text-foreground">Terminal</span>
                  <span className="truncate font-mono text-[10px]" data-testid="workspace-session-label">
                    {isConnecting ? (
                      <Skeleton className="inline-block h-3 w-36 align-middle" />
                    ) : (
                      sessionLabel || "Waiting for live session…"
                    )}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      isConnecting
                        ? "bg-muted-foreground/30 animate-pulse"
                        : connectionDotClass(status.tone),
                      !isConnecting && status.tone === "success" && "animate-pulse",
                    )}
                  />
                  <span className={cn("font-medium", isConnecting && "text-muted-foreground/50")}>
                    {runtimeLabel}
                  </span>
                </span>
              </button>
              <div
                className={cn(
                  "overflow-hidden transition-all duration-200",
                  isTerminalExpanded ? "h-64" : "h-0",
                )}
              >
                <Terminal className="h-full" />
              </div>
            </div>
          )}
        </div>

        <MilestoneExplorer isConnecting={isConnecting} />
      </div>

      <StatusBar />
      <CommandSurface />
      <OnboardingGate />
      <FocusedPanel />
    </div>
  )
}

export function GSDAppShell() {
  return (
    <GSDWorkspaceProvider>
      <DevOverridesProvider>
        <WorkspaceChrome />
      </DevOverridesProvider>
    </GSDWorkspaceProvider>
  )
}
