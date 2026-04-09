"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Archive,
  ArrowRightLeft,
  Brain,
  Check,
  ChevronRight,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderRoot,
  GitBranch,
  KeyRound,
  LifeBuoy,
  LoaderCircle,
  LogIn,
  LogOut,
  PencilLine,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from "lucide-react"

import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  COMMAND_SURFACE_THINKING_LEVELS,
  type CommandSurfaceSection,
  type CommandSurfaceTarget,
} from "@/lib/command-surface-contract"
import { cn } from "@/lib/utils"
import {
  DEV_OVERRIDE_REGISTRY,
  useDevOverrides,
} from "@/lib/dev-overrides"
import { DoctorPanel, ForensicsPanel, SkillHealthPanel } from "./diagnostics-panels"
import { KnowledgeCapturesPanel } from "./knowledge-captures-panel"
import { PrefsPanel, ModelRoutingPanel, BudgetPanel, RemoteQuestionsPanel, GeneralPanel, ExperimentalPanel } from "./settings-panels"
import { DevRootSettingsSection } from "./projects-view"
import {
  QuickPanel,
  HistoryPanel,
  UndoPanel,
  SteerPanel,
  HooksPanel,
  InspectPanel,
  ExportPanel,
  CleanupPanel,
  QueuePanel,
  StatusPanel,
} from "./remaining-command-panels"
import {
  formatCost,
  formatTokens,
  getModelLabel,
  getSessionLabelFromBridge,
  shortenPath,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"

// ─── Section metadata ────────────────────────────────────────────────

const SETTINGS_SURFACE_SECTIONS = ["general", "model", "session-behavior", "recovery", "auth", "integrations", "workspace", "experimental"] as const
const ADMIN_SECTION: CommandSurfaceSection = "admin"
const GIT_SURFACE_SECTIONS = ["git"] as const
const SESSION_SURFACE_SECTIONS = ["resume", "name", "fork", "session", "compact"] as const

function availableSectionsForSurface(surface: string | null, includeAdmin: boolean = false): CommandSurfaceSection[] {
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
      return includeAdmin
        ? [...SETTINGS_SURFACE_SECTIONS, ADMIN_SECTION]
        : [...SETTINGS_SURFACE_SECTIONS]
  }
}

function sectionLabel(section: CommandSurfaceSection): string {
  const labels: Partial<Record<CommandSurfaceSection, string>> = {
    general: "General",
    model: "Model",
    thinking: "Thinking",
    queue: "Queue",
    compaction: "Compaction",
    retry: "Retry",
    "session-behavior": "Session",
    recovery: "Recovery",
    auth: "Auth",
    admin: "Admin",
    git: "Git",
    resume: "Resume",
    name: "Name",
    fork: "Fork",
    session: "Session",
    compact: "Compact",
    workspace: "Workspace",
    integrations: "Integrations",
    experimental: "Experimental",
  }
  return labels[section] ?? section
}

function sectionIcon(section: CommandSurfaceSection) {
  const icons: Partial<Record<CommandSurfaceSection, React.ReactNode>> = {
    general: <SlidersHorizontal className="h-4 w-4" />,
    model: <Cpu className="h-4 w-4" />,
    thinking: <Brain className="h-4 w-4" />,
    queue: <ArrowRightLeft className="h-4 w-4" />,
    compaction: <Archive className="h-4 w-4" />,
    retry: <RefreshCw className="h-4 w-4" />,
    "session-behavior": <ArrowRightLeft className="h-4 w-4" />,
    recovery: <LifeBuoy className="h-4 w-4" />,
    auth: <ShieldCheck className="h-4 w-4" />,
    admin: <SquareTerminal className="h-4 w-4" />,
    git: <GitBranch className="h-4 w-4" />,
    resume: <ArrowRightLeft className="h-4 w-4" />,
    name: <PencilLine className="h-4 w-4" />,
    fork: <GitBranch className="h-4 w-4" />,
    session: <FileText className="h-4 w-4" />,
    compact: <Archive className="h-4 w-4" />,
    workspace: <FolderRoot className="h-4 w-4" />,
    integrations: <Radio className="h-4 w-4" />,
    experimental: <FlaskConical className="h-4 w-4" />,
  }
  return icons[section] ?? null
}

function surfaceTitle(surface: string | null): string {
  const titles: Record<string, string> = {
    model: "Model",
    thinking: "Thinking",
    git: "Git",
    login: "Login",
    logout: "Logout",
    settings: "Settings",
    resume: "Resume",
    name: "Name",
    fork: "Fork",
    session: "Session",
    export: "Export",
    compact: "Compact",
  }
  return titles[surface ?? ""] ?? "Settings"
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

// ─── Inline status dot ──────────────────────────────────────────────

function StatusDot({ status }: { status: "ok" | "warning" | "error" | "idle" }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        status === "ok" && "bg-success",
        status === "warning" && "bg-warning",
        status === "error" && "bg-destructive",
        status === "idle" && "bg-foreground/20",
      )}
    />
  )
}

// ─── Inline section header ──────────────────────────────────────────

function SectionHeader({
  title,
  action,
  status,
}: {
  title: string
  action?: React.ReactNode
  status?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 pb-4">
      <div className="flex items-center gap-2.5">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        {status}
      </div>
      {action}
    </div>
  )
}

// ─── Inline key-value row ───────────────────────────────────────────

function KV({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("text-right text-foreground", mono && "font-mono text-xs")}>{children}</span>
    </div>
  )
}

// ─── Toggle row: label + switch ─────────────────────────────────────

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  busy,
  testId,
}: {
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  busy?: boolean
  testId?: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border/50 bg-card/50 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {label}
          {busy && <LoaderCircle className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled || busy} data-testid={testId} />
    </div>
  )
}

// ─── Segmented control ──────────────────────────────────────────────

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[]
  value: T | null
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-card/50 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
            value === opt.value
              ? "bg-foreground/10 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(opt.value)}
          disabled={disabled || value === opt.value}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}



// ═════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════

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
    loadForensicsDiagnostics,
    loadDoctorDiagnostics,
    loadSkillHealthDiagnostics,
    loadKnowledgeData,
    loadCapturesData,
    loadSettingsData,
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
    loadHistoryData,
    loadInspectData,
    loadHooksData,
    loadUndoInfo,
    loadCleanupData,
    loadSteerData,
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
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [flowInput, setFlowInput] = useState("")
  const commandSurfaceViewportRef = useRef<HTMLDivElement>(null)

  // ─── Auto-loaders ──────────────────────────────────────────────────

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

  // Auto-fetch diagnostics panels when their sections open
  const diagnostics = commandSurface.diagnostics
  const knowledgeCaptures = commandSurface.knowledgeCaptures
  const settingsData = commandSurface.settingsData
  const remainingCommands = commandSurface.remainingCommands
  useEffect(() => {
    if (!commandSurface.open) return
    if (commandSurface.section === "gsd-forensics" && diagnostics.forensics.phase === "idle") {
      void loadForensicsDiagnostics()
    } else if (commandSurface.section === "gsd-doctor" && diagnostics.doctor.phase === "idle") {
      void loadDoctorDiagnostics()
    } else if (commandSurface.section === "gsd-skill-health" && diagnostics.skillHealth.phase === "idle") {
      void loadSkillHealthDiagnostics()
    } else if (
      commandSurface.section === "gsd-knowledge" &&
      knowledgeCaptures.knowledge.phase === "idle"
    ) {
      void loadKnowledgeData()
      void loadCapturesData()
    } else if (
      (commandSurface.section === "gsd-capture" || commandSurface.section === "gsd-triage") &&
      knowledgeCaptures.captures.phase === "idle"
    ) {
      void loadCapturesData()
      void loadKnowledgeData()
    } else if (
      (commandSurface.section === "gsd-prefs" ||
       commandSurface.section === "gsd-mode" ||
       commandSurface.section === "gsd-config" ||
       commandSurface.section === "experimental") &&
      settingsData.phase === "idle"
    ) {
      void loadSettingsData()
    } else if (commandSurface.section === "gsd-history" && remainingCommands.history.phase === "idle") {
      void loadHistoryData()
    } else if (commandSurface.section === "gsd-inspect" && remainingCommands.inspect.phase === "idle") {
      void loadInspectData()
    } else if (commandSurface.section === "gsd-hooks" && remainingCommands.hooks.phase === "idle") {
      void loadHooksData()
    } else if (commandSurface.section === "gsd-undo" && remainingCommands.undo.phase === "idle") {
      void loadUndoInfo()
    } else if (commandSurface.section === "gsd-cleanup" && remainingCommands.cleanup.phase === "idle") {
      void loadCleanupData()
    } else if (commandSurface.section === "gsd-steer" && remainingCommands.steer.phase === "idle") {
      void loadSteerData()
    }
  }, [
    commandSurface.open,
    commandSurface.section,
    diagnostics.forensics.phase,
    diagnostics.doctor.phase,
    diagnostics.skillHealth.phase,
    knowledgeCaptures.knowledge.phase,
    knowledgeCaptures.captures.phase,
    settingsData.phase,
    remainingCommands.history.phase,
    remainingCommands.inspect.phase,
    remainingCommands.hooks.phase,
    remainingCommands.undo.phase,
    remainingCommands.cleanup.phase,
    remainingCommands.steer.phase,
    loadForensicsDiagnostics,
    loadDoctorDiagnostics,
    loadSkillHealthDiagnostics,
    loadKnowledgeData,
    loadCapturesData,
    loadSettingsData,
    loadHistoryData,
    loadInspectData,
    loadHooksData,
    loadUndoInfo,
    loadCleanupData,
    loadSteerData,
  ])

  useEffect(() => {
    if (!commandSurface.open || (commandSurface.section !== "resume" && commandSurface.section !== "name")) return
    if (commandSurface.pendingAction === "load_session_browser") return
    if (commandSurface.sessionBrowser.loaded) return
    void loadSessionBrowser()
  }, [commandSurface.open, commandSurface.section, commandSurface.pendingAction, commandSurface.sessionBrowser.loaded, loadSessionBrowser])

  useEffect(() => {
    if (!commandSurface.open) return
    const viewport = commandSurfaceViewportRef.current
    if (!viewport) return
    viewport.scrollTop = 0
  }, [commandSurface.open, commandSurface.activeSurface, commandSurface.section])

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
    const resetTimer = window.setTimeout(() => {
      setFlowInput("")
    }, 0)
    return () => window.clearTimeout(resetTimer)
  }, [activeFlow?.flowId])

  // ─── Toast on action results ───────────────────────────────────────

  useEffect(() => {
    if (commandSurface.lastError) {
      toast.error(commandSurface.lastError)
    }
  }, [commandSurface.lastError])

  useEffect(() => {
    if (commandSurface.lastResult) {
      toast.success(commandSurface.lastResult)
    }
  }, [commandSurface.lastResult])

  // ─── Derived state ─────────────────────────────────────────────────

  const selectedModelTarget = commandSurface.selectedTarget?.kind === "model" ? commandSurface.selectedTarget : null
  const selectedThinkingTarget = commandSurface.selectedTarget?.kind === "thinking" ? commandSurface.selectedTarget : null
  const selectedAuthTarget = commandSurface.selectedTarget?.kind === "auth" ? commandSurface.selectedTarget : null
  const selectedResumeTarget = commandSurface.selectedTarget?.kind === "resume" ? commandSurface.selectedTarget : null
  const selectedNameTarget = commandSurface.selectedTarget?.kind === "name" ? commandSurface.selectedTarget : null
  const selectedForkTarget = commandSurface.selectedTarget?.kind === "fork" ? commandSurface.selectedTarget : null
  const selectedSessionTarget = commandSurface.selectedTarget?.kind === "session" ? commandSurface.selectedTarget : null
  const selectedCompactTarget = commandSurface.selectedTarget?.kind === "compact" ? commandSurface.selectedTarget : null
  const selectedAuthIntent = currentAuthIntent(commandSurface.activeSurface, commandSurface.selectedTarget)
  const selectedAuthProvider = onboarding?.required.providers.find((provider) => provider.id === selectedAuthTarget?.providerId) ?? null
  const modelQuery = (selectedModelTarget?.query ?? commandSurface.args).trim().toLowerCase()
  const filteredModels = useMemo(() => {
    if (!modelQuery) return commandSurface.availableModels
    return commandSurface.availableModels.filter((model) =>
      `${model.provider} ${model.modelId} ${model.name ?? ""}`.toLowerCase().includes(modelQuery),
    )
  }, [commandSurface.availableModels, modelQuery])

  // Group filtered models by provider for display
  const groupedModels = useMemo(() => {
    const groups = new Map<string, typeof filteredModels>()
    for (const model of filteredModels) {
      const key = model.provider
      const existing = groups.get(key)
      if (existing) existing.push(model)
      else groups.set(key, [model])
    }
    return groups
  }, [filteredModels])

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
  const devOverrides = useDevOverrides()
  const surfaceSections = availableSectionsForSurface(commandSurface.activeSurface, devOverrides.isDevMode)
  const surfaceKindLabel = `/${commandSurface.activeSurface ?? "settings"}`

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

  // ═══════════════════════════════════════════════════════════════════
  // SECTION RENDERERS
  // ═══════════════════════════════════════════════════════════════════

  const renderModelSection = () => (
    <div className="space-y-4" data-testid="command-surface-models">
      <SectionHeader
        title="Model"
        status={
          <span className="font-mono text-xs text-muted-foreground">{currentModelLabel}</span>
        }
        action={
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadAvailableModels()} disabled={modelBusy} className="h-7 gap-1.5 text-xs">
            <RefreshCw className={cn("h-3 w-3", modelBusy && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      {/* Search filter */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={selectedModelTarget?.query ?? commandSurface.args}
          onChange={(e) =>
            selectCommandSurfaceTarget({
              kind: "model",
              provider: selectedModelTarget?.provider,
              modelId: selectedModelTarget?.modelId,
              query: e.target.value,
            })
          }
          placeholder="Filter models…"
          className="h-8 pl-9 text-xs"
        />
      </div>

      {/* Model list */}
      {modelBusy && commandSurface.availableModels.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          Loading models…
        </div>
      ) : filteredModels.length > 0 ? (
        <div className="space-y-4">
          {Array.from(groupedModels.entries()).map(([provider, models]) => (
            <div key={provider}>
              <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                {provider}
              </div>
              <div className="space-y-0.5">
                {models.map((model) => {
                  const selected = selectedModelTarget?.provider === model.provider && selectedModelTarget?.modelId === model.modelId
                  return (
                    <button
                      key={`${model.provider}/${model.modelId}`}
                      type="button"
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                        selected
                          ? "bg-foreground/[0.07]"
                          : "hover:bg-foreground/[0.03]",
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
                      {/* Selection indicator */}
                      <div className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                        selected ? "border-foreground bg-foreground" : "border-foreground/25",
                      )}>
                        {selected && <Check className="h-2.5 w-2.5 text-background" />}
                      </div>

                      {/* Model info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{model.name || model.modelId}</span>
                          {model.isCurrent && <StatusDot status="ok" />}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {model.modelId}
                        </div>
                      </div>

                      {/* Badges */}
                      <div className="flex shrink-0 items-center gap-1.5">
                        {model.isCurrent && (
                          <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Active</span>
                        )}
                        {model.reasoning && (
                          <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Thinking</span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-xs text-muted-foreground">No models matched.</p>
      )}

      {/* Apply */}
      <div className="flex justify-end border-t border-border/50 pt-3">
        <Button
          type="button"
          size="sm"
          onClick={() =>
            selectedModelTarget?.provider &&
            selectedModelTarget?.modelId &&
            void applyModelSelection(selectedModelTarget.provider, selectedModelTarget.modelId)
          }
          disabled={!selectedModelTarget?.provider || !selectedModelTarget.modelId || commandSurface.pendingAction === "set_model"}
          data-testid="command-surface-apply-model"
          className="h-8 gap-1.5"
        >
          {commandSurface.pendingAction === "set_model" ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Apply model
        </Button>
      </div>
    </div>
  )

  const renderThinkingSection = () => (
    <div className="space-y-4" data-testid="command-surface-thinking">
      <SectionHeader
        title="Thinking level"
        status={
          <span className="font-mono text-xs text-muted-foreground">
            {workspace.boot?.bridge.sessionState?.thinkingLevel ?? "off"}
          </span>
        }
      />

      <div className="space-y-1">
        {COMMAND_SURFACE_THINKING_LEVELS.map((level) => {
          const selected = selectedThinkingTarget?.level === level
          const isCurrent = workspace.boot?.bridge.sessionState?.thinkingLevel === level
          const description = level === "off" ? "No reasoning overhead" : level === "minimal" ? "Light reasoning" : level === "low" ? "Basic analysis" : level === "medium" ? "Balanced reasoning" : level === "high" ? "Deep analysis" : "Maximum deliberation"
          return (
            <button
              key={level}
              type="button"
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.03]",
              )}
              onClick={() => selectCommandSurfaceTarget({ kind: "thinking", level })}
            >
              <div className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                selected ? "border-foreground bg-foreground" : "border-foreground/25",
              )}>
                {selected && <Check className="h-2.5 w-2.5 text-background" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium capitalize text-foreground">{level}</span>
                  {isCurrent && <StatusDot status="ok" />}
                </div>
                <span className="text-xs text-muted-foreground">{description}</span>
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex justify-end border-t border-border/50 pt-3">
        <Button
          type="button"
          size="sm"
          onClick={() => selectedThinkingTarget && void applyThinkingLevel(selectedThinkingTarget.level)}
          disabled={!selectedThinkingTarget || commandSurface.pendingAction === "set_thinking_level"}
          data-testid="command-surface-apply-thinking"
          className="h-8 gap-1.5"
        >
          {commandSurface.pendingAction === "set_thinking_level" ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Apply
        </Button>
      </div>
    </div>
  )

  const renderQueueSection = () => (
    <div className="space-y-5" data-testid="command-surface-queue-settings">
      <SectionHeader title="Queue modes" />

      {/* Steering mode */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">Steering mode</div>
            <p className="text-xs text-muted-foreground">How steering messages queue during streaming</p>
          </div>
          {settingsRequests.steeringMode.pending && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <SegmentedControl
          options={[
            { value: "all" as const, label: "Queue all" },
            { value: "one-at-a-time" as const, label: "One at a time" },
          ]}
          value={liveSessionState?.steeringMode ?? null}
          onChange={(v) => void setSteeringModeFromSurface(v)}
          disabled={!liveSessionState || queueBusy}
        />
        {settingsRequests.steeringMode.error && (
          <p className="text-xs text-destructive">{settingsRequests.steeringMode.error}</p>
        )}
      </div>

      <div className="border-t border-border/50" />

      {/* Follow-up mode */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">Follow-up mode</div>
            <p className="text-xs text-muted-foreground">How follow-up prompts sequence during a live turn</p>
          </div>
          {settingsRequests.followUpMode.pending && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <SegmentedControl
          options={[
            { value: "all" as const, label: "Queue all" },
            { value: "one-at-a-time" as const, label: "One at a time" },
          ]}
          value={liveSessionState?.followUpMode ?? null}
          onChange={(v) => void setFollowUpModeFromSurface(v)}
          disabled={!liveSessionState || queueBusy}
        />
        {settingsRequests.followUpMode.error && (
          <p className="text-xs text-destructive">{settingsRequests.followUpMode.error}</p>
        )}
      </div>
    </div>
  )

  const renderCompactionSection = () => (
    <div className="space-y-4" data-testid="command-surface-auto-compaction-settings">
      <SectionHeader
        title="Auto-compaction"
        status={
          liveSessionState?.isCompacting ? (
            <span className="flex items-center gap-1.5 text-xs text-warning">
              <LoaderCircle className="h-3 w-3 animate-spin" /> Compacting
            </span>
          ) : null
        }
      />

      <ToggleRow
        label="Auto-compact"
        description="Automatically compact when context thresholds are crossed"
        checked={liveSessionState?.autoCompactionEnabled ?? false}
        onCheckedChange={(checked) => void setAutoCompactionFromSurface(checked)}
        disabled={!liveSessionState || autoCompactionBusy}
        busy={autoCompactionBusy}
        testId="command-surface-toggle-auto-compaction"
      />

      {settingsRequests.autoCompaction.error && (
        <p className="text-xs text-destructive">{settingsRequests.autoCompaction.error}</p>
      )}
      {settingsRequests.autoCompaction.result && (
        <p className="text-xs text-success">{settingsRequests.autoCompaction.result}</p>
      )}
    </div>
  )

  const renderRetrySection = () => (
    <div className="space-y-4" data-testid="command-surface-retry-settings">
      <SectionHeader
        title="Retry"
        status={
          liveSessionState?.retryInProgress ? (
            <span className="flex items-center gap-1.5 text-xs text-warning">
              <Radio className="h-3 w-3" /> Attempt {Math.max(1, liveSessionState.retryAttempt)}
            </span>
          ) : null
        }
      />

      <ToggleRow
        label="Auto-retry"
        description="Automatically retry on transient failures"
        checked={liveSessionState?.autoRetryEnabled ?? false}
        onCheckedChange={(checked) => void setAutoRetryFromSurface(checked)}
        disabled={!liveSessionState || autoRetryBusy}
        busy={autoRetryBusy}
        testId="command-surface-toggle-auto-retry"
      />

      <p className="text-xs text-muted-foreground" data-testid="command-surface-auto-retry-state">
        {autoRetryBusy
          ? "Updating auto-retry…"
          : settingsRequests.autoRetry.error
            ? settingsRequests.autoRetry.error
            : settingsRequests.autoRetry.result
              ? settingsRequests.autoRetry.result
              : liveSessionState?.autoRetryEnabled
                ? "Auto-retry enabled"
                : "Auto-retry disabled"}
      </p>

      {liveSessionState?.retryInProgress && (
        <div className="flex items-center justify-between rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-foreground">Retry in progress</div>
            <p className="text-xs text-muted-foreground">Attempt {Math.max(1, liveSessionState.retryAttempt)} is active</p>
          </div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void abortRetryFromSurface()}
            disabled={abortRetryBusy}
            data-testid="command-surface-abort-retry"
            className="h-7 gap-1.5 text-xs"
          >
            {abortRetryBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            Abort
          </Button>
        </div>
      )}

      {settingsRequests.autoRetry.error && <p className="text-xs text-destructive">{settingsRequests.autoRetry.error}</p>}
      <p className="text-xs text-muted-foreground" data-testid="command-surface-abort-retry-state">
        {abortRetryBusy
          ? "Aborting retry…"
          : settingsRequests.abortRetry.error
            ? settingsRequests.abortRetry.error
            : settingsRequests.abortRetry.result
              ? settingsRequests.abortRetry.result
              : liveSessionState?.retryInProgress
                ? "Retry can be aborted"
                : "No retry in progress"}
      </p>
      {settingsRequests.abortRetry.error && <p className="text-xs text-destructive">{settingsRequests.abortRetry.error}</p>}
    </div>
  )

  const renderRecoverySection = () => {
    const diag = recoveryDiagnostics
    return (
      <div className="space-y-4" data-testid="command-surface-recovery">
        <div className="text-xs text-muted-foreground" data-testid="command-surface-recovery-state">
          {recoveryBusy
            ? "Loading recovery diagnostics…"
            : recovery.error
              ? "Recovery diagnostics failed"
              : recovery.stale
                ? "Recovery diagnostics stale"
                : recovery.loaded
                  ? "Recovery diagnostics loaded"
                  : "Recovery diagnostics idle"}
        </div>
        <SectionHeader
          title="Recovery"
          status={
            diag ? (
              <StatusDot status={diag.summary.tone === "healthy" ? "ok" : diag.summary.tone === "warning" ? "warning" : "error"} />
            ) : null
          }
          action={
            <Button type="button" variant="ghost" size="sm" onClick={() => void loadRecoveryDiagnostics()} disabled={recoveryBusy} className="h-7 gap-1.5 text-xs">
              <RefreshCw className={cn("h-3 w-3", recoveryBusy && "animate-spin")} />
              Refresh
            </Button>
          }
        />

        {recovery.error && (
          <div
            className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs text-destructive"
            data-testid="command-surface-recovery-error"
          >
            {recovery.error}
          </div>
        )}

        {recoveryBusy && !diag && (
          <>
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              Loading diagnostics…
            </div>
            <div className="flex flex-wrap gap-2 border-t border-border/50 pt-3" data-testid="command-surface-recovery-actions">
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => void loadRecoveryDiagnostics()}
                data-testid="command-surface-recovery-action-refresh_diagnostics"
                className="h-7 text-xs"
              >
                Refresh diagnostics
              </Button>
            </div>
          </>
        )}

        {diag?.status === "unavailable" && !recovery.error && (
          <>
            <div className="space-y-1 rounded-lg border border-border/50 bg-card/50 px-4 py-3" data-testid="command-surface-recovery-summary">
              <div className="text-sm font-medium text-foreground">{diag.summary.label}</div>
              <p className="text-xs text-muted-foreground">{diag.summary.detail}</p>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-border/50 pt-3" data-testid="command-surface-recovery-actions">
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => void loadRecoveryDiagnostics()}
                data-testid="command-surface-recovery-action-refresh_diagnostics"
                className="h-7 text-xs"
              >
                Refresh diagnostics
              </Button>
            </div>
          </>
        )}

        {diag && diag.status !== "unavailable" && (
          <>
            <div className="space-y-1" data-testid="command-surface-recovery-summary">
              <div className="text-sm font-medium text-foreground">{diag.summary.label}</div>
              <p className="text-xs text-muted-foreground">{diag.summary.detail}</p>
            </div>

            {/* Summary stats */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Validation</div>
                <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{diag.summary.validationCount}</div>
              </div>
              <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Doctor</div>
                <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{diag.summary.doctorIssueCount}</div>
              </div>
            </div>

            {/* Status badges */}
            <div className="flex flex-wrap gap-1.5">
              {diag.summary.retryInProgress && <Badge variant="default" className="text-[10px]">Retry {Math.max(1, diag.summary.retryAttempt)}</Badge>}
              {diag.summary.compactionActive && <Badge variant="default" className="text-[10px]">Compacting</Badge>}
              {diag.summary.lastFailurePhase && <Badge variant="destructive" className="text-[10px]">Phase {diag.summary.lastFailurePhase}</Badge>}
              {recovery.stale && <Badge variant="outline" className="text-[10px]">Stale</Badge>}
            </div>

            {/* Last failure */}
            {diag.bridge.lastFailure && (
              <div
                className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5"
                data-testid="command-surface-recovery-last-failure"
              >
                <div className="text-xs font-medium text-destructive">Last failure</div>
                <p className="mt-1 text-xs text-destructive/80">{diag.bridge.lastFailure.message}</p>
                <div className="mt-1.5 flex gap-3 text-[10px] text-destructive/60">
                  <span>Phase: {diag.bridge.lastFailure.phase}</span>
                  <span>{formatRelativeTime(diag.bridge.lastFailure.at)}</span>
                </div>
              </div>
            )}

            {/* Validation issues */}
            {diag.validation.topIssues.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Validation issues</div>
                {diag.validation.topIssues.map((issue) => (
                  <div key={`${issue.code}:${issue.file ?? issue.message}`} className="rounded-lg border border-border/50 bg-card/50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={issue.severity === "error" ? "destructive" : "outline"} className="text-[10px]">{issue.code}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{issue.message}</p>
                    {issue.suggestion && <p className="mt-0.5 text-[11px] text-muted-foreground">→ {issue.suggestion}</p>}
                  </div>
                ))}
              </div>
            )}

            {/* Doctor issues */}
            {diag.doctor.topIssues.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Doctor issues</div>
                {diag.doctor.topIssues.map((issue) => (
                  <div key={`${issue.code}:${issue.unitId ?? issue.message}`} className="rounded-lg border border-border/50 bg-card/50 px-3 py-2">
                    <Badge variant="outline" className="text-[10px]">{issue.code}</Badge>
                    <p className="mt-1 text-xs text-muted-foreground">{issue.message}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Interrupted run */}
            {diag.interruptedRun.detected && (
              <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2.5" data-testid="command-surface-recovery-interrupted-run">
                <div className="text-xs font-medium text-warning">Interrupted run detected</div>
                <div className="mt-1 space-y-1 text-xs text-warning/80">
                  <p>Available: yes</p>
                  <p>Detected: yes</p>
                  <p>{diag.interruptedRun.detail}</p>
                </div>
                <div className="mt-1.5 grid gap-1 text-[10px] text-warning/60">
                  <span>Tool calls: {diag.interruptedRun.counts.toolCalls}</span>
                  <span>Files written: {diag.interruptedRun.counts.filesWritten}</span>
                  <span>Commands: {diag.interruptedRun.counts.commandsRun}</span>
                  <span>Errors: {diag.interruptedRun.counts.errors}</span>
                  <span>Last forensic error: {diag.interruptedRun.lastError ?? "[redacted]"}</span>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2 border-t border-border/50 pt-3" data-testid="command-surface-recovery-actions">
              {diag.actions.browser.length > 0 ? (
                diag.actions.browser.map((action) => (
                  <Button
                    key={action.id}
                    type="button"
                    variant={action.emphasis === "danger" ? "destructive" : action.emphasis === "primary" ? "default" : "outline"}
                    size="sm"
                    onClick={() => triggerRecoveryBrowserAction(action.id)}
                    data-testid={`command-surface-recovery-action-${action.id}`}
                    className="h-7 text-xs"
                  >
                    {action.label}
                  </Button>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">
                  {recoveryBusy ? "Loading recovery actions…" : "No browser recovery actions available."}
                </span>
              )}
            </div>

            {diag.actions.commands.length > 0 && (
              <div className="space-y-2 border-t border-border/50 pt-3" data-testid="command-surface-recovery-commands">
                <div className="text-xs font-medium text-muted-foreground">Suggested commands</div>
                {diag.actions.commands.map((command) => (
                  <div key={command.command} className="rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-xs">
                    <div className="font-mono text-foreground">{command.command}</div>
                    <p className="mt-1 text-muted-foreground">{command.label}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  const gitFileStatusColor = (status: string) => {
    switch (status) {
      case "M": return "text-warning bg-warning/10"
      case "A": return "text-success bg-success/10"
      case "D": return "text-destructive bg-destructive/10"
      case "R": return "text-info bg-info/10"
      case "C": return "text-info bg-info/10"
      case "U": return "text-destructive bg-destructive/10"
      case "?": return "text-muted-foreground bg-foreground/5"
      default: return "text-muted-foreground bg-foreground/5"
    }
  }

  const renderGitSection = () => {
    const result = gitSummary.result
    return (
      <div className="space-y-5" data-testid="command-surface-git-summary">
        <div className="text-xs text-muted-foreground" data-testid="command-surface-git-state">
          {gitSummaryBusy
            ? "Loading git summary…"
            : gitSummary.error
              ? "Git summary failed"
              : result?.kind === "not_repo"
                ? "No git repository"
                : result?.kind === "repo"
                  ? `Repo ready${result.hasChanges ? " — changes detected" : " — clean"}`
                  : "Git summary idle"}
        </div>

        {gitSummaryBusy && !result && (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading repo state…</span>
          </div>
        )}

        {gitSummary.error && (
          <div
            className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive"
            data-testid="command-surface-git-error"
          >
            {gitSummary.error}
          </div>
        )}

        {!gitSummary.error && result?.kind === "not_repo" && (
          <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="command-surface-git-not-repo">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border/50 bg-card/50">
              <GitBranch className="h-4.5 w-4.5 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">No Git repository</div>
              <p className="mt-1 text-xs text-muted-foreground">{result.message}</p>
            </div>
          </div>
        )}

        {!gitSummary.error && result?.kind === "repo" && (
          <>
            {/* Repo info bar */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{shortenPath(result.project.repoRoot, 3)}</span>
              {result.project.repoRelativePath && (
                <>
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono">{result.project.repoRelativePath}</span>
                </>
              )}
            </div>

            {/* Counts row */}
            <div className="grid grid-cols-4 gap-1.5" data-testid="command-surface-git-counts">
              {[
                { label: "Staged", count: result.counts.staged, active: result.counts.staged > 0, color: "text-success" },
                { label: "Modified", count: result.counts.dirty, active: result.counts.dirty > 0, color: "text-warning" },
                { label: "Untracked", count: result.counts.untracked, active: result.counts.untracked > 0, color: "text-muted-foreground" },
                { label: "Conflicts", count: result.counts.conflicts, active: result.counts.conflicts > 0, color: "text-destructive" },
              ].map(({ label, count, active, color }) => (
                <div key={label} className={cn(
                  "rounded-md border px-2 py-2 text-center transition-colors",
                  active ? "border-border bg-card" : "border-border/50 bg-card/50",
                )}>
                  <div className={cn(
                    "text-base font-semibold tabular-nums leading-none",
                    active ? color : "text-muted-foreground",
                  )}>{count}</div>
                  <div className={cn(
                    "mt-1.5 text-[10px] leading-none",
                    active ? "text-muted-foreground" : "text-muted-foreground",
                  )}>{label}</div>
                </div>
              ))}
            </div>

            {/* Changed files */}
            {result.changedFiles.length > 0 && (
              <div data-testid="command-surface-git-files">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    Changes
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {result.changedFiles.length}{result.truncatedFileCount > 0 ? `+${result.truncatedFileCount}` : ""} files
                  </span>
                </div>
                <div className="space-y-px rounded-lg border border-border/50 bg-card/50 overflow-hidden">
                  {result.changedFiles.map((file) => (
                    <div
                      key={`${file.status}:${file.repoPath}`}
                      className="group flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-foreground/[0.03]"
                    >
                      <span className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold",
                        gitFileStatusColor(file.status),
                      )}>
                        {file.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80">
                        {file.path}
                      </span>
                      {file.conflict && (
                        <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-destructive">
                          conflict
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                {result.truncatedFileCount > 0 && (
                  <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
                    +{result.truncatedFileCount} more files not shown
                  </p>
                )}
              </div>
            )}

            {result.changedFiles.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Check className="h-4 w-4 text-success/60" />
                <span className="text-xs text-muted-foreground">Working tree clean</span>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  const renderSessionBrowserSection = (mode: "resume" | "name") => {
    const renameMode = mode === "name"
    const selectedSessionPath = renameMode ? selectedNameTarget?.sessionPath : selectedResumeTarget?.sessionPath

    return (
      <div className="space-y-4" data-testid={renameMode ? "command-surface-name" : "command-surface-resume"}>
        <SectionHeader
          title={renameMode ? "Rename" : "Resume"}
          status={
            !renameMode ? (
              <span className="text-xs text-muted-foreground">{currentSessionLabel ?? "pending"}</span>
            ) : null
          }
        />

        {/* Search bar */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={sessionBrowser.query}
              onChange={(e) => updateSessionBrowserState({ query: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void loadSessionBrowser() } }}
              placeholder="Search sessions…"
              className="h-8 pl-9 text-xs"
              disabled={sessionBrowserBusy}
              data-testid="command-surface-session-browser-query"
            />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadSessionBrowser()} disabled={sessionBrowserBusy} className="h-8 w-8 p-0">
            <RefreshCw className={cn("h-3.5 w-3.5", sessionBrowserBusy && "animate-spin")} />
          </Button>
        </div>

        {/* Sort/filter controls */}
        <div className="flex items-center gap-2">
          <SegmentedControl
            options={[
              { value: "threaded" as const, label: "Threaded" },
              { value: "recent" as const, label: "Recent" },
              { value: "relevance" as const, label: "Relevance" },
            ]}
            value={sessionBrowser.sortMode}
            onChange={(v) => { updateSessionBrowserState({ sortMode: v }); void loadSessionBrowser({ sortMode: v }) }}
            disabled={sessionBrowserBusy}
          />
          <button
            type="button"
            className={cn(
              "rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
              sessionBrowser.nameFilter === "named" ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => {
              const next = sessionBrowser.nameFilter === "named" ? "all" : "named"
              updateSessionBrowserState({ nameFilter: next })
              void loadSessionBrowser({ nameFilter: next })
            }}
            disabled={sessionBrowserBusy}
          >
            Named
          </button>
        </div>

        {sessionBrowser.error && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">{sessionBrowser.error}</div>
        )}

        {/* Session list */}
        {sessionBrowserBusy && sessionBrowser.sessions.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Loading sessions…
          </div>
        ) : sessionBrowser.sessions.length > 0 ? (
          <div className="space-y-1" data-testid="command-surface-session-browser-results">
            {sessionBrowser.sessions.map((session) => {
              const selected = session.path === selectedSessionPath
              return (
                <button
                  key={session.path}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                    selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.03]",
                  )}
                  style={{ paddingLeft: `${0.75 + session.depth * 0.6}rem` }}
                  onClick={() =>
                    renameMode
                      ? selectCommandSurfaceTarget({ kind: "name", sessionPath: session.path, name: selectedNameTarget?.sessionPath === session.path ? (selectedNameTarget?.name ?? session.name ?? "") : (session.name ?? "") })
                      : selectCommandSurfaceTarget({ kind: "resume", sessionPath: session.path })
                  }
                  data-testid={`command-surface-session-browser-item-${session.id}`}
                >
                  <div className={cn(
                    "mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    selected ? "border-foreground bg-foreground" : "border-foreground/25",
                  )}>
                    {selected && <Check className="h-2.5 w-2.5 text-background" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {session.name || session.firstMessage || session.id}
                      </span>
                      {session.isActive && <StatusDot status="ok" />}
                    </div>
                    {session.name && session.firstMessage && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{session.firstMessage}</p>
                    )}
                    <div className="mt-0.5 flex gap-3 text-[11px] text-muted-foreground">
                      <span>{session.messageCount} msgs</span>
                      <span>{formatRelativeTime(session.modifiedAt)}</span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-muted-foreground">No sessions matched.</p>
        )}

        {sessionBrowser.loaded && (
          <p className="text-[11px] text-muted-foreground" data-testid="command-surface-session-browser-meta">
            Current-project sessions · {sessionBrowser.returnedSessions} of {sessionBrowser.totalSessions} · {sessionBrowser.sortMode} · {sessionBrowser.nameFilter}
          </p>
        )}

        {/* Rename controls */}
        {renameMode && (
          <div className="space-y-3 border-t border-border/50 pt-3">
            <div className="flex gap-2">
              <Input
                value={selectedNameTarget?.name ?? ""}
                onChange={(e) =>
                  selectCommandSurfaceTarget({ kind: "name", sessionPath: selectedNameTarget?.sessionPath, name: e.target.value })
                }
                placeholder="Session name"
                className="h-8 flex-1 text-xs"
                disabled={!selectedNameTarget?.sessionPath || renameBusy}
                data-testid="command-surface-rename-input"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => selectedNameTarget?.sessionPath && void renameSessionFromSurface(selectedNameTarget.sessionPath, selectedNameTarget.name)}
                disabled={!selectedNameTarget?.sessionPath || !selectedNameTarget.name.trim() || renameBusy}
                data-testid="command-surface-apply-rename"
                className="h-8 gap-1.5"
              >
                {renameBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PencilLine className="h-3.5 w-3.5" />}
                Rename
              </Button>
            </div>
            {commandSurface.renameRequest.error && <p className="text-xs text-destructive">{commandSurface.renameRequest.error}</p>}
            {commandSurface.renameRequest.result && <p className="text-xs text-success">{commandSurface.renameRequest.result}</p>}
          </div>
        )}

        {/* Resume controls */}
        {!renameMode && (
          <div className="flex items-center justify-between border-t border-border/50 pt-3">
            <span className="text-xs text-muted-foreground" data-testid="command-surface-resume-state">
              {resumeBusy ? "Switching…" : commandSurface.resumeRequest.error ?? commandSurface.resumeRequest.result ?? "Select a session"}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => selectedResumeTarget?.sessionPath && void switchSessionFromSurface(selectedResumeTarget.sessionPath)}
              disabled={!selectedResumeTarget?.sessionPath || resumeBusy}
              data-testid="command-surface-apply-resume"
              className="h-8 gap-1.5"
            >
              {resumeBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
              Switch
            </Button>
          </div>
        )}
      </div>
    )
  }

  const renderForkSection = () => (
    <div className="space-y-4" data-testid="command-surface-fork">
      <SectionHeader
        title="Fork"
        action={
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadForkMessages()} disabled={forkBusy} className="h-7 gap-1.5 text-xs">
            <RefreshCw className={cn("h-3 w-3", commandSurface.pendingAction === "load_fork_messages" && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      {forkBusy && commandSurface.forkMessages.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          Loading fork points…
        </div>
      ) : commandSurface.forkMessages.length > 0 ? (
        <div className="space-y-1">
          {commandSurface.forkMessages.map((message) => {
            const selected = selectedForkTarget?.entryId === message.entryId
            return (
              <button
                key={message.entryId}
                type="button"
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                  selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.03]",
                )}
                onClick={() => selectCommandSurfaceTarget({ kind: "fork", entryId: message.entryId })}
              >
                <div className={cn(
                  "mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  selected ? "border-foreground bg-foreground" : "border-foreground/25",
                )}>
                  {selected && <Check className="h-2.5 w-2.5 text-background" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] text-muted-foreground">{message.entryId}</div>
                  <p className="mt-0.5 text-sm text-foreground">{message.text}</p>
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">No fork points available yet.</p>
      )}

      <div className="flex justify-end border-t border-border/50 pt-3">
        <Button
          type="button"
          size="sm"
          onClick={() => selectedForkTarget?.entryId && void forkSessionFromSurface(selectedForkTarget.entryId)}
          disabled={!selectedForkTarget?.entryId || commandSurface.pendingAction === "fork_session"}
          data-testid="command-surface-apply-fork"
          className="h-8 gap-1.5"
        >
          {commandSurface.pendingAction === "fork_session" ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitBranch className="h-3.5 w-3.5" />
          )}
          Create fork
        </Button>
      </div>
    </div>
  )

  const renderSessionSection = () => (
    <div className="space-y-4" data-testid="command-surface-session">
      <SectionHeader
        title="Session"
        status={
          <span className="text-xs text-muted-foreground">{currentSessionLabel ?? "pending"}</span>
        }
        action={
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadSessionStats()} disabled={sessionBusy} className="h-7 gap-1.5 text-xs">
            <RefreshCw className={cn("h-3 w-3", commandSurface.pendingAction === "load_session_stats" && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      {commandSurface.sessionStats ? (
        <>
          {/* Token & cost grid */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Input", value: formatTokens(commandSurface.sessionStats.tokens.input) },
              { label: "Output", value: formatTokens(commandSurface.sessionStats.tokens.output) },
              { label: "Total", value: formatTokens(commandSurface.sessionStats.tokens.total) },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 text-center">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">{value}</div>
              </div>
            ))}
          </div>

          {/* Message breakdown */}
          <div className="divide-y divide-border/30 rounded-lg border border-border/50 bg-card/50">
            <div className="px-4 py-2">
              <KV label="User messages">{commandSurface.sessionStats.userMessages}</KV>
              <KV label="Assistant messages">{commandSurface.sessionStats.assistantMessages}</KV>
              <KV label="Tool calls">{commandSurface.sessionStats.toolCalls}</KV>
              <KV label="Tool results">{commandSurface.sessionStats.toolResults}</KV>
            </div>
            <div className="px-4 py-2">
              <KV label="Total messages">{commandSurface.sessionStats.totalMessages}</KV>
              <KV label="Cost">{formatCost(commandSurface.sessionStats.cost)}</KV>
              {commandSurface.sessionStats.tokens.cacheRead > 0 && (
                <KV label="Cache read">{formatTokens(commandSurface.sessionStats.tokens.cacheRead)}</KV>
              )}
            </div>
          </div>
        </>
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">Refresh to load session stats.</p>
      )}

      {/* Export */}
      <div className="space-y-3 border-t border-border/50 pt-3">
        <div className="text-xs font-medium text-muted-foreground">Export</div>
        <div className="flex gap-2">
          <Input
            value={selectedSessionTarget?.outputPath ?? ""}
            onChange={(e) => selectCommandSurfaceTarget({ kind: "session", outputPath: e.target.value })}
            placeholder="Output path (optional)"
            className="h-8 flex-1 text-xs"
            disabled={commandSurface.pendingAction === "export_html"}
            data-testid="command-surface-export-path"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void exportSessionFromSurface(selectedSessionTarget?.outputPath)}
            disabled={commandSurface.pendingAction === "export_html"}
            data-testid="command-surface-export-session"
            className="h-8 gap-1.5"
          >
            {commandSurface.pendingAction === "export_html" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Export HTML
          </Button>
        </div>
      </div>
    </div>
  )

  const renderCompactSection = () => (
    <div className="space-y-4" data-testid="command-surface-compact">
      <SectionHeader
        title="Manual compact"
        status={
          compactBusy ? (
            <span className="flex items-center gap-1.5 text-xs text-warning">
              <LoaderCircle className="h-3 w-3 animate-spin" /> Working
            </span>
          ) : null
        }
      />

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="command-surface-compact-instructions">
          Custom instructions
        </label>
        <Textarea
          id="command-surface-compact-instructions"
          data-testid="command-surface-compact-instructions"
          value={selectedCompactTarget?.customInstructions ?? ""}
          onChange={(e) => selectCommandSurfaceTarget({ kind: "compact", customInstructions: e.target.value })}
          placeholder="Tell compaction what to preserve or emphasize…"
          rows={4}
          disabled={compactBusy}
          className="text-xs"
        />
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={() => void compactSessionFromSurface(selectedCompactTarget?.customInstructions)}
          disabled={compactBusy}
          data-testid="command-surface-apply-compact"
          className="h-8 gap-1.5"
        >
          {compactBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
          Compact now
        </Button>
      </div>

      {commandSurface.lastCompaction && (
        <div className="space-y-2 rounded-lg border border-border/50 bg-card/50 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Last compaction</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{formatTokens(commandSurface.lastCompaction.tokensBefore)} before</span>
          </div>
          <p className="whitespace-pre-wrap text-xs text-foreground">{commandSurface.lastCompaction.summary}</p>
          <p className="text-[11px] text-muted-foreground">First kept: {commandSurface.lastCompaction.firstKeptEntryId}</p>
        </div>
      )}
    </div>
  )

  const renderAuthSection = () => {
    if (!onboarding) return null
    return (
      <div className="space-y-4" data-testid="command-surface-auth">
        <SectionHeader
          title="Auth"
          status={
            <span className="text-xs text-muted-foreground">
              {selectedAuthIntent === "login" ? "Login" : selectedAuthIntent === "logout" ? "Logout" : "Manage"}
            </span>
          }
        />

        {/* Provider list */}
        <div className="space-y-1">
          {onboarding.required.providers.map((provider) => {
            const selected = provider.id === selectedAuthProvider?.id
            return (
              <button
                key={provider.id}
                type="button"
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                  selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.03]",
                )}
                onClick={() =>
                  selectCommandSurfaceTarget({ kind: "auth", providerId: provider.id, intent: selectedAuthIntent })
                }
              >
                <div className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  selected ? "border-foreground bg-foreground" : "border-foreground/25",
                )}>
                  {selected && <Check className="h-2.5 w-2.5 text-background" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{provider.label}</span>
                    {provider.configured && <StatusDot status="ok" />}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {provider.configured ? `via ${provider.configuredVia}` : "Not configured"}
                  </span>
                </div>
                {provider.recommended && (
                  <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Recommended</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Selected provider details */}
        {selectedAuthProvider && (
          <div className="space-y-4 border-t border-border/50 pt-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-foreground">{selectedAuthProvider.label}</div>
                <span className="text-xs text-muted-foreground">{selectedAuthProvider.configuredVia ?? "Not configured"}</span>
              </div>
            </div>

            {/* API key form */}
            {selectedAuthProvider.supports.apiKey && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!selectedProviderApiKey.trim()) return
                  void saveApiKeyFromSurface(selectedAuthProvider.id, selectedProviderApiKey)
                }}
              >
                <div className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={selectedProviderApiKey}
                    onChange={(e) =>
                      setApiKeys((prev) => ({ ...prev, [selectedAuthProvider.id]: e.target.value }))
                    }
                    placeholder="Paste API key"
                    className="h-8 flex-1 text-xs"
                    disabled={authBusy}
                    data-testid="command-surface-api-key-input"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!selectedProviderApiKey.trim() || authBusy}
                    data-testid="command-surface-save-api-key"
                    className="h-8 gap-1.5"
                  >
                    {commandSurface.pendingAction === "save_api_key" ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5" />
                    )}
                    Save
                  </Button>
                </div>
              </form>
            )}

            {/* OAuth / sign-in buttons */}
            <div className="flex flex-wrap gap-2">
              {selectedAuthProvider.supports.oauth && selectedAuthProvider.supports.oauthAvailable && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={authBusy}
                  onClick={() => void startProviderFlowFromSurface(selectedAuthProvider.id)}
                  data-testid="command-surface-start-provider-flow"
                  className="h-8 gap-1.5 text-xs"
                >
                  {commandSurface.pendingAction === "start_provider_flow" ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LogIn className="h-3.5 w-3.5" />
                  )}
                  Browser sign-in
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={authBusy}
                onClick={() => void logoutProviderFromSurface(selectedAuthProvider.id)}
                data-testid="command-surface-logout-provider"
                className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
              >
                {commandSurface.pendingAction === "logout_provider" ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogOut className="h-3.5 w-3.5" />
                )}
                Logout
              </Button>
            </div>

            {/* Active OAuth flow */}
            {activeFlow && activeFlow.providerId === selectedAuthProvider.id && (
              <div className="space-y-3 rounded-lg border border-foreground/10 bg-foreground/[0.03] px-4 py-3" data-testid="command-surface-active-flow">
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant="outline" className="text-[10px]">{activeFlow.status.replaceAll("_", " ")}</Badge>
                  <span className="text-muted-foreground">{new Date(activeFlow.updatedAt).toLocaleTimeString()}</span>
                </div>

                {activeFlow.auth?.instructions && (
                  <p className="text-xs text-muted-foreground">{activeFlow.auth.instructions}</p>
                )}

                {activeFlow.auth?.url && (
                  <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 text-xs" data-testid="command-surface-open-auth-url">
                    <a href={activeFlow.auth.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-3 w-3" />
                      Open sign-in page
                    </a>
                  </Button>
                )}

                {activeFlow.progress.length > 0 && (
                  <div className="space-y-1">
                    {activeFlow.progress.map((message, index) => (
                      <div key={`${activeFlow.flowId}-${index}`} className="rounded-md border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                        {message}
                      </div>
                    ))}
                  </div>
                )}

                {activeFlow.prompt && (
                  <form
                    className="space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (!activeFlow.prompt?.allowEmpty && !flowInput.trim()) return
                      void submitProviderFlowInputFromSurface(activeFlow.flowId, flowInput)
                    }}
                  >
                    <Input
                      value={flowInput}
                      onChange={(e) => setFlowInput(e.target.value)}
                      placeholder={activeFlow.prompt.placeholder || "Enter value"}
                      className="h-8 text-xs"
                      disabled={authBusy}
                      data-testid="command-surface-flow-input"
                    />
                    <p className="text-[11px] text-muted-foreground">{activeFlow.prompt.message}</p>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={authBusy || (!activeFlow.prompt.allowEmpty && !flowInput.trim())} className="h-7 gap-1.5 text-xs">
                        {commandSurface.pendingAction === "submit_provider_flow_input" ? (
                          <LoaderCircle className="h-3 w-3 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-3 w-3" />
                        )}
                        Continue
                      </Button>
                      <Button type="button" variant="ghost" size="sm" disabled={authBusy} onClick={() => void cancelProviderFlowFromSurface(activeFlow.flowId)} className="h-7 text-xs">
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {/* Bridge auth refresh status */}
            {onboarding.bridgeAuthRefresh.phase !== "idle" && (
              <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 text-xs">
                <span className="font-medium text-foreground">Auth refresh</span>
                <span className="ml-2 text-muted-foreground">
                  {onboarding.bridgeAuthRefresh.phase === "pending"
                    ? "Refreshing…"
                    : onboarding.bridgeAuthRefresh.phase === "failed"
                      ? onboarding.bridgeAuthRefresh.error || "Failed."
                      : "Complete."}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ═══════════════════════════════════════════════════════════════════
  // SECTION DISPATCH
  // ═══════════════════════════════════════════════════════════════════

  const renderAdminSection = () => (
    <div className="space-y-5" data-testid="command-surface-admin">
      <SectionHeader
        title="Admin"
        status={
          <Badge variant="outline" className="border-warning/20 bg-warning/[0.06] text-[10px] text-warning">
            Dev only
          </Badge>
        }
      />

      {/* Master toggle */}
      <ToggleRow
        label="UI overrides"
        description="Enable keyboard shortcuts and forced UI states for development"
        checked={devOverrides.enabled}
        onCheckedChange={devOverrides.setEnabled}
        testId="admin-ui-overrides-master"
      />

      {/* Individual overrides — only visible when master is on */}
      {devOverrides.enabled && (
        <div className="space-y-2 rounded-lg border border-border/50 bg-card/50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Override shortcuts
          </div>
          {DEV_OVERRIDE_REGISTRY.map((entry) => (
            <div
              key={entry.key}
              className="flex items-start justify-between gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-foreground/[0.03]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{entry.label}</span>
                  <Badge variant="outline" className="border-border font-mono text-[10px] text-muted-foreground">
                    {entry.shortcutLabel}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{entry.description}</p>
              </div>
              <Switch
                checked={devOverrides.overrides[entry.key]}
                onCheckedChange={() => devOverrides.toggle(entry.key)}
                data-testid={`admin-override-${entry.key}`}
              />
            </div>
          ))}
        </div>
      )}

      {/* Onboarding — one-click launch */}
      <div className="rounded-lg border border-border/50 bg-card/50 p-3 space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Onboarding
        </div>
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">Run setup wizard</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Opens the full onboarding flow as a new user would see it.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 gap-1.5 text-xs"
            onClick={() => {
              closeCommandSurface()
              // Small delay so the sheet closes before the gate renders
              window.setTimeout(() => {
                if (!devOverrides.enabled) devOverrides.setEnabled(true)
                if (!devOverrides.overrides.forceOnboarding) devOverrides.toggle("forceOnboarding")
              }, 150)
            }}
            data-testid="admin-trigger-onboarding"
          >
            Launch
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 text-xs text-muted-foreground">
        This tab is only visible when running via{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">npm run gsd:web</code>.
        Overrides reset on page refresh.
      </div>
    </div>
  )

  const renderSection = () => {
    switch (commandSurface.section) {
      case "general": return <GeneralPanel />
      case "experimental": return <ExperimentalPanel />
      case "model": return (
        <div className="space-y-8">
          {renderModelSection()}
          <div className="border-t border-border/50 pt-6">
            {renderThinkingSection()}
          </div>
        </div>
      )
      case "thinking": return (
        <div className="space-y-8">
          {renderModelSection()}
          <div className="border-t border-border/50 pt-6">
            {renderThinkingSection()}
          </div>
        </div>
      )
      case "session-behavior": return (
        <div className="space-y-6">
          {renderQueueSection()}
          <div className="border-t border-border/50 pt-4">
            {renderCompactionSection()}
          </div>
          <div className="border-t border-border/50 pt-4">
            {renderRetrySection()}
          </div>
        </div>
      )
      // Legacy section routes — redirect to merged panels
      case "queue": return (
        <div className="space-y-6">
          {renderQueueSection()}
          <div className="border-t border-border/50 pt-4">
            {renderCompactionSection()}
          </div>
          <div className="border-t border-border/50 pt-4">
            {renderRetrySection()}
          </div>
        </div>
      )
      case "compaction": return (
        <div className="space-y-6">
          {renderQueueSection()}
          <div className="border-t border-border/50 pt-4">
            {renderCompactionSection()}
          </div>
          <div className="border-t border-border/50 pt-4">
            {renderRetrySection()}
          </div>
        </div>
      )
      case "retry": return (
        <div className="space-y-6">
          {renderQueueSection()}
          <div className="border-t border-border/50 pt-4">
            {renderCompactionSection()}
          </div>
          <div className="border-t border-border/50 pt-4">
            {renderRetrySection()}
          </div>
        </div>
      )
      case "recovery": return renderRecoverySection()
      case "auth": return renderAuthSection()
      case "admin": return renderAdminSection()
      case "git": return renderGitSection()
      case "resume": return renderSessionBrowserSection("resume")
      case "name": return renderSessionBrowserSection("name")
      case "fork": return renderForkSection()
      case "session": return renderSessionSection()
      case "compact": return renderCompactSection()
      case "workspace": return <DevRootSettingsSection />
      case "integrations": return <RemoteQuestionsPanel />
      case "gsd-forensics": return <ForensicsPanel />
      case "gsd-doctor": return <DoctorPanel />
      case "gsd-skill-health": return <SkillHealthPanel />
      case "gsd-knowledge": return <KnowledgeCapturesPanel initialTab="knowledge" />
      case "gsd-capture": return <KnowledgeCapturesPanel initialTab="captures" />
      case "gsd-triage": return <KnowledgeCapturesPanel initialTab="captures" />
      case "gsd-prefs": return (
        <div className="space-y-6">
          <DevRootSettingsSection />
          <PrefsPanel />
          <ModelRoutingPanel />
          <BudgetPanel />
          <RemoteQuestionsPanel />
          <GeneralPanel />
          <ExperimentalPanel />
        </div>
      )
      case "gsd-mode": return <ModelRoutingPanel />
      case "gsd-config": return <BudgetPanel />
      case "gsd-quick": return <QuickPanel />
      case "gsd-history": return <HistoryPanel />
      case "gsd-undo": return <UndoPanel />
      case "gsd-steer": return <SteerPanel />
      case "gsd-hooks": return <HooksPanel />
      case "gsd-inspect": return <InspectPanel />
      case "gsd-export": return <ExportPanel />
      case "gsd-cleanup": return <CleanupPanel />
      case "gsd-queue": return <QueuePanel />
      case "gsd-status": return <StatusPanel />
      default:
        // Safety net for any unknown GSD surface
        if (commandSurface.section?.startsWith("gsd-")) {
          return (
            <div className="p-4 text-sm text-muted-foreground" data-testid={`gsd-surface-${commandSurface.section}`}>
              <p className="font-medium text-foreground">/gsd {commandSurface.section.slice(4)}</p>
              <p className="mt-1">Unknown GSD surface.</p>
            </div>
          )
        }
        return null
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════

  const isSingleSection = surfaceSections.length <= 1
  const isGitSurface = commandSurface.activeSurface === "git"
  const gitResult = gitSummary.result

  const renderGitHeader = () => {
    const branchName = gitResult?.kind === "repo" ? (gitResult.branch ?? "detached") : null
    const mainBranch = gitResult?.kind === "repo" ? gitResult.mainBranch : null
    const hasChanges = gitResult?.kind === "repo" ? gitResult.hasChanges : false
    const isClean = gitResult?.kind === "repo" && !hasChanges

    return (
      <div className="border-b border-border/50 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg",
              isClean ? "bg-success/10" : hasChanges ? "bg-warning/10" : "bg-card/50",
            )}>
              <GitBranch className={cn(
                "h-4 w-4",
                isClean ? "text-success" : hasChanges ? "text-warning" : "text-muted-foreground",
              )} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground" data-testid="command-surface-title">
                  {branchName ?? "Git"}
                </h2>
                {branchName && mainBranch && branchName !== mainBranch && (
                  <span className="text-[11px] text-muted-foreground">from {mainBranch}</span>
                )}
              </div>
              {gitResult?.kind === "repo" && (
                <div className="mt-0.5 flex items-center gap-1.5">
                  <StatusDot status={isClean ? "ok" : hasChanges ? "warning" : "idle"} />
                  <span className="text-[11px] text-muted-foreground">
                    {isClean ? "Clean" : hasChanges ? "Changes detected" : "Loading…"}
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void loadGitSummary()}
              disabled={gitSummaryBusy}
              aria-label="Refresh"
              className="h-7 w-7"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", gitSummaryBusy && "animate-spin")} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={closeCommandSurface}
              aria-label="Close"
              className="h-7 w-7"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const renderDefaultHeader = () => (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 px-5 py-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Command surface</div>
        <div className="text-lg font-semibold text-foreground" data-testid="command-surface-title">
          {surfaceTitle(commandSurface.activeSurface)}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground" data-testid="command-surface-kind">
          {surfaceKindLabel}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={closeCommandSurface}
          aria-label="Close"
          className="h-8 w-8"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )

  return (
    <Sheet open={commandSurface.open} onOpenChange={(open) => !open && closeCommandSurface()}>
      <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-[540px]" data-testid="command-surface">
        {/* Visually hidden accessible title */}
        <SheetHeader className="sr-only">
          <SheetTitle>{surfaceTitle(commandSurface.activeSurface)}</SheetTitle>
          <SheetDescription>Settings and controls</SheetDescription>
        </SheetHeader>

        <div className="flex h-full min-h-0">
          {/* ─── Left nav rail (hidden for single-section surfaces) ─── */}
          {!isSingleSection && (
            <nav className="flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-border/50 bg-card/50 py-3" data-testid="command-surface-sections">
              {surfaceSections.map((section) => {
                const active = commandSurface.section === section
                return (
                  <Tooltip key={section}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                          active
                            ? "bg-foreground/10 text-foreground"
                            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                        )}
                        onClick={() => setCommandSurfaceSection(section)}
                        data-testid={`command-surface-section-${section}`}
                      >
                        {sectionIcon(section)}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={6}>
                      {sectionLabel(section)}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </nav>
          )}

          {/* ─── Right content area ────────────────────────────────── */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {isGitSurface ? renderGitHeader() : renderDefaultHeader()}
            {(commandSurface.lastResult || commandSurface.lastError) && (
              <div
                className={cn(
                  "border-b border-border/50 px-5 py-3 text-xs",
                  commandSurface.lastError ? "bg-destructive/5 text-destructive" : "bg-success/5 text-success",
                )}
                data-testid="command-surface-result"
              >
                {commandSurface.lastError ?? commandSurface.lastResult}
              </div>
            )}
            <ScrollArea className="min-h-0 flex-1" viewportRef={commandSurfaceViewportRef}>
              <div className="px-5 py-5">
                {renderSection()}
              </div>
            </ScrollArea>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
