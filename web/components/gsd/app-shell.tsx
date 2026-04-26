"use client"

import Image from "next/image"
import dynamic from "next/dynamic"
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react"
import { Menu, X } from "lucide-react"
import { Sidebar, MilestoneExplorer, CollapsedMilestoneSidebar } from "@/components/gsd/sidebar"
import { ShellTerminal } from "@/components/gsd/shell-terminal"
import { Dashboard } from "@/components/gsd/dashboard"
import { StatusBar } from "@/components/gsd/status-bar"
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
  getStatusPresentation,
  getVisibleWorkspaceError,
  useGSDWorkspaceState,
  useGSDWorkspaceActions,
} from "@/lib/gsd-workspace-store"
import { ScopeBadge } from "@/components/gsd/scope-badge"
import { Badge } from "@/components/ui/badge"
import { ProjectsPanel, ProjectSelectionGate } from "@/components/gsd/projects-view"
import { UpdateBanner } from "@/components/gsd/update-banner"
import { getAuthToken } from "@/lib/auth"

const KNOWN_VIEWS = new Set(["dashboard", "power", "chat", "roadmap", "files", "activity", "visualize"])

const ViewLoading = () => (
  <div className="h-full w-full p-4">
    <Skeleton className="h-full w-full" />
  </div>
)

const Roadmap = dynamic(() => import("@/components/gsd/roadmap").then((mod) => mod.Roadmap), {
  loading: ViewLoading,
  ssr: false,
})
const FilesView = dynamic(() => import("@/components/gsd/files-view").then((mod) => mod.FilesView), {
  loading: ViewLoading,
  ssr: false,
})
const ActivityView = dynamic(() => import("@/components/gsd/activity-view").then((mod) => mod.ActivityView), {
  loading: ViewLoading,
  ssr: false,
})
const VisualizerView = dynamic(() => import("@/components/gsd/visualizer-view").then((mod) => mod.VisualizerView), {
  loading: ViewLoading,
  ssr: false,
})
const DualTerminal = dynamic(() => import("@/components/gsd/dual-terminal").then((mod) => mod.DualTerminal), {
  loading: ViewLoading,
  ssr: false,
})
const ChatMode = dynamic(() => import("@/components/gsd/chat-mode").then((mod) => mod.ChatMode), {
  loading: ViewLoading,
  ssr: false,
})

function viewStorageKey(projectCwd: string): string {
  return `gsd-active-view:${projectCwd}`
}

function WorkspaceChrome() {
  const [activeView, setActiveView] = useState("dashboard")
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(300)
  const [terminalDragActive, setTerminalDragActive] = useState(false)
  const isDraggingTerminal = useRef(false)
  const didDragTerminal = useRef(false)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(0)
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const isDraggingSidebar = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [viewRestored, setViewRestored] = useState(false)
  const [projectsPanelOpen, setProjectsPanelOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mobileMilestoneOpen, setMobileMilestoneOpen] = useState(false)
  const workspace = useGSDWorkspaceState()
  const { refreshBoot } = useGSDWorkspaceActions()

  const status = getStatusPresentation(workspace)
  const projectPath = workspace.boot?.project.cwd
  const projectLabel = getProjectDisplayName(projectPath)
  const titleOverride = workspace.titleOverride?.trim() || null
  const scopeLabel = getCurrentScopeLabel(workspace.boot?.workspace)
  const visibleError = getVisibleWorkspaceError(workspace)

  // Restore persisted view once boot provides projectCwd
  useEffect(() => {
    if (viewRestored || !projectPath) return
    const restoreTimer = window.setTimeout(() => {
      try {
        const stored = sessionStorage.getItem(viewStorageKey(projectPath))
        if (stored && KNOWN_VIEWS.has(stored)) {
          setActiveView(stored)
        }
      } catch {
        // sessionStorage may be unavailable (e.g. SSR, iframe sandbox)
      }
      setViewRestored(true)
    }, 0)
    return () => window.clearTimeout(restoreTimer)
  }, [projectPath, viewRestored])

  // Reset viewRestored when projectPath changes so the restore effect can
  // fire for the newly-selected project (fixes #2711: tab reset on switch).
  const prevProjectPath = useRef(projectPath)
  useEffect(() => {
    if (prevProjectPath.current !== projectPath) {
      prevProjectPath.current = projectPath
      setViewRestored(false)
    }
  }, [projectPath])

  // Persist view changes to sessionStorage
  useEffect(() => {
    if (!projectPath) return
    try {
      sessionStorage.setItem(viewStorageKey(projectPath), activeView)
    } catch {
      // sessionStorage may be unavailable
    }
  }, [activeView, projectPath])

  // Restore sidebar collapsed state from localStorage
  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const stored = localStorage.getItem("gsd-sidebar-collapsed")
        if (stored === "true") setSidebarCollapsed(true)
      } catch {
        // localStorage may be unavailable
      }
    }, 0)
    return () => window.clearTimeout(restoreTimer)
  }, [])

  // Persist sidebar collapsed state
  useEffect(() => {
    try {
      localStorage.setItem("gsd-sidebar-collapsed", String(sidebarCollapsed))
    } catch {
      // localStorage may be unavailable
    }
  }, [sidebarCollapsed])

  useEffect(() => {
    if (typeof document === "undefined") return
    const base = projectLabel ? `GSD - ${projectLabel}` : "GSD"
    document.title = titleOverride ? `${titleOverride} · ${base}` : base
  }, [titleOverride, projectLabel])

  // Close mobile nav on view change
  const handleViewChange = useCallback((view: string) => {
    setActiveView(view)
    setMobileNavOpen(false)
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

  // Listen for projects panel toggle (sidebar icon, or programmatic)
  useEffect(() => {
    const handler = () => setProjectsPanelOpen(true)
    window.addEventListener("gsd:open-projects", handler)
    return () => window.removeEventListener("gsd:open-projects", handler)
  }, [])

  // Terminal + sidebar panel drag-to-resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingTerminal.current) {
        didDragTerminal.current = true
        const delta = dragStartY.current - e.clientY
        const newHeight = Math.max(150, Math.min(600, dragStartHeight.current + delta))
        setTerminalHeight(newHeight)
      }
      if (isDraggingSidebar.current) {
        const delta = dragStartX.current - e.clientX
        const newWidth = Math.max(180, Math.min(480, dragStartWidth.current + delta))
        setSidebarWidth(newWidth)
      }
    }
    const handleMouseUp = () => {
      isDraggingTerminal.current = false
      isDraggingSidebar.current = false
      setTerminalDragActive(false)
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
      setTerminalDragActive(true)
      dragStartY.current = e.clientY
      dragStartHeight.current = terminalHeight
      document.body.style.cursor = "row-resize"
      document.body.style.userSelect = "none"
    },
    [terminalHeight],
  )

  const handleSidebarDragStart = useCallback(
    (e: React.MouseEvent) => {
      isDraggingSidebar.current = true
      dragStartX.current = e.clientX
      dragStartWidth.current = sidebarWidth
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    },
    [sidebarWidth],
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

  // Detect project welcome state — hide chrome for v1-legacy, brownfield, blank projects
  const detection = workspace.boot?.projectDetection
  const isWelcomeState =
    !isConnecting &&
    activeView === "dashboard" &&
    detection != null &&
    detection.kind !== "active-gsd" &&
    detection.kind !== "empty-gsd"

  // --- Unauthenticated gate ---
  // Render a clear recovery screen before any workspace chrome is mounted so
  // users who open a manually-typed URL (no #token= fragment) get actionable
  // guidance instead of a cascade of 401 errors.
  if (workspace.bootStatus === "unauthenticated") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-background p-8 text-center">
        <Image
          src="/logo-black.svg"
          alt="GSD"
          width={57}
          height={16}
          className="shrink-0 h-4 w-auto dark:hidden"
        />
        <Image
          src="/logo-white.svg"
          alt="GSD"
          width={57}
          height={16}
          className="shrink-0 h-4 w-auto hidden dark:block"
        />
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">Authentication Required</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            This workspace requires an auth token. Copy the full URL from your terminal
            (including the{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">#token=…</code>{" "}
            part) or restart with{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">gsd --web</code>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border bg-card px-2 md:px-4">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          {/* Mobile hamburger menu */}
          <button
            className="flex md:hidden h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
            aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
            data-testid="mobile-nav-toggle"
          >
            {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <div className="flex items-center gap-2">
            <Image
              src="/logo-black.svg"
              alt="GSD"
              width={57}
              height={16}
              className="shrink-0 h-4 w-auto dark:hidden"
            />
            <Image
              src="/logo-white.svg"
              alt="GSD"
              width={57}
              height={16}
              className="shrink-0 h-4 w-auto hidden dark:block"
            />
            <Badge variant="outline" className="hidden sm:inline-flex text-[10px] rounded-full border-foreground/15 bg-accent/40 text-muted-foreground font-normal">
              beta
            </Badge>
          </div>
          <span className="hidden sm:inline text-2xl font-thin text-muted-foreground leading-none select-none">/</span>
          <span className="hidden sm:inline text-sm text-muted-foreground truncate" data-testid="workspace-project-cwd" title={projectPath ?? undefined}>
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

        <div className="flex items-center gap-2 md:gap-3">
          {/* Hidden status marker for test instrumentation */}
          <span className="sr-only" data-testid="workspace-connection-status">{status.label}</span>
          <span
            className="hidden sm:inline text-xs text-muted-foreground"
            data-testid="workspace-scope-label"
          >
            {isConnecting ? <Skeleton className="inline-block h-3.5 w-40 align-middle" /> : <ScopeBadge label={scopeLabel} size="sm" />}
          </span>
        </div>
      </header>

      <UpdateBanner />

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

      {/* Mobile navigation drawer */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileNavOpen(false)}
          data-testid="mobile-nav-overlay"
        />
      )}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 transform bg-sidebar border-r border-border transition-transform duration-200 ease-out md:hidden",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full",
        )}
        data-testid="mobile-nav-drawer"
      >
        <Sidebar activeView={activeView} onViewChange={isConnecting ? () => {} : handleViewChange} isConnecting={isConnecting} mobile />
      </div>

      {/* Mobile milestone drawer */}
      {mobileMilestoneOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileMilestoneOpen(false)}
          data-testid="mobile-milestone-overlay"
        />
      )}
      {!isWelcomeState && (
        <div
          className={cn(
            "fixed inset-y-0 right-0 z-50 w-72 transform bg-sidebar border-l border-border transition-transform duration-200 ease-out md:hidden",
            mobileMilestoneOpen ? "translate-x-0" : "translate-x-full",
          )}
          data-testid="mobile-milestone-drawer"
        >
          <MilestoneExplorer
            isConnecting={isConnecting}
            width={288}
            onCollapse={() => setMobileMilestoneOpen(false)}
          />
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar — hidden on mobile */}
        <div className="hidden md:flex">
          <Sidebar activeView={activeView} onViewChange={isConnecting ? () => {} : handleViewChange} isConnecting={isConnecting} />
        </div>

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
                {activeView === "chat" && <ChatMode />}
              </>
            )}
          </div>

          {activeView !== "power" && activeView !== "chat" && (
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
                  <span className="text-[10px] text-muted-foreground">
                    {isTerminalExpanded ? "▼" : "▲"}
                  </span>
                </div>
              </div>
              {/* Terminal content */}
              <div
                className="overflow-hidden"
                style={{ height: isTerminalExpanded ? terminalHeight : 0, transition: terminalDragActive ? "none" : "height 200ms" }}
              >
                {isTerminalExpanded && (
                  <ShellTerminal className="h-full" projectCwd={workspace.boot?.project.cwd} />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Resizable milestone sidebar — hidden on mobile, hidden during project welcome */}
        {!isWelcomeState && !sidebarCollapsed && (
          <div
            className="relative hidden md:flex h-full items-stretch"
            style={{ flexShrink: 0 }}
          >
            {/* Thin visible border */}
            <div className="w-px bg-border" />
            {/* Wide invisible grab area overlapping the border */}
            <div
              className="absolute left-[-3px] top-0 bottom-0 w-[7px] cursor-col-resize z-10 hover:bg-muted-foreground/20 transition-colors"
              onMouseDown={handleSidebarDragStart}
            />
          </div>
        )}
        <div className="hidden md:flex">
          {!isWelcomeState && (sidebarCollapsed ? (
            <CollapsedMilestoneSidebar onExpand={() => setSidebarCollapsed(false)} />
          ) : (
            <MilestoneExplorer
              isConnecting={isConnecting}
              width={sidebarWidth}
              onCollapse={() => setSidebarCollapsed(true)}
            />
          ))}
        </div>
      </div>

      {/* Desktop status bar — hidden on mobile */}
      <div className="hidden md:block">
        <StatusBar />
      </div>

      {/* Mobile bottom bar — quick access to milestones + status */}
      {!isWelcomeState && (
        <div className="flex md:hidden h-12 items-center justify-between border-t border-border bg-card px-3" data-testid="mobile-bottom-bar">
          <div className="flex items-center gap-2 text-xs text-muted-foreground truncate">
            <span className="sr-only" data-testid="workspace-connection-status-mobile">{status.label}</span>
            <span className={cn("h-2 w-2 rounded-full shrink-0", status.tone === "success" ? "bg-success" : status.tone === "warning" ? "bg-warning" : status.tone === "danger" ? "bg-destructive" : "bg-muted-foreground")} />
            <span className="truncate">{scopeLabel}</span>
          </div>
          <button
            onClick={() => setMobileMilestoneOpen(!mobileMilestoneOpen)}
            className="flex h-10 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
            data-testid="mobile-milestone-toggle"
          >
            Milestones
          </button>
        </div>
      )}

      <ProjectsPanel open={projectsPanelOpen} onOpenChange={setProjectsPanelOpen} />
      <CommandSurface />
      <FocusedPanel />
      <OnboardingGate />
    </div>
  )
}

export function GSDAppShell() {
  // Extract the auth token from the URL fragment on first render.
  // Must happen before any API calls fire.
  getAuthToken()

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

  // Shut down all projects when the tab actually closes.
  // IMPORTANT: pagehide fires both on real page unload AND on mobile/Safari
  // tab switches (bfcache entry).  When event.persisted is true the page is
  // being cached for later reuse — the server must stay alive.  Only send
  // the shutdown beacon when the page is truly being discarded.
  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        // Page is entering bfcache (tab switch, app backgrounding) — keep
        // the server alive so PTY sessions survive.
        return
      }
      // sendBeacon cannot set custom headers, so pass the auth token as a
      // query parameter instead (the proxy accepts `_token` as a fallback).
      const token = getAuthToken()
      const url = token ? `/api/shutdown?_token=${token}` : "/api/shutdown"
      navigator.sendBeacon(url, "")
    }

    window.addEventListener("pagehide", handlePageHide)

    return () => {
      window.removeEventListener("pagehide", handlePageHide)
    }
  }, [])

  // No project selected yet — show project selection gate
  if (!activeProjectCwd || !activeStore) {
    return <ProjectSelectionGate />
  }

  return (
    <GSDWorkspaceProvider store={activeStore}>
      <DevOverridesProvider>
        <WorkspaceChrome />
      </DevOverridesProvider>
    </GSDWorkspaceProvider>
  )
}
