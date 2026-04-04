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
import { useTranslations } from "next-intl"

// ─── Variant Config ─────────────────────────────────────────────────────────

type VariantNs = "existing" | "legacy" | "empty" | "fallback"

type WelcomeVariantConfig = {
  icon: React.ReactNode
  ns: VariantNs
  primaryCommand: string
  secondary?: {
    action: "files-view" | "command"
    command?: string
  }
}

function getVariantConfig(detection: ProjectDetection): WelcomeVariantConfig {
  switch (detection.kind) {
    case "brownfield":
      return {
        icon: <FolderOpen className="h-8 w-8 text-foreground" strokeWidth={1.5} />,
        ns: "existing",
        primaryCommand: "/gsd",
        secondary: {
          action: "files-view",
        },
      }

    case "v1-legacy":
      return {
        icon: <ArrowUpCircle className="h-8 w-8 text-foreground" strokeWidth={1.5} />,
        ns: "legacy",
        primaryCommand: "/gsd migrate",
        secondary: {
          action: "command",
          command: "/gsd",
        },
      }

    case "blank":
      return {
        icon: <Sparkles className="h-8 w-8 text-foreground" strokeWidth={1.5} />,
        ns: "empty",
        primaryCommand: "/gsd",
      }

    // active-gsd and empty-gsd shouldn't reach here, but handle gracefully
    default:
      return {
        icon: <Folder className="h-8 w-8 text-foreground" strokeWidth={1.5} />,
        ns: "fallback",
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

function SignalChips({ signals, fileCountLabel }: { signals: ProjectDetection["signals"]; fileCountLabel: string }) {
  const t = useTranslations("projectWelcome.chip")
  const chips: { icon: React.ReactNode; label: string }[] = []

  if (signals.hasGitRepo) {
    chips.push({ icon: <GitBranch className="h-3 w-3" />, label: t("gitRepo") })
  }
  if (signals.hasPackageJson) {
    chips.push({ icon: <Package className="h-3 w-3" />, label: t("nodejs") })
  }
  if (signals.fileCount > 0) {
    chips.push({
      icon: <FileCode className="h-3 w-3" />,
      label: fileCountLabel,
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
  const t = useTranslations("projectWelcome")
  const config = getVariantConfig(detection)
  const showSignals = detection.kind === "brownfield" || detection.kind === "v1-legacy"
  const fileCountLabel = t("labels.fileCount", { count: detection.signals.fileCount })
  const whatsNextKind: "blank" | "brownfield" | null =
    detection.kind === "blank" || detection.kind === "brownfield" ? detection.kind : null

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg">
        {/* Icon */}
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-card">
          {config.icon}
        </div>

        {/* Headline */}
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          {t(`${config.ns}.heading`)}
        </h2>

        {/* Body */}
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {t(`${config.ns}.description`)}
        </p>

        {/* Detail note — legacy variant only */}
        {config.ns === "legacy" && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t(`${config.ns}.detail`)}
          </p>
        )}

        {/* Detected signals */}
        {showSignals && (
          <div className="mt-5">
            <SignalChips signals={detection.signals} fileCountLabel={fileCountLabel} />
          </div>
        )}

        {/* Actions */}
        <div className="mt-8 flex items-center gap-3">
          <button
            onClick={() => onCommand(config.primaryCommand)}
            disabled={disabled}
            className={cn(
              "inline-flex items-center gap-2 rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {t(`${config.ns}.primary`)}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>

          {config.secondary && (
            <button
              onClick={() => {
                if (config.secondary!.action === "files-view") {
                  onSwitchView("files")
                } else if (config.secondary!.command) {
                  onCommand(config.secondary!.command)
                }
              }}
              disabled={disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent",
                disabled && "cursor-not-allowed opacity-50",
              )}
            >
              {t(`${config.ns}.secondary`)}
            </button>
          )}
        </div>

        {/* What happens next — for blank and brownfield projects */}
        {whatsNextKind && (
          <div className="mt-8 rounded-lg border border-border/50 bg-card/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t("whatsNext.heading")}
            </p>
            <ul className="mt-2.5 space-y-2">
              {(["1", "2", "3"] as const).map((key) => (
                <li key={key} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-medium text-muted-foreground">
                    {Number(key)}
                  </span>
                  {t(`whatsNext.${whatsNextKind}.${key}`)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
