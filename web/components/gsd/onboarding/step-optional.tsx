"use client"

import { motion } from "motion/react"
import { ArrowRight, Check, CircleDashed } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkspaceOnboardingOptionalSectionState } from "@/lib/gsd-workspace-store"
import { cn } from "@/lib/utils"

interface StepOptionalProps {
  sections: WorkspaceOnboardingOptionalSectionState[]
  onBack: () => void
  onNext: () => void
}

export function StepOptional({ sections, onBack, onNext }: StepOptionalProps) {
  // Remote questions has its own dedicated step — don't show it here
  const filtered = sections.filter((s) => s.id !== "remote_questions")
  const configuredCount = filtered.filter((s) => s.configured).length

  return (
    <div className="flex flex-col items-center">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-center"
      >
        <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Integrations
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Optional tools. Nothing here blocks the workspace — configure later from settings.
        </p>
      </motion.div>

      {configuredCount > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.08, duration: 0.3 }}
          className="mt-4"
        >
          <span className="text-xs text-muted-foreground">
            <span className="font-medium text-success">{configuredCount}</span>
            {" of "}
            {filtered.length} configured
          </span>
        </motion.div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.45 }}
        className="mt-8 w-full space-y-2"
      >
        {filtered.map((section) => (
          <div
            key={section.id}
            className={cn(
              "flex items-start gap-3.5 rounded-xl border px-4 py-3.5 transition-colors",
              section.configured
                ? "border-success/15 bg-success/[0.03]"
                : "border-border/50 bg-card/50",
            )}
            data-testid={`onboarding-optional-${section.id}`}
          >
            {/* Status dot */}
            <div
              className={cn(
                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                section.configured
                  ? "bg-success/15 text-success"
                  : "bg-foreground/[0.05] text-muted-foreground",
              )}
            >
              {section.configured ? (
                <Check className="h-3 w-3" strokeWidth={3} />
              ) : (
                <CircleDashed className="h-3 w-3" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{section.label}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        section.configured
                          ? "border-success/15 text-success/70"
                          : "border-border/50 text-muted-foreground",
                      )}
                    >
                      {section.configured ? "Ready" : "Skipped"}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    {section.configured
                      ? "This integration is configured and active"
                      : "You can set this up later from workspace settings"}
                  </TooltipContent>
                </Tooltip>
              </div>

              {section.configuredItems.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {section.configuredItems.map((item) => (
                    <Badge
                      key={item}
                      variant="outline"
                      className="border-border/50 text-[10px] text-muted-foreground"
                    >
                      {item}
                    </Badge>
                  ))}
                </div>
              )}

              {section.configuredItems.length === 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Not configured — add later from settings.
                </p>
              )}
            </div>
          </div>
        ))}
      </motion.div>

      {/* Navigation */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.18, duration: 0.3 }}
        className="mt-8 flex w-full items-center justify-between"
      >
        <Button
          variant="ghost"
          onClick={onBack}
          className="text-muted-foreground transition-transform active:scale-[0.96]"
        >
          Back
        </Button>
        <Button
          onClick={onNext}
          className="group gap-2 transition-transform active:scale-[0.96]"
          data-testid="onboarding-optional-continue"
        >
          Continue
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </motion.div>
    </div>
  )
}
