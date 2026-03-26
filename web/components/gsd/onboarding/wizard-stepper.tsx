"use client"

import { cn } from "@/lib/utils"
import { Check } from "lucide-react"

export interface WizardStep {
  id: string
  label: string
  shortLabel?: string
}

interface WizardStepperProps {
  steps: WizardStep[]
  currentIndex: number
  onStepClick?: (index: number) => void
  className?: string
}

export function WizardStepper({ steps, currentIndex, onStepClick, className }: WizardStepperProps) {
  return (
    <nav aria-label="Onboarding progress" className={cn("flex items-center gap-0", className)}>
      {steps.map((step, index) => {
        const isComplete = index < currentIndex
        const isCurrent = index === currentIndex
        const isClickable = onStepClick && index <= currentIndex

        return (
          <div key={step.id} className="flex items-center">
            {/* Step node */}
            <button
              type="button"
              onClick={() => isClickable && onStepClick(index)}
              disabled={!isClickable}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "group relative flex items-center gap-2.5 rounded-full px-1 py-1 transition-all duration-300",
                isClickable && "cursor-pointer",
                !isClickable && "cursor-default",
              )}
            >
              {/* Circle indicator */}
              <div
                className={cn(
                  "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-300",
                  isComplete && "border-foreground/80 bg-foreground/90 text-background",
                  isCurrent && "border-foreground bg-foreground text-background shadow-[0_0_12px_rgba(255,255,255,0.15)]",
                  !isComplete && !isCurrent && "border-border bg-background text-muted-foreground",
                )}
              >
                {isComplete ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                ) : (
                  <span className={cn("text-xs font-semibold tabular-nums", isCurrent && "text-background")}>
                    {index + 1}
                  </span>
                )}
              </div>

              {/* Label */}
              <span
                className={cn(
                  "hidden text-sm font-medium transition-colors duration-200 sm:inline",
                  isCurrent && "text-foreground",
                  isComplete && "text-muted-foreground",
                  !isComplete && !isCurrent && "text-muted-foreground",
                )}
              >
                {step.shortLabel ?? step.label}
              </span>
            </button>

            {/* Connector line */}
            {index < steps.length - 1 && (
              <div className="mx-1 hidden h-px w-8 sm:block lg:w-12">
                <div
                  className={cn(
                    "h-full transition-all duration-500",
                    index < currentIndex ? "bg-foreground/50" : "bg-border",
                  )}
                />
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}
