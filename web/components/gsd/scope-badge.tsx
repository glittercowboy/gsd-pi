"use client"

import { cn } from "@/lib/utils"

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

type PhaseTone = "success" | "active" | "warning" | "muted" | "info"

function phasePresentation(phase: string): { label: string; tone: PhaseTone } {
  switch (phase) {
    case "complete":
    case "completed":
      return { label: "Complete", tone: "success" }
    case "executing":
      return { label: "Executing", tone: "active" }
    case "in-progress":
      return { label: "In Progress", tone: "active" }
    case "planning":
      return { label: "Planning", tone: "info" }
    case "pre-planning":
      return { label: "Pre-planning", tone: "muted" }
    case "researching":
      return { label: "Researching", tone: "info" }
    case "refining":
      return { label: "Refining", tone: "info" }
    case "summarizing":
      return { label: "Summarizing", tone: "info" }
    case "verifying":
      return { label: "Verifying", tone: "info" }
    case "blocked":
      return { label: "Blocked", tone: "warning" }
    case "paused":
      return { label: "Paused", tone: "warning" }
    case "needs-discussion":
      return { label: "Discussion", tone: "warning" }
    case "validating-milestone":
      return { label: "Validating", tone: "info" }
    case "replanning-slice":
      return { label: "Replanning", tone: "info" }
    case "escalating-task":
      return { label: "Escalating", tone: "warning" }
    case "completing-milestone":
      return { label: "Completing", tone: "info" }
    case "evaluating-gates":
      return { label: "Evaluating Gates", tone: "info" }
    default:
      return { label: phase, tone: "muted" }
  }
}

const tonePill: Record<PhaseTone, string> = {
  success: "bg-success/15 text-success",
  active: "bg-primary/15 text-primary",
  warning: "bg-warning/15 text-warning",
  info: "bg-info/15 text-info",
  muted: "bg-muted text-muted-foreground",
}

const toneDot: Record<PhaseTone, string> = {
  success: "bg-success",
  active: "bg-primary",
  warning: "bg-warning",
  info: "bg-info",
  muted: "bg-muted-foreground/50",
}

/**
 * Strip leading zeros from GSD IDs: M002 → M2, S01 → S1, T03 → T3.
 * Handles compound paths like "M001/S02/T03" → "M1/S2/T3".
 */
function normalizeScopeId(raw: string): string {
  return raw.replace(/([MST])0*(\d+)/g, "$1$2")
}

/**
 * Parse a scope label like "M002 — completed" into { scopeId, phase }.
 * Also handles bare IDs like "M002" (from auto mode).
 */
function parseScopeLabel(label: string): { scopeId: string; phase: string | null } {
  const m = label.match(/^(.+?)\s*—\s*(.+)$/)
  if (m) return { scopeId: normalizeScopeId(m[1].trim()), phase: m[2].trim() }
  return { scopeId: normalizeScopeId(label.trim()), phase: null }
}

/* ─── Components ───────────────────────────────────────────────────────────── */

interface ScopeBadgeProps {
  /** Raw scope label, e.g. "M002 — completed", "M001/S02/T03 — executing", or just "M002" */
  label: string
  /** Size variant */
  size?: "sm" | "md"
  className?: string
}

/**
 * Renders a scope label as: M002 [Complete]
 * The scope ID stays as-is (compact), phase gets a small colored pill.
 */
export function ScopeBadge({ label, size = "md", className }: ScopeBadgeProps) {
  const { scopeId, phase } = parseScopeLabel(label)

  if (scopeId === "Project scope pending") {
    return <span className={cn("text-muted-foreground", sizeText(size), className)}>Scope pending…</span>
  }

  const phaseInfo = phase ? phasePresentation(phase) : null

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className={cn("font-semibold tracking-tight", sizeValue(size))}>
        {scopeId}
      </span>
      {phaseInfo && (
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full px-2 font-medium leading-snug",
            tonePill[phaseInfo.tone],
            sizeText(size),
            sizePy(size),
          )}
        >
          {phaseInfo.label}
        </span>
      )}
    </span>
  )
}

function sizeText(size: "sm" | "md") {
  return size === "sm" ? "text-[10px]" : "text-[11px]"
}

function sizeValue(size: "sm" | "md") {
  return size === "sm" ? "text-sm" : "text-lg"
}

function sizePy(size: "sm" | "md") {
  return size === "sm" ? "py-px" : "py-0.5"
}

/**
 * Inline variant for the status bar — renders: ● M002 · Complete
 */
export function ScopeBadgeInline({ label, className }: { label: string; className?: string }) {
  const { scopeId, phase } = parseScopeLabel(label)

  if (scopeId === "Project scope pending") {
    return <span className={cn("text-muted-foreground", className)}>Scope pending…</span>
  }

  const phaseInfo = phase ? phasePresentation(phase) : null
  const dotColor = phaseInfo ? toneDot[phaseInfo.tone] : "bg-muted-foreground/50"

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColor)} />
      <span>{scopeId}</span>
      {phaseInfo && (
        <>
          <span className="text-border">·</span>
          <span>{phaseInfo.label}</span>
        </>
      )}
    </span>
  )
}
