"use client"

import { CheckCircle2, Play, Clock, Terminal, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useGSDWorkspaceState, type TerminalLineType } from "@/lib/gsd-workspace-store"

function EventIcon({ type }: { type: TerminalLineType }) {
  const baseClass = "h-4 w-4"
  switch (type) {
    case "system":
      return <Clock className={cn(baseClass, "text-blue-400")} />
    case "success":
      return <CheckCircle2 className={cn(baseClass, "text-emerald-400")} />
    case "error":
      return <AlertCircle className={cn(baseClass, "text-red-400")} />
    case "output":
      return <Terminal className={cn(baseClass, "text-foreground")} />
    case "input":
      return <Play className={cn(baseClass, "text-amber-400")} />
    default:
      return <Clock className={cn(baseClass, "text-muted-foreground")} />
  }
}

export function ActivityView() {
  const workspace = useGSDWorkspaceState()
  const terminalLines = workspace.terminalLines ?? []

  // Show most recent events first
  const reversedLines = [...terminalLines].reverse()

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-3">
        <h1 className="text-lg font-semibold">Activity Log</h1>
        <p className="text-sm text-muted-foreground">
          Execution history and git operations
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {reversedLines.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No activity yet. Events will appear here once the workspace is active.
          </div>
        ) : (
          <div className="relative px-6 py-4">
            {/* Timeline line */}
            <div className="absolute left-10 top-6 bottom-6 w-px bg-border" />

            <div className="space-y-4">
              {reversedLines.map((line) => (
                <div key={line.id} className="relative flex gap-4">
                  {/* Timeline dot */}
                  <div className="relative z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-card">
                    <EventIcon type={line.type} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 pt-0.5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium">{line.content}</p>
                      </div>
                      <span className="flex-shrink-0 font-mono text-xs text-muted-foreground">
                        {line.timestamp}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
