"use client"

import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  DollarSign,
  Layers,
  LoaderCircle,
  RefreshCw,
  Settings,
  Zap,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  SettingsData,
  SettingsPatternHistory,
  SettingsPreferencesData,
  SettingsProjectTotals,
  SettingsRoutingHistory,
  SettingsBudgetAllocation,
  SettingsDynamicRoutingConfig,
} from "@/lib/settings-types"
import { cn } from "@/lib/utils"
import {
  formatCost,
  formatTokens,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"

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
