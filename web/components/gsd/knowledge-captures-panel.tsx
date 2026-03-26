"use client"

import { useState } from "react"
import {
  BookOpen,
  InboxIcon,
  LoaderCircle,
  RefreshCw,
  Zap,
  Clock,
  Tag,
  FileText,
  Lightbulb,
  Repeat2,
  StickyNote,
  ArrowRightLeft,
  CalendarClock,
  ListTodo,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  KnowledgeData,
  KnowledgeEntry,
  CapturesData,
  CaptureEntry,
  Classification,
} from "@/lib/knowledge-captures-types"
import { cn } from "@/lib/utils"
import {
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"

// ═══════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════

function PanelHeader({
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
// KNOWLEDGE TYPE STYLING
// ═══════════════════════════════════════════════════════════════════════

function knowledgeTypeBadge(type: KnowledgeEntry["type"]) {
  switch (type) {
    case "rule":
      return { label: "Rule", className: "border-violet-500/30 bg-violet-500/10 text-violet-400" }
    case "pattern":
      return { label: "Pattern", className: "border-info/30 bg-info/10 text-info" }
    case "lesson":
      return { label: "Lesson", className: "border-warning/30 bg-warning/10 text-warning" }
    case "freeform":
      return { label: "Freeform", className: "border-success/30 bg-success/10 text-success" }
  }
}

function KnowledgeTypeIcon({ type, className }: { type: KnowledgeEntry["type"]; className?: string }) {
  const base = cn("h-3.5 w-3.5 shrink-0", className)
  switch (type) {
    case "rule":
      return <Tag className={cn(base, "text-violet-400")} />
    case "pattern":
      return <Repeat2 className={cn(base, "text-info")} />
    case "lesson":
      return <Lightbulb className={cn(base, "text-warning")} />
    case "freeform":
      return <FileText className={cn(base, "text-success")} />
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CAPTURE STATUS STYLING
// ═══════════════════════════════════════════════════════════════════════

function captureStatusStyle(status: CaptureEntry["status"]) {
  switch (status) {
    case "pending":
      return { label: "Pending", className: "border-warning/30 bg-warning/10 text-warning" }
    case "triaged":
      return { label: "Triaged", className: "border-info/30 bg-info/10 text-info" }
    case "resolved":
      return { label: "Resolved", className: "border-success/30 bg-success/10 text-success" }
  }
}

function classificationLabel(c: Classification): string {
  switch (c) {
    case "quick-task": return "Quick Task"
    case "inject": return "Inject"
    case "defer": return "Defer"
    case "replan": return "Replan"
    case "note": return "Note"
  }
}

function ClassificationIcon({ classification, className }: { classification: Classification; className?: string }) {
  const base = cn("h-3 w-3 shrink-0", className)
  switch (classification) {
    case "quick-task": return <Zap className={base} />
    case "inject": return <ArrowRightLeft className={base} />
    case "defer": return <CalendarClock className={base} />
    case "replan": return <ListTodo className={base} />
    case "note": return <StickyNote className={base} />
  }
}

const CLASSIFICATION_OPTIONS: Classification[] = ["quick-task", "inject", "defer", "replan", "note"]

// ═══════════════════════════════════════════════════════════════════════
// KNOWLEDGE TAB CONTENT
// ═══════════════════════════════════════════════════════════════════════

function KnowledgeEntryRow({ entry }: { entry: KnowledgeEntry }) {
  const badge = knowledgeTypeBadge(entry.type)
  return (
    <div className="group rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 transition-colors hover:bg-card/50">
      <div className="flex items-start gap-2.5">
        <KnowledgeTypeIcon type={entry.type} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground truncate">{entry.title}</span>
            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 shrink-0", badge.className)}>
              {badge.label}
            </Badge>
          </div>
          {entry.content && (
            <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
              {entry.content}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function KnowledgeTabContent({
  data,
  phase,
  error,
  onRefresh,
}: {
  data: KnowledgeData | null
  phase: string
  error: string | null
  onRefresh: () => void
}) {
  if (phase === "loading") return <PanelLoading label="Loading knowledge base…" />
  if (phase === "error" && error) return <PanelError message={error} />
  if (!data || data.entries.length === 0) return <PanelEmpty message="No knowledge entries found" />

  return (
    <div className="space-y-3">
      <PanelHeader
        title="Knowledge Base"
        subtitle={`${data.entries.length} entries`}
        onRefresh={onRefresh}
        refreshing={phase === "loading"}
      />
      <div className="space-y-1.5">
        {data.entries.map((entry) => (
          <KnowledgeEntryRow key={entry.id} entry={entry} />
        ))}
      </div>
      {data.lastModified && (
        <p className="pt-2 text-[10px] text-muted-foreground">
          Last modified: {new Date(data.lastModified).toLocaleString()}
        </p>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// CAPTURES TAB CONTENT
// ═══════════════════════════════════════════════════════════════════════

function CaptureEntryRow({
  entry,
  onResolve,
  resolvePending,
}: {
  entry: CaptureEntry
  onResolve: (captureId: string, classification: Classification) => void
  resolvePending: boolean
}) {
  const status = captureStatusStyle(entry.status)

  return (
    <div className="group rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 transition-colors hover:bg-card/50">
      <div className="flex items-start gap-2.5">
        <div className={cn(
          "mt-1 h-2 w-2 shrink-0 rounded-full",
          entry.status === "pending" && "bg-warning",
          entry.status === "triaged" && "bg-info",
          entry.status === "resolved" && "bg-success",
        )} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-foreground">{entry.text}</span>
            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 shrink-0", status.className)}>
              {status.label}
            </Badge>
            {entry.classification && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0 border-border/50 text-muted-foreground">
                {classificationLabel(entry.classification)}
              </Badge>
            )}
          </div>
          {entry.timestamp && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="h-2.5 w-2.5" />
              {entry.timestamp}
            </div>
          )}
          {entry.resolution && (
            <p className="mt-1 text-[10px] text-muted-foreground italic">{entry.resolution}</p>
          )}
          {entry.status === "pending" && (
            <div className="mt-2 flex flex-wrap gap-1">
              {CLASSIFICATION_OPTIONS.map((c) => (
                <Button
                  key={c}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={resolvePending}
                  onClick={() => onResolve(entry.id, c)}
                  className="h-6 gap-1 px-2 text-[10px] font-normal border-border/50 hover:bg-foreground/5"
                >
                  <ClassificationIcon classification={c} />
                  {classificationLabel(c)}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CapturesTabContent({
  data,
  phase,
  error,
  resolvePending,
  resolveError,
  onRefresh,
  onResolve,
}: {
  data: CapturesData | null
  phase: string
  error: string | null
  resolvePending: boolean
  resolveError: string | null
  onRefresh: () => void
  onResolve: (captureId: string, classification: Classification) => void
}) {
  if (phase === "loading") return <PanelLoading label="Loading captures…" />
  if (phase === "error" && error) return <PanelError message={error} />
  if (!data || data.entries.length === 0) return <PanelEmpty message="No captures found" />

  return (
    <div className="space-y-3">
      <PanelHeader
        title="Captures"
        subtitle={`${data.entries.length} total`}
        status={
          <div className="flex gap-1.5">
            <StatPill label="Pending" value={data.pendingCount} variant={data.pendingCount > 0 ? "warning" : "default"} />
            <StatPill label="Actionable" value={data.actionableCount} variant={data.actionableCount > 0 ? "info" : "default"} />
          </div>
        }
        onRefresh={onRefresh}
        refreshing={phase === "loading"}
      />

      {resolveError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          Resolve error: {resolveError}
        </div>
      )}

      <div className="space-y-1.5">
        {data.entries.map((entry) => (
          <CaptureEntryRow
            key={entry.id}
            entry={entry}
            onResolve={onResolve}
            resolvePending={resolvePending}
          />
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN PANEL COMPONENT
// ═══════════════════════════════════════════════════════════════════════

interface KnowledgeCapturesPanelProps {
  initialTab: "knowledge" | "captures"
}

export function KnowledgeCapturesPanel({ initialTab }: KnowledgeCapturesPanelProps) {
  const [activeTab, setActiveTab] = useState<"knowledge" | "captures">(initialTab)
  const workspace = useGSDWorkspaceState()
  const { loadKnowledgeData, loadCapturesData, resolveCaptureAction } = useGSDWorkspaceActions()

  const knowledgeCaptures = workspace.commandSurface.knowledgeCaptures
  const knowledgeState = knowledgeCaptures.knowledge
  const capturesState = knowledgeCaptures.captures
  const resolveState = knowledgeCaptures.resolveRequest

  const capturesData = capturesState.data as CapturesData | null
  const pendingCount = capturesData?.pendingCount ?? 0

  const handleResolve = (captureId: string, classification: Classification) => {
    void resolveCaptureAction({
      captureId,
      classification,
      resolution: "Manual browser triage",
      rationale: "Triaged via web UI",
    })
  }

  return (
    <div className="space-y-0">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 border-b border-border/50 px-1">
        <button
          type="button"
          onClick={() => setActiveTab("knowledge")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-all border-b-2 -mb-px",
            activeTab === "knowledge"
              ? "border-foreground/60 text-foreground"
              : "border-transparent text-muted-foreground hover:text-muted-foreground",
          )}
        >
          <BookOpen className="h-3.5 w-3.5" />
          Knowledge
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("captures")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-all border-b-2 -mb-px",
            activeTab === "captures"
              ? "border-foreground/60 text-foreground"
              : "border-transparent text-muted-foreground hover:text-muted-foreground",
          )}
        >
          <InboxIcon className="h-3.5 w-3.5" />
          Captures
          {pendingCount > 0 && (
            <Badge variant="outline" className="ml-1 h-4 px-1.5 py-0 text-[10px] border-warning/30 bg-warning/10 text-warning">
              {pendingCount} pending
            </Badge>
          )}
        </button>
      </div>

      {/* Tab content */}
      <div className="p-4">
        {activeTab === "knowledge" ? (
          <KnowledgeTabContent
            data={knowledgeState.data as KnowledgeData | null}
            phase={knowledgeState.phase}
            error={knowledgeState.error}
            onRefresh={() => void loadKnowledgeData()}
          />
        ) : (
          <CapturesTabContent
            data={capturesData}
            phase={capturesState.phase}
            error={capturesState.error}
            resolvePending={resolveState.pending}
            resolveError={resolveState.lastError}
            onRefresh={() => void loadCapturesData()}
            onResolve={handleResolve}
          />
        )}
      </div>
    </div>
  )
}
