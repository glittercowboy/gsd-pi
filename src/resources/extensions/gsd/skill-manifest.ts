// GSD2 + skill-manifest — per-unit-type skill allowlist resolver (RFC #4779)
//
// Each auto-mode unit type can declare which skills are relevant to it. This
// trims the set of skills considered for activation in the per-unit prompt,
// reducing prompt token bloat and sharpening model focus.
//
// Contract:
//   - Unknown unit types fall through to "all skills" (current behavior).
//   - A manifest entry referencing a skill that is not installed is a silent
//     no-op at filter time — the filter passes through installed skills only.
//   - The allowlist is an inclusion list: only skills whose normalized name
//     appears in the allowlist are retained. Order is not preserved.
//
// Phase 1 scope: seed manifests for a small number of unit types as proof.
// Additional unit types can be added incrementally; each addition is a pure
// data change with no wiring cost.

import { logWarning } from "./workflow-logger.js";

/** Normalize a skill reference the same way callers do (lowercase, trim). */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Allowlist per unit type. Keys match unit type identifiers used by auto-mode
 * dispatch. Values are normalized skill names.
 *
 * Wildcard semantics: a unit type absent from this map resolves to `null`
 * (wildcard) — meaning "all installed skills are eligible". Prefer absence
 * over an exhaustive list when uncertain.
 */
const UNIT_TYPE_SKILL_MANIFEST: Record<string, string[]> = {
  // Milestone-level planning / meta flows — predictable skill sets.
  "research-milestone": [
    "write-docs",
    "write-milestone-brief",
    "decompose-into-slices",
    "grill-me",
    "design-an-interface",
    "api-design",
    "observability",
  ],
  "plan-milestone": [
    "write-milestone-brief",
    "decompose-into-slices",
    "design-an-interface",
    "grill-me",
    "write-docs",
    "api-design",
    "tdd",
    "verify-before-complete",
  ],
  "complete-milestone": [
    "verify-before-complete",
    "write-docs",
    "handoff",
    "forensics",
    "observability",
    "security-review",
  ],
  "validate-milestone": [
    "verify-before-complete",
    "review",
    "test",
    "lint",
    "security-review",
    "accessibility",
    "forensics",
    "observability",
  ],
  "reassess-roadmap": [
    "decompose-into-slices",
    "grill-me",
    "write-milestone-brief",
    "write-docs",
    "forensics",
  ],
  // Slice-level research / planning.
  "research-slice": [
    "write-docs",
    "decompose-into-slices",
    "design-an-interface",
    "grill-me",
    "api-design",
    "observability",
  ],
  "plan-slice": [
    "decompose-into-slices",
    "design-an-interface",
    "grill-me",
    "write-docs",
    "api-design",
    "tdd",
    "verify-before-complete",
  ],
  "refine-slice": [
    "decompose-into-slices",
    "design-an-interface",
    "grill-me",
    "write-docs",
    "api-design",
    "tdd",
    "verify-before-complete",
  ],
  "replan-slice": [
    "decompose-into-slices",
    "grill-me",
    "design-an-interface",
    "write-docs",
    "api-design",
  ],
  "run-uat": [
    "verify-before-complete",
    "test",
    "review",
    "accessibility",
  ],
  // `execute-task` intentionally omitted — implementation hot path covers a
  // wide surface of technologies; wildcard fallback preserves today's
  // behavior until per-task skill hints can be derived from task-plan
  // frontmatter. See RFC #4779.
};

/**
 * Resolve the skill allowlist for a unit type.
 *
 * @returns Array of normalized skill names when an entry exists, or `null`
 *   when the unit type is unknown (wildcard — caller should not filter).
 */
export function resolveSkillManifest(unitType: string | undefined): string[] | null {
  if (!unitType) return null;
  const entry = UNIT_TYPE_SKILL_MANIFEST[unitType];
  if (!entry) return null;
  return entry.map(normalize);
}

/**
 * Filter a skill list by the manifest for `unitType`. Pass-through when the
 * manifest is wildcard (unknown unit type) or `unitType` is undefined.
 */
export function filterSkillsByManifest<T extends { name: string }>(
  skills: T[],
  unitType: string | undefined,
): T[] {
  const allowlist = resolveSkillManifest(unitType);
  if (allowlist === null) return skills;
  const allowed = new Set(allowlist);
  return skills.filter(skill => allowed.has(normalize(skill.name)));
}

/**
 * Dev-mode guard: warn once per process if a manifest entry references a name
 * that is not currently installed. Silent in production.
 */
const warnedMissing = new Set<string>();

export function warnIfManifestHasMissingSkills(
  unitType: string | undefined,
  installedNames: Set<string>,
): void {
  // Strict mode is intentionally opt-in via exactly "1"; values like "0" or
  // "false" must preserve the normal silent manifest behavior.
  if (process.env.GSD_SKILL_MANIFEST_STRICT !== "1") return;
  const allowlist = resolveSkillManifest(unitType);
  if (!allowlist) return;
  for (const name of allowlist) {
    const key = `${unitType}:${name}`;
    if (warnedMissing.has(key)) continue;
    if (!installedNames.has(name)) {
      warnedMissing.add(key);
      logWarning("prompt", `skill-manifest: references uninstalled skill '${name}' for unit '${unitType}'`);
    }
  }
}
