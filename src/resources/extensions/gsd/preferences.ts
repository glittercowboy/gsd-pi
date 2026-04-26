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
import { normalizeStringArray } from "../shared/format-utils.js";
import { logWarning } from "./workflow-logger.js";
import { resolveProfileDefaults as _resolveProfileDefaults } from "./preferences-models.js";

import {
  KNOWN_PREFERENCE_KEYS,
  MODE_DEFAULTS,
  type WorkflowMode,
  type GSDPreferences,
  type LoadedGSDPreferences,
  type SkillResolution,
  type SkillDiscoveryMode,
  formatSkillRef,
} from "./preferences-types.js";
import { validatePreferences } from "./preferences-validation.js";

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
  CmuxPreferences,
  UokTurnActionMode,
  UokPreferences,
  CodebaseMapPreferences,
  GSDPreferences,
  LoadedGSDPreferences,
  SkillResolution,
  SkillResolutionReport,
} from "./preferences-types.js";

// ─── Re-exports: validation ─────────────────────────────────────────────────
export { validatePreferences } from "./preferences-validation.js";

// ─── Re-exports: skills ─────────────────────────────────────────────────────
export { resolveAllSkillReferences } from "./preferences-skills.js";

// These lived in preferences-skills.ts but imported loadEffectiveGSDPreferences
// back from this file, creating a circular dependency. Moved here since they
// are trivial wrappers over loadEffectiveGSDPreferences.
export function resolveSkillDiscoveryMode(basePath?: string): SkillDiscoveryMode {
  const prefs = loadEffectiveGSDPreferences(basePath);
  return prefs?.preferences.skill_discovery ?? "suggest";
}

export function resolveSkillStalenessDays(basePath?: string): number {
  const prefs = loadEffectiveGSDPreferences(basePath);
  return prefs?.preferences.skill_staleness_days ?? 60;
}

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
  getProfileTierMap,
  resolveEffectiveProfile,
  resolveInlineLevel,
  resolveContextSelection,
  resolveSearchProviderFromPreferences,
  resolveDisabledModelProvidersFromPreferences,
} from "./preferences-models.js";

// ─── Path Constants & Getters ───────────────────────────────────────────────

function gsdHome(): string {
  return process.env.GSD_HOME || join(homedir(), ".gsd");
}

function globalPreferencesPath(): string {
  return join(gsdHome(), "PREFERENCES.md");
}

function legacyGlobalPreferencesPath(): string {
  return join(homedir(), ".pi", "agent", "gsd-preferences.md");
}

function projectPreferencesPath(basePath: string = process.cwd()): string {
  return join(gsdRoot(basePath), "PREFERENCES.md");
}
// Legacy lowercase files can still exist in older projects. Keep them as a
// compatibility-only fallback, but route new reads/writes through PREFERENCES.md.
function legacyGlobalPreferencesPathLowercase(): string {
  return join(gsdHome(), "preferences.md");
}
function legacyProjectPreferencesPathLowercase(basePath: string = process.cwd()): string {
  return join(gsdRoot(basePath), "preferences.md");
}

export function getGlobalGSDPreferencesPath(): string {
  return globalPreferencesPath();
}

export function getLegacyGlobalGSDPreferencesPath(): string {
  return legacyGlobalPreferencesPath();
}

export function getProjectGSDPreferencesPath(basePath?: string): string {
  return projectPreferencesPath(basePath);
}

// ─── Loading ────────────────────────────────────────────────────────────────

export function loadGlobalGSDPreferences(): LoadedGSDPreferences | null {
  return loadPreferencesFile(globalPreferencesPath(), "global")
    ?? loadPreferencesFile(legacyGlobalPreferencesPathLowercase(), "global")
    ?? loadPreferencesFile(legacyGlobalPreferencesPath(), "global");
}

export function loadProjectGSDPreferences(basePath?: string): LoadedGSDPreferences | null {
  return loadPreferencesFile(projectPreferencesPath(basePath), "project")
    ?? loadPreferencesFile(legacyProjectPreferencesPathLowercase(basePath), "project");
}

export function loadEffectiveGSDPreferences(
  basePath?: string,
  opts?: { availableModelIds?: string[] },
): LoadedGSDPreferences | null {
  const globalPreferences = loadGlobalGSDPreferences();
  const projectPreferences = loadProjectGSDPreferences(basePath);

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
    const profileDefaults = _resolveProfileDefaults(
      profile,
      opts?.availableModelIds,
      result.preferences.dynamic_routing,
    );
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

let _warnedUnrecognizedFormat = false;
let _warnedSectionParse = false;

/** @internal Reset the warn-once flags — exported for testing only. */
export function _resetParseWarningFlag(): void {
  _warnedUnrecognizedFormat = false;
  _warnedFrontmatterParse = false;
  _warnedSectionParse = false;
}

/** @internal Exported for testing only */
export function parsePreferencesMarkdown(content: string): GSDPreferences | null {
  // Use indexOf instead of [\s\S]*? regex to avoid backtracking (#468)
  const startMarker = content.startsWith('---\r\n') ? '---\r\n' : '---\n';
  if (content.startsWith(startMarker)) {
    const searchStart = startMarker.length;
    const endIdx = content.indexOf('\n---', searchStart);
    if (endIdx === -1) return null;
    const block = content.slice(searchStart, endIdx);
    return parseFrontmatterBlock(block.replace(/\r/g, ''));
  }

  // Fallback: heading+list format (e.g. "## Git\n- isolation: none") (#2036)
  // GSD agents may write preferences files without frontmatter delimiters.
  if (/^##\s+\w/m.test(content)) {
    return parseHeadingListFormat(content);
  }

  // Warn when a non-empty file exists but lacks frontmatter delimiters (#2036).
  if (content.trim().length > 0 && !_warnedUnrecognizedFormat) {
    _warnedUnrecognizedFormat = true;
    console.warn(
      "[GSD] Warning: preferences file has unrecognized format — content does not use YAML frontmatter delimiters (---). " +
      "Wrap your preferences in --- fences. See https://github.com/gsd-build/gsd-2/issues/2036",
    );
  }
  return null;
}

let _warnedFrontmatterParse = false;
function parseFrontmatterBlock(frontmatter: string): GSDPreferences {
  try {
    const parsed = parseYaml(frontmatter);
    if (typeof parsed !== 'object' || parsed === null) {
      return {} as GSDPreferences;
    }
    return parsed as GSDPreferences;
  } catch (e) {
    // Warn at most once per session to avoid flooding TUI (#3376)
    if (!_warnedFrontmatterParse) {
      _warnedFrontmatterParse = true;
      logWarning("guided", `YAML parse error in preferences frontmatter (suppressing further): ${(e as Error).message}`);
    }
    return {} as GSDPreferences;
  }
}

/**
 * Parse heading+list format into a nested object, then cast to GSDPreferences.
 * Handles markdown like:
 *   ## Git
 *   - isolation: none
 *   - commit_docs: true
 *   ## Models
 *   - planner: sonnet
 */
function parseHeadingListFormat(content: string): GSDPreferences {
  const result: Record<string, string[]> = {};
  let currentSection: string | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
      if (!result[currentSection]) result[currentSection] = [];
      continue;
    }
    if (currentSection && line.trim() && !line.trimStart().startsWith('#')) {
      result[currentSection].push(line);
    }
  }

  const typed: Record<string, unknown> = {};
  for (const [section, lines] of Object.entries(result)) {
    if (lines.length === 0) continue;

    const usesLegacyListItems = lines.every((line) => /^\s*-\s+[^:]+:\s*.*$/.test(line));
    const yamlBlock = usesLegacyListItems
      ? lines.map((line) => line.replace(/^\s*-\s+/, '')).join('\n')
      : lines.join('\n');

    try {
      const parsed = parseYaml(yamlBlock);
      if (typeof parsed !== 'object' || parsed === null) continue;

      let targetSection = section;
      let value: unknown = parsed;

      if (!Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length === 1) {
          const [onlyKey] = keys;
          if (onlyKey === section || (!KNOWN_PREFERENCE_KEYS.has(section) && KNOWN_PREFERENCE_KEYS.has(onlyKey))) {
            targetSection = onlyKey;
            value = (parsed as Record<string, unknown>)[onlyKey];
          }
        }
      }

      typed[targetSection] = value;
    } catch (e) {
      if (!_warnedSectionParse) {
        _warnedSectionParse = true;
        logWarning("guided", `preferences section parse failed: ${(e as Error).message}`);
      }
    }
  }

  return typed as GSDPreferences;
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
    cmux: (base.cmux || override.cmux)
      ? { ...(base.cmux ?? {}), ...(override.cmux ?? {}) }
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
    disabled_model_providers: mergeStringLists(
      base.disabled_model_providers,
      override.disabled_model_providers,
    ),
    uok: (base.uok || override.uok)
      ? {
          enabled: override.uok?.enabled ?? base.uok?.enabled,
          legacy_fallback: (base.uok?.legacy_fallback || override.uok?.legacy_fallback)
            ? { ...(base.uok?.legacy_fallback ?? {}), ...(override.uok?.legacy_fallback ?? {}) }
            : undefined,
          gates: (base.uok?.gates || override.uok?.gates)
            ? { ...(base.uok?.gates ?? {}), ...(override.uok?.gates ?? {}) }
            : undefined,
          model_policy: (base.uok?.model_policy || override.uok?.model_policy)
            ? { ...(base.uok?.model_policy ?? {}), ...(override.uok?.model_policy ?? {}) }
            : undefined,
          execution_graph: (base.uok?.execution_graph || override.uok?.execution_graph)
            ? { ...(base.uok?.execution_graph ?? {}), ...(override.uok?.execution_graph ?? {}) }
            : undefined,
          gitops: (base.uok?.gitops || override.uok?.gitops)
            ? { ...(base.uok?.gitops ?? {}), ...(override.uok?.gitops ?? {}) }
            : undefined,
          audit_unified: (base.uok?.audit_unified || override.uok?.audit_unified)
            ? { ...(base.uok?.audit_unified ?? {}), ...(override.uok?.audit_unified ?? {}) }
            : undefined,
          plan_v2: (base.uok?.plan_v2 || override.uok?.plan_v2)
            ? { ...(base.uok?.plan_v2 ?? {}), ...(override.uok?.plan_v2 ?? {}) }
            : undefined,
        }
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
    enhanced_verification: override.enhanced_verification ?? base.enhanced_verification,
    enhanced_verification_pre: override.enhanced_verification_pre ?? base.enhanced_verification_pre,
    enhanced_verification_post: override.enhanced_verification_post ?? base.enhanced_verification_post,
    enhanced_verification_strict: override.enhanced_verification_strict ?? base.enhanced_verification_strict,
    search_provider: override.search_provider ?? base.search_provider,
    context_selection: override.context_selection ?? base.context_selection,
    auto_visualize: override.auto_visualize ?? base.auto_visualize,
    auto_report: override.auto_report ?? base.auto_report,
    github: (base.github || override.github)
      ? { ...(base.github ?? {}), ...(override.github ?? {}) } as import("../github-sync/types.js").GitHubSyncConfig
      : undefined,
    experimental: (base.experimental || override.experimental)
      ? { ...(base.experimental ?? {}), ...(override.experimental ?? {}) }
      : undefined,
    service_tier: override.service_tier ?? base.service_tier,
    forensics_dedup: override.forensics_dedup ?? base.forensics_dedup,
    show_token_cost: override.show_token_cost ?? base.show_token_cost,
    min_request_interval_ms: override.min_request_interval_ms ?? base.min_request_interval_ms,
    codebase: (base.codebase || override.codebase)
      ? {
          ...(base.codebase ?? {}),
          ...(override.codebase ?? {}),
          // Merge exclude_patterns arrays rather than overriding
          exclude_patterns: [
            ...((base.codebase?.exclude_patterns) ?? []),
            ...((override.codebase?.exclude_patterns) ?? []),
          ].filter(Boolean),
        }
      : undefined,
    slice_parallel: (base.slice_parallel || override.slice_parallel)
      ? { ...(base.slice_parallel ?? {}), ...(override.slice_parallel ?? {}) }
      : undefined,
    language: override.language ?? base.language,
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

  if (preferences.language) {
    const safeLang = preferences.language.replace(/[\r\n]/g, " ").slice(0, 50);
    lines.push(`- Language: Always respond in ${safeLang}.`);
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
 * Returns "none" (default), "worktree", or "branch".
 *
 * Default is "none" so GSD works out of the box without preferences.md.
 * Worktree isolation requires explicit opt-in because it depends on git
 * branch infrastructure that must be set up before use.
 */
export function getIsolationMode(basePath?: string): "none" | "worktree" | "branch" {
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
  if (prefs?.isolation === "worktree") return "worktree";
  if (prefs?.isolation === "branch") return "branch";
  return "none"; // default — no isolation, work on current branch
}

export function resolveParallelConfig(prefs: GSDPreferences | undefined): import("./types.js").ParallelConfig {
  return {
    enabled: prefs?.parallel?.enabled ?? false,
    max_workers: Math.max(1, Math.min(4, prefs?.parallel?.max_workers ?? 2)),
    budget_ceiling: prefs?.parallel?.budget_ceiling,
    merge_strategy: prefs?.parallel?.merge_strategy ?? "per-milestone",
    auto_merge: prefs?.parallel?.auto_merge ?? "confirm",
    worker_model: prefs?.parallel?.worker_model,
  };
}
