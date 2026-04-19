// GSD — Onboarding completion record (~/.gsd/agent/onboarding.json)
//
// First-class state for the onboarding wizard so re-entry, resume, and the
// web boot probe all read the same source of truth. Replaces the implicit
// "settings.defaultProvider exists" heuristic.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { logWarning } from "./workflow-logger.js"

/**
 * Bump `FLOW_VERSION` whenever a new required step is added to ONBOARDING_STEPS.
 * Records with an older flowVersion are treated as "needs partial re-onboarding"
 * by isOnboardingComplete().
 */
export const FLOW_VERSION = 1

const RECORD_VERSION = 1
// Inline agentDir computation (mirrors src/app-paths.ts) — keep this module
// rootDir-clean for the resources tsconfig; importing from src/ pulls files
// outside src/resources and breaks the build.
const AGENT_DIR =
  process.env.GSD_CODING_AGENT_DIR ||
  join(process.env.GSD_HOME || join(homedir(), ".gsd"), "agent")
const FILE = join(AGENT_DIR, "onboarding.json")

export interface OnboardingRecord {
  version: number
  flowVersion: number
  completedAt: string | null
  completedSteps: string[]
  skippedSteps: string[]
  lastResumePoint: string | null
}

const DEFAULT: OnboardingRecord = {
  version: RECORD_VERSION,
  flowVersion: FLOW_VERSION,
  completedAt: null,
  completedSteps: [],
  skippedSteps: [],
  lastResumePoint: null,
}

export function readOnboardingRecord(): OnboardingRecord {
  if (!existsSync(FILE)) return { ...DEFAULT }
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf-8")) as Partial<OnboardingRecord>
    return {
      version: typeof raw.version === "number" ? raw.version : RECORD_VERSION,
      flowVersion: typeof raw.flowVersion === "number" ? raw.flowVersion : 0,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
      completedSteps: Array.isArray(raw.completedSteps) ? raw.completedSteps.filter(s => typeof s === "string") : [],
      skippedSteps: Array.isArray(raw.skippedSteps) ? raw.skippedSteps.filter(s => typeof s === "string") : [],
      lastResumePoint: typeof raw.lastResumePoint === "string" ? raw.lastResumePoint : null,
    }
  } catch {
    // Corrupt/unreadable — fall back to defaults rather than crashing onboarding flow
    return { ...DEFAULT }
  }
}

function atomicWrite(record: OnboardingRecord): void {
  mkdirSync(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp.${process.pid}.${Date.now()}`
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8")
    renameSync(tmp, FILE)
  } catch (err) {
    // Best-effort: drop the tmp file if the rename failed (don't leak stale tmps)
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* swallow secondary error */ }
    throw err
  }
}

export function writeOnboardingRecord(patch: Partial<OnboardingRecord>): OnboardingRecord {
  const current = readOnboardingRecord()
  const next: OnboardingRecord = {
    ...current,
    ...patch,
    version: RECORD_VERSION,
    // flowVersion is sticky on writes unless explicitly patched
    flowVersion: typeof patch.flowVersion === "number" ? patch.flowVersion : current.flowVersion,
  }
  try {
    atomicWrite(next)
  } catch (err) {
    // Non-fatal for the wizard, but make the failure diagnosable. The next boot
    // will re-prompt for onboarding because the record didn't persist; the
    // logWarning entry tells the user why.
    logWarning("state", `Failed to persist onboarding record: ${err instanceof Error ? err.message : String(err)}`, {
      file: FILE,
    })
  }
  return next
}

/**
 * Onboarding is "complete" when there's a completedAt timestamp AND the
 * flowVersion matches the current FLOW_VERSION. A flowVersion bump means
 * a new required step exists and the user should re-enter to configure it.
 */
export function isOnboardingComplete(): boolean {
  const r = readOnboardingRecord()
  return r.completedAt !== null && r.flowVersion === FLOW_VERSION
}

export function markStepCompleted(stepId: string): void {
  const r = readOnboardingRecord()
  if (r.completedSteps.includes(stepId)) {
    writeOnboardingRecord({ lastResumePoint: stepId })
    return
  }
  writeOnboardingRecord({
    completedSteps: [...r.completedSteps, stepId],
    skippedSteps: r.skippedSteps.filter(s => s !== stepId),
    lastResumePoint: stepId,
  })
}

export function markStepSkipped(stepId: string): void {
  const r = readOnboardingRecord()
  if (r.skippedSteps.includes(stepId) || r.completedSteps.includes(stepId)) return
  writeOnboardingRecord({
    skippedSteps: [...r.skippedSteps, stepId],
    lastResumePoint: stepId,
  })
}

export function markOnboardingComplete(completedSteps: string[]): void {
  writeOnboardingRecord({
    completedAt: new Date().toISOString(),
    flowVersion: FLOW_VERSION,
    completedSteps,
  })
}

export function resetOnboarding(): void {
  writeOnboardingRecord({
    completedAt: null,
    completedSteps: [],
    skippedSteps: [],
    lastResumePoint: null,
  })
}
