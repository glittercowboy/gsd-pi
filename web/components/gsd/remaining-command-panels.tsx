"use client"

import { useState } from "react"
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  Database,
  Download,
  GitBranch,
  Layers,
  ListChecks,
  LoaderCircle,
  Navigation,
  RefreshCw,
  RotateCcw,
  Scissors,
  Terminal,
  Trash2,
  Undo2,
  XCircle,
  Zap,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type {
  HistoryData,
  HistoryPhaseAggregate,
  HistorySliceAggregate,
  HistoryModelAggregate,
  InspectData,
  HooksData,
  HookStatusEntry,
  ExportResult,
  UndoInfo,
  UndoResult,
  CleanupData,
  CleanupBranch,
  CleanupSnapshot,
  CleanupResult,
  SteerData,
} from "@/lib/remaining-command-types"
import { cn } from "@/lib/utils"
import {
  formatCost,
  getLiveWorkspaceIndex,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
  type WorkspaceMilestoneTarget,
  type WorkspaceSliceTarget,
} from "@/lib/gsd-workspace-store"

// ═══════════════════════════════════════════════════════════════════════
// SHARED INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════

function PanelHeader({
  title,
  icon,
  subtitle,
  status,
  onRefresh,
  refreshing,
}: {
  title: string
  icon: React.ReactNode
  subtitle?: string | null
  status?: React.ReactNode
  onRefresh?: () => void
  refreshing?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 pb-4">
      <div className="flex items-center gap-2.5">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        {status}
        {subtitle && <span className="text-[11px] text-muted-foreground">{subtitle}</span>}
      </div>
      {onRefresh && (
        <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing} className="h-7 gap-1.5 text-xs">
          <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          Refresh
        </Button>
      )}
    </div>
  )
}

function PanelError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
      {message}
    </div>
  )
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      {label}
    </div>
  )
}

function PanelEmpty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-4 py-5 text-center text-xs text-muted-foreground">
      {message}
    </div>
  )
}

function InfoPill({ label, value, variant }: { label: string; value: string | number; variant?: "default" | "info" | "warning" | "success" | "error" }) {
  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs",
      variant === "info" && "border-info/20 bg-info/5 text-info",
      variant === "warning" && "border-warning/20 bg-warning/5 text-warning",
      variant === "success" && "border-success/20 bg-success/5 text-success",
      variant === "error" && "border-destructive/20 bg-destructive/5 text-destructive",
      (!variant || variant === "default") && "border-border/50 bg-card/50 text-foreground/80",
    )}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSec = seconds % 60
  if (minutes < 60) return remainingSec > 0 ? `${minutes}m ${remainingSec}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMin = minutes % 60
  return remainingMin > 0 ? `${hours}h ${remainingMin}m` : `${hours}h`
}

// ═══════════════════════════════════════════════════════════════════════
// 1. QUICK PANEL — Static usage instructions
// ═══════════════════════════════════════════════════════════════════════

export function QuickPanel() {
  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-quick">
      <PanelHeader
        title="Quick Task"
        icon={<Zap className="h-3.5 w-3.5" />}
      />

      <div className="rounded-lg border border-border/50 bg-card/50 px-4 py-4 space-y-3">
        <p className="text-xs text-foreground">
          Create a quick one-off task outside the current plan. Useful for small fixes, experiments, or ad-hoc work that
          doesn&apos;t fit into the milestone structure.
        </p>

        <div className="space-y-2">
          <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Usage</h4>
          <div className="rounded-md border border-border/50 bg-background/50 px-3 py-2 font-mono text-[11px] text-foreground/80">
            /gsd quick &lt;description&gt;
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Examples</h4>
          <div className="space-y-1.5">
            {[
              "Fix the typo in README.md header",
              "Add .env.example with required keys",
              "Update the LICENSE year to 2026",
              "Run prettier on the whole project",
            ].map((example) => (
              <div key={example} className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">$</span>
                <code className="font-mono text-muted-foreground">/gsd quick {example}</code>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-info/15 bg-info/5 px-3 py-2 text-[11px] text-info/90">
          Quick tasks run as standalone units — they don&apos;t affect milestone progress, slices, or the plan. Use them
          for work that should happen now without ceremony.
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 2. HISTORY PANEL — Project metrics and breakdowns
// ═══════════════════════════════════════════════════════════════════════

type HistoryTab = "phase" | "slice" | "model" | "units"

export function HistoryPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadHistoryData } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.remainingCommands.history
  const data = state.data as HistoryData | null
  const busy = state.phase === "loading"
  const [activeTab, setActiveTab] = useState<HistoryTab>("phase")

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-history">
      <PanelHeader
        title="History & Metrics"
        icon={<Clock className="h-3.5 w-3.5" />}
        onRefresh={() => void loadHistoryData()}
        refreshing={busy}
      />

      {state.error && <PanelError message={state.error} />}
      {busy && !data && <PanelLoading label="Loading history data…" />}

      {data && (
        <>
          {/* Totals summary */}
          <div className="flex flex-wrap gap-2">
            <InfoPill label="Units" value={data.totals.units} />
            <InfoPill label="Cost" value={formatCost(data.totals.cost)} variant="warning" />
            <InfoPill label="Duration" value={formatDuration(data.totals.duration)} />
            <InfoPill label="Tool Calls" value={data.totals.toolCalls} />
          </div>

          {/* Tab switcher */}
          <div className="flex gap-1 rounded-lg border border-border/50 bg-card/50 p-0.5">
            {(["phase", "slice", "model", "units"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "flex-1 rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                  activeTab === tab
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-muted-foreground",
                )}
              >
                {tab === "units" ? "Recent" : `By ${tab}`}
              </button>
            ))}
          </div>

          {/* By Phase */}
          {activeTab === "phase" && data.byPhase.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/50 bg-card/50">
                    <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Phase</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Units</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Cost</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPhase.map((row: HistoryPhaseAggregate) => (
                    <tr key={row.phase} className="border-b border-border/50 last:border-0">
                      <td className="px-2.5 py-1.5 font-mono text-foreground/80 capitalize">{row.phase}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{row.units}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatCost(row.cost)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatDuration(row.duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* By Slice */}
          {activeTab === "slice" && data.bySlice.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/50 bg-card/50">
                    <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Slice</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Units</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Cost</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bySlice.map((row: HistorySliceAggregate) => (
                    <tr key={row.sliceId} className="border-b border-border/50 last:border-0">
                      <td className="px-2.5 py-1.5 font-mono text-foreground/80">{row.sliceId}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{row.units}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatCost(row.cost)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatDuration(row.duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* By Model */}
          {activeTab === "model" && data.byModel.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/50 bg-card/50">
                    <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Model</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Units</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((row: HistoryModelAggregate) => (
                    <tr key={row.model} className="border-b border-border/50 last:border-0">
                      <td className="px-2.5 py-1.5 font-mono text-foreground/80 truncate max-w-[180px]">{row.model}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{row.units}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatCost(row.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Recent Units */}
          {activeTab === "units" && (
            <>
              {data.units.length > 0 ? (
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
                      {data.units.slice(0, 20).map((u, i) => (
                        <tr key={i} className="border-b border-border/50 last:border-0">
                          <td className="px-2.5 py-1.5 font-mono text-foreground/80">{u.type}</td>
                          <td className="px-2.5 py-1.5 font-mono text-foreground/80 truncate max-w-[120px]">{u.id}</td>
                          <td className="px-2.5 py-1.5 text-muted-foreground truncate max-w-[120px]">{u.model}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatCost(u.cost)}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">{formatDuration(u.finishedAt - u.startedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <PanelEmpty message="No unit history recorded yet" />
              )}
            </>
          )}

          {activeTab === "phase" && data.byPhase.length === 0 && <PanelEmpty message="No phase breakdown available" />}
          {activeTab === "slice" && data.bySlice.length === 0 && <PanelEmpty message="No slice breakdown available" />}
          {activeTab === "model" && data.byModel.length === 0 && <PanelEmpty message="No model breakdown available" />}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 3. UNDO PANEL — Last completed unit info + undo action
// ═══════════════════════════════════════════════════════════════════════

export function UndoPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadUndoInfo, executeUndoAction } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.remainingCommands.undo
  const data = state.data as UndoInfo | null
  const busy = state.phase === "loading"
  const [confirming, setConfirming] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [result, setResult] = useState<UndoResult | null>(null)

  const handleUndo = async () => {
    setExecuting(true)
    setResult(null)
    try {
      const res = await executeUndoAction()
      setResult(res)
      setConfirming(false)
    } finally {
      setExecuting(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-undo">
      <PanelHeader
        title="Undo Last Unit"
        icon={<Undo2 className="h-3.5 w-3.5" />}
        onRefresh={() => { setResult(null); setConfirming(false); void loadUndoInfo() }}
        refreshing={busy}
      />

      {state.error && <PanelError message={state.error} />}
      {busy && !data && <PanelLoading label="Loading undo info…" />}

      {/* Result banner */}
      {result && (
        <div className={cn(
          "rounded-lg border px-3 py-2.5 text-xs",
          result.success
            ? "border-success/20 bg-success/5 text-success"
            : "border-destructive/20 bg-destructive/5 text-destructive",
        )}>
          <div className="flex items-center gap-2">
            {result.success ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            <span className="font-medium">{result.success ? "Undo Successful" : "Undo Failed"}</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{result.message}</p>
        </div>
      )}

      {data && (
        <>
          {data.lastUnitType ? (
            <>
              {/* Last unit info */}
              <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 space-y-1.5">
                <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Last Completed Unit</h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                  <span className="text-muted-foreground">Type</span>
                  <span className="font-mono text-foreground/80">{data.lastUnitType}</span>
                  <span className="text-muted-foreground">ID</span>
                  <span className="font-mono text-foreground/80 truncate">{data.lastUnitId ?? "—"}</span>
                  <span className="text-muted-foreground">Key</span>
                  <span className="font-mono text-foreground/80 truncate">{data.lastUnitKey ?? "—"}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <InfoPill label="Completed Units" value={data.completedCount} />
                {data.commits.length > 0 && (
                  <InfoPill label="Commits" value={data.commits.length} variant="info" />
                )}
              </div>

              {/* Commit SHAs */}
              {data.commits.length > 0 && (
                <div className="space-y-1.5">
                  <h4 className="text-[11px] font-medium text-muted-foreground">Associated Commits</h4>
                  <div className="flex flex-wrap gap-1">
                    {data.commits.map((sha) => (
                      <Badge key={sha} variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                        {sha.slice(0, 8)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Confirmation */}
              {!confirming ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirming(true)}
                  disabled={executing || !!result?.success}
                  className="h-7 gap-1.5 text-xs"
                >
                  <RotateCcw className="h-3 w-3" />
                  Undo Last Unit
                </Button>
              ) : (
                <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span className="font-medium">This will revert the last unit and its git commits.</span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleUndo()}
                      disabled={executing}
                      className="h-7 gap-1.5 text-xs"
                    >
                      {executing ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      Confirm Undo
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirming(false)}
                      disabled={executing}
                      className="h-7 text-xs"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <PanelEmpty message="No completed units to undo" />
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 4. STEER PANEL — Overrides display + steer message form
// ═══════════════════════════════════════════════════════════════════════

export function SteerPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadSteerData, sendSteer } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.remainingCommands.steer
  const data = state.data as SteerData | null
  const busy = state.phase === "loading"
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSend = async () => {
    if (!message.trim()) return
    setSending(true)
    setSent(false)
    try {
      await sendSteer(message.trim())
      setSent(true)
      setMessage("")
      // Reload overrides after steering
      void loadSteerData()
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-steer">
      <PanelHeader
        title="Steer"
        icon={<Navigation className="h-3.5 w-3.5" />}
        onRefresh={() => { setSent(false); void loadSteerData() }}
        refreshing={busy}
      />

      {state.error && <PanelError message={state.error} />}
      {busy && !data && <PanelLoading label="Loading steer data…" />}

      {/* Success banner */}
      {sent && (
        <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2.5 text-xs text-success flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Steering message sent successfully.
        </div>
      )}

      {/* Current overrides */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Current Overrides</h4>
        {data?.overridesContent ? (
          <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-2.5 text-[11px] font-mono text-foreground/80 whitespace-pre-wrap max-h-[200px] overflow-y-auto leading-relaxed">
            {data.overridesContent}
          </div>
        ) : (
          <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 text-[11px] text-muted-foreground italic">
            No active overrides
          </div>
        )}
      </div>

      {/* Steer message form */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Send Steering Message</h4>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Enter steering instructions for the agent…"
          className="min-h-[80px] text-xs resize-none"
        />
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void handleSend()}
          disabled={sending || !message.trim()}
          className="h-7 gap-1.5 text-xs"
        >
          {sending ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Navigation className="h-3 w-3" />}
          Send
        </Button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 5. HOOKS PANEL — Hook entries table
// ═══════════════════════════════════════════════════════════════════════

export function HooksPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadHooksData } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.remainingCommands.hooks
  const data = state.data as HooksData | null
  const busy = state.phase === "loading"

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-hooks">
      <PanelHeader
        title="Hooks"
        icon={<Layers className="h-3.5 w-3.5" />}
        status={data ? (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {data.entries.length} {data.entries.length === 1 ? "hook" : "hooks"}
          </Badge>
        ) : null}
        onRefresh={() => void loadHooksData()}
        refreshing={busy}
      />

      {state.error && <PanelError message={state.error} />}
      {busy && !data && <PanelLoading label="Loading hooks…" />}

      {data && (
        <>
          {data.entries.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/50 bg-card/50">
                    <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Name</th>
                    <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Type</th>
                    <th className="px-2.5 py-1.5 text-center font-medium text-muted-foreground">Status</th>
                    <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Targets</th>
                    <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Cycles</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((entry: HookStatusEntry) => {
                    const totalCycles = Object.values(entry.activeCycles).reduce((sum, n) => sum + n, 0)
                    return (
                      <tr key={entry.name} className="border-b border-border/50 last:border-0">
                        <td className="px-2.5 py-1.5 font-mono text-foreground/80">{entry.name}</td>
                        <td className="px-2.5 py-1.5">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {entry.type}
                          </Badge>
                        </td>
                        <td className="px-2.5 py-1.5 text-center">
                          <Badge
                            variant={entry.enabled ? "secondary" : "outline"}
                            className={cn(
                              "text-[10px] px-1.5 py-0",
                              entry.enabled ? "border-success/30 text-success" : "text-muted-foreground",
                            )}
                          >
                            {entry.enabled ? "enabled" : "disabled"}
                          </Badge>
                        </td>
                        <td className="px-2.5 py-1.5 text-muted-foreground">
                          {entry.targets.length > 0 ? entry.targets.join(", ") : "all"}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground/80">
                          {totalCycles}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <PanelEmpty message="No hooks configured" />
          )}

          {/* Formatted status */}
          {data.formattedStatus && (
            <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-2.5 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {data.formattedStatus}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 6. INSPECT PANEL — GSD database overview
// ═══════════════════════════════════════════════════════════════════════

export function InspectPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadInspectData } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.remainingCommands.inspect
  const data = state.data as InspectData | null
  const busy = state.phase === "loading"

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-inspect">
      <PanelHeader
        title="Inspect Database"
        icon={<Database className="h-3.5 w-3.5" />}
        subtitle={data?.schemaVersion != null ? `v${data.schemaVersion}` : null}
        onRefresh={() => void loadInspectData()}
        refreshing={busy}
      />

      {state.error && <PanelError message={state.error} />}
      {busy && !data && <PanelLoading label="Loading database…" />}

      {data && (
        <>
          {/* Counts */}
          <div className="flex flex-wrap gap-2">
            <InfoPill label="Decisions" value={data.counts.decisions} variant="info" />
            <InfoPill label="Requirements" value={data.counts.requirements} variant="info" />
            <InfoPill label="Artifacts" value={data.counts.artifacts} />
          </div>

          {/* Recent decisions */}
          {data.recentDecisions.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">Recent Decisions ({data.recentDecisions.length})</h4>
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border/50 bg-card/50">
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">ID</th>
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Decision</th>
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Choice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentDecisions.map((d) => (
                      <tr key={d.id} className="border-b border-border/50 last:border-0">
                        <td className="px-2.5 py-1.5 font-mono text-foreground/80">{d.id}</td>
                        <td className="px-2.5 py-1.5 text-foreground/80 max-w-[200px] truncate">{d.decision}</td>
                        <td className="px-2.5 py-1.5 text-muted-foreground max-w-[150px] truncate">{d.choice}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Recent requirements */}
          {data.recentRequirements.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">Recent Requirements ({data.recentRequirements.length})</h4>
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border/50 bg-card/50">
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">ID</th>
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Status</th>
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentRequirements.map((r) => (
                      <tr key={r.id} className="border-b border-border/50 last:border-0">
                        <td className="px-2.5 py-1.5 font-mono text-foreground/80">{r.id}</td>
                        <td className="px-2.5 py-1.5">
                          <Badge
                            variant={r.status === "active" ? "secondary" : "outline"}
                            className={cn(
                              "text-[10px] px-1.5 py-0",
                              r.status === "active" && "border-success/30 text-success",
                              r.status === "validated" && "border-info/30 text-info",
                              r.status === "deferred" && "text-muted-foreground",
                            )}
                          >
                            {r.status}
                          </Badge>
                        </td>
                        <td className="px-2.5 py-1.5 text-foreground/80 max-w-[220px] truncate">{r.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.recentDecisions.length === 0 && data.recentRequirements.length === 0 && (
            <PanelEmpty message="Database is empty — no decisions or requirements recorded" />
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 7. EXPORT PANEL — Format selection + download trigger
// ═══════════════════════════════════════════════════════════════════════

export function ExportPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadExportData } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.remainingCommands.exportData
  const data = state.data as ExportResult | null
  const busy = state.phase === "loading"
  const [format, setFormat] = useState<"markdown" | "json">("markdown")

  const triggerDownload = (result: ExportResult) => {
    const mimeType = result.format === "json" ? "application/json" : "text/markdown"
    const blob = new Blob([result.content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = result.filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleExport = async () => {
    const result = await loadExportData(format)
    if (result) triggerDownload(result)
  }

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-export">
      <PanelHeader
        title="Export"
        icon={<Download className="h-3.5 w-3.5" />}
      />

      {state.error && <PanelError message={state.error} />}

      {/* Format selector */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Format</h4>
        <div className="flex gap-1 rounded-lg border border-border/50 bg-card/50 p-0.5">
          {(["markdown", "json"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-[11px] font-medium capitalize transition-colors",
                format === f
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-muted-foreground",
              )}
            >
              {f === "markdown" ? "Markdown" : "JSON"}
            </button>
          ))}
        </div>
      </div>

      {/* Export button */}
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={() => void handleExport()}
        disabled={busy}
        className="h-7 gap-1.5 text-xs"
      >
        {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
        Generate Export
      </Button>

      {/* Download result */}
      {data && (
        <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2.5 space-y-2">
          <div className="flex items-center gap-2 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span className="font-medium">Export Ready</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-mono text-muted-foreground">{data.filename}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => triggerDownload(data)}
              className="h-6 gap-1 text-[10px]"
            >
              <Download className="h-2.5 w-2.5" />
              Download Again
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 8. CLEANUP PANEL — Branches and snapshots management
// ═══════════════════════════════════════════════════════════════════════

export function CleanupPanel() {
  const workspace = useGSDWorkspaceState()
  const { loadCleanupData, executeCleanupAction } = useGSDWorkspaceActions()
  const state = workspace.commandSurface.remainingCommands.cleanup
  const data = state.data as CleanupData | null
  const busy = state.phase === "loading"
  const [executing, setExecuting] = useState(false)
  const [result, setResult] = useState<CleanupResult | null>(null)

  const mergedBranches = data?.branches.filter((b: CleanupBranch) => b.merged) ?? []
  const oldSnapshots = data?.snapshots ?? []

  const handleCleanup = async (type: "branches" | "snapshots") => {
    setExecuting(true)
    setResult(null)
    try {
      const branches = type === "branches" ? mergedBranches.map((b: CleanupBranch) => b.name) : []
      const snapshots = type === "snapshots" ? oldSnapshots.map((s: CleanupSnapshot) => s.ref) : []
      const res = await executeCleanupAction(branches, snapshots)
      setResult(res)
      // Reload after cleanup
      void loadCleanupData()
    } finally {
      setExecuting(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-cleanup">
      <PanelHeader
        title="Cleanup"
        icon={<Trash2 className="h-3.5 w-3.5" />}
        onRefresh={() => { setResult(null); void loadCleanupData() }}
        refreshing={busy}
      />

      {state.error && <PanelError message={state.error} />}
      {busy && !data && <PanelLoading label="Scanning for cleanup targets…" />}

      {/* Result banner */}
      {result && (
        <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2.5 text-xs text-success">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span className="font-medium">Cleanup Complete</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{result.message}</p>
        </div>
      )}

      {data && (
        <>
          {/* Branches table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground">Branches ({data.branches.length})</h4>
              {mergedBranches.length > 0 && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => void handleCleanup("branches")}
                  disabled={executing}
                  className="h-6 gap-1 text-[10px]"
                >
                  {executing ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" /> : <Scissors className="h-2.5 w-2.5" />}
                  Delete Merged ({mergedBranches.length})
                </Button>
              )}
            </div>
            {data.branches.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border/50 bg-card/50">
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Branch</th>
                      <th className="px-2.5 py-1.5 text-center font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.branches.map((b: CleanupBranch) => (
                      <tr key={b.name} className="border-b border-border/50 last:border-0">
                        <td className="px-2.5 py-1.5 font-mono text-foreground/80 truncate max-w-[250px]">
                          <span className="flex items-center gap-1.5">
                            <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                            {b.name}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 text-center">
                          <Badge
                            variant={b.merged ? "secondary" : "outline"}
                            className={cn(
                              "text-[10px] px-1.5 py-0",
                              b.merged ? "border-success/30 text-success" : "text-muted-foreground",
                            )}
                          >
                            {b.merged ? "merged" : "active"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <PanelEmpty message="No branches to clean up" />
            )}
          </div>

          {/* Snapshots table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground">Snapshots ({data.snapshots.length})</h4>
              {oldSnapshots.length > 0 && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => void handleCleanup("snapshots")}
                  disabled={executing}
                  className="h-6 gap-1 text-[10px]"
                >
                  {executing ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" /> : <Archive className="h-2.5 w-2.5" />}
                  Prune Snapshots ({oldSnapshots.length})
                </Button>
              )}
            </div>
            {data.snapshots.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border/50 bg-card/50">
                      <th className="px-2.5 py-1.5 text-left font-medium text-muted-foreground">Ref</th>
                      <th className="px-2.5 py-1.5 text-right font-medium text-muted-foreground">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.snapshots.map((s: CleanupSnapshot) => (
                      <tr key={s.ref} className="border-b border-border/50 last:border-0">
                        <td className="px-2.5 py-1.5 font-mono text-foreground/80 truncate max-w-[200px]">{s.ref}</td>
                        <td className="px-2.5 py-1.5 text-right text-muted-foreground">{s.date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <PanelEmpty message="No snapshots to prune" />
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 9. QUEUE PANEL — Milestone registry from existing workspace data
// ═══════════════════════════════════════════════════════════════════════

function sliceProgress(slices: WorkspaceSliceTarget[]): { done: number; total: number } {
  const done = slices.filter((s) => s.done).length
  return { done, total: slices.length }
}

export function QueuePanel() {
  const workspace = useGSDWorkspaceState()
  const workspaceIndex = getLiveWorkspaceIndex(workspace)
  const milestones = workspaceIndex?.milestones ?? []
  const active = workspaceIndex?.active

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-queue">
      <PanelHeader
        title="Queue"
        icon={<ListChecks className="h-3.5 w-3.5" />}
        status={
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {milestones.length} {milestones.length === 1 ? "milestone" : "milestones"}
          </Badge>
        }
      />

      {milestones.length > 0 ? (
        <div className="space-y-2">
          {milestones.map((m: WorkspaceMilestoneTarget) => {
            const isActive = active?.milestoneId === m.id
            const progress = sliceProgress(m.slices)
            return (
              <div
                key={m.id}
                className={cn(
                  "rounded-lg border px-3 py-2.5 space-y-1.5",
                  isActive
                    ? "border-info/25 bg-info/5"
                    : "border-border/50 bg-card/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium text-foreground/80">{m.id}</span>
                    <span className="text-xs text-foreground truncate">{m.title}</span>
                    {isActive && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 border-info/30 text-info">
                        active
                      </Badge>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                    {progress.done}/{progress.total} slices
                  </span>
                </div>

                {/* Progress bar */}
                {progress.total > 0 && (
                  <div className="h-1 rounded-full bg-border/50 overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        progress.done === progress.total ? "bg-success" : "bg-info",
                      )}
                      style={{ width: `${(progress.done / progress.total) * 100}%` }}
                    />
                  </div>
                )}

                {/* Slice list for active milestone */}
                {isActive && m.slices.length > 0 && (
                  <div className="space-y-0.5 pt-1">
                    {m.slices.map((s: WorkspaceSliceTarget) => (
                      <div key={s.id} className="flex items-center gap-2 text-[11px]">
                        {s.done ? (
                          <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
                        ) : (
                          <span className={cn(
                            "inline-block h-1.5 w-1.5 rounded-full shrink-0",
                            active?.sliceId === s.id ? "bg-info" : "bg-border/50",
                          )} />
                        )}
                        <span className="font-mono text-muted-foreground">{s.id}</span>
                        <span className={cn(
                          "truncate",
                          s.done ? "text-muted-foreground line-through" : "text-foreground/80",
                        )}>
                          {s.title}
                        </span>
                        {active?.sliceId === s.id && !s.done && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 text-info">current</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <PanelEmpty message="No milestones in the plan" />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 10. STATUS PANEL — Current active context from workspace data
// ═══════════════════════════════════════════════════════════════════════

export function StatusPanel() {
  const workspace = useGSDWorkspaceState()
  const workspaceIndex = getLiveWorkspaceIndex(workspace)
  const active = workspaceIndex?.active
  const milestones = workspaceIndex?.milestones ?? []

  const currentMilestone = milestones.find((m: WorkspaceMilestoneTarget) => m.id === active?.milestoneId)
  const currentSlice = currentMilestone?.slices.find((s: WorkspaceSliceTarget) => s.id === active?.sliceId)

  const totalSlices = milestones.reduce((sum: number, m: WorkspaceMilestoneTarget) => sum + m.slices.length, 0)
  const doneSlices = milestones.reduce((sum: number, m: WorkspaceMilestoneTarget) => sum + m.slices.filter((s) => s.done).length, 0)

  return (
    <div className="space-y-4" data-testid="gsd-surface-gsd-status">
      <PanelHeader
        title="Status"
        icon={<Terminal className="h-3.5 w-3.5" />}
      />

      {/* Active context card */}
      <div className="rounded-lg border border-border/50 bg-card/50 px-3 py-3 space-y-2">
        <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Active Context</h4>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
          <span className="text-muted-foreground">Phase</span>
          <span className="font-mono text-foreground/80">
            {active?.phase ? (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{active.phase}</Badge>
            ) : (
              <span className="text-muted-foreground italic">idle</span>
            )}
          </span>

          <span className="text-muted-foreground">Milestone</span>
          <span className="font-mono text-foreground/80">
            {currentMilestone ? (
              <span>{currentMilestone.id} — {currentMilestone.title}</span>
            ) : (
              <span className="text-muted-foreground italic">none</span>
            )}
          </span>

          <span className="text-muted-foreground">Slice</span>
          <span className="font-mono text-foreground/80">
            {currentSlice ? (
              <span>{currentSlice.id} — {currentSlice.title}</span>
            ) : (
              <span className="text-muted-foreground italic">none</span>
            )}
          </span>

          <span className="text-muted-foreground">Task</span>
          <span className="font-mono text-foreground/80">
            {active?.taskId ?? <span className="text-muted-foreground italic">none</span>}
          </span>
        </div>
      </div>

      {/* Overall progress */}
      <div className="flex flex-wrap gap-2">
        <InfoPill label="Milestones" value={milestones.length} />
        <InfoPill label="Slices" value={`${doneSlices}/${totalSlices}`} variant={doneSlices === totalSlices && totalSlices > 0 ? "success" : "info"} />
      </div>

      {/* Progress bar */}
      {totalSlices > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Overall Progress</span>
            <span className="tabular-nums">{Math.round((doneSlices / totalSlices) * 100)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-border/50 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                doneSlices === totalSlices ? "bg-success" : "bg-info",
              )}
              style={{ width: `${(doneSlices / totalSlices) * 100}%` }}
            />
          </div>
        </div>
      )}

      {milestones.length === 0 && (
        <PanelEmpty message="No plan loaded — run /gsd to initialize" />
      )}
    </div>
  )
}
