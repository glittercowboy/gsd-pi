// GSD — /gsd onboarding command handler (re-entry hub)
//
// The first-run wizard in src/onboarding.ts uses @clack/prompts and takes over
// raw stdin. Running it from inside the pi-coding-agent TUI wedges the TUI
// (clack leaves stdin paused + cooked, pi-tui's data handler then receives no
// keypresses). So re-entry cannot replay the clack wizard — instead it routes
// to a setup hub built from ctx.ui.select, which the TUI owns.
//
// Clack-only steps (llm/search/remote/tool-keys via the first-run wizard) are
// surfaced as notifications pointing the user at the canonical per-step
// commands (/login, /gsd keys, /gsd remote) that are already ctx.ui-safe.

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent"
import {
  ONBOARDING_STEPS,
  isValidStepId,
  type OnboardingStepId,
} from "../../setup-catalog.js"
import {
  isOnboardingComplete,
  readOnboardingRecord,
  resetOnboarding,
} from "../../onboarding-state.js"

interface ParsedArgs {
  reset: boolean
  step: string | null
  stepValid: boolean | null
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.split(/\s+/).filter(Boolean)
  const out: ParsedArgs = { reset: false, step: null, stepValid: null }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === "--reset" || t === "reset") out.reset = true
    else if (t === "--resume" || t === "resume") {
      // Re-entry no longer replays the wizard; --resume collapses into the hub.
    }
    else if (t === "--step" || t === "step") {
      const next = tokens[i + 1]
      if (next) {
        out.step = next
        out.stepValid = isValidStepId(next)
        i++
      }
    } else if (t.startsWith("--step=")) {
      const v = t.slice(7)
      out.step = v
      out.stepValid = isValidStepId(v)
    }
  }
  return out
}

// ─── Per-step routing ────────────────────────────────────────────────────────
//
// Clack-based steps are surfaced as notifications — running them inline from
// the TUI would wedge stdin (see header comment). Everything else routes to an
// existing ctx.ui-safe handler.

async function runStep(ctx: ExtensionCommandContext, stepId: OnboardingStepId): Promise<void> {
  switch (stepId) {
    case "llm":
      ctx.ui.notify(
        "LLM provider setup: run /login to sign in via OAuth, or /gsd keys add to paste an API key.",
        "info",
      )
      return
    case "search":
      ctx.ui.notify(
        "Web search setup: run /gsd keys add and pick a search provider (brave, tavily, etc.).",
        "info",
      )
      return
    case "remote":
      ctx.ui.notify(
        "Remote questions setup: run /gsd remote to configure Discord / Slack / Telegram notifications.",
        "info",
      )
      return
    case "tool-keys":
      ctx.ui.notify(
        "Tool keys setup: run /gsd keys add to save API keys for Context7, Jina, Groq voice, etc.",
        "info",
      )
      return
    case "model": {
      const { handleCoreCommand } = await import("./core.js")
      await handleCoreCommand("model", ctx)
      return
    }
    case "prefs": {
      const { ensurePreferencesFile, handlePrefsWizard } = await import("../../commands-prefs-wizard.js")
      const { getGlobalGSDPreferencesPath } = await import("../../preferences.js")
      await ensurePreferencesFile(getGlobalGSDPreferencesPath(), ctx, "global")
      await handlePrefsWizard(ctx, "global")
      return
    }
    case "doctor": {
      try {
        const { runProviderDoctor } = await import("../../doctor-providers.js") as any
        if (typeof runProviderDoctor === "function") {
          await runProviderDoctor(ctx)
          return
        }
      } catch { /* fall through */ }
      ctx.ui.notify("Run /gsd doctor to validate your setup.", "info")
      return
    }
    case "skills":
      ctx.ui.notify("Skill install runs during /gsd init. Use /gsd init or /skill manage.", "info")
      return
    case "project": {
      const { handleCoreCommand } = await import("./core.js")
      await handleCoreCommand("init", ctx)
      return
    }
  }
}

// ─── Setup hub ───────────────────────────────────────────────────────────────

async function renderSetupHub(ctx: ExtensionCommandContext): Promise<void> {
  const record = readOnboardingRecord()
  const completed = new Set(record.completedSteps)
  const skipped = new Set(record.skippedSteps)

  const labels = ONBOARDING_STEPS.map(step => {
    const mark = completed.has(step.id) ? "✓" : skipped.has(step.id) ? "↷" : "○"
    const req = step.required ? " (required)" : ""
    return `${mark} ${step.label}${req} — ${step.hint}`
  })
  const labelToStep = new Map(labels.map((label, i) => [label, ONBOARDING_STEPS[i].id]))

  const choice = await ctx.ui.select("GSD Setup — pick a step to configure", labels)
  if (typeof choice !== "string") return
  const stepId = labelToStep.get(choice)
  if (!stepId) return
  await runStep(ctx, stepId)
}

function renderStatus(): string {
  const r = readOnboardingRecord()
  const lines: string[] = ["GSD Onboarding\n"]
  if (r.completedAt) {
    lines.push(`  Completed: ${r.completedAt}`)
  } else {
    lines.push(`  Status: not complete`)
  }
  if (r.lastResumePoint) lines.push(`  Last step: ${r.lastResumePoint}`)
  lines.push("")
  lines.push("  Steps:")
  for (const step of ONBOARDING_STEPS) {
    const mark = r.completedSteps.includes(step.id)
      ? "✓"
      : r.skippedSteps.includes(step.id)
        ? "↷"
        : "○"
    const reqTag = step.required ? " (required)" : ""
    lines.push(`    ${mark} ${step.id.padEnd(10)} — ${step.label}${reqTag}`)
  }
  return lines.join("\n")
}

export async function handleOnboarding(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
  const args = parseArgs(rawArgs.trim())

  if (args.step !== null) {
    if (!args.stepValid) {
      const validIds = ONBOARDING_STEPS.map(s => s.id).join(", ")
      ctx.ui.notify(`Unknown step "${args.step}". Valid: ${validIds}`, "warning")
      return
    }
    await runStep(ctx, args.step as OnboardingStepId)
    return
  }

  if (args.reset) {
    resetOnboarding()
    ctx.ui.notify(
      "Onboarding state cleared. API keys/credentials are unchanged — manage them with /gsd keys. Restart GSD to re-run the first-run wizard, or pick a step below.",
      "info",
    )
    await renderSetupHub(ctx)
    return
  }

  // No flags (or --resume). Show status if complete, then open the hub.
  if (isOnboardingComplete()) {
    ctx.ui.notify(renderStatus(), "info")
  }
  await renderSetupHub(ctx)
}

export { renderStatus as renderOnboardingStatus }
