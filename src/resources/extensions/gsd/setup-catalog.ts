// GSD — Setup catalog (single source of truth for onboarding steps + provider sub-views)
//
// Re-exports filtered views over PROVIDER_REGISTRY (key-manager.ts) and owns the
// canonical ONBOARDING_STEPS list. Consumers (CLI wizard, /gsd setup hub,
// onboarding handler, web alignment) all read from here so adding a step or
// provider lands in one place. Keep this module thin: no behavior beyond
// filters + lookup helpers, so it stays cycle-safe even though it depends on
// key-manager for the provider catalog.

import { PROVIDER_REGISTRY, type ProviderInfo } from "./key-manager.js"

export type OnboardingStepId =
  | "llm"
  | "model"
  | "search"
  | "remote"
  | "tool-keys"
  | "prefs"
  | "skills"
  | "doctor"
  | "project"

export interface OnboardingStepDef {
  id: OnboardingStepId
  label: string
  /** Required steps gate the "complete" flag. Skipped required steps mark the wizard incomplete. */
  required: boolean
  /** Short description shown in /gsd setup status hub. */
  hint: string
}

/**
 * Canonical ordered list of onboarding steps.
 *
 * To add a new step:
 *   1. Append here (or insert at the right position).
 *   2. Bump FLOW_VERSION in onboarding-state.ts so existing users get re-prompted.
 *   3. Wire its CLI runner in src/onboarding.ts (and handlers/onboarding.ts for --step).
 */
export const ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  { id: "llm",       label: "LLM provider & auth",      required: true,  hint: "Sign in or paste an API key" },
  { id: "model",     label: "Default model",            required: false, hint: "Pick a default model for the chosen provider" },
  { id: "search",    label: "Web search provider",      required: false, hint: "Brave, Tavily, or Anthropic built-in" },
  { id: "remote",    label: "Remote questions",         required: false, hint: "Discord / Slack / Telegram notifications" },
  { id: "tool-keys", label: "Tool API keys",            required: false, hint: "Context7, Jina, Groq voice, etc." },
  { id: "prefs",     label: "Global preferences",       required: false, hint: "Mode, profile, notifications" },
  { id: "skills",    label: "Skills install",           required: false, hint: "Browse and install skill plugins" },
  { id: "doctor",    label: "Validate setup",           required: false, hint: "Run provider doctor checks" },
  { id: "project",   label: "Project init",             required: false, hint: "Bootstrap .gsd/ in this repo" },
]

const STEP_INDEX = new Map(ONBOARDING_STEPS.map((s, i) => [s.id, i]))

export function getStep(id: string): OnboardingStepDef | undefined {
  const idx = STEP_INDEX.get(id as OnboardingStepId)
  return idx === undefined ? undefined : ONBOARDING_STEPS[idx]
}

export function isValidStepId(id: string): id is OnboardingStepId {
  return STEP_INDEX.has(id as OnboardingStepId)
}

/**
 * Given a possibly-stale resume point, return the nearest next step that is
 * still defined in the catalog. Falls back to the first step.
 */
export function nearestResumeStep(lastResumePoint: string | null, completedSteps: string[]): OnboardingStepId {
  const completed = new Set(completedSteps)
  // First incomplete step at or after the lastResumePoint
  let startIdx = 0
  if (lastResumePoint && STEP_INDEX.has(lastResumePoint as OnboardingStepId)) {
    startIdx = STEP_INDEX.get(lastResumePoint as OnboardingStepId) ?? 0
  }
  for (let i = startIdx; i < ONBOARDING_STEPS.length; i++) {
    if (!completed.has(ONBOARDING_STEPS[i].id)) return ONBOARDING_STEPS[i].id
  }
  // Everything from the resume point is complete — try from the start
  for (const step of ONBOARDING_STEPS) {
    if (!completed.has(step.id)) return step.id
  }
  return ONBOARDING_STEPS[0].id
}

// ─── Provider catalog views ───────────────────────────────────────────────────

export function getLlmProviders(): ProviderInfo[] {
  return PROVIDER_REGISTRY.filter(p => p.category === "llm")
}

export function getToolProviders(): ProviderInfo[] {
  return PROVIDER_REGISTRY.filter(p => p.category === "tool")
}

export function getSearchProviders(): ProviderInfo[] {
  return PROVIDER_REGISTRY.filter(p => p.category === "search")
}

export function getRemoteProviders(): ProviderInfo[] {
  return PROVIDER_REGISTRY.filter(p => p.category === "remote")
}

/** Provider IDs that count as "the user has an LLM configured" for shouldRunOnboarding. */
export function getLlmProviderIds(): string[] {
  return Array.from(new Set([...getLlmProviders().map(p => p.id), "claude-code"]))
}
