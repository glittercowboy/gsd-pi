"use client"

import { useMemo } from "react"
import { motion } from "motion/react"
import { ArrowRight, Check, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkspaceOnboardingProviderState } from "@/lib/gsd-workspace-store"
import { cn } from "@/lib/utils"

interface StepProviderProps {
  providers: WorkspaceOnboardingProviderState[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNext: () => void
  onBack: () => void
}

function capabilityBadges(provider: WorkspaceOnboardingProviderState): string[] {
  const badges: string[] = []
  if (provider.supports.apiKey) badges.push("API key")
  if (provider.supports.oauth)
    badges.push(provider.supports.oauthAvailable ? "Browser sign-in" : "OAuth unavailable")
  if (provider.supports.externalCli) badges.push("CLI auth")
  return badges
}

function configuredViaLabel(source: WorkspaceOnboardingProviderState["configuredVia"]): string {
  switch (source) {
    case "auth_file": return "Saved auth"
    case "environment": return "Environment variable"
    case "runtime": return "Runtime"
    case "external_cli": return "CLI"
    default: return "Not configured"
  }
}

/** Group providers: configured first, then recommended, then rest. */
function groupProviders(providers: WorkspaceOnboardingProviderState[]): {
  label: string
  items: WorkspaceOnboardingProviderState[]
}[] {
  const configured = providers.filter((p) => p.configured)
  const recommended = providers.filter((p) => !p.configured && p.recommended)
  const rest = providers.filter((p) => !p.configured && !p.recommended)

  const groups: { label: string; items: WorkspaceOnboardingProviderState[] }[] = []
  if (configured.length > 0) groups.push({ label: "Configured", items: configured })
  if (recommended.length > 0) groups.push({ label: "Recommended", items: recommended })
  if (rest.length > 0) groups.push({ label: "Other Providers", items: rest })
  return groups
}

export function StepProvider({ providers, selectedId, onSelect, onNext, onBack }: StepProviderProps) {
  const groups = useMemo(() => groupProviders(providers), [providers])
  const hasConfigured = providers.some((p) => p.configured)

  return (
    <div className="flex flex-col items-center">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-center"
      >
        <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Choose a provider
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Click a provider to configure it. Set up as many as you want, then continue.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.45 }}
        className="mt-8 w-full space-y-5"
      >
        {groups.map((group) => (
          <div key={group.label}>
            <div className="mb-2 px-0.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {group.label}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.items.map((provider) => {
                const selected = provider.id === selectedId
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => onSelect(provider.id)}
                    className={cn(
                      "group relative rounded-xl border px-4 py-3.5 text-left transition-all duration-200",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      "active:scale-[0.98]",
                      selected
                        ? "border-foreground/30 bg-foreground/[0.06]"
                        : "border-border/50 bg-card/50 hover:border-foreground/15 hover:bg-card/50",
                    )}
                    data-testid={`onboarding-provider-${provider.id}`}
                  >
                    {/* Radio dot */}
                    <div className="absolute right-3 top-3">
                      <div
                        className={cn(
                          "flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] transition-all duration-200",
                          selected ? "border-foreground bg-foreground" : "border-foreground/15",
                        )}
                      >
                        {selected && <Check className="h-2.5 w-2.5 text-background" strokeWidth={3} />}
                      </div>
                    </div>

                    <div className="pr-8">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{provider.label}</span>
                        {provider.recommended && (
                          <Badge variant="outline" className="border-foreground/10 bg-foreground/[0.03] text-[9px] text-muted-foreground">
                            Recommended
                          </Badge>
                        )}
                      </div>

                      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        {provider.configured ? (
                          <>
                            <ShieldCheck className="h-3 w-3 text-success/80" />
                            <span>{configuredViaLabel(provider.configuredVia)}</span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Not configured</span>
                        )}
                      </div>
                    </div>

                    <div className="mt-2.5 flex flex-wrap gap-1">
                      {capabilityBadges(provider).map((cap) => (
                        <Tooltip key={cap}>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="border-border/50 text-[10px] text-muted-foreground">
                              {cap}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            {cap === "API key"
                              ? "Enter an API key to authenticate"
                              : cap === "Browser sign-in"
                                ? "Authenticate through your browser"
                                : cap === "CLI auth"
                                  ? "Authenticated via local CLI — no API key needed"
                                  : "This auth method is not available"}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </motion.div>

      {/* Navigation — pinned inside the step */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.15, duration: 0.3 }}
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
          disabled={!hasConfigured}
          className="group gap-2 transition-transform active:scale-[0.96]"
          data-testid="onboarding-provider-continue"
        >
          Continue
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </motion.div>
    </div>
  )
}
