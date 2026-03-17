"use client"

import { useEffect, useState, useCallback } from "react"
import {
  CheckCircle2,
  Circle,
  Play,
  AlertTriangle,
  Clock,
  DollarSign,
  Download,
  Activity,
  GitBranch,
  ArrowRight,
  BarChart3,
  FileText,
  FileJson,
  Loader2,
  Layers,
  Zap,
  TrendingUp,
  ListTree,
  Bot,
  RotateCcw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type {
  VisualizerData,
  VisualizerMilestone,
  VisualizerSlice,
  VisualizerTask,
  PhaseAggregate,
  ModelAggregate,
  SliceAggregate,
  UnitMetrics,
  AgentActivityInfo,
  ChangelogEntry,
  CriticalPathInfo,
  ProjectTotals,
  TokenCounts,
} from "@/lib/visualizer-types"
import {
  formatCost,
  formatTokenCount,
  formatDuration,
} from "@/lib/visualizer-types"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusIcon(status: "complete" | "active" | "pending" | "done") {
  switch (status) {
    case "complete":
    case "done":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
    case "active":
      return <Play className="h-4 w-4 shrink-0 text-sky-400" />
    case "pending":
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
  }
}

function taskStatusIcon(task: VisualizerTask) {
  if (task.done) return statusIcon("done")
  if (task.active) return statusIcon("active")
  return statusIcon("pending")
}

function riskBadge(risk: string) {
  const color =
    risk === "high"
      ? "bg-red-500/15 text-red-400 border-red-500/20"
      : risk === "medium"
        ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
        : "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        color,
      )}
    >
      {risk}
    </span>
  )
}

function formatRelative(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  if (diff < 60_000) return "just now"
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center rounded-md border border-dashed border-border py-10">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

function StatCell({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-bold tabular-nums leading-tight">{value}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      )}
    </div>
  )
}

// ─── Progress Tab ────────────────────────────────────────────────────────────

function ProgressTab({ data }: { data: VisualizerData }) {
  if (data.milestones.length === 0) {
    return <EmptyState message="No milestones defined yet." />
  }

  // Compute risk heatmap data
  const allSlices = data.milestones.flatMap((m) => m.slices)
  const riskCounts = { low: 0, medium: 0, high: 0 }
  for (const sl of allSlices) {
    if (sl.risk === "high") riskCounts.high++
    else if (sl.risk === "medium") riskCounts.medium++
    else riskCounts.low++
  }

  return (
    <div className="space-y-6">
      {/* Risk Heatmap */}
      {allSlices.length > 0 && (
        <div className="rounded-md border border-border bg-card p-4">
          <SectionHeading>Risk Heatmap</SectionHeading>
          <div className="mt-3 space-y-2">
            {data.milestones
              .filter((m) => m.slices.length > 0)
              .map((ms) => (
                <div key={ms.id} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                    {ms.id}
                  </span>
                  <div className="flex gap-1">
                    {ms.slices.map((sl) => (
                      <div
                        key={sl.id}
                        title={`${sl.id}: ${sl.title} (${sl.risk})`}
                        className={cn(
                          "h-5 w-5 rounded-sm",
                          sl.risk === "high"
                            ? "bg-red-500"
                            : sl.risk === "medium"
                              ? "bg-amber-500"
                              : "bg-emerald-500",
                        )}
                      />
                    ))}
                  </div>
                </div>
              ))}
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-emerald-500" /> low ({riskCounts.low})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-amber-500" /> med ({riskCounts.medium})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-red-500" /> high ({riskCounts.high})
            </span>
          </div>
        </div>
      )}

      {/* Milestone/Slice/Task Tree */}
      <div className="space-y-3">
        {data.milestones.map((ms) => (
          <div key={ms.id} className="rounded-md border border-border bg-card">
            {/* Milestone header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2.5">
                {statusIcon(ms.status)}
                <span className="font-mono text-xs text-muted-foreground">{ms.id}</span>
                <span className="text-sm font-medium">{ms.title}</span>
              </div>
              <span
                className={cn(
                  "rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                  ms.status === "complete"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : ms.status === "active"
                      ? "bg-sky-500/15 text-sky-400"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {ms.status}
              </span>
            </div>

            {/* Dependency note for pending milestones */}
            {ms.status === "pending" && ms.dependsOn.length > 0 && (
              <div className="px-4 py-2 text-xs text-muted-foreground">
                Depends on {ms.dependsOn.join(", ")}
              </div>
            )}

            {/* Slices */}
            {ms.slices.length > 0 && (
              <div className="divide-y divide-border">
                {ms.slices.map((sl) => {
                  const doneTasks = sl.tasks.filter((t) => t.done).length
                  return (
                    <div key={sl.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        {statusIcon(sl.done ? "done" : sl.active ? "active" : "pending")}
                        <span className="font-mono text-xs text-muted-foreground">
                          {sl.id}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {sl.title}
                        </span>
                        <div className="flex items-center gap-2">
                          {sl.depends.length > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                              deps: {sl.depends.join(", ")}
                            </span>
                          )}
                          {sl.tasks.length > 0 && (
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {doneTasks}/{sl.tasks.length}
                            </span>
                          )}
                          {riskBadge(sl.risk)}
                        </div>
                      </div>

                      {/* Tasks (show for active slices or slices with any active task) */}
                      {(sl.active || sl.tasks.some((t) => t.active)) &&
                        sl.tasks.length > 0 && (
                          <div className="ml-6 mt-2 space-y-0.5">
                            {sl.tasks.map((task) => (
                              <div
                                key={task.id}
                                className={cn(
                                  "flex items-center gap-2 rounded px-2 py-1",
                                  task.active && "bg-accent",
                                )}
                              >
                                {taskStatusIcon(task)}
                                <span className="font-mono text-[11px] text-muted-foreground">
                                  {task.id}
                                </span>
                                <span
                                  className={cn(
                                    "text-xs",
                                    task.done &&
                                      "text-muted-foreground line-through decoration-muted-foreground/40",
                                    task.active && "font-medium",
                                    !task.done && !task.active && "text-muted-foreground",
                                  )}
                                >
                                  {task.title}
                                </span>
                                {task.active && (
                                  <span className="ml-auto rounded-sm bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-400">
                                    active
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Deps Tab ────────────────────────────────────────────────────────────────

function DepsTab({ data }: { data: VisualizerData }) {
  const cp = data.criticalPath
  const activeMs = data.milestones.find((m) => m.status === "active")

  return (
    <div className="space-y-6">
      {/* Milestone Dependencies */}
      <div className="rounded-md border border-border bg-card p-4">
        <SectionHeading>Milestone Dependencies</SectionHeading>
        <div className="mt-3">
          {data.milestones.filter((m) => m.dependsOn.length > 0).length === 0 ? (
            <p className="text-sm text-muted-foreground">No milestone dependencies.</p>
          ) : (
            <div className="space-y-1.5">
              {data.milestones
                .filter((m) => m.dependsOn.length > 0)
                .flatMap((ms) =>
                  ms.dependsOn.map((dep) => (
                    <div key={`${dep}-${ms.id}`} className="flex items-center gap-2 text-sm">
                      <span className="font-mono text-sky-400">{dep}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono">{ms.id}</span>
                    </div>
                  )),
                )}
            </div>
          )}
        </div>
      </div>

      {/* Slice Dependencies (active milestone) */}
      <div className="rounded-md border border-border bg-card p-4">
        <SectionHeading>Slice Dependencies (active milestone)</SectionHeading>
        <div className="mt-3">
          {!activeMs ? (
            <p className="text-sm text-muted-foreground">No active milestone.</p>
          ) : (
            (() => {
              const slDeps = activeMs.slices.filter((s) => s.depends.length > 0)
              if (slDeps.length === 0)
                return <p className="text-sm text-muted-foreground">No slice dependencies.</p>
              return (
                <div className="space-y-1.5">
                  {slDeps.flatMap((sl) =>
                    sl.depends.map((dep) => (
                      <div key={`${dep}-${sl.id}`} className="flex items-center gap-2 text-sm">
                        <span className="font-mono text-sky-400">{dep}</span>
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono">{sl.id}</span>
                      </div>
                    )),
                  )}
                </div>
              )
            })()
          )}
        </div>
      </div>

      {/* Critical Path */}
      <div className="rounded-md border border-border bg-card p-4">
        <SectionHeading>Critical Path</SectionHeading>
        <div className="mt-3">
          {cp.milestonePath.length === 0 ? (
            <p className="text-sm text-muted-foreground">No critical path data.</p>
          ) : (
            <div className="space-y-4">
              {/* Milestone chain */}
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Milestone Chain
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {cp.milestonePath.map((id, i) => (
                    <span key={id} className="flex items-center gap-1.5">
                      <span className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 font-mono text-xs font-semibold text-red-400">
                        {id}
                      </span>
                      {i < cp.milestonePath.length - 1 && (
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </span>
                  ))}
                </div>
              </div>

              {/* Milestone slack */}
              {Object.keys(cp.milestoneSlack).length > 0 && (
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Milestone Slack
                  </p>
                  <div className="space-y-1">
                    {data.milestones
                      .filter((m) => !cp.milestonePath.includes(m.id))
                      .map((m) => (
                        <div key={m.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span className="font-mono">{m.id}</span>
                          <span className="text-xs">slack: {cp.milestoneSlack[m.id] ?? 0}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Slice critical path */}
              {cp.slicePath.length > 0 && (
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Slice Critical Path
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {cp.slicePath.map((id, i) => (
                      <span key={id} className="flex items-center gap-1.5">
                        <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-xs text-amber-400">
                          {id}
                        </span>
                        {i < cp.slicePath.length - 1 && (
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </span>
                    ))}
                  </div>

                  {/* Bottleneck warnings */}
                  {activeMs && (
                    <div className="mt-2 space-y-1">
                      {cp.slicePath
                        .map((sid) => activeMs.slices.find((s) => s.id === sid))
                        .filter(
                          (sl): sl is VisualizerSlice =>
                            sl != null && !sl.done && !sl.active,
                        )
                        .map((sl) => (
                          <div
                            key={sl.id}
                            className="flex items-center gap-1.5 text-xs text-amber-400"
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {sl.id}: critical but not yet started
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* Slice slack */}
              {Object.keys(cp.sliceSlack).length > 0 && (
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Slice Slack
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(cp.sliceSlack).map(([id, slack]) => (
                      <span
                        key={id}
                        className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                      >
                        {id}: {slack}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Metrics Tab ─────────────────────────────────────────────────────────────

function MetricsTab({ data }: { data: VisualizerData }) {
  if (!data.totals) {
    return <EmptyState message="No metrics data available." />
  }

  const totals = data.totals

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCell label="Units" value={String(totals.units)} />
        <StatCell label="Total Cost" value={formatCost(totals.cost)} />
        <StatCell
          label="Duration"
          value={formatDuration(totals.duration)}
        />
        <StatCell
          label="Tokens"
          value={formatTokenCount(totals.tokens.total)}
          sub={`${formatTokenCount(totals.tokens.input)} in / ${formatTokenCount(totals.tokens.output)} out`}
        />
      </div>

      {/* By Phase */}
      {data.byPhase.length > 0 && (
        <div className="rounded-md border border-border bg-card p-4">
          <SectionHeading>By Phase</SectionHeading>
          <div className="mt-3 space-y-2">
            {data.byPhase.map((phase) => {
              const pct =
                totals.cost > 0 ? (phase.cost / totals.cost) * 100 : 0
              return (
                <div key={phase.phase}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{phase.phase}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatCost(phase.cost)} · {pct.toFixed(1)}% ·{" "}
                      {formatTokenCount(phase.tokens.total)} tokens ·{" "}
                      {phase.units} units
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-sky-500 transition-all"
                      style={{ width: `${Math.max(1, pct)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* By Model */}
      {data.byModel.length > 0 && (
        <div className="rounded-md border border-border bg-card p-4">
          <SectionHeading>By Model</SectionHeading>
          <div className="mt-3 space-y-2">
            {data.byModel.map((model) => {
              const pct =
                totals.cost > 0 ? (model.cost / totals.cost) * 100 : 0
              return (
                <div key={model.model}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs">{model.model}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatCost(model.cost)} · {pct.toFixed(1)}% ·{" "}
                      {formatTokenCount(model.tokens.total)} · {model.units} units
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${Math.max(1, pct)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* By Slice */}
      {data.bySlice.length > 0 && (
        <div className="rounded-md border border-border bg-card p-4">
          <SectionHeading>By Slice</SectionHeading>
          <div className="mt-3">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Slice</th>
                    <th className="pb-2 pr-4 text-right font-medium">Units</th>
                    <th className="pb-2 pr-4 text-right font-medium">Cost</th>
                    <th className="pb-2 pr-4 text-right font-medium">Duration</th>
                    <th className="pb-2 text-right font-medium">Tokens</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.bySlice.map((sl) => (
                    <tr key={sl.sliceId}>
                      <td className="py-2 pr-4 font-mono">{sl.sliceId}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {sl.units}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatCost(sl.cost)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatDuration(sl.duration)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatTokenCount(sl.tokens.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Projections */}
      {data.bySlice.length >= 2 && data.totals && (
        <ProjectionsSection data={data} totals={totals} />
      )}
    </div>
  )
}

function ProjectionsSection({
  data,
  totals,
}: {
  data: VisualizerData
  totals: ProjectTotals
}) {
  const sliceLevelEntries = data.bySlice.filter((s) => s.sliceId.includes("/"))
  if (sliceLevelEntries.length < 2) return null

  const totalSliceCost = sliceLevelEntries.reduce((sum, s) => sum + s.cost, 0)
  const avgCostPerSlice = totalSliceCost / sliceLevelEntries.length
  const projectedRemaining = avgCostPerSlice * data.remainingSliceCount
  const projectedTotal = totals.cost + projectedRemaining
  const burnRate =
    totals.duration > 0 ? totals.cost / (totals.duration / 3_600_000) : 0

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <SectionHeading>Projections</SectionHeading>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCell label="Avg / Slice" value={formatCost(avgCostPerSlice)} />
        <StatCell
          label="Projected Remaining"
          value={formatCost(projectedRemaining)}
          sub={`${data.remainingSliceCount} slices left`}
        />
        <StatCell label="Projected Total" value={formatCost(projectedTotal)} />
        {burnRate > 0 && (
          <StatCell label="Burn Rate" value={`${formatCost(burnRate)}/hr`} />
        )}
      </div>
      {projectedTotal > 2 * totals.cost && data.remainingSliceCount > 0 && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" />
          Projected total {formatCost(projectedTotal)} exceeds 2× current spend
        </div>
      )}
    </div>
  )
}

// ─── Timeline Tab ────────────────────────────────────────────────────────────

function TimelineTab({ data }: { data: VisualizerData }) {
  if (data.units.length === 0) {
    return <EmptyState message="No execution history." />
  }

  const sorted = [...data.units].sort((a, b) => a.startedAt - b.startedAt)
  const recent = sorted.slice(-30)
  const maxDuration = Math.max(
    ...recent.map((u) => (u.finishedAt || Date.now()) - u.startedAt),
    1,
  )

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-2.5">
          <SectionHeading>Execution Timeline</SectionHeading>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Showing {recent.length} of {data.units.length} units — most recent
          </p>
        </div>
        <div className="divide-y divide-border">
          {[...recent].reverse().map((unit, i) => {
            const duration = (unit.finishedAt || Date.now()) - unit.startedAt
            const pct = (duration / maxDuration) * 100
            const isRunning = !unit.finishedAt || unit.finishedAt === 0
            return (
              <div
                key={`${unit.id}-${unit.startedAt}-${i}`}
                className="flex items-center gap-3 px-4 py-2"
              >
                {/* Time */}
                <span className="w-11 shrink-0 font-mono text-[11px] text-muted-foreground">
                  {formatTime(unit.startedAt)}
                </span>
                {/* Status icon */}
                {isRunning ? (
                  <Play className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                )}
                {/* Type + ID */}
                <span className="w-20 shrink-0 truncate text-xs">{unit.type}</span>
                <span className="w-28 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                  {unit.id}
                </span>
                {/* Duration bar */}
                <div className="hidden flex-1 sm:block">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        isRunning ? "animate-pulse bg-sky-500" : "bg-sky-500",
                      )}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                </div>
                {/* Stats */}
                <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatDuration(duration)}
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums">
                  {formatCost(unit.cost)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Agent Tab ───────────────────────────────────────────────────────────────

function AgentTab({ data }: { data: VisualizerData }) {
  const activity = data.agentActivity

  if (!activity) {
    return <EmptyState message="No agent activity data available." />
  }

  const completed = activity.completedUnits
  const total = Math.max(completed, activity.totalSlices)
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0

  return (
    <div className="space-y-4">
      {/* Status header */}
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "h-3 w-3 rounded-full",
                activity.active ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
            <span className="text-lg font-semibold">
              {activity.active ? "Active" : "Idle"}
            </span>
          </div>
          {activity.active && (
            <span className="font-mono text-sm text-muted-foreground">
              {formatDuration(activity.elapsed)}
            </span>
          )}
        </div>

        {activity.currentUnit && (
          <div className="mt-3 flex items-center gap-2 rounded border border-sky-500/20 bg-sky-500/5 px-3 py-2">
            <Play className="h-3.5 w-3.5 text-sky-400" />
            <span className="text-sm">
              <span className="text-muted-foreground">Running:</span>{" "}
              <span className="font-mono font-medium">
                {activity.currentUnit.type} {activity.currentUnit.id}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="rounded-md border border-border bg-card p-4">
          <div className="flex items-center justify-between text-sm">
            <SectionHeading>Completion</SectionHeading>
            <span className="font-mono text-xs text-muted-foreground">
              {completed}/{total} slices
            </span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-right text-xs text-muted-foreground">{pct}%</p>
        </div>
      )}

      {/* Session stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCell
          label="Completion Rate"
          value={
            activity.completionRate > 0
              ? `${activity.completionRate.toFixed(1)} u/hr`
              : "—"
          }
        />
        <StatCell label="Session Cost" value={formatCost(activity.sessionCost)} />
        <StatCell
          label="Session Tokens"
          value={formatTokenCount(activity.sessionTokens)}
        />
        <StatCell
          label="Completed Units"
          value={String(activity.completedUnits)}
        />
      </div>

      {/* Recent completed units */}
      {data.units.filter((u) => u.finishedAt > 0).length > 0 && (
        <div className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-2.5">
            <SectionHeading>Recent Completed (last 5)</SectionHeading>
          </div>
          <div className="divide-y divide-border">
            {data.units
              .filter((u) => u.finishedAt > 0)
              .slice(-5)
              .reverse()
              .map((u, i) => (
                <div key={`${u.id}-${i}`} className="flex items-center gap-3 px-4 py-2">
                  <span className="w-11 font-mono text-[11px] text-muted-foreground">
                    {formatTime(u.startedAt)}
                  </span>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  <span className="flex-1 truncate text-xs">{u.type}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {u.id}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums">
                    {formatDuration(u.finishedAt - u.startedAt)}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums">
                    {formatCost(u.cost)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Changes Tab ─────────────────────────────────────────────────────────────

function ChangesTab({ data }: { data: VisualizerData }) {
  const entries = data.changelog.entries

  if (entries.length === 0) {
    return <EmptyState message="No completed slices yet." />
  }

  // Most recent first
  const sorted = [...entries].reverse()

  return (
    <div className="space-y-3">
      {sorted.map((entry, i) => (
        <div key={`${entry.milestoneId}-${entry.sliceId}-${i}`} className="rounded-md border border-border bg-card">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span className="font-mono text-xs text-emerald-400">
                {entry.milestoneId}/{entry.sliceId}
              </span>
              <span className="text-sm font-medium">{entry.title}</span>
            </div>
            {entry.completedAt && (
              <span className="text-[11px] text-muted-foreground">
                {formatRelative(entry.completedAt)}
              </span>
            )}
          </div>

          <div className="px-4 py-3">
            {/* One-liner */}
            {entry.oneLiner && (
              <p className="text-sm text-muted-foreground italic">
                &ldquo;{entry.oneLiner}&rdquo;
              </p>
            )}

            {/* Files modified */}
            {entry.filesModified.length > 0 && (
              <div className={cn("space-y-1", entry.oneLiner && "mt-3")}>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Files Modified
                </p>
                {entry.filesModified.map((f, fi) => (
                  <div
                    key={fi}
                    className="flex items-start gap-2 text-xs"
                  >
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500/60" />
                    <span className="font-mono text-muted-foreground">{f.path}</span>
                    {f.description && (
                      <span className="text-muted-foreground/70">— {f.description}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Export Tab ───────────────────────────────────────────────────────────────

function ExportTab({ data }: { data: VisualizerData }) {
  const downloadBlob = useCallback(
    (content: string, filename: string, mimeType: string) => {
      const blob = new Blob([content], { type: mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    },
    [],
  )

  const generateMarkdown = useCallback(() => {
    const lines: string[] = []
    lines.push("# GSD Workflow Report")
    lines.push("")
    lines.push(`Generated: ${new Date().toISOString()}`)
    lines.push(`Phase: ${data.phase}`)
    lines.push("")

    // Milestones
    lines.push("## Milestones")
    lines.push("")
    for (const ms of data.milestones) {
      const icon = ms.status === "complete" ? "✓" : ms.status === "active" ? "▸" : "○"
      lines.push(`### ${icon} ${ms.id}: ${ms.title} (${ms.status})`)
      if (ms.dependsOn.length > 0) lines.push(`Depends on: ${ms.dependsOn.join(", ")}`)
      lines.push("")
      for (const sl of ms.slices) {
        const slIcon = sl.done ? "✓" : sl.active ? "▸" : "○"
        lines.push(`- ${slIcon} **${sl.id}**: ${sl.title} [risk: ${sl.risk}]`)
        for (const t of sl.tasks) {
          const tIcon = t.done ? "✓" : t.active ? "▸" : "○"
          lines.push(`  - ${tIcon} ${t.id}: ${t.title}`)
        }
      }
      lines.push("")
    }

    // Metrics
    if (data.totals) {
      lines.push("## Metrics Summary")
      lines.push("")
      lines.push(`| Metric | Value |`)
      lines.push(`|--------|-------|`)
      lines.push(`| Units | ${data.totals.units} |`)
      lines.push(`| Total Cost | ${formatCost(data.totals.cost)} |`)
      lines.push(`| Duration | ${formatDuration(data.totals.duration)} |`)
      lines.push(`| Tokens | ${formatTokenCount(data.totals.tokens.total)} |`)
      lines.push("")
    }

    // Critical Path
    if (data.criticalPath.milestonePath.length > 0) {
      lines.push("## Critical Path")
      lines.push("")
      lines.push(`Milestone: ${data.criticalPath.milestonePath.join(" → ")}`)
      if (data.criticalPath.slicePath.length > 0) {
        lines.push(`Slice: ${data.criticalPath.slicePath.join(" → ")}`)
      }
      lines.push("")
    }

    // Changelog
    if (data.changelog.entries.length > 0) {
      lines.push("## Changelog")
      lines.push("")
      for (const entry of data.changelog.entries) {
        lines.push(`### ${entry.milestoneId}/${entry.sliceId}: ${entry.title}`)
        if (entry.oneLiner) lines.push(`> ${entry.oneLiner}`)
        if (entry.filesModified.length > 0) {
          lines.push("Files:")
          for (const f of entry.filesModified) {
            lines.push(`- \`${f.path}\` — ${f.description}`)
          }
        }
        if (entry.completedAt) lines.push(`Completed: ${entry.completedAt}`)
        lines.push("")
      }
    }

    return lines.join("\n")
  }, [data])

  const handleMarkdown = () => {
    downloadBlob(generateMarkdown(), "gsd-report.md", "text/markdown")
  }

  const handleJSON = () => {
    downloadBlob(
      JSON.stringify(data, null, 2),
      "gsd-report.json",
      "application/json",
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-card p-6">
        <SectionHeading>Export Project Data</SectionHeading>
        <p className="mt-2 text-sm text-muted-foreground">
          Download the current visualizer data as a structured report. The
          markdown format includes milestones, metrics, critical path, and
          changelog in a readable format. The JSON format contains the full raw
          data payload.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {/* Markdown */}
          <button
            onClick={handleMarkdown}
            className="group flex items-center gap-4 rounded-md border border-border p-4 text-left transition-colors hover:border-sky-500/30 hover:bg-sky-500/5"
          >
            <div className="rounded-md bg-sky-500/10 p-3">
              <FileText className="h-5 w-5 text-sky-400" />
            </div>
            <div>
              <p className="text-sm font-medium group-hover:text-sky-400">
                Download Markdown
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Human-readable report with tables
              </p>
            </div>
            <Download className="ml-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>

          {/* JSON */}
          <button
            onClick={handleJSON}
            className="group flex items-center gap-4 rounded-md border border-border p-4 text-left transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/5"
          >
            <div className="rounded-md bg-emerald-500/10 p-3">
              <FileJson className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-medium group-hover:text-emerald-400">
                Download JSON
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Full raw data payload
              </p>
            </div>
            <Download className="ml-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function VisualizerView() {
  const [data, setData] = useState<VisualizerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const resp = await fetch("/api/visualizer")
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: "Unknown error" }))
        throw new Error(body.error || `HTTP ${resp.status}`)
      }
      const json: VisualizerData = await resp.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch visualizer data")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10_000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Loading state
  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading visualizer data…</p>
        </div>
      </div>
    )
  }

  // Error state (no data at all)
  if (error && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <AlertTriangle className="h-6 w-6 text-amber-400" />
          <p className="text-sm font-medium">Failed to load visualizer</p>
          <p className="max-w-md text-xs text-muted-foreground">{error}</p>
          <button
            onClick={fetchData}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            <RotateCcw className="h-3 w-3" />
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Workflow Visualizer</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Phase: <span className="font-medium text-foreground">{data.phase}</span>
            {data.remainingSliceCount > 0 && (
              <span className="ml-3">
                {data.remainingSliceCount} slice{data.remainingSliceCount !== 1 ? "s" : ""} remaining
              </span>
            )}
            {error && (
              <span className="ml-3 text-amber-400">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                Stale data — {error}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-y-auto">
        <Tabs defaultValue="progress" className="h-full">
          <div className="sticky top-0 z-10 border-b border-border bg-background px-6 py-2">
            <TabsList>
              <TabsTrigger value="progress">
                <Layers className="h-3.5 w-3.5" />
                Progress
              </TabsTrigger>
              <TabsTrigger value="deps">
                <GitBranch className="h-3.5 w-3.5" />
                Deps
              </TabsTrigger>
              <TabsTrigger value="metrics">
                <BarChart3 className="h-3.5 w-3.5" />
                Metrics
              </TabsTrigger>
              <TabsTrigger value="timeline">
                <Clock className="h-3.5 w-3.5" />
                Timeline
              </TabsTrigger>
              <TabsTrigger value="agent">
                <Bot className="h-3.5 w-3.5" />
                Agent
              </TabsTrigger>
              <TabsTrigger value="changes">
                <Activity className="h-3.5 w-3.5" />
                Changes
              </TabsTrigger>
              <TabsTrigger value="export">
                <Download className="h-3.5 w-3.5" />
                Export
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="p-6">
            <TabsContent value="progress">
              <ProgressTab data={data} />
            </TabsContent>
            <TabsContent value="deps">
              <DepsTab data={data} />
            </TabsContent>
            <TabsContent value="metrics">
              <MetricsTab data={data} />
            </TabsContent>
            <TabsContent value="timeline">
              <TimelineTab data={data} />
            </TabsContent>
            <TabsContent value="agent">
              <AgentTab data={data} />
            </TabsContent>
            <TabsContent value="changes">
              <ChangesTab data={data} />
            </TabsContent>
            <TabsContent value="export">
              <ExportTab data={data} />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  )
}
