/**
 * GSD Preferences -- loading, merging, and rendering.
 *
 * This module is the primary entry point for preference operations.
 * Type definitions live in ./preferences-types.js, validation in
 * ./preferences-validation.js, skill logic in ./preferences-skills.js,
 * and model logic in ./preferences-models.js.
 *
 * All symbols are re-exported here so that existing `import { ... } from "./preferences.js"`
 * statements continue to work without modification.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { parse as parseYaml } from "yaml";
import type { PostUnitHookConfig, PreDispatchHookConfig, TokenProfile } from "./types.js";
import type { DynamicRoutingConfig } from "./model-router.js";
import { normalizeStringArray } from "../shared/mod.js";
import { resolveProfileDefaults as _resolveProfileDefaults } from "./preferences-models.js";

import {
  MODE_DEFAULTS,
  type WorkflowMode,
  type GSDPreferences,
  type LoadedGSDPreferences,
  type SkillResolution,
} from "./preferences-types.js";
import { validatePreferences } from "./preferences-validation.js";
import { formatSkillRef } from "./preferences-skills.js";

// ─── Re-exports: types ──────────────────────────────────────────────────────
// Every type/interface that was previously exported from this file is
// re-exported so that downstream `import { Foo } from "./preferences.js"`
// statements keep compiling.

export type {
  WorkflowMode,
  GSDSkillRule,
  GSDPhaseModelConfig,
  GSDModelConfig,
  GSDModelConfigV2,
  ResolvedModelConfig,
  SkillDiscoveryMode,
  AutoSupervisorConfig,
  RemoteQuestionsConfig,
  GSDPreferences,
  LoadedGSDPreferences,
  SkillResolution,
  SkillResolutionReport,
} from "./preferences-types.js";

// ─── Re-exports: validation ─────────────────────────────────────────────────
export { validatePreferences } from "./preferences-validation.js";

// ─── Re-exports: skills ─────────────────────────────────────────────────────
export {
  resolveAllSkillReferences,
  resolveSkillDiscoveryMode,
  resolveSkillStalenessDays,
} from "./preferences-skills.js";

// ─── Re-exports: models ─────────────────────────────────────────────────────
export {
  resolveModelForUnit,
  resolveModelWithFallbacksForUnit,
  getNextFallbackModel,
  isTransientNetworkError,
  validateModelId,
  updatePreferencesModels,
  resolveDynamicRoutingConfig,
  resolveAutoSupervisorConfig,
  resolveProfileDefaults,
  resolveEffectiveProfile,
  resolveInlineLevel,
  resolveCompressionStrategy,
  resolveContextSelection,
  resolveSearchProviderFromPreferences,
} from "./preferences-models.js";

// ─── Path Constants & Getters ───────────────────────────────────────────────

const GLOBAL_PREFERENCES_PATH = join(homedir(), ".gsd", "preferences.md");
const LEGACY_GLOBAL_PREFERENCES_PATH = join(homedir(), ".pi", "agent", "gsd-preferences.md");
function projectPreferencesPath(): string {
  return join(gsdRoot(process.cwd()), "preferences.md");
}
// Bootstrap in gitignore.ts historically created PREFERENCES.md (uppercase) by mistake.
// Check uppercase as a fallback so those files aren't silently ignored.
const GLOBAL_PREFERENCES_PATH_UPPERCASE = join(homedir(), ".gsd", "PREFERENCES.md");
function projectPreferencesPathUppercase(): string {
  return join(gsdRoot(process.cwd()), "PREFERENCES.md");
}

export function getGlobalGSDPreferencesPath(): string {
  return GLOBAL_PREFERENCES_PATH;
}

export function getLegacyGlobalGSDPreferencesPath(): string {
  return LEGACY_GLOBAL_PREFERENCES_PATH;
}

export function getProjectGSDPreferencesPath(): string {
  return projectPreferencesPath();
}

// ─── Loading ────────────────────────────────────────────────────────────────

export function loadGlobalGSDPreferences(): LoadedGSDPreferences | null {
  return loadPreferencesFile(GLOBAL_PREFERENCES_PATH, "global")
    ?? loadPreferencesFile(GLOBAL_PREFERENCES_PATH_UPPERCASE, "global")
    ?? loadPreferencesFile(LEGACY_GLOBAL_PREFERENCES_PATH, "global");
}

export function loadProjectGSDPreferences(): LoadedGSDPreferences | null {
  return loadPreferencesFile(projectPreferencesPath(), "project")
    ?? loadPreferencesFile(projectPreferencesPathUppercase(), "project");
}

export function loadEffectiveGSDPreferences(): LoadedGSDPreferences | null {
  const globalPreferences = loadGlobalGSDPreferences();
  const projectPreferences = loadProjectGSDPreferences();

  if (!globalPreferences && !projectPreferences) return null;

  let result: LoadedGSDPreferences;
  if (!globalPreferences) {
    result = projectPreferences!;
  } else if (!projectPreferences) {
    result = globalPreferences;
  } else {
    const mergedWarnings = [
      ...(globalPreferences.warnings ?? []),
      ...(projectPreferences.warnings ?? []),
    ];
    result = {
      path: projectPreferences.path,
      scope: "project",
      preferences: mergePreferences(globalPreferences.preferences, projectPreferences.preferences),
      ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
    };
  }

  // Apply token-profile defaults as the lowest-priority layer so that
  // `token_profile: budget` sets models and phase-skips automatically.
  // Explicit user preferences always override profile defaults.
  const profile = result.preferences.token_profile as TokenProfile | undefined;
  if (profile) {
    const profileDefaults = _resolveProfileDefaults(profile);
    result = {
      ...result,
      preferences: mergePreferences(profileDefaults as GSDPreferences, result.preferences),
    };
  }

  // Apply mode defaults as the lowest-priority layer
  if (result.preferences.mode) {
    result = {
      ...result,
      preferences: applyModeDefaults(result.preferences.mode, result.preferences),
    };
  }

  return result;
}

function loadPreferencesFile(path: string, scope: "global" | "project"): LoadedGSDPreferences | null {
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf-8");
  const preferences = parsePreferencesMarkdown(raw);
  if (!preferences) return null;

  const validation = validatePreferences(preferences);
  const allWarnings = [...validation.warnings, ...validation.errors];

  return {
    path,
    scope,
    preferences: validation.preferences,
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
  };
}

/** @internal Exported for testing only */
export function parsePreferencesMarkdown(content: string): GSDPreferences | null {
  // Use indexOf instead of [\s\S]*? regex to avoid backtracking (#468)
  const startMarker = content.startsWith('---\r\n') ? '---\r\n' : '---\n';
  if (!content.startsWith(startMarker)) return null;
  const searchStart = startMarker.length;
  const endIdx = content.indexOf('\n---', searchStart);
  if (endIdx === -1) return null;
  const block = content.slice(searchStart, endIdx);
  return parseFrontmatterBlock(block.replace(/\r/g, ''));
}

function parseFrontmatterBlock(frontmatter: string): GSDPreferences {
  try {
    const parsed = parseYaml(frontmatter);
    if (typeof parsed !== 'object' || parsed === null) {
      return {} as GSDPreferences;
    }
    return parsed as GSDPreferences;
  } catch (e) {
    console.error("[parseFrontmatterBlock] YAML parse error:", e);
    return {} as GSDPreferences;
  }
}

// ─── Merging ────────────────────────────────────────────────────────────────

/**
 * Apply mode defaults as the lowest-priority layer.
 * Mode defaults fill in undefined fields; any explicit user value wins.
 */
export function applyModeDefaults(mode: WorkflowMode, prefs: GSDPreferences): GSDPreferences {
  const defaults = MODE_DEFAULTS[mode];
  if (!defaults) return prefs;
  return mergePreferences(defaults, prefs);
}

function mergePreferences(base: GSDPreferences, override: GSDPreferences): GSDPreferences {
  return {
    version: override.version ?? base.version,
    mode: override.mode ?? base.mode,
    always_use_skills: mergeStringLists(base.always_use_skills, override.always_use_skills),
    prefer_skills: mergeStringLists(base.prefer_skills, override.prefer_skills),
    avoid_skills: mergeStringLists(base.avoid_skills, override.avoid_skills),
    skill_rules: [...(base.skill_rules ?? []), ...(override.skill_rules ?? [])],
    custom_instructions: mergeStringLists(base.custom_instructions, override.custom_instructions),
    models: { ...(base.models ?? {}), ...(override.models ?? {}) },
    skill_discovery: override.skill_discovery ?? base.skill_discovery,
    skill_staleness_days: override.skill_staleness_days ?? base.skill_staleness_days,
    auto_supervisor: { ...(base.auto_supervisor ?? {}), ...(override.auto_supervisor ?? {}) },
    uat_dispatch: override.uat_dispatch ?? base.uat_dispatch,
    unique_milestone_ids: override.unique_milestone_ids ?? base.unique_milestone_ids,
    budget_ceiling: override.budget_ceiling ?? base.budget_ceiling,
    budget_enforcement: override.budget_enforcement ?? base.budget_enforcement,
    context_pause_threshold: override.context_pause_threshold ?? base.context_pause_threshold,
    notifications: (base.notifications || override.notifications)
      ? { ...(base.notifications ?? {}), ...(override.notifications ?? {}) }
      : undefined,
    remote_questions: override.remote_questions
      ? { ...(base.remote_questions ?? {}), ...override.remote_questions }
      : base.remote_questions,
    git: (base.git || override.git)
      ? { ...(base.git ?? {}), ...(override.git ?? {}) }
      : undefined,
    post_unit_hooks: mergePostUnitHooks(base.post_unit_hooks, override.post_unit_hooks),
    pre_dispatch_hooks: mergePreDispatchHooks(base.pre_dispatch_hooks, override.pre_dispatch_hooks),
    dynamic_routing: (base.dynamic_routing || override.dynamic_routing)
      ? { ...(base.dynamic_routing ?? {}), ...(override.dynamic_routing ?? {}) } as DynamicRoutingConfig
      : undefined,
    token_profile: override.token_profile ?? base.token_profile,
    phases: (base.phases || override.phases)
      ? { ...(base.phases ?? {}), ...(override.phases ?? {}) }
      : undefined,
    parallel: (base.parallel || override.parallel)
      ? { ...(base.parallel ?? {}), ...(override.parallel ?? {}) } as import("./types.js").ParallelConfig
      : undefined,
    verification_commands: mergeStringLists(base.verification_commands, override.verification_commands),
    verification_auto_fix: override.verification_auto_fix ?? base.verification_auto_fix,
    verification_max_retries: override.verification_max_retries ?? base.verification_max_retries,
    search_provider: override.search_provider ?? base.search_provider,
    compression_strategy: override.compression_strategy ?? base.compression_strategy,
    context_selection: override.context_selection ?? base.context_selection,
    auto_visualize: override.auto_visualize ?? base.auto_visualize,
    auto_report: override.auto_report ?? base.auto_report,
  };
}

function mergeStringLists(base?: unknown, override?: unknown): string[] | undefined {
  const merged = [
    ...normalizeStringArray(base),
    ...normalizeStringArray(override),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
}

function mergePostUnitHooks(
  base?: PostUnitHookConfig[],
  override?: PostUnitHookConfig[],
): PostUnitHookConfig[] | undefined {
  if (!base?.length && !override?.length) return undefined;
  const merged = [...(base ?? [])];
  for (const hook of override ?? []) {
    // Override hooks with same name replace base hooks
    const idx = merged.findIndex(h => h.name === hook.name);
    if (idx >= 0) {
      merged[idx] = hook;
    } else {
      merged.push(hook);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function mergePreDispatchHooks(
  base?: PreDispatchHookConfig[],
  override?: PreDispatchHookConfig[],
): PreDispatchHookConfig[] | undefined {
  if (!base?.length && !override?.length) return undefined;
  const merged = [...(base ?? [])];
  for (const hook of override ?? []) {
    const idx = merged.findIndex(h => h.name === hook.name);
    if (idx >= 0) {
      merged[idx] = hook;
    } else {
      merged.push(hook);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

// ─── System Prompt Rendering ──────────────────────────────────────────────────

export function renderPreferencesForSystemPrompt(preferences: GSDPreferences, resolutions?: Map<string, SkillResolution>): string {
  const validated = validatePreferences(preferences);
  const lines: string[] = ["## GSD Skill Preferences"];

  if (validated.errors.length > 0) {
    lines.push("- Validation: some preference values were ignored because they were invalid.");
  }
  for (const warning of validated.warnings) {
    lines.push(`- Deprecation: ${warning}`);
  }

  preferences = validated.preferences;

  lines.push(
    "- Treat these as explicit skill-selection policy for GSD work.",
    "- If a listed skill exists and is relevant, load and follow it instead of treating it as a vague suggestion.",
    "- Current user instructions still override these defaults.",
  );

  const fmt = (ref: string) => resolutions ? formatSkillRef(ref, resolutions) : ref;

  if (preferences.always_use_skills && preferences.always_use_skills.length > 0) {
    lines.push("- Always use these skills when relevant:");
    for (const skill of preferences.always_use_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }

  if (preferences.prefer_skills && preferences.prefer_skills.length > 0) {
    lines.push("- Prefer these skills when relevant:");
    for (const skill of preferences.prefer_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }

  if (preferences.avoid_skills && preferences.avoid_skills.length > 0) {
    lines.push("- Avoid these skills unless clearly needed:");
    for (const skill of preferences.avoid_skills) {
      lines.push(`  - ${fmt(skill)}`);
    }
  }

  if (preferences.skill_rules && preferences.skill_rules.length > 0) {
    lines.push("- Situational rules:");
    for (const rule of preferences.skill_rules) {
      lines.push(`  - When ${rule.when}:`);
      if (rule.use && rule.use.length > 0) {
        lines.push(`    - use: ${rule.use.map(fmt).join(", ")}`);
      }
      if (rule.prefer && rule.prefer.length > 0) {
        lines.push(`    - prefer: ${rule.prefer.map(fmt).join(", ")}`);
      }
      if (rule.avoid && rule.avoid.length > 0) {
        lines.push(`    - avoid: ${rule.avoid.map(fmt).join(", ")}`);
      }
    }
  }

  if (preferences.custom_instructions && preferences.custom_instructions.length > 0) {
    lines.push("- Additional instructions:");
    for (const instruction of preferences.custom_instructions) {
      lines.push(`  - ${instruction}`);
    }
  }

  return lines.join("\n");
}

// ─── Hook Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve enabled post-unit hooks from effective preferences.
 * Returns an empty array when no hooks are configured.
 */
export function resolvePostUnitHooks(): PostUnitHookConfig[] {
  const prefs = loadEffectiveGSDPreferences();
  return (prefs?.preferences.post_unit_hooks ?? [])
    .filter(h => h.enabled !== false);
}

/**
 * Resolve enabled pre-dispatch hooks from effective preferences.
 * Returns an empty array when no hooks are configured.
 */
export function resolvePreDispatchHooks(): PreDispatchHookConfig[] {
  const prefs = loadEffectiveGSDPreferences();
  return (prefs?.preferences.pre_dispatch_hooks ?? [])
    .filter(h => h.enabled !== false);
}

// ─── Isolation & Parallel ─────────────────────────────────────────────────────

/**
 * Resolve the effective git isolation mode from preferences.
 * Returns "worktree" (default), "branch", or "none".
 */
export function getIsolationMode(): "none" | "worktree" | "branch" {
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git;
  if (prefs?.isolation === "none") return "none";
  if (prefs?.isolation === "branch") return "branch";
  return "worktree"; // default
}

export function resolveParallelConfig(prefs: GSDPreferences | undefined): import("./types.js").ParallelConfig {
  return {
    enabled: prefs?.parallel?.enabled ?? false,
    max_workers: Math.max(1, Math.min(4, prefs?.parallel?.max_workers ?? 2)),
    budget_ceiling: prefs?.parallel?.budget_ceiling,
    merge_strategy: prefs?.parallel?.merge_strategy ?? "per-milestone",
    auto_merge: prefs?.parallel?.auto_merge ?? "confirm",
  };
}
