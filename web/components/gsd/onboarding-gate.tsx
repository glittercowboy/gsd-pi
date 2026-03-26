"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import Image from "next/image"
import {
  type WorkspaceOnboardingProviderState,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"
import { useDevOverrides } from "@/lib/dev-overrides"
import { useUserMode, type UserMode } from "@/lib/use-user-mode"
import { navigateToGSDView } from "@/lib/workflow-action-execution"
import { cn } from "@/lib/utils"

import { StepWelcome } from "./onboarding/step-welcome"
import { StepMode } from "./onboarding/step-mode"
import { StepProvider } from "./onboarding/step-provider"
import { StepAuthenticate } from "./onboarding/step-authenticate"
import { StepDevRoot } from "./onboarding/step-dev-root"
import { StepOptional } from "./onboarding/step-optional"
import { StepRemote } from "./onboarding/step-remote"
import { StepReady } from "./onboarding/step-ready"
import { StepProject } from "./onboarding/step-project"

// ─── Constants ──────────────────────────────────────────────────────

const WIZARD_STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "mode", label: "Mode" },
  { id: "provider", label: "Provider" },
  { id: "authenticate", label: "Auth" },
  { id: "devRoot", label: "Root" },
  { id: "optional", label: "Extras" },
  { id: "remote", label: "Remote" },
  { id: "ready", label: "Ready" },
  { id: "project", label: "Project" },
] as const

const TOTAL_STEPS = WIZARD_STEPS.length
const EMPTY_PROVIDERS: WorkspaceOnboardingProviderState[] = []

// ─── Helpers ────────────────────────────────────────────────────────

function chooseDefaultProvider(providers: WorkspaceOnboardingProviderState[]): string | null {
  const unresolvedRecommended = providers.find((p) => !p.configured && p.recommended)
  if (unresolvedRecommended) return unresolvedRecommended.id
  const unresolved = providers.find((p) => !p.configured)
  if (unresolved) return unresolved.id
  return providers[0]?.id ?? null
}

// Slide animation
const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 50 : -50, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir < 0 ? 50 : -50, opacity: 0 }),
}

// ─── Step indicator (centered row of dots with labels) ──────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            "rounded-full transition-all duration-300",
            i === current
              ? "h-1.5 w-5 bg-foreground"
              : i < current
                ? "h-1.5 w-1.5 bg-foreground/40"
                : "h-1.5 w-1.5 bg-foreground/10",
          )}
        />
      ))}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────

export function OnboardingGate() {
  const workspace = useGSDWorkspaceState()
  const {
    refreshOnboarding,
    saveApiKey,
    startProviderFlow,
    submitProviderFlowInput,
    cancelProviderFlow,
    refreshBoot,
  } = useGSDWorkspaceActions()
  const devOverrides = useDevOverrides()

  const onboarding = workspace.boot?.onboarding
  const forceVisible = devOverrides.isActive("forceOnboarding")
  const isBusy = workspace.onboardingRequestState !== "idle"

  // ─── Wizard state ───
  const [stepIndex, setStepIndex] = useState(0)
  const [direction, setDirection] = useState(0)
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [dismissedAfterSuccess, setDismissedAfterSuccess] = useState(false)
  const [userMode, setUserMode] = useUserMode()
  const [selectedMode, setSelectedMode] = useState<UserMode | null>(userMode)

  const providers = onboarding?.required.providers ?? EMPTY_PROVIDERS
  const effectiveSelectedProviderId = useMemo(() => {
    if (onboarding?.activeFlow?.providerId) return onboarding.activeFlow.providerId
    if (selectedProviderId && providers.some((p) => p.id === selectedProviderId)) return selectedProviderId
    return chooseDefaultProvider(providers)
  }, [onboarding?.activeFlow?.providerId, providers, selectedProviderId])
  const shouldHideAfterSuccess = dismissedAfterSuccess && !onboarding?.locked && !isBusy

  // Track whether auth was locked when the user arrived at step 3.
  // Auto-advance only fires when auth transitions from locked → unlocked
  // while the user is on the auth step — not when navigating back or
  // when the provider was already configured.
  const [authWasLockedOnArrival, setAuthWasLockedOnArrival] = useState(false)

  const goTo = useCallback(
    (target: number) => {
      // When arriving at auth step, snapshot the locked state
      if (target === 3 && onboarding?.locked) {
        setAuthWasLockedOnArrival(true)
      } else if (target === 3 && !onboarding?.locked) {
        // Already unlocked — don't set the flag (prevents auto-advance)
        setAuthWasLockedOnArrival(false)
      }
      setDirection(target > stepIndex ? 1 : -1)
      setStepIndex(target)
    },
    [stepIndex, onboarding?.locked],
  )

  // Auto-advance past auth only when it just succeeded during this visit
  useEffect(() => {
    if (!onboarding) return
    if (stepIndex !== 3) return
    if (!authWasLockedOnArrival) return
    const isUnlocked = !onboarding.locked
    const bridgeDone = onboarding.bridgeAuthRefresh.phase === "succeeded" || onboarding.bridgeAuthRefresh.phase === "idle"
    if (!isUnlocked || !bridgeDone) return
    const t = window.setTimeout(() => goTo(4), 0)
    return () => window.clearTimeout(t)
  }, [onboarding, goTo, stepIndex, authWasLockedOnArrival])

  const selectedProvider = useMemo(() => {
    return providers.find((p) => p.id === effectiveSelectedProviderId) ?? null
  }, [effectiveSelectedProviderId, providers])


  // ─── Gate check ───
  if (!onboarding) return null
  const onboardingSettled =
    !onboarding.locked ||
    (onboarding.lastValidation?.status === "succeeded" &&
      (onboarding.bridgeAuthRefresh.phase === "succeeded" || onboarding.bridgeAuthRefresh.phase === "idle"))
  if (!forceVisible && (onboardingSettled || shouldHideAfterSuccess)) return null

  const stepLabel = WIZARD_STEPS[stepIndex]?.label ?? ""

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex flex-col bg-background" data-testid="onboarding-gate">
      {/* Header */}
      <header className="relative z-10 flex h-12 shrink-0 items-center justify-between px-5 md:px-8">
        {/* Left — logo */}
        <div className="flex w-24 items-center gap-2">
          <Image src="/logo-white.svg" alt="GSD" width={57} height={16} className="hidden h-4 w-auto dark:block" />
          <Image src="/logo-black.svg" alt="GSD" width={57} height={16} className="h-4 w-auto dark:hidden" />
        </div>

        {/* Center — step indicator */}
        <div className="absolute inset-x-0 flex justify-center pointer-events-none">
          <div className="pointer-events-auto">
            <StepIndicator current={stepIndex} total={TOTAL_STEPS} />
          </div>
        </div>

        {/* Right — step label */}
        <div className="flex w-24 justify-end">
          <span className="text-xs text-muted-foreground">{stepLabel}</span>
        </div>
      </header>

      {/* Thin progress — hidden when not needed */}

      {/* Content — full remaining height, scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-5 py-10 md:px-8 md:py-16">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={stepIndex}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "spring", stiffness: 400, damping: 35, opacity: { duration: 0.15 } }}
            >
              {stepIndex === 0 && <StepWelcome onNext={() => goTo(1)} />}

              {stepIndex === 1 && (
                <StepMode
                  selected={selectedMode}
                  onSelect={(mode) => { setSelectedMode(mode); setUserMode(mode) }}
                  onNext={() => goTo(2)}
                  onBack={() => goTo(0)}
                />
              )}

              {stepIndex === 2 && (
                <StepProvider
                  providers={onboarding.required.providers}
                  selectedId={effectiveSelectedProviderId}
                  onSelect={(id) => {
                    setSelectedProviderId(id)
                    goTo(3)
                  }}
                  onNext={() => goTo(4)}
                  onBack={() => goTo(1)}
                />
              )}

              {stepIndex === 3 && selectedProvider && (
                <StepAuthenticate
                  provider={selectedProvider}
                  activeFlow={onboarding.activeFlow}
                  lastValidation={onboarding.lastValidation}
                  requestState={workspace.onboardingRequestState}
                  requestProviderId={workspace.onboardingRequestProviderId}
                  onSaveApiKey={async (pid, key) => {
                    const next = await saveApiKey(pid, key)
                    const settled = Boolean(
                      next && !next.locked &&
                      (next.bridgeAuthRefresh.phase === "succeeded" || next.bridgeAuthRefresh.phase === "idle"),
                    )
                    if (settled) { setDismissedAfterSuccess(true); void refreshBoot() }
                    return next
                  }}
                  onStartFlow={(pid) => void startProviderFlow(pid)}
                  onSubmitFlowInput={(fid, input) => void submitProviderFlowInput(fid, input)}
                  onCancelFlow={(fid) => void cancelProviderFlow(fid)}
                  onBack={() => goTo(2)}
                  onNext={() => goTo(2)}
                  bridgeRefreshPhase={onboarding.bridgeAuthRefresh.phase}
                  bridgeRefreshError={onboarding.bridgeAuthRefresh.error}
                />
              )}

              {stepIndex === 4 && <StepDevRoot onBack={() => goTo(2)} onNext={() => goTo(5)} />}

              {stepIndex === 5 && (
                <StepOptional
                  sections={onboarding.optional.sections}
                  onBack={() => goTo(4)}
                  onNext={() => goTo(6)}
                />
              )}

              {stepIndex === 6 && (
                <StepRemote
                  onBack={() => goTo(5)}
                  onNext={() => goTo(7)}
                />
              )}

              {stepIndex === 7 && (
                <StepReady
                  providerLabel={
                    onboarding.lastValidation?.providerId
                      ? onboarding.required.providers.find((p) => p.id === onboarding.lastValidation?.providerId)?.label ?? "Provider"
                      : "Provider"
                  }
                  onFinish={() => goTo(8)}
                />
              )}

              {stepIndex === 8 && (
                <StepProject
                  onBack={() => goTo(7)}
                  onBeforeSwitch={() => {
                    // Disarm the gate BEFORE switchProject triggers a store remount
                    if (devOverrides.isActive("forceOnboarding")) {
                      devOverrides.toggle("forceOnboarding")
                    }
                    setDismissedAfterSuccess(true)
                  }}
                  onFinish={() => {
                    const mode = selectedMode ?? userMode
                    navigateToGSDView("dashboard")
                    void refreshBoot()
                  }}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
