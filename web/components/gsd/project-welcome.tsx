"use client"

import {
  ArrowRight,
  FolderOpen,
  GitBranch,
  Package,
  FileCode,
  Sparkles,
  ArrowUpCircle,
  Folder,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ProjectDetection } from "@/lib/gsd-workspace-store"

// ─── Variant Config ─────────────────────────────────────────────────────────

interface WelcomeVariant {
  icon: React.ReactNode
  headline: string
  body: string
  detail?: string
  primaryLabel: string
  primaryCommand: string
  secondary?: {
    label: string
    action: "files-view" | "command"
    command?: string
  }
}

function getVariant(detection: ProjectDetection): WelcomeVariant {
  switch (detection.kind) {
    case "brownfield":
      return {
        icon: <FolderOpen className="h-8 w-8 text-foreground" strokeWidth={1.5} />,
        headline: "Existing project detected",
        body: "GSD will map your codebase and ask a few questions about what you want to build. From there it generates structured milestones and deliverable slices.",
        primaryLabel: "Map & Initialize",
        primaryCommand: "/gsd",
        secondary: {
          label: "Browse files first",
          action: "files-view",
        },
      }

    case "v1-legacy":
      return {
        icon: <ArrowUpCircle className="h-8 w-8 text-foreground" strokeWidth={1.5} />,
        headline: "GSD v1 project found",
        body: "This project has a .planning/ folder from an earlier GSD version. Migration converts your existing planning data into the new .gsd/ format.",
        detail: "Your original files will be preserved — migration creates the new structure alongside them.",
        primaryLabel: "Migrate to v2",
        primaryCommand: "/gsd migrate",
        secondary: {
          label: "Start fresh instead",
          action: "command",
          command: "/gsd",
        },
      }

    case "blank":
      return {
        icon: <Sparkles className="h-8 w-8 text-foreground" strokeWidth={1.5} />,
        headline: "Start a new project",
        body: "This folder is empty. GSD will ask what you want to build, then generate a structured plan — milestones broken into deliverable slices with risk-ordered execution.",
        primaryLabel: "Start Project Setup",
        primaryCommand: "/gsd",
      }

    // active-gsd and empty-gsd shouldn't reach here, but handle gracefully
    default:
      return {
        icon: <Folder className="h-8 w-8 text-foreground" strokeWidth={1.5} />,
        headline: "Set up your project",
        body: "Run the GSD wizard to get started.",
        primaryLabel: "Get Started",
        primaryCommand: "/gsd",
      }
  }
}

// ─── Signal Chips ───────────────────────────────────────────────────────────

function SignalChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground">
      {icon}
      {label}
    </span>
  )
}

function SignalChips({ signals }: { signals: ProjectDetection["signals"] }) {
  const chips: { icon: React.ReactNode; label: string }[] = []

  if (signals.hasGitRepo) {
    chips.push({ icon: <GitBranch className="h-3 w-3" />, label: "Git repository" })
  }
  if (signals.hasPackageJson) {
    chips.push({ icon: <Package className="h-3 w-3" />, label: "Node.js project" })
  }
  if (signals.fileCount > 0) {
    chips.push({
      icon: <FileCode className="h-3 w-3" />,
      label: `${signals.fileCount} file${signals.fileCount === 1 ? "" : "s"}`,
    })
  }

  if (chips.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <SignalChip key={chip.label} icon={chip.icon} label={chip.label} />
      ))}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface ProjectWelcomeProps {
  detection: ProjectDetection
  onCommand: (command: string) => void
  onSwitchView: (view: string) => void
  disabled?: boolean
}

export function ProjectWelcome({
  detection,
  onCommand,
  onSwitchView,
  disabled = false,
}: ProjectWelcomeProps) {
  const variant = getVariant(detection)
  const showSignals = detection.kind === "brownfield" || detection.kind === "v1-legacy"

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg">
        {/* Icon */}
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-card">
          {variant.icon}
        </div>

        {/* Headline */}
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          {variant.headline}
        </h2>

        {/* Body */}
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {variant.body}
        </p>

        {/* Detail note */}
        {variant.detail && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {variant.detail}
          </p>
        )}

        {/* Detected signals */}
        {showSignals && (
          <div className="mt-5">
            <SignalChips signals={detection.signals} />
          </div>
        )}

        {/* Actions */}
        <div className="mt-8 flex items-center gap-3">
          <button
            onClick={() => onCommand(variant.primaryCommand)}
            disabled={disabled}
            className={cn(
              "inline-flex items-center gap-2 rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {variant.primaryLabel}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>

          {variant.secondary && (
            <button
              onClick={() => {
                if (variant.secondary!.action === "files-view") {
                  onSwitchView("files")
                } else if (variant.secondary!.command) {
                  onCommand(variant.secondary!.command)
                }
              }}
              disabled={disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent",
                disabled && "cursor-not-allowed opacity-50",
              )}
            >
              {variant.secondary.label}
            </button>
          )}
        </div>

        {/* What happens next — for blank projects */}
        {detection.kind === "blank" && (
          <div className="mt-8 rounded-lg border border-border/50 bg-card/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              What happens next
            </p>
            <ul className="mt-2.5 space-y-2">
              {[
                "A few questions about what you're building",
                "Codebase analysis and context gathering",
                "Structured milestone and slice generation",
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* What happens next — for brownfield */}
        {detection.kind === "brownfield" && (
          <div className="mt-8 rounded-lg border border-border/50 bg-card/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              What happens next
            </p>
            <ul className="mt-2.5 space-y-2">
              {[
                "GSD scans your codebase and asks about your goals",
                "You discuss scope, constraints, and priorities",
                "A milestone with risk-ordered slices is generated",
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
