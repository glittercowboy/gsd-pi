"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Archive,
  ArrowRightLeft,
  ArrowUpRight,
  Brain,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  KeyRound,
  LifeBuoy,
  LoaderCircle,
  LogIn,
  LogOut,
  PencilLine,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import {
  COMMAND_SURFACE_THINKING_LEVELS,
  type CommandSurfaceSection,
  type CommandSurfaceTarget,
} from "@/lib/command-surface-contract"
import { cn } from "@/lib/utils"
import {
  formatCost,
  formatTokens,
  getModelLabel,
  getSessionLabelFromBridge,
  shortenPath,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"

const SETTINGS_SURFACE_SECTIONS = ["model", "thinking", "queue", "compaction", "retry", "recovery", "auth"] as const
const GIT_SURFACE_SECTIONS = ["git"] as const
const SESSION_SURFACE_SECTIONS = ["resume", "name", "fork", "session", "compact"] as const

function availableSectionsForSurface(surface: string | null): CommandSurfaceSection[] {
  switch (surface) {
    case "git":
      return [...GIT_SURFACE_SECTIONS]
    case "resume":
    case "name":
    case "fork":
    case "session":
    case "export":
    case "compact":
      return [...SESSION_SURFACE_SECTIONS]
    default:
      return [...SETTINGS_SURFACE_SECTIONS]
  }
}

function sectionLabel(section: CommandSurfaceSection): string {
  switch (section) {
    case "model":
      return "Model"
    case "thinking":
      return "Thinking"
    case "queue":
      return "Queue"
    case "compaction":
      return "Auto-compact"
    case "retry":
      return "Retry"
    case "recovery":
      return "Recovery"
    case "auth":
      return "Auth"
    case "git":
      return "Git"
    case "resume":
      return "Resume"
    case "name":
      return "Name"
    case "fork":
      return "Fork"
    case "session":
      return "Session"
    case "compact":
      return "Compact"
  }
}

function sectionIcon(section: CommandSurfaceSection) {
  switch (section) {
    case "model":
      return <Cpu className="h-4 w-4" />
    case "thinking":
      return <Brain className="h-4 w-4" />
    case "queue":
      return <ArrowRightLeft className="h-4 w-4" />
    case "compaction":
      return <Archive className="h-4 w-4" />
    case "retry":
      return <RefreshCw className="h-4 w-4" />
    case "recovery":
      return <LifeBuoy className="h-4 w-4" />
    case "auth":
      return <ShieldCheck className="h-4 w-4" />
    case "git":
      return <GitBranch className="h-4 w-4" />
    case "resume":
      return <ArrowRightLeft className="h-4 w-4" />
    case "name":
      return <PencilLine className="h-4 w-4" />
    case "fork":
      return <GitBranch className="h-4 w-4" />
    case "session":
      return <FileText className="h-4 w-4" />
    case "compact":
      return <Archive className="h-4 w-4" />
  }
}

function sectionDescription(section: CommandSurfaceSection): string {
  switch (section) {
    case "model":
      return "Load available models from the live bridge and apply a real model change."
    case "thinking":
      return "Choose the thinking level that the current live session should use."
    case "queue":
      return "Adjust live steering and follow-up queue behavior; both settings also persist for later sessions."
    case "compaction":
      return "Toggle persisted auto-compaction behavior and see whether the live session is compacting right now."
    case "retry":
      return "Inspect retry-enabled and retry-in-progress state directly from the bridge, then change or abort it here."
    case "recovery":
      return "Load structured doctor, validation, bridge, and interrupted-run diagnostics from the dedicated recovery contract without parsing transcript text."
    case "auth":
      return "Manage browser sign-in, API-key setup, and logout against the current onboarding contract."
    case "git":
      return "Inspect the current-project repository branch and working tree from authoritative Git state instead of a dead sidebar control."
    case "resume":
      return "Switch the live browser workspace to another resumable project session."
    case "name":
      return "Search current-project sessions, pick one, and apply an authoritative session rename."
    case "fork":
      return "Load forkable user messages from the current session and create a new fork from one of them."
    case "session":
      return "Inspect current session stats and export the session as HTML from the browser surface."
    case "compact":
      return "Run a real manual compaction with optional custom instructions and inspect the resulting summary."
  }
}

function surfaceTitle(surface: string | null): string {
  switch (surface) {
    case "model":
      return "Model"
    case "thinking":
      return "Thinking"
    case "git":
      return "Git"
    case "login":
      return "Login"
    case "logout":
      return "Logout"
    case "settings":
      return "Settings"
    case "resume":
      return "Resume"
    case "name":
      return "Name"
    case "fork":
      return "Fork"
    case "session":
      return "Session"
    case "export":
      return "Export"
    case "compact":
      return "Compact"
    default:
      return "Command surface"
  }
}

function surfaceDescription(surface: string | null): string {
  switch (surface) {
    case "git":
      return "Browser-native Git summary loads current-project repo truth on demand and keeps not-a-repo or load failures visible in the shared surface."
    case "resume":
    case "name":
    case "fork":
    case "session":
    case "export":
    case "compact":
      return "Browser-native session controls reuse one shared surface for resume, naming, fork, session stats, export, and compaction."
    default:
      return "Browser-native command controls reuse one shared surface for model, thinking, queue, compaction, retry, and auth controls."
  }
}

function currentAuthIntent(activeSurface: string | null, selectedTarget: CommandSurfaceTarget | null): "login" | "logout" | "manage" {
  if (selectedTarget?.kind === "auth") return selectedTarget.intent
  if (activeSurface === "login") return "login"
  if (activeSurface === "logout") return "logout"
  return "manage"
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

export function CommandSurface() {
  const workspace = useGSDWorkspaceState()
  const {
    closeCommandSurface,
    openCommandSurface,
    refreshBoot,
    setCommandSurfaceSection,
    selectCommandSurfaceTarget,
    loadGitSummary,
    loadRecoveryDiagnostics,
    updateSessionBrowserState,
    loadSessionBrowser,
    renameSessionFromSurface,
    loadAvailableModels,
    applyModelSelection,
    applyThinkingLevel,
    setSteeringModeFromSurface,
    setFollowUpModeFromSurface,
    setAutoCompactionFromSurface,
    setAutoRetryFromSurface,
    abortRetryFromSurface,
    switchSessionFromSurface,
    loadSessionStats,
    exportSessionFromSurface,
    loadForkMessages,
    forkSessionFromSurface,
    compactSessionFromSurface,
    saveApiKeyFromSurface,
    startProviderFlowFromSurface,
    submitProviderFlowInputFromSurface,
    cancelProviderFlowFromSurface,
    logoutProviderFromSurface,
  } = useGSDWorkspaceActions()

  const { commandSurface } = workspace
  const onboarding = workspace.boot?.onboarding ?? null
  const activeFlow = onboarding?.activeFlow ?? null
  const gitSummary = commandSurface.gitSummary
  const recovery = commandSurface.recovery
  const sessionBrowser = commandSurface.sessionBrowser
  const liveSessionState = workspace.boot?.bridge.sessionState ?? null
  const settingsRequests = commandSurface.settingsRequests
  const currentModelLabel = getModelLabel(workspace.boot?.bridge)
  const currentSessionLabel = getSessionLabelFromBridge(workspace.boot?.bridge)
  const currentSessionFile = workspace.boot?.bridge.activeSessionFile ?? workspace.boot?.bridge.sessionState?.sessionFile ?? null
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [flowInput, setFlowInput] = useState("")

  useEffect(() => {
    if (!commandSurface.open || commandSurface.section !== "model") return
    if (commandSurface.availableModels.length > 0) return
    if (commandSurface.pendingAction === "loading_models") return
    void loadAvailableModels()
  }, [commandSurface.open, commandSurface.section, commandSurface.availableModels.length, commandSurface.pendingAction, loadAvailableModels])

  useEffect(() => {
    if (!commandSurface.open || commandSurface.section !== "git") return
    if (commandSurface.pendingAction === "load_git_summary") return
    if (commandSurface.gitSummary.loaded || commandSurface.gitSummary.error) return
    void loadGitSummary()
  }, [commandSurface.open, commandSurface.section, commandSurface.pendingAction, commandSurface.gitSummary.loaded, commandSurface.gitSummary.error, loadGitSummary])

  useEffect(() => {
    if (!commandSurface.open || commandSurface.section !== "recovery") return
    if (commandSurface.pendingAction === "load_recovery_diagnostics") return
    if (commandSurface.recovery.pending) return
    if (commandSurface.recovery.loaded && !commandSurface.recovery.stale && !commandSurface.recovery.error) return
    void loadRecoveryDiagnostics()
  }, [
    commandSurface.open,
    commandSurface.section,
    commandSurface.pendingAction,
    commandSurface.recovery.pending,
    commandSurface.recovery.loaded,
    commandSurface.recovery.stale,
    commandSurface.recovery.error,
    loadRecoveryDiagnostics,
  ])

  useEffect(() => {
    if (!commandSurface.open || (commandSurface.section !== "resume" && commandSurface.section !== "name")) return
    if (commandSurface.pendingAction === "load_session_browser") return
    if (commandSurface.sessionBrowser.loaded) return
    void loadSessionBrowser()
  }, [commandSurface.open, commandSurface.section, commandSurface.pendingAction, commandSurface.sessionBrowser.loaded, loadSessionBrowser])

  useEffect(() => {
    if (!commandSurface.open || commandSurface.section !== "session") return
    if (commandSurface.sessionStats) return
    if (commandSurface.pendingAction === "load_session_stats") return
    void loadSessionStats()
  }, [commandSurface.open, commandSurface.section, commandSurface.sessionStats, commandSurface.pendingAction, loadSessionStats])

  useEffect(() => {
    if (!commandSurface.open || commandSurface.section !== "fork") return
    if (commandSurface.forkMessages.length > 0) return
    if (commandSurface.pendingAction === "load_fork_messages") return
    void loadForkMessages()
  }, [commandSurface.open, commandSurface.section, commandSurface.forkMessages.length, commandSurface.pendingAction, loadForkMessages])

  useEffect(() => {
    if (!commandSurface.open || commandSurface.section !== "resume") return
    const selectedResumeTarget = commandSurface.selectedTarget?.kind === "resume" ? commandSurface.selectedTarget : null
    if (selectedResumeTarget?.sessionPath) return
    const defaultSession = sessionBrowser.sessions.find((session) => !session.isActive) ?? sessionBrowser.sessions[0]
    if (!defaultSession) return
    selectCommandSurfaceTarget({ kind: "resume", sessionPath: defaultSession.path })
  }, [commandSurface.open, commandSurface.section, commandSurface.selectedTarget, sessionBrowser.sessions, selectCommandSurfaceTarget])

  useEffect(() => {
    if (!commandSurface.open || commandSurface.section !== "name") return
    const selectedNameTarget = commandSurface.selectedTarget?.kind === "name" ? commandSurface.selectedTarget : null
    if (selectedNameTarget?.sessionPath) return
    const defaultSession = sessionBrowser.sessions.find((session) => session.isActive) ?? sessionBrowser.sessions[0]
    if (!defaultSession) return
    selectCommandSurfaceTarget({ kind: "name", sessionPath: defaultSession.path, name: defaultSession.name ?? "" })
  }, [commandSurface.open, commandSurface.section, commandSurface.selectedTarget, sessionBrowser.sessions, selectCommandSurfaceTarget])

  useEffect(() => {
    setFlowInput("")
  }, [activeFlow?.flowId])

  const selectedModelTarget = commandSurface.selectedTarget?.kind === "model" ? commandSurface.selectedTarget : null
  const selectedThinkingTarget = commandSurface.selectedTarget?.kind === "thinking" ? commandSurface.selectedTarget : null
  const selectedAuthTarget = commandSurface.selectedTarget?.kind === "auth" ? commandSurface.selectedTarget : null
  const selectedResumeTarget = commandSurface.selectedTarget?.kind === "resume" ? commandSurface.selectedTarget : null
  const selectedNameTarget = commandSurface.selectedTarget?.kind === "name" ? commandSurface.selectedTarget : null
  const selectedForkTarget = commandSurface.selectedTarget?.kind === "fork" ? commandSurface.selectedTarget : null
  const selectedSessionTarget = commandSurface.selectedTarget?.kind === "session" ? commandSurface.selectedTarget : null
  const selectedCompactTarget = commandSurface.selectedTarget?.kind === "compact" ? commandSurface.selectedTarget : null
  const selectedRenameSession =
    selectedNameTarget?.sessionPath ? sessionBrowser.sessions.find((session) => session.path === selectedNameTarget.sessionPath) ?? null : null

  const selectedAuthIntent = currentAuthIntent(commandSurface.activeSurface, commandSurface.selectedTarget)
  const selectedAuthProvider = onboarding?.required.providers.find((provider) => provider.id === selectedAuthTarget?.providerId) ?? null
  const modelQuery = (selectedModelTarget?.query ?? commandSurface.args).trim().toLowerCase()
  const filteredModels = useMemo(() => {
    if (!modelQuery) return commandSurface.availableModels
    return commandSurface.availableModels.filter((model) =>
      `${model.provider} ${model.modelId} ${model.name ?? ""}`.toLowerCase().includes(modelQuery),
    )
  }, [commandSurface.availableModels, modelQuery])

  const authBusy = workspace.onboardingRequestState !== "idle"
  const modelBusy = commandSurface.pendingAction === "loading_models" || workspace.commandInFlight === "get_available_models"
  const gitSummaryBusy = commandSurface.pendingAction === "load_git_summary"
  const recoveryBusy = commandSurface.pendingAction === "load_recovery_diagnostics" || recovery.pending
  const recoveryDiagnostics = recovery.diagnostics
  const sessionBrowserBusy = commandSurface.pendingAction === "load_session_browser"
  const forkBusy = commandSurface.pendingAction === "load_fork_messages" || commandSurface.pendingAction === "fork_session"
  const sessionBusy = commandSurface.pendingAction === "load_session_stats" || commandSurface.pendingAction === "export_html"
  const resumeBusy = commandSurface.pendingAction === "switch_session"
  const renameBusy = commandSurface.pendingAction === "rename_session"
  const compactBusy = commandSurface.pendingAction === "compact_session" || liveSessionState?.isCompacting === true
  const queueBusy = settingsRequests.steeringMode.pending || settingsRequests.followUpMode.pending
  const autoCompactionBusy = settingsRequests.autoCompaction.pending
  const autoRetryBusy = settingsRequests.autoRetry.pending
  const abortRetryBusy = settingsRequests.abortRetry.pending
  const selectedProviderApiKey = selectedAuthProvider ? apiKeys[selectedAuthProvider.id] ?? "" : ""
  const surfaceSections = availableSectionsForSurface(commandSurface.activeSurface)

  const triggerRecoveryBrowserAction = (actionId: string) => {
    switch (actionId) {
      case "refresh_diagnostics":
        void loadRecoveryDiagnostics()
        return
      case "refresh_workspace":
        void refreshBoot({ soft: true })
        return
      case "open_retry_controls":
        setCommandSurfaceSection("retry")
        return
      case "open_resume_controls":
        openCommandSurface("resume", { source: "surface" })
        return
      case "open_auth_controls":
        setCommandSurfaceSection("auth")
        return
      default:
        return
    }
  }

  const renderGitSummaryCard = () => {
    const result = gitSummary.result

    return (
      <Card data-testid="command-surface-git-summary">
        <CardHeader className="gap-3 border-b border-border/60 pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Current-project repo summary</CardTitle>
              <CardDescription>
                Read-only Git state from the current project instead of an inert sidebar button.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadGitSummary()}
              disabled={gitSummaryBusy}
              data-testid="command-surface-git-refresh"
            >
              <RefreshCw className={cn("h-4 w-4", gitSummaryBusy && "animate-spin")} />
              Refresh repo state
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-6">
          <div className="text-xs text-muted-foreground" data-testid="command-surface-git-state">
            {gitSummaryBusy
              ? "Loading current-project Git summary…"
              : gitSummary.error
                ? gitSummary.error
                : result?.kind === "not_repo"
                  ? result.message
                  : result
                    ? `${result.counts.changed} changed · ${result.counts.staged} staged · ${result.counts.dirty} dirty · ${result.counts.untracked} untracked · ${result.counts.conflicts} conflicts`
                    : "Ready to inspect the current-project repository."}
          </div>

          {gitSummary.error && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-testid="command-surface-git-error">
              {gitSummary.error}
            </div>
          )}

          {!gitSummary.error && gitSummaryBusy && !result ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading current-project repository state…
            </div>
          ) : null}

          {!gitSummary.error && result?.kind === "not_repo" && (
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4" data-testid="command-surface-git-not-repo">
              <div className="font-medium text-foreground">No Git repository for this project</div>
              <div className="mt-2 text-sm text-muted-foreground">{result.message}</div>
              <div className="mt-3 text-xs text-muted-foreground">{shortenPath(result.project.cwd, 5)}</div>
            </div>
          )}

          {!gitSummary.error && result?.kind === "repo" && (
            <>
              <div className="grid gap-3 md:grid-cols-2" data-testid="command-surface-git-meta">
                <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Current branch</div>
                  <div className="mt-2 font-medium text-foreground" data-testid="command-surface-git-branch">
                    {result.branch ?? "Detached HEAD"}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Main branch: {result.mainBranch ?? "Unavailable"}
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Scope</div>
                  <div className="mt-2 font-medium text-foreground">{shortenPath(result.project.repoRoot, 5)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {result.project.repoRelativePath ? `Project subpath: ${result.project.repoRelativePath}` : "Project root matches repo root"}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2" data-testid="command-surface-git-counts">
                <Badge variant={result.hasChanges ? "default" : "outline"}>{result.hasChanges ? "Dirty" : "Clean"}</Badge>
                <Badge variant="outline">{result.counts.staged} staged</Badge>
                <Badge variant="outline">{result.counts.dirty} dirty</Badge>
                <Badge variant="outline">{result.counts.untracked} untracked</Badge>
                <Badge variant={result.hasConflicts ? "destructive" : "outline"}>{result.counts.conflicts} conflicts</Badge>
              </div>

              {result.changedFiles.length > 0 ? (
                <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4" data-testid="command-surface-git-files">
                  <div>
                    <FieldTitle>Changed files</FieldTitle>
                    <FieldDescription>
                      Current-project status derived from Git porcelain parsing; refresh to reload authoritative repo truth.
                    </FieldDescription>
                  </div>
                  <div className="space-y-2">
                    {result.changedFiles.map((file) => (
                      <div key={`${file.status}:${file.repoPath}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2 text-sm">
                        <div className="min-w-0 flex-1 font-mono text-[12px] text-foreground">{file.path}</div>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="outline">{file.status}</Badge>
                          {file.staged && <Badge variant="outline">staged</Badge>}
                          {file.dirty && <Badge variant="outline">dirty</Badge>}
                          {file.untracked && <Badge variant="outline">untracked</Badge>}
                          {file.conflict && <Badge variant="destructive">conflict</Badge>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {result.truncatedFileCount > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {result.truncatedFileCount} additional changed file{result.truncatedFileCount === 1 ? "" : "s"} not shown here.
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground" data-testid="command-surface-git-clean">
                  No current-project file changes are pending.
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    )
  }

  const renderSessionBrowserCard = (mode: "resume" | "name") => {
    const renameMode = mode === "name"
    const selectedSessionPath = renameMode ? selectedNameTarget?.sessionPath : selectedResumeTarget?.sessionPath
    const selectedSession = selectedSessionPath
      ? sessionBrowser.sessions.find((session) => session.path === selectedSessionPath) ?? null
      : null

    return (
      <Card data-testid={renameMode ? "command-surface-name" : "command-surface-resume"}>
        <CardHeader className="gap-3 border-b border-border/60 pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">{renameMode ? "Rename a project session" : "Resume another session"}</CardTitle>
              <CardDescription>
                {renameMode
                  ? "Use the current-project browser surface to rename the active or any stored project session."
                  : `Current live session: ${currentSessionLabel ?? "session pending"}`}
              </CardDescription>
            </div>
            <Badge variant="outline">
              {sessionBrowser.loaded
                ? `${sessionBrowser.returnedSessions}/${sessionBrowser.totalSessions} current-project`
                : "Current project"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-6">
          <div className="space-y-4 rounded-2xl border border-border/70 bg-background/70 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[16rem] flex-1 space-y-2">
                <FieldLabel htmlFor="command-surface-session-browser-query">Search current-project sessions</FieldLabel>
                <Input
                  id="command-surface-session-browser-query"
                  data-testid="command-surface-session-browser-query"
                  value={sessionBrowser.query}
                  onChange={(event) => updateSessionBrowserState({ query: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      void loadSessionBrowser()
                    }
                  }}
                  placeholder="Search names, ids, paths, and session text"
                  disabled={sessionBrowserBusy}
                />
                <FieldDescription>
                  Querying stays current-project scoped and uses the dedicated browser contract instead of widening boot.
                </FieldDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadSessionBrowser()}
                disabled={sessionBrowserBusy}
                data-testid="command-surface-session-browser-refresh"
              >
                <RefreshCw className={cn("h-4 w-4", sessionBrowserBusy && "animate-spin")} />
                Refresh results
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              {(["threaded", "recent", "relevance"] as const).map((sortMode) => (
                <Button
                  key={sortMode}
                  type="button"
                  variant={sessionBrowser.sortMode === sortMode ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    updateSessionBrowserState({ sortMode })
                    void loadSessionBrowser({ sortMode })
                  }}
                  disabled={sessionBrowserBusy}
                  data-testid={`command-surface-session-browser-sort-${sortMode}`}
                >
                  {sortMode}
                </Button>
              ))}
              <Button
                type="button"
                variant={sessionBrowser.nameFilter === "named" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  const nextFilter = sessionBrowser.nameFilter === "named" ? "all" : "named"
                  updateSessionBrowserState({ nameFilter: nextFilter })
                  void loadSessionBrowser({ nameFilter: nextFilter })
                }}
                disabled={sessionBrowserBusy}
                data-testid="command-surface-session-browser-named-only"
              >
                {sessionBrowser.nameFilter === "named" ? "Named only" : "All sessions"}
              </Button>
            </div>

            <div className="text-xs text-muted-foreground" data-testid="command-surface-session-browser-meta">
              {sessionBrowser.scope === "current_project"
                ? `${sessionBrowser.returnedSessions} visible of ${sessionBrowser.totalSessions} current-project sessions`
                : "Current-project session browser"}
              {sessionBrowser.query.trim() ? ` · query: “${sessionBrowser.query.trim()}”` : ""}
            </div>

            {sessionBrowser.error && (
              <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="command-surface-session-browser-error">
                {sessionBrowser.error}
              </div>
            )}
          </div>

          {sessionBrowserBusy && sessionBrowser.sessions.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading current-project sessions…
            </div>
          ) : sessionBrowser.sessions.length > 0 ? (
            <div className="grid gap-3" data-testid="command-surface-session-browser-results">
              {sessionBrowser.sessions.map((session) => {
                const selected = session.path === selectedSessionPath
                const draftName =
                  renameMode && selectedNameTarget?.sessionPath === session.path ? selectedNameTarget.name : session.name ?? ""
                return (
                  <button
                    key={session.path}
                    type="button"
                    className={cn(
                      "rounded-2xl border px-4 py-3 text-left transition-all",
                      selected
                        ? "border-foreground/40 bg-foreground/[0.045] shadow-sm"
                        : "border-border/70 bg-background/70 hover:border-foreground/20 hover:bg-accent/40",
                    )}
                    style={{ paddingLeft: `${1 + session.depth * 0.85}rem` }}
                    onClick={() =>
                      renameMode
                        ? selectCommandSurfaceTarget({ kind: "name", sessionPath: session.path, name: draftName })
                        : selectCommandSurfaceTarget({ kind: "resume", sessionPath: session.path })
                    }
                    data-testid={`command-surface-session-browser-item-${session.id}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-medium text-foreground">{session.name || session.firstMessage || session.id}</div>
                          {session.isActive && <Badge>Active</Badge>}
                          {session.name && !session.isActive && <Badge variant="outline">Named</Badge>}
                          {session.depth > 0 && <Badge variant="outline">Depth {session.depth}</Badge>}
                        </div>
                        {session.name && (
                          <div className="mt-2 text-sm text-muted-foreground">{session.firstMessage}</div>
                        )}
                        <div className="mt-2 text-xs text-muted-foreground">{shortenPath(session.path)}</div>
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                          <span>{session.messageCount} messages</span>
                          <span>{formatRelativeTime(session.modifiedAt)}</span>
                          <span>{session.isLastInThread ? "Thread end" : "Thread continues"}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground">
              No current-project sessions matched the current browser query.
            </div>
          )}

          {renameMode ? (
            <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
              <FieldLabel htmlFor="command-surface-rename-input">Session name</FieldLabel>
              <Input
                id="command-surface-rename-input"
                data-testid="command-surface-rename-input"
                value={selectedNameTarget?.name ?? ""}
                onChange={(event) =>
                  selectCommandSurfaceTarget({
                    kind: "name",
                    sessionPath: selectedNameTarget?.sessionPath,
                    name: event.target.value,
                  })
                }
                placeholder="Enter a session display name"
                disabled={!selectedNameTarget?.sessionPath || renameBusy}
              />
              <FieldDescription>
                {selectedRenameSession
                  ? `Selected session: ${selectedRenameSession.name || selectedRenameSession.id}`
                  : "Select a session above to rename it."}
              </FieldDescription>
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground" data-testid="command-surface-rename-state">
                  {renameBusy
                    ? "Saving session name…"
                    : commandSurface.renameRequest.error ?? commandSurface.renameRequest.result ?? "Ready to rename"}
                </div>
                <Button
                  type="button"
                  onClick={() =>
                    selectedNameTarget?.sessionPath && void renameSessionFromSurface(selectedNameTarget.sessionPath, selectedNameTarget.name)
                  }
                  disabled={!selectedNameTarget?.sessionPath || !selectedNameTarget.name.trim() || renameBusy}
                  data-testid="command-surface-apply-rename"
                >
                  {renameBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PencilLine className="h-4 w-4" />}
                  Apply session name
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground" data-testid="command-surface-resume-state">
                {resumeBusy
                  ? "Switching live session…"
                  : commandSurface.resumeRequest.error ?? commandSurface.resumeRequest.result ?? "Select a session to resume it live"}
              </div>
              <Button
                type="button"
                onClick={() => selectedResumeTarget?.sessionPath && void switchSessionFromSurface(selectedResumeTarget.sessionPath)}
                disabled={!selectedResumeTarget?.sessionPath || resumeBusy}
                data-testid="command-surface-apply-resume"
              >
                {resumeBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
                Switch session
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Sheet open={commandSurface.open} onOpenChange={(open) => !open && closeCommandSurface()}>
      <SheetContent side="right" className="sm:max-w-2xl" data-testid="command-surface">
        <SheetHeader className="border-b border-border/70">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <SheetTitle data-testid="command-surface-title">{surfaceTitle(commandSurface.activeSurface)}</SheetTitle>
            {commandSurface.activeSurface && (
              <Badge variant="outline" data-testid="command-surface-kind">
                /{commandSurface.activeSurface}
              </Badge>
            )}
          </div>
          <SheetDescription>{surfaceDescription(commandSurface.activeSurface)}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <div className="sticky top-0 z-10 -mx-4 border-b border-border/60 bg-background/95 px-4 py-3 backdrop-blur">
            <div className="flex flex-wrap gap-2" data-testid="command-surface-sections">
              {surfaceSections.map((section) => (
                <Button
                  key={section}
                  type="button"
                  variant={commandSurface.section === section ? "default" : "outline"}
                  size="sm"
                  onClick={() => setCommandSurfaceSection(section)}
                  data-testid={`command-surface-section-${section}`}
                >
                  {sectionIcon(section)}
                  {sectionLabel(section)}
                </Button>
              ))}
            </div>
            {commandSurface.section && (
              <p className="mt-2 text-xs text-muted-foreground">{sectionDescription(commandSurface.section)}</p>
            )}
          </div>

          <div className="space-y-4 pt-4">
            {commandSurface.lastError && (
              <div
                className="rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                data-testid="command-surface-error"
              >
                <div className="flex items-start gap-3">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>{commandSurface.lastError}</div>
                </div>
              </div>
            )}

            {commandSurface.lastResult && !commandSurface.lastError && (
              <div
                className="rounded-xl border border-success/25 bg-success/10 px-4 py-3 text-sm text-success"
                data-testid="command-surface-result"
              >
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>{commandSurface.lastResult}</div>
                </div>
              </div>
            )}

            {commandSurface.section === "git" && renderGitSummaryCard()}

            {commandSurface.section === "model" && (
              <Card data-testid="command-surface-models">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">Live model selection</CardTitle>
                      <CardDescription>
                        Current session model: <span className="font-mono text-xs text-foreground">{currentModelLabel}</span>
                      </CardDescription>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void loadAvailableModels()} disabled={modelBusy}>
                      <RefreshCw className={cn("h-4 w-4", modelBusy && "animate-spin")} />
                      Refresh models
                    </Button>
                  </div>
                  {modelQuery && (
                    <div className="text-xs text-muted-foreground">Showing models matching “{modelQuery}”.</div>
                  )}
                </CardHeader>
                <CardContent className="space-y-3 pt-6">
                  {modelBusy && commandSurface.availableModels.length === 0 ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Loading models from the live bridge…
                    </div>
                  ) : filteredModels.length > 0 ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      {filteredModels.map((model) => {
                        const selected =
                          selectedModelTarget?.provider === model.provider &&
                          selectedModelTarget?.modelId === model.modelId
                        return (
                          <button
                            key={`${model.provider}/${model.modelId}`}
                            type="button"
                            className={cn(
                              "rounded-2xl border px-4 py-3 text-left transition-all",
                              selected
                                ? "border-foreground/40 bg-foreground/[0.045] shadow-sm"
                                : "border-border/70 bg-background/70 hover:border-foreground/20 hover:bg-accent/40",
                            )}
                            onClick={() =>
                              selectCommandSurfaceTarget({
                                kind: "model",
                                provider: model.provider,
                                modelId: model.modelId,
                                query: selectedModelTarget?.query,
                              })
                            }
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-medium text-foreground">{model.name || model.modelId}</div>
                                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                  {model.provider}/{model.modelId}
                                </div>
                              </div>
                              <div className="flex flex-wrap justify-end gap-1">
                                {model.isCurrent && <Badge>Current</Badge>}
                                {model.reasoning && <Badge variant="outline">Thinking</Badge>}
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground">
                      No models matched the current filter.
                    </div>
                  )}

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      onClick={() =>
                        selectedModelTarget?.provider &&
                        selectedModelTarget?.modelId &&
                        void applyModelSelection(selectedModelTarget.provider, selectedModelTarget.modelId)
                      }
                      disabled={!selectedModelTarget?.provider || !selectedModelTarget.modelId || commandSurface.pendingAction === "set_model"}
                      data-testid="command-surface-apply-model"
                    >
                      {commandSurface.pendingAction === "set_model" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Cpu className="h-4 w-4" />
                      )}
                      Apply model
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "thinking" && (
              <Card data-testid="command-surface-thinking">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <CardTitle className="text-lg">Thinking level</CardTitle>
                  <CardDescription>
                    Current level: <span className="font-mono text-xs text-foreground">{workspace.boot?.bridge.sessionState?.thinkingLevel ?? "off"}</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    {COMMAND_SURFACE_THINKING_LEVELS.map((level) => {
                      const selected = selectedThinkingTarget?.level === level
                      return (
                        <button
                          key={level}
                          type="button"
                          className={cn(
                            "rounded-2xl border px-4 py-3 text-left text-sm transition-all",
                            selected
                              ? "border-foreground/40 bg-foreground/[0.045] shadow-sm"
                              : "border-border/70 bg-background/70 hover:border-foreground/20 hover:bg-accent/40",
                          )}
                          onClick={() => selectCommandSurfaceTarget({ kind: "thinking", level })}
                        >
                          <div className="font-medium capitalize text-foreground">{level}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {level === "off" ? "Fastest path" : level === "minimal" ? "Light reasoning" : "More deliberate model work"}
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      onClick={() => selectedThinkingTarget && void applyThinkingLevel(selectedThinkingTarget.level)}
                      disabled={!selectedThinkingTarget || commandSurface.pendingAction === "set_thinking_level"}
                      data-testid="command-surface-apply-thinking"
                    >
                      {commandSurface.pendingAction === "set_thinking_level" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Brain className="h-4 w-4" />
                      )}
                      Apply thinking level
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "queue" && (
              <Card data-testid="command-surface-queue-settings">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <CardTitle className="text-lg">Queue modes</CardTitle>
                  <CardDescription>
                    Steering and follow-up modes change the live session immediately and also persist for later sessions.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 pt-6">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Current steering mode</div>
                      <div className="mt-2 font-medium text-foreground">{liveSessionState?.steeringMode ?? "pending"}</div>
                      <div className="mt-1 text-xs text-muted-foreground">Controls how new steering messages queue while the agent is already streaming.</div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Current follow-up mode</div>
                      <div className="mt-2 font-medium text-foreground">{liveSessionState?.followUpMode ?? "pending"}</div>
                      <div className="mt-1 text-xs text-muted-foreground">Controls how follow-up prompts queue when a live turn is already running.</div>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div>
                        <FieldTitle>Steering mode</FieldTitle>
                        <FieldDescription>Live-session behavior plus persisted default for later sessions.</FieldDescription>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          variant={liveSessionState?.steeringMode === "all" ? "default" : "outline"}
                          onClick={() => void setSteeringModeFromSurface("all")}
                          disabled={!liveSessionState || queueBusy || liveSessionState.steeringMode === "all"}
                          data-testid="command-surface-set-steering-all"
                        >
                          {settingsRequests.steeringMode.pending && commandSurface.pendingAction === "set_steering_mode" ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : null}
                          Queue all
                        </Button>
                        <Button
                          type="button"
                          variant={liveSessionState?.steeringMode === "one-at-a-time" ? "default" : "outline"}
                          onClick={() => void setSteeringModeFromSurface("one-at-a-time")}
                          disabled={!liveSessionState || queueBusy || liveSessionState.steeringMode === "one-at-a-time"}
                          data-testid="command-surface-set-steering-one-at-a-time"
                        >
                          One at a time
                        </Button>
                      </div>
                      <div className="text-xs text-muted-foreground" data-testid="command-surface-steering-mode-state">
                        {settingsRequests.steeringMode.pending
                          ? "Updating steering mode…"
                          : settingsRequests.steeringMode.error ??
                            settingsRequests.steeringMode.result ??
                            "The selected button reflects the live bridge state."}
                      </div>
                    </div>

                    <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div>
                        <FieldTitle>Follow-up mode</FieldTitle>
                        <FieldDescription>Changes how queued follow-up prompts are sequenced from this browser shell.</FieldDescription>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          variant={liveSessionState?.followUpMode === "all" ? "default" : "outline"}
                          onClick={() => void setFollowUpModeFromSurface("all")}
                          disabled={!liveSessionState || queueBusy || liveSessionState.followUpMode === "all"}
                          data-testid="command-surface-set-follow-up-all"
                        >
                          {settingsRequests.followUpMode.pending && commandSurface.pendingAction === "set_follow_up_mode" ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : null}
                          Queue all
                        </Button>
                        <Button
                          type="button"
                          variant={liveSessionState?.followUpMode === "one-at-a-time" ? "default" : "outline"}
                          onClick={() => void setFollowUpModeFromSurface("one-at-a-time")}
                          disabled={!liveSessionState || queueBusy || liveSessionState.followUpMode === "one-at-a-time"}
                          data-testid="command-surface-set-follow-up-one-at-a-time"
                        >
                          One at a time
                        </Button>
                      </div>
                      <div className="text-xs text-muted-foreground" data-testid="command-surface-follow-up-mode-state">
                        {settingsRequests.followUpMode.pending
                          ? "Updating follow-up mode…"
                          : settingsRequests.followUpMode.error ??
                            settingsRequests.followUpMode.result ??
                            "The selected button reflects the live bridge state."}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "compaction" && (
              <Card data-testid="command-surface-auto-compaction-settings">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <CardTitle className="text-lg">Auto-compaction</CardTitle>
                  <CardDescription>
                    Persist whether the session should compact automatically when thresholds are crossed. Manual compaction stays in the Compact section.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 pt-6">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Persisted setting</div>
                      <div className="mt-2 font-medium text-foreground">
                        {liveSessionState
                          ? liveSessionState.autoCompactionEnabled
                            ? "Enabled"
                            : "Disabled"
                          : "Pending bridge state"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">Applies to this session now and persists for later sessions.</div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Live session status</div>
                      <div className="mt-2 font-medium text-foreground">
                        {liveSessionState ? (liveSessionState.isCompacting ? "Compacting now" : "Idle") : "Pending bridge state"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">This is live bridge state, not a browser guess.</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      variant={liveSessionState?.autoCompactionEnabled ? "default" : "outline"}
                      onClick={() => void setAutoCompactionFromSurface(true)}
                      disabled={!liveSessionState || autoCompactionBusy || liveSessionState.autoCompactionEnabled === true}
                      data-testid="command-surface-enable-auto-compaction"
                    >
                      {autoCompactionBusy && commandSurface.pendingAction === "set_auto_compaction" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : null}
                      Enable auto-compaction
                    </Button>
                    <Button
                      type="button"
                      variant={liveSessionState?.autoCompactionEnabled === false ? "default" : "outline"}
                      onClick={() => void setAutoCompactionFromSurface(false)}
                      disabled={!liveSessionState || autoCompactionBusy || liveSessionState.autoCompactionEnabled === false}
                      data-testid="command-surface-disable-auto-compaction"
                    >
                      Disable auto-compaction
                    </Button>
                  </div>

                  <div className="text-xs text-muted-foreground" data-testid="command-surface-auto-compaction-state">
                    {settingsRequests.autoCompaction.pending
                      ? "Updating auto-compaction…"
                      : settingsRequests.autoCompaction.error ??
                        settingsRequests.autoCompaction.result ??
                        "Use the Compact section when you want a one-off manual compaction instead."}
                  </div>
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "retry" && (
              <Card data-testid="command-surface-retry-settings">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <CardTitle className="text-lg">Retry controls</CardTitle>
                  <CardDescription>
                    Inspect retry-enabled and retry-in-progress state directly from the bridge, then change the persisted setting or cancel the active retry.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 pt-6">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Persisted auto-retry setting</div>
                      <div className="mt-2 font-medium text-foreground">
                        {liveSessionState
                          ? liveSessionState.autoRetryEnabled
                            ? "Enabled"
                            : "Disabled"
                          : "Pending bridge state"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">The toggle persists; the live retry status below is session state.</div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Live retry state</div>
                      <div className="mt-2 font-medium text-foreground">
                        {liveSessionState
                          ? liveSessionState.retryInProgress
                            ? `Attempt ${Math.max(1, liveSessionState.retryAttempt)}`
                            : "Idle"
                          : "Pending bridge state"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {liveSessionState?.retryInProgress
                          ? "A scheduled retry is currently active and can be cancelled here."
                          : "No retry is currently scheduled."}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      variant={liveSessionState?.autoRetryEnabled ? "default" : "outline"}
                      onClick={() => void setAutoRetryFromSurface(true)}
                      disabled={!liveSessionState || autoRetryBusy || liveSessionState.autoRetryEnabled === true}
                      data-testid="command-surface-enable-auto-retry"
                    >
                      {autoRetryBusy && commandSurface.pendingAction === "set_auto_retry" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : null}
                      Enable auto-retry
                    </Button>
                    <Button
                      type="button"
                      variant={liveSessionState?.autoRetryEnabled === false ? "default" : "outline"}
                      onClick={() => void setAutoRetryFromSurface(false)}
                      disabled={!liveSessionState || autoRetryBusy || liveSessionState.autoRetryEnabled === false}
                      data-testid="command-surface-disable-auto-retry"
                    >
                      Disable auto-retry
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => void abortRetryFromSurface()}
                      disabled={!liveSessionState || abortRetryBusy || !liveSessionState.retryInProgress}
                      data-testid="command-surface-abort-retry"
                    >
                      {abortRetryBusy && commandSurface.pendingAction === "abort_retry" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : null}
                      Abort current retry
                    </Button>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="text-xs text-muted-foreground" data-testid="command-surface-auto-retry-state">
                      {settingsRequests.autoRetry.pending
                        ? "Updating auto-retry…"
                        : settingsRequests.autoRetry.error ??
                          settingsRequests.autoRetry.result ??
                          "Changing auto-retry updates the persisted setting and affects future transient failures."}
                    </div>
                    <div className="text-xs text-muted-foreground" data-testid="command-surface-abort-retry-state">
                      {settingsRequests.abortRetry.pending
                        ? "Cancelling the live retry…"
                        : settingsRequests.abortRetry.error ??
                          settingsRequests.abortRetry.result ??
                          (liveSessionState?.retryInProgress
                            ? `Retry attempt ${Math.max(1, liveSessionState.retryAttempt)} is currently active.`
                            : "No retry is currently active.")}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "recovery" && (
              <Card data-testid="command-surface-recovery">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">Recovery diagnostics</CardTitle>
                      <CardDescription>
                        On-demand doctor, validation, bridge, and interrupted-run diagnostics for the current project.
                      </CardDescription>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadRecoveryDiagnostics()}
                      disabled={recoveryBusy}
                      data-testid="command-surface-recovery-refresh"
                    >
                      <RefreshCw className={cn("h-4 w-4", recoveryBusy && "animate-spin")} />
                      Refresh diagnostics
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 pt-6">
                  <div className="text-xs text-muted-foreground" data-testid="command-surface-recovery-state">
                    {recoveryBusy
                      ? "Loading recovery diagnostics…"
                      : recovery.error
                        ? recovery.error
                        : recoveryDiagnostics
                          ? `${recoveryDiagnostics.summary.label}${recovery.stale ? " · stale" : ""}`
                          : "Load the current-project recovery diagnostics contract."}
                  </div>

                  {recovery.error && (
                    <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-testid="command-surface-recovery-error">
                      {recovery.error}
                    </div>
                  )}

                  {!recoveryDiagnostics && recoveryBusy && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Loading structured recovery diagnostics…
                    </div>
                  )}

                  {recoveryDiagnostics?.status === "unavailable" && !recovery.error && (
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4" data-testid="command-surface-recovery-unavailable">
                      <div className="font-medium text-foreground">{recoveryDiagnostics.summary.label}</div>
                      <div className="mt-2 text-sm text-muted-foreground">{recoveryDiagnostics.summary.detail}</div>
                    </div>
                  )}

                  {recoveryDiagnostics && (
                    <>
                      <div className="grid gap-3 md:grid-cols-2" data-testid="command-surface-recovery-summary">
                        <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">Current scope</div>
                          <div className="mt-2 font-medium text-foreground">{recoveryDiagnostics.project.activeScope ?? "project"}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {recoveryDiagnostics.summary.detail}
                          </div>
                        </div>
                        <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">Loaded</div>
                          <div className="mt-2 font-medium text-foreground">
                            {recovery.lastLoadedAt ? formatRelativeTime(recovery.lastLoadedAt) : "Not loaded yet"}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {recovery.stale
                              ? `Marked stale${recovery.lastInvalidatedAt ? ` ${formatRelativeTime(recovery.lastInvalidatedAt)}` : ""}`
                              : recoveryDiagnostics.loadedAt
                                ? `Captured ${formatRelativeTime(recoveryDiagnostics.loadedAt)}`
                                : "Fresh diagnostics"}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2" data-testid="command-surface-recovery-counts">
                        <Badge variant="outline">Validation {recoveryDiagnostics.summary.validationCount}</Badge>
                        <Badge variant="outline">Doctor {recoveryDiagnostics.summary.doctorIssueCount}</Badge>
                        <Badge variant={recoveryDiagnostics.summary.retryInProgress ? "default" : "outline"}>
                          {recoveryDiagnostics.summary.retryInProgress ? `Retry ${Math.max(1, recoveryDiagnostics.summary.retryAttempt)}` : "Retry idle"}
                        </Badge>
                        <Badge variant={recoveryDiagnostics.summary.compactionActive ? "default" : "outline"}>
                          {recoveryDiagnostics.summary.compactionActive ? "Compacting" : "Compaction idle"}
                        </Badge>
                        {recoveryDiagnostics.summary.lastFailurePhase && (
                          <Badge variant="destructive">Phase {recoveryDiagnostics.summary.lastFailurePhase}</Badge>
                        )}
                      </div>

                      {recoveryDiagnostics.bridge.lastFailure && (
                        <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-4" data-testid="command-surface-recovery-last-failure">
                          <div className="font-medium text-destructive">Last bridge failure</div>
                          <div className="mt-2 text-sm text-destructive">{recoveryDiagnostics.bridge.lastFailure.message}</div>
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-destructive/90">
                            <span>Phase: {recoveryDiagnostics.bridge.lastFailure.phase}</span>
                            {recoveryDiagnostics.bridge.lastFailure.commandType && <span>Command: {recoveryDiagnostics.bridge.lastFailure.commandType}</span>}
                            <span>{formatRelativeTime(recoveryDiagnostics.bridge.lastFailure.at)}</span>
                          </div>
                        </div>
                      )}

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4" data-testid="command-surface-recovery-validation">
                          <div>
                            <FieldTitle>Validation diagnostics</FieldTitle>
                            <FieldDescription>
                              {recoveryDiagnostics.validation.total > 0
                                ? "Current-project validation issues with stable rule ids and suggestions."
                                : "No validation issues are currently active."}
                            </FieldDescription>
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>Errors: {recoveryDiagnostics.validation.bySeverity.errors}</span>
                            <span>Warnings: {recoveryDiagnostics.validation.bySeverity.warnings}</span>
                            <span>Infos: {recoveryDiagnostics.validation.bySeverity.infos}</span>
                          </div>
                          {recoveryDiagnostics.validation.codes.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {recoveryDiagnostics.validation.codes.map((code) => (
                                <Badge key={code.code} variant={code.severity === "error" ? "destructive" : "outline"}>
                                  {code.code} · {code.count}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-muted-foreground">No validation codes are currently active.</div>
                          )}
                          {recoveryDiagnostics.validation.topIssues.length > 0 && (
                            <div className="space-y-2 text-sm">
                              {recoveryDiagnostics.validation.topIssues.map((issue) => (
                                <div key={`${issue.code}:${issue.file ?? issue.message}`} className="rounded-xl border border-border/60 px-3 py-2">
                                  <div className="font-medium text-foreground">{issue.code}</div>
                                  <div className="mt-1 text-muted-foreground">{issue.message}</div>
                                  {issue.suggestion && <div className="mt-1 text-xs text-muted-foreground">Suggested: {issue.suggestion}</div>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4" data-testid="command-surface-recovery-doctor">
                          <div>
                            <FieldTitle>Doctor diagnostics</FieldTitle>
                            <FieldDescription>
                              {recoveryDiagnostics.doctor.total > 0
                                ? `Scoped doctor findings for ${recoveryDiagnostics.doctor.scope ?? "the current project"}.`
                                : "No doctor findings are currently active."}
                            </FieldDescription>
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>Errors: {recoveryDiagnostics.doctor.errors}</span>
                            <span>Warnings: {recoveryDiagnostics.doctor.warnings}</span>
                            <span>Infos: {recoveryDiagnostics.doctor.infos}</span>
                            <span>Fixable: {recoveryDiagnostics.doctor.fixable}</span>
                          </div>
                          {recoveryDiagnostics.doctor.codes.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {recoveryDiagnostics.doctor.codes.map((code) => (
                                <Badge key={code.code} variant="outline">
                                  {code.code} · {code.count}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-muted-foreground">No doctor codes are currently active.</div>
                          )}
                          {recoveryDiagnostics.doctor.topIssues.length > 0 && (
                            <div className="space-y-2 text-sm">
                              {recoveryDiagnostics.doctor.topIssues.map((issue) => (
                                <div key={`${issue.code}:${issue.unitId ?? issue.message}`} className="rounded-xl border border-border/60 px-3 py-2">
                                  <div className="font-medium text-foreground">{issue.code}</div>
                                  <div className="mt-1 text-muted-foreground">{issue.message}</div>
                                  {issue.unitId && <div className="mt-1 text-xs text-muted-foreground">Scope: {issue.unitId}</div>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4" data-testid="command-surface-recovery-interrupted-run">
                        <div>
                          <FieldTitle>Interrupted-run diagnostics</FieldTitle>
                          <FieldDescription>{recoveryDiagnostics.interruptedRun.detail}</FieldDescription>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>Available: {recoveryDiagnostics.interruptedRun.available ? "yes" : "no"}</span>
                          <span>Detected: {recoveryDiagnostics.interruptedRun.detected ? "yes" : "no"}</span>
                          <span>Tool calls: {recoveryDiagnostics.interruptedRun.counts.toolCalls}</span>
                          <span>Files written: {recoveryDiagnostics.interruptedRun.counts.filesWritten}</span>
                          <span>Commands: {recoveryDiagnostics.interruptedRun.counts.commandsRun}</span>
                          <span>Errors: {recoveryDiagnostics.interruptedRun.counts.errors}</span>
                          <span>Git changes: {recoveryDiagnostics.interruptedRun.gitChangesDetected ? "yes" : "no"}</span>
                        </div>
                        {recoveryDiagnostics.interruptedRun.unit && (
                          <div className="text-sm text-foreground">
                            Last unit: {recoveryDiagnostics.interruptedRun.unit.type} · {recoveryDiagnostics.interruptedRun.unit.id}
                          </div>
                        )}
                        {recoveryDiagnostics.interruptedRun.lastError && (
                          <div className="text-sm text-destructive">Last forensic error: {recoveryDiagnostics.interruptedRun.lastError}</div>
                        )}
                      </div>

                      <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4" data-testid="command-surface-recovery-actions">
                        <div>
                          <FieldTitle>Browser actions</FieldTitle>
                          <FieldDescription>
                            These controls stay on the authoritative store command path instead of guessing from transcript text.
                          </FieldDescription>
                        </div>
                        <div className="flex flex-wrap gap-3">
                          {recoveryDiagnostics.actions.browser.map((action) => (
                            <Button
                              key={action.id}
                              type="button"
                              variant={action.emphasis === "danger" ? "destructive" : action.emphasis === "primary" ? "default" : "outline"}
                              onClick={() => triggerRecoveryBrowserAction(action.id)}
                              disabled={action.id === "refresh_diagnostics" ? recoveryBusy : false}
                              data-testid={`command-surface-recovery-action-${action.id}`}
                            >
                              {action.label}
                            </Button>
                          ))}
                        </div>
                        {recoveryDiagnostics.actions.commands.length > 0 && (
                          <div className="space-y-2">
                            <FieldTitle>Suggested commands</FieldTitle>
                            <div className="flex flex-wrap gap-2" data-testid="command-surface-recovery-commands">
                              {recoveryDiagnostics.actions.commands.map((command) => (
                                <Badge key={command.command} variant="outline" title={command.label}>
                                  {command.command}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "resume" && renderSessionBrowserCard("resume")}

            {commandSurface.section === "name" && renderSessionBrowserCard("name")}

            {commandSurface.section === "fork" && (
              <Card data-testid="command-surface-fork">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">Fork from a previous message</CardTitle>
                      <CardDescription>
                        Load real forkable user messages from the current session and create a new branch session from one.
                      </CardDescription>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void loadForkMessages()} disabled={forkBusy}>
                      <RefreshCw className={cn("h-4 w-4", commandSurface.pendingAction === "load_fork_messages" && "animate-spin")} />
                      Refresh fork points
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                  {forkBusy && commandSurface.forkMessages.length === 0 ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Loading forkable messages…
                    </div>
                  ) : commandSurface.forkMessages.length > 0 ? (
                    <div className="grid gap-3">
                      {commandSurface.forkMessages.map((message) => {
                        const selected = selectedForkTarget?.entryId === message.entryId
                        return (
                          <button
                            key={message.entryId}
                            type="button"
                            className={cn(
                              "rounded-2xl border px-4 py-3 text-left transition-all",
                              selected
                                ? "border-foreground/40 bg-foreground/[0.045] shadow-sm"
                                : "border-border/70 bg-background/70 hover:border-foreground/20 hover:bg-accent/40",
                            )}
                            onClick={() => selectCommandSurfaceTarget({ kind: "fork", entryId: message.entryId })}
                          >
                            <div className="font-mono text-[11px] text-muted-foreground">{message.entryId}</div>
                            <div className="mt-2 text-sm text-foreground">{message.text}</div>
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground">
                      No user messages are available for forking yet.
                    </div>
                  )}

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      onClick={() => selectedForkTarget?.entryId && void forkSessionFromSurface(selectedForkTarget.entryId)}
                      disabled={!selectedForkTarget?.entryId || commandSurface.pendingAction === "fork_session"}
                      data-testid="command-surface-apply-fork"
                    >
                      {commandSurface.pendingAction === "fork_session" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <GitBranch className="h-4 w-4" />
                      )}
                      Create fork
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "session" && (
              <Card data-testid="command-surface-session">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">Current session details</CardTitle>
                      <CardDescription>
                        Inspect stats for the active session and export the exact session tree to HTML.
                      </CardDescription>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void loadSessionStats()} disabled={sessionBusy}>
                      <RefreshCw className={cn("h-4 w-4", commandSurface.pendingAction === "load_session_stats" && "animate-spin")} />
                      Refresh stats
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 pt-6">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Active session</div>
                      <div className="mt-2 font-medium text-foreground">{currentSessionLabel ?? "session pending"}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{currentSessionFile ? shortenPath(currentSessionFile) : "No session file attached yet"}</div>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Loaded stats</div>
                      <div className="mt-2 font-medium text-foreground">{commandSurface.sessionStats?.sessionId ?? "Not loaded yet"}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {commandSurface.sessionStats?.sessionFile ? shortenPath(commandSurface.sessionStats.sessionFile) : "Refresh to inspect the current session snapshot"}
                      </div>
                    </div>
                  </div>

                  {commandSurface.sessionStats ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Messages</div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                          <div>User: {commandSurface.sessionStats.userMessages}</div>
                          <div>Assistant: {commandSurface.sessionStats.assistantMessages}</div>
                          <div>Tool calls: {commandSurface.sessionStats.toolCalls}</div>
                          <div>Tool results: {commandSurface.sessionStats.toolResults}</div>
                          <div className="col-span-2 font-medium">Total: {commandSurface.sessionStats.totalMessages}</div>
                        </div>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Tokens + cost</div>
                        <div className="mt-3 space-y-2 text-sm">
                          <div>Input: {formatTokens(commandSurface.sessionStats.tokens.input)}</div>
                          <div>Output: {formatTokens(commandSurface.sessionStats.tokens.output)}</div>
                          {commandSurface.sessionStats.tokens.cacheRead > 0 && <div>Cache read: {formatTokens(commandSurface.sessionStats.tokens.cacheRead)}</div>}
                          {commandSurface.sessionStats.tokens.cacheWrite > 0 && <div>Cache write: {formatTokens(commandSurface.sessionStats.tokens.cacheWrite)}</div>}
                          <div className="font-medium">Total: {formatTokens(commandSurface.sessionStats.tokens.total)}</div>
                          <div>Cost: {formatCost(commandSurface.sessionStats.cost)}</div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground">
                      Refresh session stats to inspect the current session breakdown.
                    </div>
                  )}

                  <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
                    <FieldTitle>Export HTML</FieldTitle>
                    <FieldDescription>
                      Leave the path blank to let the bridge choose the default export location.
                    </FieldDescription>
                    <Field>
                      <FieldLabel htmlFor="command-surface-export-path">Output path</FieldLabel>
                      <FieldContent>
                        <Input
                          id="command-surface-export-path"
                          data-testid="command-surface-export-path"
                          value={selectedSessionTarget?.outputPath ?? ""}
                          onChange={(event) => selectCommandSurfaceTarget({ kind: "session", outputPath: event.target.value })}
                          placeholder="Optional output path"
                          disabled={commandSurface.pendingAction === "export_html"}
                        />
                      </FieldContent>
                    </Field>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        onClick={() => void exportSessionFromSurface(selectedSessionTarget?.outputPath)}
                        disabled={commandSurface.pendingAction === "export_html"}
                        data-testid="command-surface-export-session"
                      >
                        {commandSurface.pendingAction === "export_html" ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4" />
                        )}
                        Export HTML
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "compact" && (
              <Card data-testid="command-surface-compact">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <CardTitle className="text-lg">Manual compaction</CardTitle>
                  <CardDescription>
                    Compact the current session context now. Provide optional guidance if you want the summary to emphasize specific constraints or files.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5 pt-6">
                  <Field>
                    <FieldLabel htmlFor="command-surface-compact-instructions">Custom instructions</FieldLabel>
                    <FieldContent>
                      <Textarea
                        id="command-surface-compact-instructions"
                        data-testid="command-surface-compact-instructions"
                        value={selectedCompactTarget?.customInstructions ?? ""}
                        onChange={(event) => selectCommandSurfaceTarget({ kind: "compact", customInstructions: event.target.value })}
                        placeholder="Optional: tell compaction what to preserve or emphasize"
                        rows={6}
                        disabled={compactBusy}
                      />
                      <FieldDescription>
                        These instructions are sent directly to the real `compact` RPC command only when provided.
                      </FieldDescription>
                    </FieldContent>
                  </Field>

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      onClick={() => void compactSessionFromSurface(selectedCompactTarget?.customInstructions)}
                      disabled={compactBusy}
                      data-testid="command-surface-apply-compact"
                    >
                      {compactBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                      Compact now
                    </Button>
                  </div>

                  {commandSurface.lastCompaction && (
                    <div className="space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <FieldTitle>Last compaction result</FieldTitle>
                        <Badge variant="outline">{formatTokens(commandSurface.lastCompaction.tokensBefore)} before</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">First kept entry: {commandSurface.lastCompaction.firstKeptEntryId}</div>
                      <div className="whitespace-pre-wrap text-sm text-foreground">{commandSurface.lastCompaction.summary}</div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {commandSurface.section === "auth" && onboarding && (
              <Card data-testid="command-surface-auth">
                <CardHeader className="gap-3 border-b border-border/60 pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">Auth controls</CardTitle>
                      <CardDescription>
                        Start sign-in, validate API keys, or log out without leaving the browser shell.
                      </CardDescription>
                    </div>
                    <Badge variant="outline">
                      {selectedAuthIntent === "login" ? "Login" : selectedAuthIntent === "logout" ? "Logout" : "Manage auth"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 pt-6">
                  <div className="grid gap-3 md:grid-cols-2">
                    {onboarding.required.providers.map((provider) => {
                      const selected = provider.id === selectedAuthProvider?.id
                      return (
                        <button
                          key={provider.id}
                          type="button"
                          className={cn(
                            "rounded-2xl border px-4 py-3 text-left transition-all",
                            selected
                              ? "border-foreground/40 bg-foreground/[0.045] shadow-sm"
                              : "border-border/70 bg-background/70 hover:border-foreground/20 hover:bg-accent/40",
                          )}
                          onClick={() =>
                            selectCommandSurfaceTarget({
                              kind: "auth",
                              providerId: provider.id,
                              intent: selectedAuthIntent,
                            })
                          }
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-medium text-foreground">{provider.label}</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {provider.configured ? `Configured via ${provider.configuredVia}` : "Not configured yet"}
                              </div>
                            </div>
                            <div className="flex flex-wrap justify-end gap-1">
                              {provider.recommended && <Badge>Recommended</Badge>}
                              {provider.configured && <Badge variant="outline">Detected</Badge>}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  {selectedAuthProvider && (
                    <div className="space-y-4 rounded-2xl border border-border/70 bg-background/70 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <FieldTitle>{selectedAuthProvider.label}</FieldTitle>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {selectedAuthProvider.supports.apiKey
                              ? "Validate a provider key here or use browser sign-in when available."
                              : "This provider uses browser sign-in instead of an API key."}
                          </div>
                        </div>
                        <Badge variant="outline">{selectedAuthProvider.configuredVia ?? "not configured"}</Badge>
                      </div>

                      {selectedAuthProvider.supports.apiKey && (
                        <form
                          className="space-y-4"
                          onSubmit={(event) => {
                            event.preventDefault()
                            if (!selectedProviderApiKey.trim()) return
                            void saveApiKeyFromSurface(selectedAuthProvider.id, selectedProviderApiKey)
                          }}
                        >
                          <FieldGroup>
                            <Field>
                              <FieldLabel htmlFor="command-surface-api-key">API key</FieldLabel>
                              <FieldContent>
                                <Input
                                  id="command-surface-api-key"
                                  data-testid="command-surface-api-key-input"
                                  type="password"
                                  autoComplete="off"
                                  value={selectedProviderApiKey}
                                  onChange={(event) =>
                                    setApiKeys((previous) => ({
                                      ...previous,
                                      [selectedAuthProvider.id]: event.target.value,
                                    }))
                                  }
                                  placeholder="Paste a provider key"
                                  disabled={authBusy}
                                />
                                <FieldDescription>
                                  Validation happens through the onboarding API and only returns sanitized status and refresh state.
                                </FieldDescription>
                              </FieldContent>
                            </Field>
                          </FieldGroup>

                          <div className="flex flex-wrap gap-3">
                            <Button
                              type="submit"
                              disabled={!selectedProviderApiKey.trim() || authBusy}
                              data-testid="command-surface-save-api-key"
                            >
                              {commandSurface.pendingAction === "save_api_key" ? (
                                <LoaderCircle className="h-4 w-4 animate-spin" />
                              ) : (
                                <KeyRound className="h-4 w-4" />
                              )}
                              Validate and save
                            </Button>

                            {selectedAuthProvider.supports.oauth && selectedAuthProvider.supports.oauthAvailable && (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={authBusy}
                                onClick={() => void startProviderFlowFromSurface(selectedAuthProvider.id)}
                                data-testid="command-surface-start-provider-flow"
                              >
                                <ArrowUpRight className="h-4 w-4" />
                                Browser sign-in
                              </Button>
                            )}
                          </div>
                        </form>
                      )}

                      {!selectedAuthProvider.supports.apiKey && selectedAuthProvider.supports.oauth && selectedAuthProvider.supports.oauthAvailable && (
                        <Button
                          type="button"
                          disabled={authBusy}
                          onClick={() => void startProviderFlowFromSurface(selectedAuthProvider.id)}
                          data-testid="command-surface-start-provider-flow"
                        >
                          {commandSurface.pendingAction === "start_provider_flow" ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : (
                            <LogIn className="h-4 w-4" />
                          )}
                          Start browser sign-in
                        </Button>
                      )}

                      <div className="flex flex-wrap gap-3">
                        {selectedAuthProvider.supports.oauth && selectedAuthProvider.supports.oauthAvailable && selectedAuthProvider.supports.apiKey && (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={authBusy}
                            onClick={() => void startProviderFlowFromSurface(selectedAuthProvider.id)}
                          >
                            <LogIn className="h-4 w-4" />
                            Sign in with browser
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={authBusy}
                          onClick={() => void logoutProviderFromSurface(selectedAuthProvider.id)}
                          data-testid="command-surface-logout-provider"
                        >
                          {commandSurface.pendingAction === "logout_provider" ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : (
                            <LogOut className="h-4 w-4" />
                          )}
                          Logout provider
                        </Button>
                      </div>

                      {activeFlow && activeFlow.providerId === selectedAuthProvider.id && (
                        <div className="space-y-4 rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-4" data-testid="command-surface-active-flow">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{activeFlow.status.replaceAll("_", " ")}</Badge>
                            <span className="text-sm text-muted-foreground">Updated {new Date(activeFlow.updatedAt).toLocaleTimeString()}</span>
                          </div>

                          {activeFlow.auth?.instructions && (
                            <div className="text-sm text-muted-foreground">{activeFlow.auth.instructions}</div>
                          )}

                          {activeFlow.auth?.url && (
                            <Button asChild variant="outline" size="sm" data-testid="command-surface-open-auth-url">
                              <a href={activeFlow.auth.url} target="_blank" rel="noreferrer">
                                <ExternalLink className="h-4 w-4" />
                                Open sign-in page
                              </a>
                            </Button>
                          )}

                          {activeFlow.progress.length > 0 && (
                            <div className="space-y-2">
                              <FieldTitle>Flow progress</FieldTitle>
                              <div className="space-y-2 text-sm text-muted-foreground">
                                {activeFlow.progress.map((message, index) => (
                                  <div key={`${activeFlow.flowId}-${index}`} className="rounded-lg border border-border/50 bg-background/70 px-3 py-2">
                                    {message}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {activeFlow.prompt && (
                            <form
                              className="space-y-3"
                              onSubmit={(event) => {
                                event.preventDefault()
                                if (!activeFlow.prompt?.allowEmpty && !flowInput.trim()) return
                                void submitProviderFlowInputFromSurface(activeFlow.flowId, flowInput)
                              }}
                            >
                              <Field>
                                <FieldLabel htmlFor="command-surface-flow-input">Next step</FieldLabel>
                                <FieldContent>
                                  <Input
                                    id="command-surface-flow-input"
                                    data-testid="command-surface-flow-input"
                                    value={flowInput}
                                    onChange={(event) => setFlowInput(event.target.value)}
                                    placeholder={activeFlow.prompt.placeholder || "Enter the requested value"}
                                    disabled={authBusy}
                                  />
                                  <FieldDescription>{activeFlow.prompt.message}</FieldDescription>
                                </FieldContent>
                              </Field>

                              <div className="flex flex-wrap gap-3">
                                <Button type="submit" disabled={authBusy || (!activeFlow.prompt.allowEmpty && !flowInput.trim())}>
                                  {commandSurface.pendingAction === "submit_provider_flow_input" ? (
                                    <LoaderCircle className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <ShieldCheck className="h-4 w-4" />
                                  )}
                                  Continue sign-in
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={authBusy}
                                  onClick={() => void cancelProviderFlowFromSurface(activeFlow.flowId)}
                                >
                                  Cancel flow
                                </Button>
                              </div>
                            </form>
                          )}
                        </div>
                      )}

                      {onboarding.bridgeAuthRefresh.phase !== "idle" && (
                        <div className="rounded-xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-muted-foreground">
                          <div className="font-medium text-foreground">Bridge auth refresh</div>
                          <div className="mt-1">
                            {onboarding.bridgeAuthRefresh.phase === "pending"
                              ? "Refreshing the live bridge onto the new auth view…"
                              : onboarding.bridgeAuthRefresh.phase === "failed"
                                ? onboarding.bridgeAuthRefresh.error || "Bridge auth refresh failed."
                                : "The live bridge picked up the latest auth state."}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        <SheetFooter className="border-t border-border/70">
          <Button type="button" variant="ghost" onClick={() => closeCommandSurface()}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
