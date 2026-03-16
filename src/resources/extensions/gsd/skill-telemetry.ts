/**
 * GSD Skill Telemetry — Track which skills are loaded per unit (#599)
 *
 * Captures skill names at dispatch time for inclusion in UnitMetrics.
 * Distinguishes between "available" skills (in system prompt) and
 * "actively loaded" skills (read via tool calls during execution).
 *
 * Data flow:
 *   1. At dispatch, captureAvailableSkills() records skills from the system prompt
 *   2. During execution, recordSkillRead() tracks explicit SKILL.md reads
 *   3. At unit completion, getAndClearSkills() returns the loaded list for metrics
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@gsd/pi-coding-agent";

// ─── In-memory state ──────────────────────────────────────────────────────────

/** Skills available in the system prompt for the current unit */
let availableSkills: string[] = [];

/** Skills explicitly read (SKILL.md loaded) during the current unit */
const activelyLoadedSkills = new Set<string>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Capture the list of available skill names at dispatch time.
 * Called before each unit starts.
 */
export function captureAvailableSkills(): void {
  const skillsDir = join(getAgentDir(), "skills");
  availableSkills = listSkillNames(skillsDir);
  activelyLoadedSkills.clear();
}

/**
 * Record that a skill was actively loaded (its SKILL.md was read).
 * Call this when the agent reads a SKILL.md file.
 */
export function recordSkillRead(skillName: string): void {
  activelyLoadedSkills.add(skillName);
}

/**
 * Get the skill names for the current unit and clear state.
 * Returns actively loaded skills if any, otherwise available skills.
 * This gives the most useful signal: if the agent read specific skills,
 * report those; otherwise report what was available.
 */
export function getAndClearSkills(): string[] {
  const result = activelyLoadedSkills.size > 0
    ? Array.from(activelyLoadedSkills)
    : [...availableSkills];
  availableSkills = [];
  activelyLoadedSkills.clear();
  return result;
}

/**
 * Reset all telemetry state. Called when auto-mode stops.
 */
export function resetSkillTelemetry(): void {
  availableSkills = [];
  activelyLoadedSkills.clear();
}

/**
 * Get last-used timestamps for all skills from metrics data.
 * Returns a Map from skill name to most recent ms timestamp.
 */
export function getSkillLastUsed(units: Array<{ finishedAt: number; skills?: string[] }>): Map<string, number> {
  const lastUsed = new Map<string, number>();
  for (const u of units) {
    if (!u.skills) continue;
    for (const skill of u.skills) {
      const existing = lastUsed.get(skill) ?? 0;
      if (u.finishedAt > existing) {
        lastUsed.set(skill, u.finishedAt);
      }
    }
  }
  return lastUsed;
}

/**
 * Detect stale skills — those not used within the given threshold (in days).
 * Returns skill names that should be deprioritized.
 */
export function detectStaleSkills(
  units: Array<{ finishedAt: number; skills?: string[] }>,
  thresholdDays: number,
): string[] {
  if (thresholdDays <= 0) return [];

  const lastUsed = getSkillLastUsed(units);
  const cutoff = Date.now() - (thresholdDays * 24 * 60 * 60 * 1000);
  const stale: string[] = [];

  // Check all installed skills, not just those with usage data
  const skillsDir = join(getAgentDir(), "skills");
  const installed = listSkillNames(skillsDir);

  for (const skill of installed) {
    const lastTs = lastUsed.get(skill);
    if (lastTs === undefined || lastTs < cutoff) {
      stale.push(skill);
    }
  }

  return stale;
}

// ─── Internals ────────────────────────────────────────────────────────────────

function listSkillNames(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."))
      .filter(d => existsSync(join(skillsDir, d.name, "SKILL.md")))
      .map(d => d.name);
  } catch {
    return [];
  }
}
