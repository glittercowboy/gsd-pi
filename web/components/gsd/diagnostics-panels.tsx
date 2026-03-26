"use client"

import { AlertTriangle, CheckCircle2, Info, LoaderCircle, RefreshCw, ShieldAlert, Wrench, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  DoctorIssue,
  ForensicAnomaly,
  ForensicReport,
  DoctorReport,
  SkillHealthReport,
  SkillHealSuggestion,
} from "@/lib/diagnostics-types"
import { cn } from "@/lib/utils"
import {
  formatCost,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"

// ═══════════════════════════════════════════════════════════════════════
// SHARED
// ═══════════════════════════════════════════════════════════════════════

function SeverityIcon({ severity, className }: { severity: "info" | "warning" | "error" | "critical"; className?: string }) {
  const base = cn("h-3.5 w-3.5 shrink-0", className)
  switch (severity) {
    case "error":
    case "critical":
      return <XCircle className={cn(base, "text-destructive")} />
    case "warning":
      return <AlertTriangle className={cn(base, "text-warning")} />
    default:
      return <Info className={cn(base, "text-info")} />
  }
}

function severityBadgeVariant(s: string): "destructive" | "secondary" | "outline" {
  if (s === "error" || s === "critical") return "destructive"
  if (s === "warning") return "secondary"
  return "outline"
}

function DiagHeader({
  title,
  subtitle,
  status,
  onRefresh,
  refreshing,
}: {
  title: string
  subtitle?: string | null
  status?: React.ReactNode
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 pb-4">
      <div className="flex items-center gap-2.5">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        {status}
        {subtitle && <span className="text-[11px] text-muted-foreground">{subtitle}</span>}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing} className="h-7 gap-1.5 text-xs">
        <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
        Refresh
      </Button>
    </div>
  )
}

function DiagError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
      {message}
    </div>
  )
}

function DiagLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      {label}
    </div>
  )
}

function DiagEmpty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-4 py-5 text-center text-xs text-muted-foreground">
      {message}
    </div>
  )
}

function StatPill({ label, value, variant }: { label: string; value: number | string; variant?: "default" | "error" | "warning" | "info" }) {
  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs",
      variant === "error" && "border-destructive/20 bg-destructive/5 text-destructive",
      variant === "warning" && "border-warning/20 bg-warning/5 text-warning",
      variant === "info" && "border-info/20 bg-info/5 text-info",
      (!variant || variant === "default") && "border-border/50 bg-card/50 text-foreground/80",
    )}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// FORENSICS PANEL
// ═══════════════════════════════════════════════════════════════════════

function AnomalyRow({ anomaly }: { anomaly: ForensicAnomaly }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 space-y-1">
      <div className="flex items-center gap-2">
        <SeverityIcon severity={anomaly.severity} />
        <Badge variant={severityBadgeVariant(anomaly.severity)} className="text-[10px] px-1.5 py-0">{anomaly.severity}</Badge>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">{anomaly.type}</Badge>
        {anomaly.unitId && (
          <span className="text-[10px] text-muted-foreground font-mono truncate">{anomaly.unitType}/{anomaly.unitId}</span>
        )}
      </div>
      <p className="text-xs text-foreground">{anomaly.summary}</p>
      {anomaly.details && anomaly.details !== anomaly.summary && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">{anomaly.details}</p>
      )}
    </div>
  )
}

export function ForensicsPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadForensicsDiagnostics } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.diagnostics.forensics
  const data = state.data as ForensicReport | null
  const busy = state.phase === "loading"

  return (
    <div className="space-y-4" data-testid="diagnostics-forensics">
      <DiagHeader
        title="Forensic Analysis"
        subtitle={data ? new Date(data.timestamp).toLocaleString() : null}
        status={data ? (
          <span className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            data.anomalies.length > 0 ? "bg-warning" : "bg-success",
          )} />
        ) : null}
        onRefresh={() => void loadForensicsDiagnostics()}
        refreshing={busy}
      />

      {state.error && <DiagError message={state.error} />}
      {busy && !data && <DiagLoading label="Running forensic analysis…" />}

      {data && (
        <>
          {/* Metrics summary */}
          {data.metrics && (
            <div className="flex flex-wrap gap-2">
              <StatPill label="Units" value={data.metrics.totalUnits} />
              <StatPill label="Cost" value={formatCost(data.metrics.totalCost)} />
              <StatPill label="Duration" value={`${Math.round(data.metrics.totalDuration / 1000)}s`} />
              <StatPill label="Traces" value={data.unitTraceCount} />
            </div>
          )}

          {/* Crash lock */}
          {data.crashLock ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 space-y-1">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
                <span className="text-xs font-medium text-destructive">Crash Lock Active</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                <span className="text-muted-foreground">PID</span>
                <span className="font-mono text-foreground/80">{data.crashLock.pid}</span>
                <span className="text-muted-foreground">Started</span>
                <span className="text-foreground/80">{new Date(data.crashLock.startedAt).toLocaleString()}</span>
                <span className="text-muted-foreground">Unit</span>
                <span className="font-mono text-foreground/80">{data.crashLock.unitType}/{data.crashLock.unitId}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              No crash lock
            </div>
          )}

          {/* Anomalies */}
          {data.anomalies.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">Anomalies ({data.anomalies.length})</h4>
              {data.anomalies.map((a, i) => <AnomalyRow key={i} anomaly={a} />)}
            </div>
          ) : (
            <DiagEmpty message="No anomalies detected" />
          )}

          {/* Recent units */}
          {data.recentUnits.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">Recent Units ({data.recentUnits.length})</h4>
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border/50 bg-card/50">
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Type</th>
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">ID</th>
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Model</th>
                      <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Cost</th>
                      <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentUnits.map((u, i) => (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="px-2.5 py-1.5 font-mono text-foreground/80">{u.type}</td>
                        <td className="px-2.5 py-1.5 font-mono text-foreground/80 truncate max-w-[120px]">{u.id}</td>
                        <td className="px-2.5 py-1.5 text-muted-foreground">{u.model}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatCost(u.cost)}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{Math.round(u.duration / 1000)}s</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// DOCTOR PANEL
// ═══════════════════════════════════════════════════════════════════════

function humanizeCode(code: string): string {
  return code.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function IssueRow({ issue }: { issue: DoctorIssue }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <SeverityIcon severity={issue.severity} />
        <Badge variant={severityBadgeVariant(issue.severity)} className="text-[10px] px-1.5 py-0">{issue.severity}</Badge>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">{humanizeCode(issue.code)}</Badge>
        {issue.scope && <span className="text-[10px] text-muted-foreground font-mono">{issue.scope}</span>}
        {issue.fixable && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-success/30 text-success">
            <Wrench className="h-2.5 w-2.5 mr-0.5" />fixable
          </Badge>
        )}
      </div>
      <p className="text-xs text-foreground">{issue.message}</p>
      {issue.file && <p className="text-[10px] font-mono text-muted-foreground truncate">{issue.file}</p>}
    </div>
  )
}

export function DoctorPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadDoctorDiagnostics, applyDoctorFixes } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.diagnostics.doctor
  const data = state.data as DoctorReport | null
  const busy = state.phase === "loading"

  const fixableCount = data?.summary.fixable ?? 0

  return (
    <div className="space-y-4" data-testid="diagnostics-doctor">
      <DiagHeader
        title="Doctor Health Check"
        status={data ? (
          <span className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            data.ok ? "bg-success" : "bg-destructive",
          )} />
        ) : null}
        onRefresh={() => void loadDoctorDiagnostics()}
        refreshing={busy}
      />

      {state.error && <DiagError message={state.error} />}
      {busy && !data && <DiagLoading label="Running health check…" />}

      {data && (
        <>
          {/* Summary bar */}
          <div className="flex flex-wrap gap-2">
            <StatPill label="Total" value={data.summary.total} />
            {data.summary.errors > 0 && <StatPill label="Errors" value={data.summary.errors} variant="error" />}
            {data.summary.warnings > 0 && <StatPill label="Warnings" value={data.summary.warnings} variant="warning" />}
            {data.summary.infos > 0 && <StatPill label="Info" value={data.summary.infos} variant="info" />}
            {fixableCount > 0 && (
              <StatPill label="Fixable" value={fixableCount} variant="info" />
            )}
          </div>

          {/* Apply fixes button */}
          {fixableCount > 0 && (
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => void applyDoctorFixes()}
                disabled={state.fixPending}
                className="h-7 gap-1.5 text-xs"
                data-testid="doctor-apply-fixes"
              >
                {state.fixPending ? (
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                ) : (
                  <Wrench className="h-3 w-3" />
                )}
                Apply Fixes ({fixableCount})
              </Button>
              {state.lastFixError && (
                <span className="text-[11px] text-destructive">{state.lastFixError}</span>
              )}
            </div>
          )}

          {/* Fix results */}
          {state.lastFixResult && state.lastFixResult.fixesApplied.length > 0 && (
            <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2.5 space-y-1">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                <span className="text-xs font-medium text-success">Fixes Applied</span>
              </div>
              <ul className="space-y-0.5 pl-5">
                {state.lastFixResult.fixesApplied.map((fix, i) => (
                  <li key={i} className="text-[11px] text-foreground/80 list-disc">{fix}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Issue list */}
          {data.issues.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">Issues ({data.issues.length})</h4>
              {data.issues.map((issue, i) => <IssueRow key={i} issue={issue} />)}
            </div>
          ) : (
            <DiagEmpty message="No issues found — workspace is healthy" />
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// SKILL HEALTH PANEL
// ═══════════════════════════════════════════════════════════════════════

function trendArrow(trend: "stable" | "rising" | "declining"): string {
  if (trend === "rising") return "↑"
  if (trend === "declining") return "↓"
  return "→"
}

function trendColor(trend: "stable" | "rising" | "declining"): string {
  if (trend === "rising") return "text-warning"
  if (trend === "declining") return "text-destructive"
  return "text-muted-foreground"
}

function SuggestionRow({ suggestion }: { suggestion: SkillHealSuggestion }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <SeverityIcon severity={suggestion.severity} />
        <Badge variant={severityBadgeVariant(suggestion.severity)} className="text-[10px] px-1.5 py-0">{suggestion.severity}</Badge>
        <span className="text-[11px] font-medium text-foreground/80">{suggestion.skillName}</span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">{suggestion.trigger.replace(/_/g, " ")}</Badge>
      </div>
      <p className="text-xs text-foreground">{suggestion.message}</p>
    </div>
  )
}

export function SkillHealthPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadSkillHealthDiagnostics } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.diagnostics.skillHealth
  const data = state.data as SkillHealthReport | null
  const busy = state.phase === "loading"

  return (
    <div className="space-y-4" data-testid="diagnostics-skill-health">
      <DiagHeader
        title="Skill Health"
        subtitle={data ? new Date(data.generatedAt).toLocaleString() : null}
        status={data ? (
          <span className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            data.decliningSkills.length > 0 ? "bg-warning" : "bg-success",
          )} />
        ) : null}
        onRefresh={() => void loadSkillHealthDiagnostics()}
        refreshing={busy}
      />

      {state.error && <DiagError message={state.error} />}
      {busy && !data && <DiagLoading label="Analyzing skill health…" />}

      {data && (
        <>
          {/* Stats bar */}
          <div className="flex flex-wrap gap-2">
            <StatPill label="Skills" value={data.skills.length} />
            {data.staleSkills.length > 0 && <StatPill label="Stale" value={data.staleSkills.length} variant="warning" />}
            {data.decliningSkills.length > 0 && <StatPill label="Declining" value={data.decliningSkills.length} variant="error" />}
            <StatPill label="Total units" value={data.totalUnitsWithSkills} />
          </div>

          {/* Skill table */}
          {data.skills.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">Skills ({data.skills.length})</h4>
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border/50 bg-card/50">
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Skill</th>
                      <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Uses</th>
                      <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Success</th>
                      <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Tokens</th>
                      <th className="px-2.5 py-1.5 text-center font-medium text-muted-foreground">Trend</th>
                      <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Stale</th>
                      <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.skills.map((skill) => (
                      <tr key={skill.name} className={cn(
                        "border-b border-border/50 last:border-0",
                        skill.flagged && "bg-destructive/3",
                      )}>
                        <td className="px-2.5 py-1.5 font-mono text-foreground/80">
                          <span className="flex items-center gap-1.5">
                            {skill.name}
                            {skill.flagged && <AlertTriangle className="h-3 w-3 text-warning shrink-0" />}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{skill.totalUses}</td>
                        <td className={cn(
                          "px-2.5 py-1.5 text-right tabular-nums",
                          skill.successRate >= 0.9 ? "text-success" : skill.successRate >= 0.7 ? "text-warning" : "text-destructive",
                        )}>
                          {(skill.successRate * 100).toFixed(0)}%
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{Math.round(skill.avgTokens)}</td>
                        <td className={cn("px-2.5 py-1.5 text-center", trendColor(skill.tokenTrend))}>
                          {trendArrow(skill.tokenTrend)}
                        </td>
                        <td className={cn(
                          "px-2.5 py-1.5 text-right tabular-nums",
                          skill.staleDays > 30 ? "text-warning" : "text-foreground/80",
                        )}>
                          {skill.staleDays > 0 ? `${skill.staleDays}d` : "—"}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatCost(skill.avgCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Stale skills */}
          {data.staleSkills.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-medium text-muted-foreground">Stale Skills</h4>
              <div className="flex flex-wrap gap-1.5">
                {data.staleSkills.map((name) => (
                  <Badge key={name} variant="secondary" className="text-[10px] font-mono">{name}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Declining skills */}
          {data.decliningSkills.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-medium text-muted-foreground">Declining Skills</h4>
              <div className="flex flex-wrap gap-1.5">
                {data.decliningSkills.map((name) => (
                  <Badge key={name} variant="destructive" className="text-[10px] font-mono">{name}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Suggestions */}
          {data.suggestions.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">Suggestions ({data.suggestions.length})</h4>
              {data.suggestions.map((s, i) => <SuggestionRow key={i} suggestion={s} />)}
            </div>
          )}

          {data.skills.length === 0 && data.suggestions.length === 0 && (
            <DiagEmpty message="No skill usage data available" />
          )}
        </>
      )}
    </div>
  )
}
