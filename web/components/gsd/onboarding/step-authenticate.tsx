"use client"

import { useEffect, useState } from "react"
import { motion, AnimatePresence } from "motion/react"
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import type {
  WorkspaceOnboardingFlowState,
  WorkspaceOnboardingProviderState,
  WorkspaceOnboardingRequestState,
  WorkspaceOnboardingState,
  WorkspaceOnboardingValidationResult,
} from "@/lib/gsd-workspace-store"
import { cn } from "@/lib/utils"

// ─── Error parsing ──────────────────────────────────────────────────

function parseValidationError(raw: string | null | undefined): { title: string; detail: string | null } {
  if (!raw) return { title: "Validation failed", detail: null }

  const jsonInStatusMatch = raw.match(/^\d{3}\s+[^:]+:\s*(.+)$/s)
  const jsonCandidate = jsonInStatusMatch?.[1] ?? raw

  try {
    const parsed = JSON.parse(jsonCandidate)
    if (typeof parsed === "object" && parsed !== null) {
      const message = parsed.error_details?.message ?? parsed.error?.message ?? parsed.message ?? parsed.error ?? null
      if (typeof message === "string" && message.length > 0) {
        if (/subscription.*(ended|expired|cancelled)/i.test(message))
          return { title: "Subscription expired", detail: message.replace(/\.$/, "") + ". Check your plan status with this provider." }
        if (/rate.limit/i.test(message))
          return { title: "Rate limited", detail: "Too many requests. Wait a moment and try again." }
        if (/invalid.*key|invalid.*token|incorrect.*key/i.test(message))
          return { title: "Invalid credentials", detail: "The API key was rejected. Double-check and try again." }
        if (/quota|billing|payment/i.test(message))
          return { title: "Billing issue", detail: message }
        return { title: "Provider error", detail: message }
      }
    }
  } catch { /* not JSON */ }

  if (/^401\b/i.test(raw)) return { title: "Unauthorized", detail: "The credentials were rejected. Double-check your API key." }
  if (/^403\b/i.test(raw)) return { title: "Access denied", detail: "Your account doesn't have access. Check your subscription or permissions." }
  if (/^429\b/i.test(raw)) return { title: "Rate limited", detail: "Too many requests. Wait a moment and try again." }
  if (/^5\d{2}\b/i.test(raw)) return { title: "Server error", detail: "The provider returned an error. Try again in a minute." }

  return { title: "Validation failed", detail: raw.length > 200 ? raw.slice(0, 200) + "…" : raw }
}

/** Extract a device code from instructions/prompt text */
function extractDeviceCode(flow: WorkspaceOnboardingFlowState): string | null {
  const sources = [flow.prompt?.message, flow.auth?.instructions].filter(Boolean)
  for (const src of sources) {
    const match = src?.match(/(?:code|Code)[:\s]+([A-Z0-9]{4}[-–][A-Z0-9]{4})/i)
    if (match) return match[1]
  }
  return null
}

// ─── Component ──────────────────────────────────────────────────────

interface StepAuthenticateProps {
  provider: WorkspaceOnboardingProviderState
  activeFlow: WorkspaceOnboardingFlowState | null
  lastValidation: WorkspaceOnboardingValidationResult | null
  requestState: WorkspaceOnboardingRequestState
  requestProviderId: string | null
  onSaveApiKey: (providerId: string, apiKey: string) => Promise<WorkspaceOnboardingState | null>
  onStartFlow: (providerId: string) => void
  onSubmitFlowInput: (flowId: string, input: string) => void
  onCancelFlow: (flowId: string) => void
  onBack: () => void
  onNext: () => void
  bridgeRefreshPhase: "idle" | "pending" | "succeeded" | "failed"
  bridgeRefreshError: string | null
}

export function StepAuthenticate({
  provider,
  activeFlow,
  lastValidation,
  requestState,
  requestProviderId,
  onSaveApiKey,
  onStartFlow,
  onSubmitFlowInput,
  onCancelFlow,
  onBack,
  onNext,
  bridgeRefreshPhase,
  bridgeRefreshError,
}: StepAuthenticateProps) {
  const [apiKey, setApiKey] = useState("")
  const [flowInput, setFlowInput] = useState("")
  const [copied, setCopied] = useState(false)

  const isBusy = requestState !== "idle"
  const isThisProviderBusy = requestProviderId === provider.id && isBusy
  const isValidated = lastValidation?.status === "succeeded" && lastValidation.providerId === provider.id
  const isBridgeDone = bridgeRefreshPhase === "succeeded" || bridgeRefreshPhase === "idle"
  const canProceed = isValidated && isBridgeDone
  const validationFailed = lastValidation?.status === "failed" && lastValidation.providerId === provider.id
  const parsedError = validationFailed ? parseValidationError(lastValidation.message) : null

  const isOAuthOnly = !provider.supports.apiKey && provider.supports.oauth
  const hasOAuth = provider.supports.oauth && provider.supports.oauthAvailable
  const hasApiKey = provider.supports.apiKey

  // Active flow state
  const flowActive = activeFlow && activeFlow.providerId === provider.id && !canProceed
  const flowFailed = flowActive && activeFlow.status === "failed"
  const flowRunning = flowActive && (activeFlow.status === "running" || activeFlow.status === "awaiting_browser_auth")
  const flowWaiting = flowActive && activeFlow.status === "awaiting_input"
  const deviceCode = flowActive ? extractDeviceCode(activeFlow) : null

  useEffect(() => {
    if (lastValidation?.status !== "succeeded") return
    const t = window.setTimeout(() => setApiKey(""), 0)
    return () => window.clearTimeout(t)
  }, [lastValidation?.checkedAt, lastValidation?.status])

  useEffect(() => {
    const t = window.setTimeout(() => setFlowInput(""), 0)
    return () => window.clearTimeout(t)
  }, [activeFlow?.flowId])

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(t)
  }, [copied])

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code).then(() => setCopied(true)).catch(() => {})
  }

  return (
    <div className="flex flex-col items-center">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-center"
      >
        <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Connect {provider.label}
        </h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {canProceed
            ? "Authenticated and ready to go."
            : hasApiKey && hasOAuth
              ? "Paste an API key or sign in through your browser."
              : hasApiKey
                ? "Paste your API key to authenticate."
                : "Sign in through your browser to authenticate."}
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.45 }}
        className="mt-8 w-full max-w-md space-y-4"
      >
        {/* ─── Success state ─── */}
        <AnimatePresence>
          {canProceed && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", duration: 0.4, bounce: 0 }}
              className="flex flex-col items-center gap-3 rounded-xl border border-success/15 bg-success/[0.04] px-6 py-6 text-center"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/15">
                <ShieldCheck className="h-5 w-5 text-success" />
              </div>
              <div className="text-sm font-medium text-foreground">{provider.label} authenticated</div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Validation error ─── */}
        {validationFailed && parsedError && (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/[0.06] px-4 py-3 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <div className="font-medium text-destructive">{parsedError.title}</div>
              {parsedError.detail && <div className="mt-0.5 text-muted-foreground">{parsedError.detail}</div>}
            </div>
          </div>
        )}

        {/* ─── Bridge refresh ─── */}
        {bridgeRefreshPhase === "pending" && (
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-xl border border-foreground/10 bg-foreground/[0.03] px-4 py-3 text-sm text-foreground/80">
              <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
              Connecting to provider…
            </div>
            <Progress value={66} className="h-1" />
          </div>
        )}

        {bridgeRefreshPhase === "failed" && bridgeRefreshError && (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/[0.06] px-4 py-3 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <div className="font-medium text-destructive">Connection failed</div>
              <div className="mt-0.5 text-muted-foreground">{bridgeRefreshError}</div>
            </div>
          </div>
        )}

        {/* ─── API key form ─── */}
        {hasApiKey && !canProceed && (
          <div className="space-y-3 rounded-xl border border-border/50 bg-card/50 p-4">
            <div className="text-sm font-medium text-foreground">API key</div>
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!apiKey.trim()) return
                const next = await onSaveApiKey(provider.id, apiKey)
                if (next && !next.locked && (next.bridgeAuthRefresh.phase === "succeeded" || next.bridgeAuthRefresh.phase === "idle")) {
                  onNext()
                }
              }}
            >
              <Input
                data-testid="onboarding-api-key-input"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={`Paste your ${provider.label} API key`}
                disabled={isBusy}
                className="font-mono text-sm"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  disabled={!apiKey.trim() || isBusy}
                  className="gap-2 transition-transform active:scale-[0.96]"
                  data-testid="onboarding-save-api-key"
                >
                  {isThisProviderBusy && requestState === "saving_api_key" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  Validate & save
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* ─── OAuth section ─── */}
        {hasOAuth && !canProceed && (
          <div className="space-y-3">
            {/* Divider between API key and OAuth */}
            {hasApiKey && (
              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-border/50" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="h-px flex-1 bg-border/50" />
              </div>
            )}

            {/* ─── No active flow: show start button ─── */}
            {!flowActive && (
              <div className="rounded-xl border border-border/50 bg-card/50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">Browser sign-in</div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Opens a new tab to authenticate with {provider.label}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    disabled={isBusy}
                    onClick={() => onStartFlow(provider.id)}
                    className="shrink-0 gap-2 transition-transform active:scale-[0.96]"
                    data-testid="onboarding-start-provider-flow"
                  >
                    {isThisProviderBusy && requestState === "starting_provider_flow" ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4" />
                    )}
                    Sign in
                  </Button>
                </div>
              </div>
            )}

            {/* ─── Active flow: device code UX ─── */}
            {flowActive && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="rounded-xl border border-border/50 bg-card/50 p-4 space-y-4"
                data-testid="onboarding-active-flow"
              >
                {/* Device code — big and prominent */}
                {deviceCode && (
                  <div className="flex flex-col items-center gap-3 py-2">
                    <div className="text-xs text-muted-foreground">Enter this code on the sign-in page</div>
                    <button
                      type="button"
                      onClick={() => copyCode(deviceCode)}
                      className="group flex items-center gap-3 rounded-lg border border-border bg-background/50 px-5 py-3 transition-colors hover:border-foreground/20 active:scale-[0.98]"
                    >
                      <span className="font-mono text-2xl font-bold tracking-[0.15em] text-foreground">
                        {deviceCode}
                      </span>
                      <span className="text-muted-foreground transition-colors group-hover:text-muted-foreground">
                        {copied ? (
                          <CheckCircle2 className="h-4 w-4 text-success" />
                        ) : (
                          <ClipboardCopy className="h-4 w-4" />
                        )}
                      </span>
                    </button>
                    <div className="text-[11px] text-muted-foreground">
                      {copied ? "Copied!" : "Click to copy"}
                    </div>
                  </div>
                )}

                {/* Instructions text (when no device code extracted) */}
                {!deviceCode && activeFlow.auth?.instructions && (
                  <p className="text-sm text-muted-foreground">{activeFlow.auth.instructions}</p>
                )}

                {/* Open sign-in page button */}
                {activeFlow.auth?.url && (
                  <Button asChild className="w-full gap-2 transition-transform active:scale-[0.96]">
                    <a href={activeFlow.auth.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      Open sign-in page
                    </a>
                  </Button>
                )}

                {/* Status indicator */}
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    {flowRunning && (
                      <>
                        <LoaderCircle className="h-3 w-3 animate-spin" />
                        <span>Waiting for authentication…</span>
                      </>
                    )}
                    {flowFailed && (
                      <>
                        <XCircle className="h-3 w-3 text-destructive" />
                        <span className="text-destructive">Sign-in failed or timed out</span>
                      </>
                    )}
                    {flowWaiting && !deviceCode && (
                      <>
                        <LoaderCircle className="h-3 w-3 animate-spin" />
                        <span>Waiting for input…</span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {flowFailed && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onStartFlow(provider.id)}
                        disabled={isBusy}
                        className="h-7 gap-1.5 text-xs text-muted-foreground"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Retry
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onCancelFlow(activeFlow.flowId)}
                      disabled={isBusy}
                      className="h-7 text-xs text-muted-foreground"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>

                {/* Generic prompt input (non-device-code) */}
                {activeFlow.prompt && !deviceCode && (
                  <form
                    className="space-y-2 border-t border-border/50 pt-3"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (!activeFlow.prompt?.allowEmpty && !flowInput.trim()) return
                      onSubmitFlowInput(activeFlow.flowId, flowInput)
                    }}
                  >
                    <div className="text-xs text-muted-foreground">{activeFlow.prompt.message}</div>
                    <div className="flex gap-2">
                      <Input
                        data-testid="onboarding-flow-input"
                        value={flowInput}
                        onChange={(e) => setFlowInput(e.target.value)}
                        placeholder={activeFlow.prompt.placeholder || "Enter value"}
                        disabled={isBusy}
                        className="text-sm"
                      />
                      <Button
                        type="submit"
                        disabled={isBusy || (!activeFlow.prompt.allowEmpty && !flowInput.trim())}
                        className="shrink-0 transition-transform active:scale-[0.96]"
                      >
                        {requestState === "submitting_provider_flow_input" ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          "Submit"
                        )}
                      </Button>
                    </div>
                  </form>
                )}

                {/* Progress messages */}
                {activeFlow.progress.length > 0 && (
                  <div className="space-y-1 border-t border-border/50 pt-3">
                    {activeFlow.progress.map((message, i) => (
                      <div key={`${activeFlow.flowId}-${i}`} className="text-xs text-muted-foreground">
                        {message}
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </div>
        )}

        {/* OAuth unavailable */}
        {provider.supports.oauth && !provider.supports.oauthAvailable && !hasApiKey && (
          <div className="rounded-xl border border-border/50 bg-card/50 px-4 py-3.5 text-sm text-muted-foreground">
            Browser sign-in is not available in this runtime. Go back and choose a provider with API-key support.
          </div>
        )}
      </motion.div>

      {/* Navigation */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.15, duration: 0.3 }}
        className="mt-8 flex w-full max-w-md items-center justify-between"
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
          disabled={!canProceed}
          className="group gap-2 transition-transform active:scale-[0.96]"
          data-testid="onboarding-auth-continue"
        >
          Configure another provider
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </motion.div>
    </div>
  )
}
