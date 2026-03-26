"use client"

import { useState, useEffect, useCallback } from "react"

import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  DollarSign,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  LoaderCircle,
  Radio,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Type,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  SettingsData,
  SettingsPatternHistory,
  SettingsRoutingHistory,
} from "@/lib/settings-types"
import { cn } from "@/lib/utils"
import {
  formatCost,
  formatTokens,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"
import { useTerminalFontSize } from "@/lib/use-terminal-font-size"
import { useEditorFontSize } from "@/lib/use-editor-font-size"
import { authFetch } from "@/lib/auth"

// ═══════════════════════════════════════════════════════════════════════
// SHARED INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════

function SettingsHeader({
  title,
  icon,
  subtitle,
  onRefresh,
  refreshing,
}: {
  title: string
  icon: React.ReactNode
  subtitle?: string | null
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 pb-4">
      <div className="flex items-center gap-2.5">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        {subtitle && <span className="text-[11px] text-muted-foreground">{subtitle}</span>}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing} className="h-7 gap-1.5 text-xs">
        <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
        Refresh
      </Button>
    </div>
  )
}

function SettingsError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
      {message}
    </div>
  )
}

function SettingsLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      {label}
    </div>
  )
}

function SettingsEmpty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-4 py-5 text-center text-xs text-muted-foreground">
      {message}
    </div>
  )
}

function Pill({ label, value, variant }: { label: string; value: string | number; variant?: "default" | "info" | "warning" | "success" }) {
  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs",
      variant === "info" && "border-info/20 bg-info/5 text-info",
      variant === "warning" && "border-warning/20 bg-warning/5 text-warning",
      variant === "success" && "border-success/20 bg-success/5 text-success",
      (!variant || variant === "default") && "border-border/50 bg-card/50 text-foreground/80",
    )}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

function FlagBadge({ label, enabled }: { label: string; enabled: boolean | undefined }) {
  return (
    <Badge
      variant={enabled ? "secondary" : "outline"}
      className={cn(
        "text-[10px] px-1.5 py-0 font-mono",
        enabled ? "border-success/30 text-success" : "text-muted-foreground",
      )}
    >
      {label}: {enabled ? "on" : "off"}
    </Badge>
  )
}

function SkillBadgeList({ label, skills }: { label: string; skills: string[] | undefined }) {
  if (!skills?.length) return null
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {skills.map((skill) => (
          <Badge key={skill} variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
            {skill}
          </Badge>
        ))}
      </div>
    </div>
  )
}

function KvRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground/80 text-right truncate">{children}</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// HOOK: shared settings data access
// ═══════════════════════════════════════════════════════════════════════

function useSettingsData() {
  const workspace = useGSDWorkspaceState()
  const { loadSettingsData } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.settingsData
  return {
    state,
    data: state.data as SettingsData | null,
    busy: state.phase === "loading",
    refresh: () => void loadSettingsData(),
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PREFS PANEL
// ═══════════════════════════════════════════════════════════════════════

function tokenProfileVariant(profile: string | undefined): "info" | "warning" | "success" {
  if (profile === "budget") return "warning"
  if (profile === "quality") return "success"
  return "info"
}

export function PrefsPanel() {
  const { state, data, busy, refresh } = useSettingsData()
  const prefs = data?.preferences ?? null

  return (
    <div className="space-y-4" data-testid="settings-prefs">
      <SettingsHeader
        title="Effective Preferences"
        icon={<Settings className="h-3.5 w-3.5" />}
        subtitle={prefs ? `${prefs.scope} scope` : null}
        onRefresh={refresh}
        refreshing={busy}
      />

      {state.error && <SettingsError message={state.error} />}
      {busy && !data && <SettingsLoading label="Loading preferences…" />}

      {data && !prefs && <SettingsEmpty message="No preferences file found" />}

      {prefs && (
        <>
          {/* Core mode & profile */}
          <div className="flex flex-wrap gap-2">
            <Pill label="Mode" value={prefs.mode ?? "solo"} variant="info" />
            <Pill label="Token Profile" value={prefs.tokenProfile ?? "balanced"} variant={tokenProfileVariant(prefs.tokenProfile)} />
            {prefs.customInstructions?.length ? (
              <Pill label="Custom Instructions" value={prefs.customInstructions.length} />
            ) : null}
          </div>

          {/* Skills */}
          <div className="space-y-2">
            <SkillBadgeList label="Always use" skills={prefs.alwaysUseSkills} />
            <SkillBadgeList label="Prefer" skills={prefs.preferSkills} />
            <SkillBadgeList label="Avoid" skills={prefs.avoidSkills} />
            {!prefs.alwaysUseSkills?.length && !prefs.preferSkills?.length && !prefs.avoidSkills?.length && (
              <span className="text-[11px] text-muted-foreground">No skill preferences configured</span>
            )}
          </div>

          {/* Toggles */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border/50 bg-card/50 px-3 py-2.5">
            <KvRow label="Auto-Supervisor">
              {prefs.autoSupervisor?.enabled ? (
                <span className="text-success">
                  on{prefs.autoSupervisor.softTimeoutMinutes != null && ` (${prefs.autoSupervisor.softTimeoutMinutes}m)`}
                </span>
              ) : (
                <span className="text-muted-foreground">off</span>
              )}
            </KvRow>
            <KvRow label="UAT Dispatch">
              <span className={prefs.uatDispatch ? "text-success" : "text-muted-foreground"}>
                {prefs.uatDispatch ? "on" : "off"}
              </span>
            </KvRow>
            <KvRow label="Auto-Visualize">
              <span className={prefs.autoVisualize ? "text-success" : "text-muted-foreground"}>
                {prefs.autoVisualize ? "on" : "off"}
              </span>
            </KvRow>
            <KvRow label="Preference Scope">
              <span className="font-mono text-[10px]">{prefs.scope}</span>
            </KvRow>
          </div>

          {/* Source file */}
          <div className="text-[11px] text-muted-foreground truncate font-mono">
            Source: {prefs.path}
          </div>

          {/* Warnings */}
          {prefs.warnings && prefs.warnings.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle className="h-3 w-3" />
                <span className="font-medium">Warnings ({prefs.warnings.length})</span>
              </div>
              {prefs.warnings.map((warning, i) => (
                <div key={i} className="rounded border border-warning/20 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning">
                  {warning}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// MODEL ROUTING PANEL
// ═══════════════════════════════════════════════════════════════════════

function topPatterns(history: SettingsRoutingHistory, max = 5): Array<{ name: string; total: number; pattern: SettingsPatternHistory }> {
  return Object.entries(history.patterns)
    .map(([name, pattern]) => {
      const total =
        pattern.light.success + pattern.light.fail +
        pattern.standard.success + pattern.standard.fail +
        pattern.heavy.success + pattern.heavy.fail
      return { name, total, pattern }
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, max)
}

function TierModelRow({ tier, modelId }: { tier: string; modelId: string | undefined }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted-foreground capitalize">{tier}</span>
      <span className="font-mono text-[11px] text-foreground/80 truncate max-w-[200px]">
        {modelId ?? <span className="text-muted-foreground italic">default</span>}
      </span>
    </div>
  )
}

function TierOutcomeBadge({ tier, success, fail }: { tier: string; success: number; fail: number }) {
  const total = success + fail
  if (total === 0) return null
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] px-1.5 py-0 font-mono",
        fail > 0 ? "border-destructive/20 text-destructive" : "text-muted-foreground",
      )}
    >
      {tier}: {success}✓{fail > 0 && <span> {fail}✗</span>}
    </Badge>
  )
}

export function ModelRoutingPanel() {
  const { state, data, busy, refresh } = useSettingsData()
  const routingConfig = data?.routingConfig ?? null
  const routingHistory = data?.routingHistory ?? null

  return (
    <div className="space-y-4" data-testid="settings-model-routing">
      <SettingsHeader
        title="Model Routing"
        icon={<Cpu className="h-3.5 w-3.5" />}
        onRefresh={refresh}
        refreshing={busy}
      />

      {state.error && <SettingsError message={state.error} />}
      {busy && !data && <SettingsLoading label="Loading routing config…" />}

      {data && (
        <>
          {/* Dynamic routing status */}
          <div className="flex items-center gap-2">
            <Badge
              variant={routingConfig?.enabled ? "secondary" : "outline"}
              className={cn(
                "text-[10px] px-2 py-0.5",
                routingConfig?.enabled ? "border-success/30 text-success" : "text-muted-foreground",
              )}
            >
              Dynamic Routing: {routingConfig?.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>

          {/* Tier assignments */}
          {routingConfig?.tier_models && (
            <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 space-y-1.5">
              <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Tier Assignments</h4>
              <TierModelRow tier="light" modelId={routingConfig.tier_models.light} />
              <TierModelRow tier="standard" modelId={routingConfig.tier_models.standard} />
              <TierModelRow tier="heavy" modelId={routingConfig.tier_models.heavy} />
            </div>
          )}

          {/* Routing flags */}
          <div className="flex flex-wrap gap-1.5">
            <FlagBadge label="escalate_on_failure" enabled={routingConfig?.escalate_on_failure} />
            <FlagBadge label="budget_pressure" enabled={routingConfig?.budget_pressure} />
            <FlagBadge label="cross_provider" enabled={routingConfig?.cross_provider} />
            <FlagBadge label="hooks" enabled={routingConfig?.hooks} />
          </div>

          {/* Routing history */}
          {routingHistory ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Pill label="Patterns" value={Object.keys(routingHistory.patterns).length} />
                <Pill label="Feedback" value={routingHistory.feedback.length} />
              </div>

              {/* Top patterns table */}
              {Object.keys(routingHistory.patterns).length > 0 && (
                <div className="space-y-1.5">
                  <h4 className="text-[11px] font-medium text-muted-foreground">Top Patterns</h4>
                  <div className="space-y-2">
                    {topPatterns(routingHistory).map(({ name, total, pattern }) => (
                      <div key={name} className="rounded-lg border border-border/50 bg-card/50 px-3 py-2 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-mono text-foreground/80 truncate">{name}</span>
                          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{total} attempts</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <TierOutcomeBadge tier="L" success={pattern.light.success} fail={pattern.light.fail} />
                          <TierOutcomeBadge tier="S" success={pattern.standard.success} fail={pattern.standard.fail} />
                          <TierOutcomeBadge tier="H" success={pattern.heavy.success} fail={pattern.heavy.fail} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <SettingsEmpty message="No routing history yet" />
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// BUDGET PANEL
// ═══════════════════════════════════════════════════════════════════════

function enforcementVariant(enforcement: string | undefined): "info" | "warning" | "success" {
  if (enforcement === "halt") return "warning"
  if (enforcement === "pause") return "info"
  return "success"
}

function formatChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`
  if (chars >= 1_000) return `${Math.round(chars / 1_000)}K`
  return String(chars)
}

export function BudgetPanel() {
  const { state, data, busy, refresh } = useSettingsData()
  const prefs = data?.preferences ?? null
  const budget = data?.budgetAllocation ?? null
  const totals = data?.projectTotals ?? null

  return (
    <div className="space-y-4" data-testid="settings-budget">
      <SettingsHeader
        title="Budget & Costs"
        icon={<DollarSign className="h-3.5 w-3.5" />}
        onRefresh={refresh}
        refreshing={busy}
      />

      {state.error && <SettingsError message={state.error} />}
      {busy && !data && <SettingsLoading label="Loading budget data…" />}

      {data && (
        <>
          {/* Budget controls */}
          <div className="flex flex-wrap gap-2">
            <Pill
              label="Ceiling"
              value={prefs?.budgetCeiling != null ? formatCost(prefs.budgetCeiling) : "Not set"}
              variant={prefs?.budgetCeiling != null ? "warning" : "default"}
            />
            <Pill
              label="Enforcement"
              value={prefs?.budgetEnforcement ?? "Not set"}
              variant={prefs?.budgetEnforcement ? enforcementVariant(prefs.budgetEnforcement) : "default"}
            />
            <Pill
              label="Token Profile"
              value={prefs?.tokenProfile ?? "balanced"}
              variant={tokenProfileVariant(prefs?.tokenProfile)}
            />
          </div>

          {/* Context budget allocations */}
          {budget && (
            <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 space-y-1.5">
              <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Context Budget Allocations</h4>
              <KvRow label="Summary Budget">{formatChars(budget.summaryBudgetChars)} chars</KvRow>
              <KvRow label="Inline Context">{formatChars(budget.inlineContextBudgetChars)} chars</KvRow>
              <KvRow label="Verification">{formatChars(budget.verificationBudgetChars)} chars</KvRow>
              <KvRow label="Task Count Range">{budget.taskCountRange.min}–{budget.taskCountRange.max}</KvRow>
              <KvRow label="Continue Threshold">{budget.continueThresholdPercent}%</KvRow>
            </div>
          )}

          {/* Project cost totals */}
          {totals ? (
            <div className="space-y-3">
              <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Project Cost Totals</h4>

              {/* Summary pills */}
              <div className="flex flex-wrap gap-2">
                <Pill label="Units" value={totals.units} />
                <Pill label="Total Cost" value={formatCost(totals.cost)} variant="warning" />
                <Pill label="Duration" value={`${Math.round(totals.duration / 1000)}s`} />
              </div>

              {/* Token breakdown */}
              <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 space-y-1.5">
                <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Token Breakdown</h4>
                <KvRow label="Input">{formatTokens(totals.tokens.input)}</KvRow>
                <KvRow label="Output">{formatTokens(totals.tokens.output)}</KvRow>
                <KvRow label="Cache Read">{formatTokens(totals.tokens.cacheRead)}</KvRow>
                <KvRow label="Cache Write">{formatTokens(totals.tokens.cacheWrite)}</KvRow>
                <KvRow label="Total">{formatTokens(totals.tokens.total)}</KvRow>
              </div>

              {/* Interaction counts */}
              <div className="flex flex-wrap gap-2">
                <Pill label="Tool Calls" value={totals.toolCalls} />
                <Pill label="Assistant Msgs" value={totals.assistantMessages} />
                <Pill label="User Msgs" value={totals.userMessages} />
              </div>
            </div>
          ) : (
            <SettingsEmpty message="No execution metrics yet" />
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// REMOTE QUESTIONS PANEL (Integrations tab)
// ═══════════════════════════════════════════════════════════════════════

type RemoteChannel = "slack" | "discord" | "telegram"

const CHANNEL_OPTIONS: {
  value: RemoteChannel
  label: string
  description: string
  idPlaceholder: string
}[] = [
  { value: "slack", label: "Slack", description: "Get pinged in a Slack channel", idPlaceholder: "Channel ID (e.g. C01ABCD2EFG)" },
  { value: "discord", label: "Discord", description: "Get pinged in a Discord channel", idPlaceholder: "Channel ID (17–20 digit number)" },
  { value: "telegram", label: "Telegram", description: "Get pinged via Telegram bot", idPlaceholder: "Chat ID (numeric, may start with -)" },
]

const CHANNEL_ID_PATTERNS: Record<RemoteChannel, RegExp> = {
  slack: /^[A-Z0-9]{9,12}$/,
  discord: /^\d{17,20}$/,
  telegram: /^-?\d{5,20}$/,
}

interface RemoteQuestionsApiResponse {
  config: {
    channel: RemoteChannel
    channelId: string
    timeoutMinutes: number
    pollIntervalSeconds: number
  } | null
  envVarSet: boolean
  tokenSet: boolean
  envVarName: string | null
  status: string
  error?: string
}

export function RemoteQuestionsPanel() {
  const { data, busy, refresh } = useSettingsData()
  const existingConfig = data?.preferences?.remoteQuestions ?? null

  const [envVarSet, setEnvVarSet] = useState(false)
  const [envVarName, setEnvVarName] = useState<string | null>(null)
  const [apiLoading, setApiLoading] = useState(true)
  const [tokenSet, setTokenSet] = useState(false)

  const [channel, setChannel] = useState<RemoteChannel>("slack")
  const [channelId, setChannelId] = useState("")
  const [timeoutMinutes, setTimeoutMinutes] = useState(5)
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(5)
  const [botToken, setBotToken] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [savingToken, setSavingToken] = useState(false)
  const [tokenSuccess, setTokenSuccess] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isConfigured, setIsConfigured] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const fetchApiStatus = useCallback(async () => {
    try {
      setApiLoading(true)
      const res = await authFetch("/api/remote-questions", { cache: "no-store" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }))
        setError(body.error ?? `API error ${res.status}`)
        return
      }
      const json: RemoteQuestionsApiResponse = await res.json()
      setEnvVarSet(json.envVarSet)
      setEnvVarName(json.envVarName)
      setTokenSet(json.tokenSet)
      setIsConfigured(json.status === "configured" && json.config !== null)
      if (json.config) {
        setChannel(json.config.channel)
        setChannelId(json.config.channelId)
        setTimeoutMinutes(json.config.timeoutMinutes)
        setPollIntervalSeconds(json.config.pollIntervalSeconds)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch remote questions status")
    } finally {
      setApiLoading(false)
    }
  }, [])

  useEffect(() => { void fetchApiStatus() }, [fetchApiStatus])

  useEffect(() => {
    if (existingConfig?.channel) {
      setChannel(existingConfig.channel)
      setChannelId(existingConfig.channelId ?? "")
      setTimeoutMinutes(existingConfig.timeoutMinutes ?? 5)
      setPollIntervalSeconds(existingConfig.pollIntervalSeconds ?? 5)
    }
  }, [existingConfig])

  const channelIdValid = channelId.trim().length > 0 && CHANNEL_ID_PATTERNS[channel].test(channelId.trim())
  const canSave = channelIdValid && !saving && !deleting

  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(null), 3000)
    return () => clearTimeout(timer)
  }, [success])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await authFetch("/api/remote-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, channelId: channelId.trim(), timeoutMinutes, pollIntervalSeconds }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? `Save failed (${res.status})`); return }
      setSuccess("Configuration saved")
      setIsConfigured(true)
      refresh()
      void fetchApiStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save configuration")
    } finally {
      setSaving(false)
    }
  }

  const handleDisconnect = async () => {
    setDeleting(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await authFetch("/api/remote-questions", { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? `Disconnect failed (${res.status})`); return }
      setSuccess("Channel disconnected")
      setIsConfigured(false)
      setChannelId("")
      setTimeoutMinutes(5)
      setPollIntervalSeconds(5)
      setChannel("slack")
      setTokenSet(false)
      refresh()
      void fetchApiStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect channel")
    } finally {
      setDeleting(false)
    }
  }

  const handleSaveToken = async () => {
    if (!botToken.trim()) return
    setSavingToken(true)
    setError(null)
    setTokenSuccess(null)
    try {
      const res = await authFetch("/api/remote-questions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, token: botToken.trim() }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? `Token save failed (${res.status})`); return }
      setTokenSuccess(`Token saved (${json.masked})`)
      setTokenSet(true)
      setBotToken("")
      setShowToken(false)
      void fetchApiStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save token")
    } finally {
      setSavingToken(false)
    }
  }

  useEffect(() => {
    if (!tokenSuccess) return
    const timer = setTimeout(() => setTokenSuccess(null), 3000)
    return () => clearTimeout(timer)
  }, [tokenSuccess])

  const derivedEnvVarName = envVarName ?? `${channel.toUpperCase()}_BOT_TOKEN`
  const selectedChannelOption = CHANNEL_OPTIONS.find((o) => o.value === channel)!

  if ((busy || apiLoading) && !data && !isConfigured) {
    return (
      <div className="space-y-5" data-testid="settings-remote-questions">
        <SettingsHeader title="Integrations" icon={<Radio className="h-3.5 w-3.5" />} subtitle="Remote notifications" onRefresh={() => { refresh(); void fetchApiStatus() }} refreshing />
        <SettingsLoading label="Loading integration status…" />
      </div>
    )
  }

  return (
    <div className="space-y-5" data-testid="settings-remote-questions">
      <SettingsHeader
        title="Integrations"
        icon={<Radio className="h-3.5 w-3.5" />}
        subtitle="Remote notifications"
        onRefresh={() => { refresh(); void fetchApiStatus() }}
        refreshing={busy || apiLoading}
      />

      {/* Intro */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Connect a chat channel so the agent pings you when it needs input
        instead of waiting silently.
      </p>

      {/* Feedback banners */}
      {error && <SettingsError message={error} />}
      {success && (
        <div className="flex items-center gap-2.5 rounded-xl border border-success/15 bg-success/[0.04] px-4 py-3 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
          {success}
        </div>
      )}

      {/* ── Connected state banner ───────────────────────────────── */}
      {isConfigured && (
        <div className="rounded-xl border border-success/15 bg-success/[0.04] px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-success/20 bg-success/10">
                <CheckCircle2 className="h-4.5 w-4.5 text-success" />
              </div>
              <div>
                <div className="text-sm font-medium text-foreground">
                  Connected to {selectedChannelOption.label}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {channelId}
                </div>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleDisconnect()}
              disabled={deleting}
              className="h-7 text-xs text-destructive/70 hover:text-destructive"
            >
              {deleting ? <LoaderCircle className="h-3 w-3 animate-spin" /> : "Disconnect"}
            </Button>
          </div>
          <div className="mt-3 flex gap-4 border-t border-success/10 pt-3 text-[11px] text-muted-foreground">
            <span>Timeout: {timeoutMinutes}m</span>
            <span>Poll: {pollIntervalSeconds}s</span>
          </div>
        </div>
      )}

      {/* ── Channel picker (card-based) ──────────────────────────── */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          {isConfigured ? "Switch channel" : "Choose a channel"}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {CHANNEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setChannel(opt.value)
                setError(null)
              }}
              disabled={saving}
              className={cn(
                "rounded-xl border px-3 py-3 text-left transition-all duration-200",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "active:scale-[0.97]",
                channel === opt.value
                  ? "border-foreground/30 bg-foreground/[0.06]"
                  : "border-border/50 bg-card/50 hover:border-foreground/15 hover:bg-card/50",
              )}
            >
              <div className="text-sm font-medium text-foreground">{opt.label}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{opt.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Channel ID input ─────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Channel ID</div>
        <input
          type="text"
          value={channelId}
          onChange={(e) => { setChannelId(e.target.value); if (error) setError(null) }}
          placeholder={selectedChannelOption.idPlaceholder}
          disabled={saving}
          className={cn(
            "w-full rounded-xl border bg-card/50 px-4 py-2.5 font-mono text-sm text-foreground",
            "placeholder:text-muted-foreground",
            "focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent",
            "transition-colors",
            channelId.trim().length > 0 && !CHANNEL_ID_PATTERNS[channel].test(channelId.trim())
              ? "border-destructive/40"
              : "border-border/50",
          )}
          onKeyDown={(e) => { if (e.key === "Enter" && canSave) void handleSave() }}
        />
        {channelId.trim().length > 0 && !CHANNEL_ID_PATTERNS[channel].test(channelId.trim()) && (
          <p className="text-[11px] text-destructive/70">
            Doesn't match the expected format for {selectedChannelOption.label}
          </p>
        )}
      </div>

      {/* ── Advanced (collapsed by default) ──────────────────────── */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-muted-foreground transition-colors"
      >
        <svg
          className={cn("h-3 w-3 transition-transform", showAdvanced && "rotate-90")}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        Advanced settings
      </button>

      {showAdvanced && (
        <div className="grid grid-cols-2 gap-3 pl-4">
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground" htmlFor="rq-timeout">
              Timeout (min)
            </label>
            <input
              id="rq-timeout"
              type="number"
              min={1}
              max={30}
              value={timeoutMinutes}
              onChange={(e) => setTimeoutMinutes(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
              className="w-full rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-xs text-foreground tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground" htmlFor="rq-poll">
              Poll interval (sec)
            </label>
            <input
              id="rq-poll"
              type="number"
              min={2}
              max={30}
              value={pollIntervalSeconds}
              onChange={(e) => setPollIntervalSeconds(Math.max(2, Math.min(30, Number(e.target.value) || 2)))}
              className="w-full rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-xs text-foreground tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      )}

      {/* ── Save button ──────────────────────────────────────────── */}
      {channelId.trim().length > 0 && (
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="gap-2 transition-transform active:scale-[0.96]"
        >
          {saving ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          {isConfigured ? "Update connection" : "Save & connect"}
        </Button>
      )}

      {/* ── Bot token ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="text-xs font-medium text-muted-foreground">Bot token</div>

        {tokenSuccess && (
          <div className="flex items-center gap-2.5 rounded-xl border border-success/15 bg-success/[0.04] px-4 py-2.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
            {tokenSuccess}
          </div>
        )}

        {tokenSet && !tokenSuccess && (
          <div className="flex items-center gap-2.5 rounded-xl border border-success/15 bg-success/[0.04] px-4 py-2.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
            <span className="font-mono text-[11px]">{derivedEnvVarName}</span> is configured
          </div>
        )}

        {!tokenSet && (
          <div className="flex items-center gap-2.5 rounded-xl border border-warning/15 bg-warning/[0.04] px-4 py-2.5 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
            <span><span className="font-mono text-[11px]">{derivedEnvVarName}</span> not configured</span>
          </div>
        )}

        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showToken ? "text" : "password"}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={`Paste your ${selectedChannelOption.label} bot token`}
              disabled={savingToken}
              className={cn(
                "w-full rounded-xl border border-border/50 bg-card/50 pl-4 pr-10 py-2.5 font-mono text-sm text-foreground",
                "placeholder:text-muted-foreground",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent",
                "transition-colors",
              )}
              onKeyDown={(e) => { if (e.key === "Enter" && botToken.trim()) void handleSaveToken() }}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground transition-colors"
            >
              {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSaveToken()}
            disabled={!botToken.trim() || savingToken}
            className="h-[42px] gap-1.5 px-4"
          >
            {savingToken ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// GENERAL PANEL (font sizes)
// ═══════════════════════════════════════════════════════════════════════

const TERMINAL_SIZE_PRESETS = [11, 12, 13, 14, 15, 16] as const
const EDITOR_SIZE_PRESETS = [11, 12, 13, 14, 15, 16] as const

function FontSizeControl({
  label,
  description,
  presets,
  defaultSize,
  currentSize,
  onChange,
  previewFont,
}: {
  label: string
  description: string
  presets: readonly number[]
  defaultSize: number
  currentSize: number
  onChange: (size: number) => void
  previewFont: "mono" | "sans"
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-3 space-y-3">
      <div>
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {presets.map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => onChange(size)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-medium tabular-nums transition-colors",
              currentSize === size
                ? "border-foreground/30 bg-foreground/10 text-foreground shadow-sm"
                : "border-border/50 bg-card/50 text-muted-foreground hover:border-foreground/20 hover:text-foreground",
            )}
          >
            {size}px
            {size === defaultSize && (
              <span className="ml-1 text-[10px] text-muted-foreground">(default)</span>
            )}
          </button>
        ))}
      </div>

      <div
        className={cn(
          "mt-2 rounded-md border border-border/50 bg-terminal px-3 py-2 text-foreground/80",
          previewFont === "mono" ? "font-mono" : "font-sans",
        )}
        style={{ fontSize: `${currentSize}px`, lineHeight: 1.35 }}
      >
        The quick brown fox jumps over the lazy dog
      </div>
    </div>
  )
}

export function GeneralPanel() {
  const [terminalFontSize, setTerminalFontSize] = useTerminalFontSize()
  const [editorFontSize, setEditorFontSize] = useEditorFontSize()

  return (
    <div className="space-y-5" data-testid="settings-general">
      <SettingsHeader
        title="General"
        icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
        subtitle="Appearance & behavior"
        onRefresh={() => {}}
        refreshing={false}
      />

      <FontSizeControl
        label="Terminal font size"
        description="Applies to all terminals and the chat mode interface"
        presets={TERMINAL_SIZE_PRESETS}
        defaultSize={13}
        currentSize={terminalFontSize}
        onChange={setTerminalFontSize}
        previewFont="mono"
      />

      <FontSizeControl
        label="Code font size"
        description="Applies to the file viewer and code editor"
        presets={EDITOR_SIZE_PRESETS}
        defaultSize={14}
        currentSize={editorFontSize}
        onChange={setEditorFontSize}
        previewFont="mono"
      />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// EXPERIMENTAL PANEL
// ═══════════════════════════════════════════════════════════════════════

interface ExperimentalFlag {
  key: string
  label: string
  description: string
  warning?: string
}

const EXPERIMENTAL_FLAGS: ExperimentalFlag[] = [
  {
    key: "rtk",
    label: "RTK Shell Compression",
    description:
      "Wraps shell commands through the RTK binary to reduce token usage during command execution. RTK is downloaded automatically on first use.",
    warning: "Experimental — may change or be removed without notice.",
  },
]

export function ExperimentalPanel() {
  const { state, data, busy, refresh } = useSettingsData()
  const prefs = data?.preferences ?? null

  const [flags, setFlags] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  // Trigger a settings load if data hasn't been fetched yet (e.g. navigating
  // directly to the Experimental tab without going through gsd-prefs first).
  useEffect(() => {
    if (!data && !busy && state.phase === "idle") {
      refresh()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync local state from loaded prefs
  useEffect(() => {
    if (!prefs) return
    setFlags({ rtk: prefs.experimental?.rtk === true })
  }, [prefs])

  async function toggle(flagKey: string, next: boolean) {
    setSaving((s) => ({ ...s, [flagKey]: true }))
    setSaveError(null)
    try {
      const res = await authFetch("/api/experimental", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag: flagKey, enabled: next }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setFlags((f) => ({ ...f, [flagKey]: next }))
      // Refresh settings data so PrefsPanel reflects the change
      refresh()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving((s) => ({ ...s, [flagKey]: false }))
    }
  }

  return (
    <div className="space-y-4" data-testid="settings-experimental">
      <SettingsHeader
        title="Experimental"
        icon={<FlaskConical className="h-3.5 w-3.5" />}
        subtitle="Opt-in features — may change without notice"
        onRefresh={refresh}
        refreshing={busy}
      />

      {state.error && <SettingsError message={state.error} />}
      {saveError && <SettingsError message={saveError} />}
      {busy && !data && <SettingsLoading label="Loading preferences…" />}

      <div className="space-y-3">
        {EXPERIMENTAL_FLAGS.map((flag) => {
          const enabled = flags[flag.key] ?? false
          const isSaving = saving[flag.key] ?? false

          return (
            <div
              key={flag.key}
              className="rounded-lg border border-border/50 bg-card/50 px-3 py-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">{flag.label}</span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        enabled
                          ? "bg-success/10 text-success"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {enabled ? "on" : "off"}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {flag.description}
                  </p>
                  {flag.warning && (
                    <div className="flex items-center gap-1 text-[10px] text-warning">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      <span>{flag.warning}</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => toggle(flag.key, !enabled)}
                  disabled={isSaving || busy || !data}
                  className={cn(
                    "shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed",
                    enabled ? "bg-success" : "bg-muted-foreground/30",
                  )}
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`Toggle ${flag.label}`}
                >
                  <span
                    className={cn(
                      "inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
                      enabled ? "translate-x-4" : "translate-x-0.5",
                    )}
                  />
                  {isSaving && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <LoaderCircle className="h-3 w-3 animate-spin text-white" />
                    </span>
                  )}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {data && (
        <p className="text-[11px] text-muted-foreground">
          Changes are written to{" "}
          <span className="font-mono">{prefs?.path ?? "~/.gsd/PREFERENCES.md"}</span>
          {" "}and take effect on the next session.
        </p>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// LEGACY EXPORTS
// ═══════════════════════════════════════════════════════════════════════

// Legacy exports for backward compatibility with gsd-prefs mega-scroll
export const TerminalSizePanel = GeneralPanel
export const EditorSizePanel = () => null
