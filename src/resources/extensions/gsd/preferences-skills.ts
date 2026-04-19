/**
 * Skill-related preferences: resolution, discovery, and formatting.
 *
 * Contains all logic for resolving skill references from preferences
 * to absolute filesystem paths, plus skill discovery and staleness config.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { statSync } from "node:fs";

import type {
  GSDPreferences,
  SkillDiscoveryMode,
  SkillResolution,
  SkillResolutionReport,
} from "./preferences-types.js";
import { validatePreferences } from "./preferences-validation.js";

// Re-export types so existing consumers of ./preferences-skills.js keep working
export type { GSDSkillRule, SkillDiscoveryMode, SkillResolution, SkillResolutionReport } from "./preferences-types.js";

/**
 * Known skill directories, in priority order.
 * Searches both the skills.sh ecosystem directory (~/.agents/skills/) and
 * Claude Code's official directory (~/.claude/skills/). Project-level
 * directories for both conventions are included as well.
 * Legacy ~/.gsd/agent/skills/ is included as a fallback for pre-migration installs.
 */
export function getSkillSearchDirs(cwd: string): Array<{ dir: string; method: SkillResolution["method"] }> {
  const dirs: Array<{ dir: string; method: SkillResolution["method"] }> = [
    { dir: join(homedir(), ".agents", "skills"), method: "user-skill" },
    { dir: join(cwd, ".agents", "skills"), method: "project-skill" },
    // Claude Code official skill directories
    { dir: join(homedir(), ".claude", "skills"), method: "user-skill" },
    { dir: join(cwd, ".claude", "skills"), method: "project-skill" },
  ];
  // Legacy fallback — read skills from old GSD directory only if migration hasn't completed
  const legacyDir = join(homedir(), ".gsd", "agent", "skills");
  if (existsSync(legacyDir) && !existsSync(join(legacyDir, ".migrated-to-agents"))) {
    dirs.push({ dir: legacyDir, method: "user-skill" });
  }
  return dirs;
}

/**
 * Resolve a single skill reference to an absolute path.
 *
 * Resolution order:
 * 1. Absolute path to a file -> check existsSync
 * 2. Absolute path to a directory -> check for SKILL.md inside
 * 3. Bare name -> scan known skill directories for <name>/SKILL.md
 */
export function resolveSkillReference(ref: string, cwd: string): SkillResolution {
  const trimmed = ref.trim();

  // Expand tilde
  const expanded = trimmed.startsWith("~/")
    ? join(homedir(), trimmed.slice(2))
    : trimmed;

  // Absolute path
  if (isAbsolute(expanded)) {
    // Direct file reference
    if (existsSync(expanded)) {
      // Check if it's a directory -- look for SKILL.md inside
      try {
        const stat = statSync(expanded);
        if (stat.isDirectory()) {
          const skillFile = join(expanded, "SKILL.md");
          if (existsSync(skillFile)) {
            return { original: ref, resolvedPath: skillFile, method: "absolute-dir" };
          }
          return { original: ref, resolvedPath: null, method: "unresolved" };
        }
      } catch { /* fall through */ }
      return { original: ref, resolvedPath: expanded, method: "absolute-path" };
    }
    // Maybe it's a directory path without SKILL.md suffix
    const withSkillMd = join(expanded, "SKILL.md");
    if (existsSync(withSkillMd)) {
      return { original: ref, resolvedPath: withSkillMd, method: "absolute-dir" };
    }
    return { original: ref, resolvedPath: null, method: "unresolved" };
  }

  // Bare name -- scan known skill directories
  for (const { dir, method } of getSkillSearchDirs(cwd)) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name === expanded) {
          const skillFile = join(dir, entry.name, "SKILL.md");
          if (existsSync(skillFile)) {
            return { original: ref, resolvedPath: skillFile, method };
          }
        }
      }
    } catch { /* directory not readable -- skip */ }
  }

  return { original: ref, resolvedPath: null, method: "unresolved" };
}

/**
 * Resolve all skill references in a preferences object.
 * Caches resolution per reference string to avoid redundant filesystem scans.
 */
export function resolveAllSkillReferences(preferences: GSDPreferences, cwd: string): SkillResolutionReport {
  const validated = validatePreferences(preferences).preferences;
  preferences = validated;

  const resolutions = new Map<string, SkillResolution>();
  const warnings: string[] = [];

  function resolve(ref: string): SkillResolution {
    const existing = resolutions.get(ref);
    if (existing) return existing;
    const result = resolveSkillReference(ref, cwd);
    resolutions.set(ref, result);
    if (result.method === "unresolved") {
      warnings.push(ref);
    }
    return result;
  }

  // Resolve all skill lists
  for (const skill of preferences.always_use_skills ?? []) resolve(skill);
  for (const skill of preferences.prefer_skills ?? []) resolve(skill);
  for (const skill of preferences.avoid_skills ?? []) resolve(skill);

  // Resolve skill rules
  for (const rule of preferences.skill_rules ?? []) {
    for (const skill of rule.use ?? []) resolve(skill);
    for (const skill of rule.prefer ?? []) resolve(skill);
    for (const skill of rule.avoid ?? []) resolve(skill);
  }

  return { resolutions, warnings };
}

// resolveSkillDiscoveryMode and resolveSkillStalenessDays moved to
// preferences.ts to break circular dependency (they need loadEffectiveGSDPreferences).
