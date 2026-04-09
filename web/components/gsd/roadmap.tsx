"use client"

import { CheckCircle2, Circle, Play, AlertTriangle, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { getLiveWorkspaceIndex, useGSDWorkspaceState, type RiskLevel } from "@/lib/gsd-workspace-store"
import { getMilestoneStatus, getSliceStatus, type ItemStatus } from "@/lib/workspace-status"

const StatusIcon = ({
  status,
  size = "default",
}: {
  status: ItemStatus
  size?: "default" | "large"
}) => {
  const sizeClass = size === "large" ? "h-5 w-5" : "h-4 w-4"
  if (status === "done") {
    return <CheckCircle2 className={cn(sizeClass, "text-success")} />
  }
  if (status === "in-progress") {
    return <Play className={cn(sizeClass, "text-warning")} />
  }
  return <Circle className={cn(sizeClass, "text-muted-foreground")} />
}

const RiskBadge = ({ risk }: { risk: RiskLevel }) => {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
        risk === "high" && "bg-destructive/20 text-destructive",
        risk === "medium" && "bg-warning/20 text-warning",
        risk === "low" && "bg-muted text-muted-foreground",
      )}
    >
      {risk === "high" && <AlertTriangle className="h-2.5 w-2.5" />}
      {risk}
    </span>
  )
}

export function Roadmap() {
  const workspace = useGSDWorkspaceState()
  const liveWorkspace = getLiveWorkspaceIndex(workspace)
  const milestones = liveWorkspace?.milestones ?? []
  const activeScope = liveWorkspace?.active ?? {}
  const workspaceFreshness = workspace.live.freshness.workspace.stale ? "stale" : workspace.live.freshness.workspace.status

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-3">
        <h1 className="text-lg font-semibold">Roadmap</h1>
        <p className="text-sm text-muted-foreground">
          Project milestone structure with slices and dependencies
        </p>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="roadmap-workspace-freshness">
          Workspace freshness: {workspaceFreshness}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {workspace.bootStatus === "loading" && (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading workspace…</div>
        )}

        {workspace.bootStatus === "ready" && milestones.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No milestones found. Create a milestone with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">/gsd</code> to get started.
          </div>
        )}

        <div className="space-y-6">
          {milestones.map((milestone) => {
            const milestoneStatus = getMilestoneStatus(milestone, activeScope)
            const doneSlices = milestone.slices.filter((s) => s.done).length
            const totalTasks = milestone.slices.reduce((acc, s) => acc + s.tasks.length, 0)
            const doneTasks = milestone.slices.reduce((acc, s) => acc + s.tasks.filter((t) => t.done).length, 0)

            return (
              <div key={milestone.id} className="rounded-md border border-border bg-card">
                <div
                  className={cn(
                    "flex items-center gap-3 border-b border-border px-4 py-3",
                    milestoneStatus === "in-progress" && "bg-accent/30",
                  )}
                >
                  <StatusIcon status={milestoneStatus} size="large" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{milestone.id}</span>
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      <span className="font-semibold">{milestone.title}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium">
                      {doneSlices}/{milestone.slices.length} slices
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {doneTasks}/{totalTasks} tasks
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-border">
                  {milestone.slices.map((slice) => {
                    const sliceStatus = getSliceStatus(milestone.id, slice, activeScope)
                    const sliceDoneTasks = slice.tasks.filter((t) => t.done).length
                    const sliceTotalTasks = slice.tasks.length

                    return (
                      <div
                        key={`${milestone.id}-${slice.id}`}
                        className={cn(
                          "flex items-center gap-3 px-4 py-2.5",
                          sliceStatus === "in-progress" && "bg-accent/20",
                          sliceStatus === "pending" && "opacity-70",
                        )}
                      >
                        <div className="w-4" />
                        <StatusIcon status={sliceStatus} />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">{slice.id}</span>
                            <span className="text-sm">{slice.title}</span>
                            {slice.risk && <RiskBadge risk={slice.risk} />}
                            {slice.depends && slice.depends.length > 0 && (
                              <span className="text-[10px] text-muted-foreground">
                                depends on {slice.depends.join(", ")}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="w-24">
                            <div className="h-1 w-full rounded-full bg-accent">
                              <div
                                className="h-full rounded-full bg-foreground/70 transition-all"
                                style={{
                                  width: sliceTotalTasks > 0 ? `${(sliceDoneTasks / sliceTotalTasks) * 100}%` : "0%",
                                }}
                              />
                            </div>
                          </div>
                          <span className="w-12 text-right text-xs text-muted-foreground">
                            {sliceDoneTasks}/{sliceTotalTasks}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
