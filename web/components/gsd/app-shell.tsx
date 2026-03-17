"use client"

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react"
import { Sidebar, MilestoneExplorer } from "@/components/gsd/sidebar"
import { Terminal } from "@/components/gsd/terminal"
import { Dashboard } from "@/components/gsd/dashboard"
import { Roadmap } from "@/components/gsd/roadmap"
import { FilesView } from "@/components/gsd/files-view"
import { ActivityView } from "@/components/gsd/activity-view"
import { VisualizerView } from "@/components/gsd/visualizer-view"
import { StatusBar } from "@/components/gsd/status-bar"
import { DualTerminal } from "@/components/gsd/dual-terminal"
import { FocusedPanel } from "@/components/gsd/focused-panel"
import { OnboardingGate } from "@/components/gsd/onboarding-gate"
import { CommandSurface } from "@/components/gsd/command-surface"
import { DevOverridesProvider } from "@/lib/dev-overrides"
import { ProjectStoreManagerProvider, useProjectStoreManager } from "@/lib/project-store-manager"
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
import { ProjectsView } from "@/components/gsd/projects-view"

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

const KNOWN_VIEWS = new Set(["dashboard", "power", "roadmap", "files", "activity", "visualize", "projects"])

function viewStorageKey(projectCwd: string): string {
  return `gsd-active-view:${projectCwd}`
}

function WorkspaceChrome() {
  const [activeView, setActiveView] = useState("dashboard")
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(300)
  const isDraggingTerminal = useRef(false)
  const didDragTerminal = useRef(false)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(0)
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

  // Listen for cross-component file navigation events (e.g. sidebar task clicks)
  useEffect(() => {
    const handler = () => {
      setActiveView("files")
    }
    window.addEventListener("gsd:open-file", handler)
    return () => window.removeEventListener("gsd:open-file", handler)
  }, [])

  // Listen for cross-component view navigation events (e.g. /gsd visualize dispatch)
  useEffect(() => {
    const handler = (e: CustomEvent<{ view: string }>) => {
      if (KNOWN_VIEWS.has(e.detail.view)) {
        handleViewChange(e.detail.view)
      }
    }
    window.addEventListener("gsd:navigate-view", handler as EventListener)
    return () => window.removeEventListener("gsd:navigate-view", handler as EventListener)
  }, [handleViewChange])

  // Terminal panel drag-to-resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingTerminal.current) return
      didDragTerminal.current = true
      const delta = dragStartY.current - e.clientY
      const newHeight = Math.max(150, Math.min(600, dragStartHeight.current + delta))
      setTerminalHeight(newHeight)
    }
    const handleMouseUp = () => {
      isDraggingTerminal.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }
  }, [])

  const handleTerminalDragStart = useCallback(
    (e: React.MouseEvent) => {
      isDraggingTerminal.current = true
      dragStartY.current = e.clientY
      dragStartHeight.current = terminalHeight
      document.body.style.cursor = "row-resize"
      document.body.style.userSelect = "none"
    },
    [terminalHeight],
  )

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
            <img
              src="/logo-black.svg"
              alt="GSD"
              height={16}
              className="shrink-0 h-4 w-auto dark:hidden"
            />
            <img
              src="/logo-white.svg"
              alt="GSD"
              height={16}
              className="shrink-0 h-4 w-auto hidden dark:block"
            />
          </div>
          <span className="text-2xl font-thin text-muted-foreground/50 leading-none select-none">/</span>
          <span className="text-sm text-muted-foreground" data-testid="workspace-project-cwd" title={projectPath ?? undefined}>
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
          {/* Hidden status marker for test instrumentation */}
          <span className="sr-only" data-testid="workspace-connection-status">{status.label}</span>
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
                {activeView === "visualize" && <VisualizerView />}
                {activeView === "projects" && <ProjectsView />}
              </>
            )}
          </div>

          {activeView !== "power" && (
            <div className="border-t border-border flex flex-col" style={{ flexShrink: 0 }}>
              {/* Drag handle + toggle header — entire bar is clickable */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (didDragTerminal.current) {
                    didDragTerminal.current = false
                    return
                  }
                  if (!isConnecting) setIsTerminalExpanded(!isTerminalExpanded)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    if (!isConnecting) setIsTerminalExpanded(!isTerminalExpanded)
                  }
                }}
                className={cn(
                  "flex h-8 w-full items-center justify-between bg-card px-3 text-xs select-none transition-colors",
                  isTerminalExpanded && "cursor-row-resize",
                  !isTerminalExpanded && !isConnecting && "cursor-pointer hover:bg-muted/50",
                  isConnecting && "cursor-default",
                )}
                onMouseDown={(e) => {
                  if (isTerminalExpanded) handleTerminalDragStart(e)
                }}
              >
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="font-medium text-foreground">Terminal</span>
                  <span className="text-[10px] text-muted-foreground/50">
                    {isTerminalExpanded ? "▼" : "▲"}
                  </span>
                </div>
              </div>
              {/* Terminal content */}
              <div
                className="overflow-hidden"
                style={{ height: isTerminalExpanded ? terminalHeight : 0, transition: isDraggingTerminal.current ? "none" : "height 200ms" }}
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
    <ProjectStoreManagerProvider>
      <ProjectAwareWorkspace />
    </ProjectStoreManagerProvider>
  )
}

function ProjectAwareWorkspace() {
  const manager = useProjectStoreManager()
  const activeProjectCwd = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)
  const activeStore = activeProjectCwd ? manager.getActiveStore() : null

  // Shut down all projects when the tab actually closes
  useEffect(() => {
    const handlePageHide = () => {
      navigator.sendBeacon("/api/shutdown", "")
    }

    window.addEventListener("pagehide", handlePageHide)

    return () => {
      window.removeEventListener("pagehide", handlePageHide)
    }
  }, [])

  return (
    <GSDWorkspaceProvider store={activeStore ?? undefined}>
      <DevOverridesProvider>
        <BootProjectInitializer />
        <WorkspaceChrome />
      </DevOverridesProvider>
    </GSDWorkspaceProvider>
  )
}

/**
 * Auto-registers the boot project with the ProjectStoreManager.
 *
 * When the workspace boots and provides a project.cwd (from the server's launch
 * payload), this component calls manager.switchProject() to register the initial
 * project — enabling the multi-project flow without requiring explicit user action.
 *
 * Runs once on boot completion, then becomes a no-op.
 */
function BootProjectInitializer() {
  const manager = useProjectStoreManager()
  const workspace = useGSDWorkspaceState()
  const bootProjectCwd = workspace.boot?.project.cwd

  useEffect(() => {
    if (bootProjectCwd && !manager.getActiveProjectCwd()) {
      manager.switchProject(bootProjectCwd)
    }
  }, [bootProjectCwd, manager])

  return null
}
