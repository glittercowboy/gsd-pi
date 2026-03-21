"use client"

import { useState, useEffect, useCallback } from "react"

import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  DollarSign,
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
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-foreground/70">{title}</h3>
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
    <div className="rounded-lg border border-border/30 bg-card/30 px-4 py-5 text-center text-xs text-muted-foreground">
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
      (!variant || variant === "default") && "border-border/40 bg-card/50 text-foreground/80",
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
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border/30 bg-card/30 px-3 py-2.5">
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
            <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2.5 space-y-1.5">
              <h4 className="text-[11px] font-medium text-foreground/70 uppercase tracking-wide">Tier Assignments</h4>
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
                  <h4 className="text-[11px] font-medium text-foreground/70">Top Patterns</h4>
                  <div className="space-y-2">
                    {topPatterns(routingHistory).map(({ name, total, pattern }) => (
                      <div key={name} className="rounded-lg border border-border/30 bg-card/30 px-3 py-2 space-y-1">
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
            <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2.5 space-y-1.5">
              <h4 className="text-[11px] font-medium text-foreground/70 uppercase tracking-wide">Context Budget Allocations</h4>
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
              <h4 className="text-[11px] font-medium text-foreground/70 uppercase tracking-wide">Project Cost Totals</h4>

              {/* Summary pills */}
              <div className="flex flex-wrap gap-2">
                <Pill label="Units" value={totals.units} />
                <Pill label="Total Cost" value={formatCost(totals.cost)} variant="warning" />
                <Pill label="Duration" value={`${Math.round(totals.duration / 1000)}s`} />
              </div>

              {/* Token breakdown */}
              <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2.5 space-y-1.5">
                <h4 className="text-[11px] font-medium text-foreground/70 uppercase tracking-wide">Token Breakdown</h4>
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
// REMOTE QUESTIONS PANEL
// ═══════════════════════════════════════════════════════════════════════

type RemoteChannel = "slack" | "discord" | "telegram"

const CHANNEL_OPTIONS: { value: RemoteChannel; label: string }[] = [
  { value: "slack", label: "Slack" },
  { value: "discord", label: "Discord" },
  { value: "telegram", label: "Telegram" },
]

const CHANNEL_ID_PATTERNS: Record<RemoteChannel, { regex: RegExp; hint: string }> = {
  slack: { regex: /^[A-Z0-9]{9,12}$/, hint: "9–12 uppercase alphanumeric characters (e.g. C01ABCD2EFG)" },
  discord: { regex: /^\d{17,20}$/, hint: "17–20 digit numeric ID" },
  telegram: { regex: /^-?\d{5,20}$/, hint: "Numeric chat ID (may start with -)" },
}

interface RemoteQuestionsApiResponse {
  config: {
    channel: RemoteChannel
    channelId: string
    timeoutMinutes: number
    pollIntervalSeconds: number
  } | null
  envVarSet: boolean
  envVarName: string | null
  status: string
  error?: string
}

export function RemoteQuestionsPanel() {
  const { data, busy, refresh } = useSettingsData()
  const existingConfig = data?.preferences?.remoteQuestions ?? null

  // API-only state (env var info)
  const [envVarSet, setEnvVarSet] = useState(false)
  const [envVarName, setEnvVarName] = useState<string | null>(null)
  const [apiLoading, setApiLoading] = useState(true)

  // Form fields
  const [channel, setChannel] = useState<RemoteChannel>("slack")
  const [channelId, setChannelId] = useState("")
  const [timeoutMinutes, setTimeoutMinutes] = useState(5)
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(5)

  // Feedback states
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Whether a configuration currently exists (from API response, not just form state)
  const [isConfigured, setIsConfigured] = useState(false)

  // Track whether user has interacted with channel ID for validation display
  const [channelIdTouched, setChannelIdTouched] = useState(false)

  // Fetch full status from API on mount and after mutations
  const fetchApiStatus = useCallback(async () => {
    try {
      setApiLoading(true)
      const res = await fetch("/api/remote-questions", { cache: "no-store" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }))
        setError(body.error ?? `API error ${res.status}`)
        return
      }
      const json: RemoteQuestionsApiResponse = await res.json()
      setEnvVarSet(json.envVarSet)
      setEnvVarName(json.envVarName)
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

  // Sync form when existingConfig changes from the settings hook
  useEffect(() => {
    if (existingConfig?.channel) {
      setChannel(existingConfig.channel)
      setChannelId(existingConfig.channelId ?? "")
      setTimeoutMinutes(existingConfig.timeoutMinutes ?? 5)
      setPollIntervalSeconds(existingConfig.pollIntervalSeconds ?? 5)
    }
  }, [existingConfig])

  // Validation
  const channelIdValid = channelId.length === 0 || CHANNEL_ID_PATTERNS[channel].regex.test(channelId)
  const canSave = channelId.length > 0 && CHANNEL_ID_PATTERNS[channel].regex.test(channelId) && !saving && !deleting

  // Clear success feedback after 3s
  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(null), 3000)
    return () => clearTimeout(timer)
  }, [success])

  // Save
  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch("/api/remote-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, channelId, timeoutMinutes, pollIntervalSeconds }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? `Save failed (${res.status})`)
        return
      }
      setSuccess("Configuration saved")
      setIsConfigured(true)
      setChannelIdTouched(false)
      refresh()
      void fetchApiStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save configuration")
    } finally {
      setSaving(false)
    }
  }

  // Disconnect
  const handleDisconnect = async () => {
    setDeleting(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch("/api/remote-questions", { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? `Disconnect failed (${res.status})`)
        return
      }
      setSuccess("Channel disconnected")
      setIsConfigured(false)
      setChannelId("")
      setTimeoutMinutes(5)
      setPollIntervalSeconds(5)
      setChannel("slack")
      setChannelIdTouched(false)
      refresh()
      void fetchApiStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect channel")
    } finally {
      setDeleting(false)
    }
  }

  const derivedEnvVarName = envVarName ?? (channel ? `${channel.toUpperCase()}_BOT_TOKEN` : null)

  return (
    <div className="space-y-4" data-testid="settings-remote-questions">
      <SettingsHeader
        title="Remote Questions"
        icon={<Radio className="h-3.5 w-3.5" />}
        onRefresh={() => { refresh(); void fetchApiStatus() }}
        refreshing={busy || apiLoading}
      />

      {error && <SettingsError message={error} />}
      {success && (
        <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2.5 text-xs text-success flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {success}
        </div>
      )}
      {(busy || apiLoading) && !data && !isConfigured && <SettingsLoading label="Loading remote questions…" />}

      {/* Current config summary (when configured) */}
      {isConfigured && (
        <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2.5 space-y-1.5">
          <h4 className="text-[11px] font-medium text-foreground/70 uppercase tracking-wide">Current Channel</h4>
          <KvRow label="Channel">
            <span className="capitalize">{channel}</span>
          </KvRow>
          <KvRow label="Channel ID">
            <span className="font-mono text-[11px]">{channelId}</span>
          </KvRow>
          <KvRow label="Timeout">{timeoutMinutes}m</KvRow>
          <KvRow label="Poll Interval">{pollIntervalSeconds}s</KvRow>
        </div>
      )}

      {!isConfigured && !apiLoading && !busy && (
        <SettingsEmpty message="No remote channel configured" />
      )}

      {/* Form */}
      <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-3 space-y-3">
        <h4 className="text-[11px] font-medium text-foreground/70 uppercase tracking-wide">
          {isConfigured ? "Update Configuration" : "Configure Channel"}
        </h4>

        {/* Channel type */}
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground" htmlFor="rq-channel">Channel Type</label>
          <select
            id="rq-channel"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as RemoteChannel)
              setChannelIdTouched(false)
            }}
            className="w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {CHANNEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Channel ID */}
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground" htmlFor="rq-channel-id">Channel ID</label>
          <input
            id="rq-channel-id"
            type="text"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            onBlur={() => setChannelIdTouched(true)}
            placeholder={CHANNEL_ID_PATTERNS[channel].hint}
            className={cn(
              "w-full rounded-md border bg-input px-2.5 py-1.5 text-xs text-foreground font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring",
              channelIdTouched && channelId && !channelIdValid
                ? "border-destructive/50"
                : "border-border",
            )}
          />
          {channelIdTouched && channelId && !channelIdValid && (
            <p className="text-[10px] text-destructive">
              Invalid format — {CHANNEL_ID_PATTERNS[channel].hint}
            </p>
          )}
        </div>

        {/* Timeout + Poll Interval (side by side) */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground" htmlFor="rq-timeout">Timeout (min)</label>
            <input
              id="rq-timeout"
              type="number"
              min={1}
              max={30}
              value={timeoutMinutes}
              onChange={(e) => setTimeoutMinutes(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
              className="w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-xs text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground" htmlFor="rq-poll">Poll Interval (sec)</label>
            <input
              id="rq-poll"
              type="number"
              min={2}
              max={30}
              value={pollIntervalSeconds}
              onChange={(e) => setPollIntervalSeconds(Math.max(2, Math.min(30, Number(e.target.value) || 2)))}
              className="w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-xs text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!canSave}
            className="h-7 text-xs gap-1.5"
          >
            {saving && <LoaderCircle className="h-3 w-3 animate-spin" />}
            {isConfigured ? "Update" : "Save"}
          </Button>
          {isConfigured && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDisconnect}
              disabled={deleting}
              className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive"
            >
              {deleting && <LoaderCircle className="h-3 w-3 animate-spin" />}
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {/* Env var status */}
      {derivedEnvVarName && !apiLoading && (
        <div className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
          envVarSet
            ? "border-success/20 bg-success/5 text-success"
            : "border-warning/20 bg-warning/5 text-warning",
        )}>
          {envVarSet ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>{derivedEnvVarName} is set</span>
            </>
          ) : (
            <>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{derivedEnvVarName} not set — configure via TUI or environment</span>
            </>
          )}
        </div>
      )}
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
    <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-3 space-y-3">
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
                : "border-border/40 bg-card/50 text-muted-foreground hover:border-foreground/20 hover:text-foreground",
            )}
          >
            {size}px
            {size === defaultSize && (
              <span className="ml-1 text-[10px] text-muted-foreground/60">(default)</span>
            )}
          </button>
        ))}
      </div>

      <div
        className={cn(
          "mt-2 rounded-md border border-border/20 bg-terminal px-3 py-2 text-foreground/80",
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

// Legacy exports for backward compatibility with gsd-prefs mega-scroll
export const TerminalSizePanel = GeneralPanel
export const EditorSizePanel = () => null
