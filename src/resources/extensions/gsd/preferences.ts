import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@gsd/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import type { GitPreferences } from "./git-service.js";
import type { PostUnitHookConfig, PreDispatchHookConfig, BudgetEnforcementMode, NotificationPreferences, TokenProfile, InlineLevel, PhaseSkipPreferences } from "./types.js";
import type { DynamicRoutingConfig } from "./model-router.js";
import { defaultRoutingConfig } from "./model-router.js";
import { VALID_BRANCH_NAME } from "./git-service.js";

const GLOBAL_PREFERENCES_PATH = join(homedir(), ".gsd", "preferences.md");
const LEGACY_GLOBAL_PREFERENCES_PATH = join(homedir(), ".pi", "agent", "gsd-preferences.md");
const PROJECT_PREFERENCES_PATH = join(process.cwd(), ".gsd", "preferences.md");
// Bootstrap in gitignore.ts historically created PREFERENCES.md (uppercase) by mistake.
// Check uppercase as a fallback so those files aren't silently ignored.
const GLOBAL_PREFERENCES_PATH_UPPERCASE = join(homedir(), ".gsd", "PREFERENCES.md");
const PROJECT_PREFERENCES_PATH_UPPERCASE = join(process.cwd(), ".gsd", "PREFERENCES.md");
const SKILL_ACTIONS = new Set(["use", "prefer", "avoid"]);

// ─── Workflow Modes ──────────────────────────────────────────────────────────

export type WorkflowMode = "solo" | "team";

/** Default preference values for each workflow mode. */
const MODE_DEFAULTS: Record<WorkflowMode, Partial<GSDPreferences>> = {
  solo: {
    git: {
      auto_push: true,
      push_branches: false,
      pre_merge_check: false,
      merge_strategy: "squash",
      isolation: "worktree",
      commit_docs: true,
    },
    unique_milestone_ids: false,
  },
  team: {
    git: {
      auto_push: false,
      push_branches: true,
      pre_merge_check: true,
      merge_strategy: "squash",
      isolation: "worktree",
      commit_docs: true,
    },
    unique_milestone_ids: true,
  },
};

/** All recognized top-level keys in GSDPreferences. Used to detect typos / stale config. */
const KNOWN_PREFERENCE_KEYS = new Set<string>([
  "version",
  "mode",
  "always_use_skills",
  "prefer_skills",
  "avoid_skills",
  "skill_rules",
  "custom_instructions",
  "models",
  "skill_discovery",
  "skill_staleness_days",
  "auto_supervisor",
  "uat_dispatch",
  "unique_milestone_ids",
  "budget_ceiling",
  "budget_enforcement",
  "context_pause_threshold",
  "notifications",
  "remote_questions",
  "git",
  "post_unit_hooks",
  "pre_dispatch_hooks",
  "dynamic_routing",
  "token_profile",
  "phases",
  "auto_visualize",
  "parallel",
  "verification_commands",
  "verification_auto_fix",
  "verification_max_retries",
]);

export interface GSDSkillRule {
  when: string;
  use?: string[];
  prefer?: string[];
  avoid?: string[];
}

/**
 * Model configuration for a single phase.
 * Supports primary model with optional fallbacks for resilience.
 */
export interface GSDPhaseModelConfig {
  /** Primary model ID (e.g., "claude-opus-4-6") */
  model: string;
  /** Provider name to disambiguate when the same model ID exists across providers (e.g., "bedrock", "anthropic") */
  provider?: string;
  /** Fallback models to try in order if primary fails (e.g., rate limits, credits exhausted) */
  fallbacks?: string[];
}

/**
 * Legacy model config — simple string per phase.
 * Kept for backward compatibility; will be migrated to GSDModelConfigV2 on load.
 */
export interface GSDModelConfig {
  research?: string;
  planning?: string;
  execution?: string;
  execution_simple?: string;
  completion?: string;
  subagent?: string;
}

/**
 * Extended model config with per-phase fallback support.
 * Each phase can specify a primary model and ordered fallbacks.
 */
export interface GSDModelConfigV2 {
  research?: string | GSDPhaseModelConfig;
  planning?: string | GSDPhaseModelConfig;
  execution?: string | GSDPhaseModelConfig;
  execution_simple?: string | GSDPhaseModelConfig;
  completion?: string | GSDPhaseModelConfig;
  subagent?: string | GSDPhaseModelConfig;
}

/** Normalized model selection with resolved fallbacks */
export interface ResolvedModelConfig {
  primary: string;
  fallbacks: string[];
}

export type SkillDiscoveryMode = "auto" | "suggest" | "off";

export interface AutoSupervisorConfig {
  model?: string;
  soft_timeout_minutes?: number;
  idle_timeout_minutes?: number;
  hard_timeout_minutes?: number;
}

export interface RemoteQuestionsConfig {
  channel: "slack" | "discord" | "telegram";
  channel_id: string | number;
  timeout_minutes?: number;        // clamped to 1-30
  poll_interval_seconds?: number;  // clamped to 2-30
}

export interface GSDPreferences {
  version?: number;
  mode?: WorkflowMode;
  always_use_skills?: string[];
  prefer_skills?: string[];
  avoid_skills?: string[];
  skill_rules?: GSDSkillRule[];
  custom_instructions?: string[];
  models?: GSDModelConfig | GSDModelConfigV2;
  skill_discovery?: SkillDiscoveryMode;
  skill_staleness_days?: number;  // Skills unused for N days get deprioritized (#599). 0 = disabled. Default: 60.
  auto_supervisor?: AutoSupervisorConfig;
  uat_dispatch?: boolean;
  unique_milestone_ids?: boolean;
  budget_ceiling?: number;
  budget_enforcement?: BudgetEnforcementMode;
  context_pause_threshold?: number;
  notifications?: NotificationPreferences;
  remote_questions?: RemoteQuestionsConfig;
  git?: GitPreferences;
  post_unit_hooks?: PostUnitHookConfig[];
  pre_dispatch_hooks?: PreDispatchHookConfig[];
  dynamic_routing?: DynamicRoutingConfig;
  token_profile?: TokenProfile;
  phases?: PhaseSkipPreferences;
  auto_visualize?: boolean;
  parallel?: import("./types.js").ParallelConfig;
  verification_commands?: string[];
  verification_auto_fix?: boolean;
  verification_max_retries?: number;
}

export interface LoadedGSDPreferences {
  path: string;
  scope: "global" | "project";
  preferences: GSDPreferences;
  /** Validation warnings (unknown keys, type mismatches, deprecations). Empty when preferences are clean. */
  warnings?: string[];
}

export function getGlobalGSDPreferencesPath(): string {
  return GLOBAL_PREFERENCES_PATH;
}

export function getLegacyGlobalGSDPreferencesPath(): string {
  return LEGACY_GLOBAL_PREFERENCES_PATH;
}

export function getProjectGSDPreferencesPath(): string {
  return PROJECT_PREFERENCES_PATH;
}

export function loadGlobalGSDPreferences(): LoadedGSDPreferences | null {
  return loadPreferencesFile(GLOBAL_PREFERENCES_PATH, "global")
    ?? loadPreferencesFile(GLOBAL_PREFERENCES_PATH_UPPERCASE, "global")
    ?? loadPreferencesFile(LEGACY_GLOBAL_PREFERENCES_PATH, "global");
}

export function loadProjectGSDPreferences(): LoadedGSDPreferences | null {
  return loadPreferencesFile(PROJECT_PREFERENCES_PATH, "project")
    ?? loadPreferencesFile(PROJECT_PREFERENCES_PATH_UPPERCASE, "project");
}

/**
 * Apply mode defaults as the lowest-priority layer.
 * Mode defaults fill in undefined fields; any explicit user value wins.
 */
export function applyModeDefaults(mode: WorkflowMode, prefs: GSDPreferences): GSDPreferences {
  const defaults = MODE_DEFAULTS[mode];
  if (!defaults) return prefs;
  return mergePreferences(defaults, prefs);
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

  // Apply mode defaults as the lowest-priority layer
  if (result.preferences.mode) {
    result = {
      ...result,
      preferences: applyModeDefaults(result.preferences.mode, result.preferences),
    };
  }

  return result;
}

// ─── Skill Reference Resolution ───────────────────────────────────────────────

export interface SkillResolution {
  /** The original reference from preferences (bare name or path). */
  original: string;
  /** The resolved absolute path to the SKILL.md file, or null if unresolved. */
  resolvedPath: string | null;
  /** How it was resolved. */
  method: "absolute-path" | "absolute-dir" | "user-skill" | "project-skill" | "unresolved";
}

export interface SkillResolutionReport {
  /** All resolution results, keyed by original reference. */
  resolutions: Map<string, SkillResolution>;
  /** References that could not be resolved. */
  warnings: string[];
}

/**
 * Known skill directories, in priority order.
 * User skills (~/.gsd/agent/skills/) take precedence over project skills.
 */
function getSkillSearchDirs(cwd: string): Array<{ dir: string; method: SkillResolution["method"] }> {
  return [
    { dir: join(getAgentDir(), "skills"), method: "user-skill" },
    { dir: join(cwd, ".pi", "agent", "skills"), method: "project-skill" },
  ];
}

/**
 * Resolve a single skill reference to an absolute path.
 *
 * Resolution order:
 * 1. Absolute path to a file → check existsSync
 * 2. Absolute path to a directory → check for SKILL.md inside
 * 3. Bare name → scan known skill directories for <name>/SKILL.md
 */
function resolveSkillReference(ref: string, cwd: string): SkillResolution {
  const trimmed = ref.trim();

  // Expand tilde
  const expanded = trimmed.startsWith("~/")
    ? join(homedir(), trimmed.slice(2))
    : trimmed;

  // Absolute path
  if (isAbsolute(expanded)) {
    // Direct file reference
    if (existsSync(expanded)) {
      // Check if it's a directory — look for SKILL.md inside
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

  // Bare name — scan known skill directories
  for (const { dir, method } of getSkillSearchDirs(cwd)) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === expanded) {
          const skillFile = join(dir, entry.name, "SKILL.md");
          if (existsSync(skillFile)) {
            return { original: ref, resolvedPath: skillFile, method };
          }
        }
      }
    } catch { /* directory not readable — skip */ }
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

/**
 * Format a skill reference for the system prompt.
 * If resolved, shows the path so the agent knows exactly where to read.
 * If unresolved, marks it clearly.
 */
function formatSkillRef(ref: string, resolutions: Map<string, SkillResolution>): string {
  const resolution = resolutions.get(ref);
  if (!resolution || resolution.method === "unresolved") {
    return `${ref} (⚠ not found — check skill name or path)`;
  }
  // For absolute paths where SKILL.md is just appended, don't clutter the output
  if (resolution.method === "absolute-path" || resolution.method === "absolute-dir") {
    return ref;
  }
  // For bare names resolved from skill directories, show the resolved path
  return `${ref} → \`${resolution.resolvedPath}\``;
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

/**
 * Resolve the skill discovery mode from effective preferences.
 * Defaults to "suggest" — skills are identified during research but not installed automatically.
 */
export function resolveSkillDiscoveryMode(): SkillDiscoveryMode {
  const prefs = loadEffectiveGSDPreferences();
  return prefs?.preferences.skill_discovery ?? "suggest";
}

/**
 * Resolve the skill staleness threshold in days.
 * Returns 0 if disabled, default 60 if not configured.
 */
export function resolveSkillStalenessDays(): number {
  const prefs = loadEffectiveGSDPreferences();
  return prefs?.preferences.skill_staleness_days ?? 60;
}

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

/**
 * Resolve which model ID to use for a given auto-mode unit type.
 * Returns undefined if no model preference is set for this unit type.
 */
export function resolveModelForUnit(unitType: string): string | undefined {
  const resolved = resolveModelWithFallbacksForUnit(unitType);
  return resolved?.primary;
}

/**
 * Resolve model and fallbacks for a given auto-mode unit type.
 * Returns the primary model and ordered fallbacks, or undefined if not configured.
 *
 * Supports both legacy string format and extended object format:
 * - Legacy: `planning: claude-opus-4-6`
 * - Extended: `planning: { model: claude-opus-4-6, fallbacks: [glm-5, minimax-m2.5] }`
 */
/**
 * Determines the next fallback model to try when the current model fails.
 * If the current model is not in the configured list, returns the primary model.
 * If the current model is the last in the list, returns undefined (exhausted).
 */
export function getNextFallbackModel(
  currentModelId: string | undefined,
  modelConfig: ResolvedModelConfig,
): string | undefined {
  const modelsToTry = [modelConfig.primary, ...modelConfig.fallbacks];

  if (!currentModelId) {
    return modelsToTry[0];
  }

  let foundCurrent = false;
  for (let i = 0; i < modelsToTry.length; i++) {
    const mId = modelsToTry[i];
    // Check for exact match or provider/model suffix match
    if (mId === currentModelId || (mId.includes("/") && mId.endsWith(`/${currentModelId}`))) {
      foundCurrent = true;
      return modelsToTry[i + 1]; // Return the next one, or undefined if at the end
    }
  }

  // If the current model wasn't in our preference list, default to starting the sequence
  if (!foundCurrent) {
    return modelsToTry[0];
  }
}

export function resolveModelWithFallbacksForUnit(unitType: string): ResolvedModelConfig | undefined {
  const prefs = loadEffectiveGSDPreferences();
  if (!prefs?.preferences.models) return undefined;
  const m = prefs.preferences.models as GSDModelConfigV2;

  let phaseConfig: string | GSDPhaseModelConfig | undefined;
  switch (unitType) {
    case "research-milestone":
    case "research-slice":
      phaseConfig = m.research;
      break;
    case "plan-milestone":
    case "plan-slice":
    case "replan-slice":
      phaseConfig = m.planning;
      break;
    case "execute-task":
      phaseConfig = m.execution;
      break;
    case "execute-task-simple":
      phaseConfig = m.execution_simple ?? m.execution;
      break;
    case "complete-slice":
    case "run-uat":
      phaseConfig = m.completion;
      break;
    default:
      // Subagent unit types (e.g., "subagent", "subagent/scout")
      if (unitType === "subagent" || unitType.startsWith("subagent/")) {
        phaseConfig = m.subagent;
        break;
      }
      return undefined;
  }

  if (!phaseConfig) return undefined;

  // Normalize: string -> { model, fallbacks: [] }
  if (typeof phaseConfig === "string") {
    return { primary: phaseConfig, fallbacks: [] };
  }

  // When provider is explicitly set, prepend it to the model ID so the
  // resolution code in auto.ts can do an explicit provider match.
  const primary = phaseConfig.provider && !phaseConfig.model.includes("/")
    ? `${phaseConfig.provider}/${phaseConfig.model}`
    : phaseConfig.model;

  return {
    primary,
    fallbacks: phaseConfig.fallbacks ?? [],
  };
}

/**
 * Resolve the dynamic routing configuration from effective preferences.
 * Returns the merged config with defaults applied.
 */
export function resolveDynamicRoutingConfig(): DynamicRoutingConfig {
  const prefs = loadEffectiveGSDPreferences();
  const configured = prefs?.preferences.dynamic_routing;
  if (!configured) return defaultRoutingConfig();
  return {
    ...defaultRoutingConfig(),
    ...configured,
  };
}

export function resolveAutoSupervisorConfig(): AutoSupervisorConfig {
  const prefs = loadEffectiveGSDPreferences();
  const configured = prefs?.preferences.auto_supervisor ?? {};

  return {
    soft_timeout_minutes: configured.soft_timeout_minutes ?? 20,
    idle_timeout_minutes: configured.idle_timeout_minutes ?? 10,
    hard_timeout_minutes: configured.hard_timeout_minutes ?? 30,
    ...(configured.model ? { model: configured.model } : {}),
  };
}

// ─── Token Profile Resolution ─────────────────────────────────────────────

const VALID_TOKEN_PROFILES = new Set<TokenProfile>(["budget", "balanced", "quality"]);

/**
 * Resolve profile defaults for a given token profile tier.
 * Returns a partial GSDPreferences that is used as the base layer —
 * explicit user preferences always override these defaults.
 */
export function resolveProfileDefaults(profile: TokenProfile): Partial<GSDPreferences> {
  switch (profile) {
    case "budget":
      return {
        models: {
          planning: "claude-sonnet-4-5-20250514",
          execution: "claude-sonnet-4-5-20250514",
          execution_simple: "claude-haiku-4-5-20250414",
          completion: "claude-haiku-4-5-20250414",
          subagent: "claude-haiku-4-5-20250414",
        },
        phases: {
          skip_research: true,
          skip_reassess: true,
          skip_slice_research: true,
          skip_milestone_validation: true,
        },
      };
    case "balanced":
      return {
        models: {
          subagent: "claude-sonnet-4-5-20250514",
        },
        phases: {
          skip_slice_research: true,
        },
      };
    case "quality":
      return {
        models: {},
        phases: {},
      };
  }
}

/**
 * Resolve the effective token profile from preferences.
 * Returns "balanced" when no profile is set (D046).
 */
export function resolveEffectiveProfile(): TokenProfile {
  const prefs = loadEffectiveGSDPreferences();
  const profile = prefs?.preferences.token_profile;
  if (profile && VALID_TOKEN_PROFILES.has(profile)) return profile;
  return "balanced";
}

/**
 * Resolve the inline level from the active token profile.
 * budget → minimal, balanced → standard, quality → full.
 */
export function resolveInlineLevel(): InlineLevel {
  const profile = resolveEffectiveProfile();
  switch (profile) {
    case "budget": return "minimal";
    case "balanced": return "standard";
    case "quality": return "full";
  }
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
  };
}

export function validatePreferences(preferences: GSDPreferences): {
  preferences: GSDPreferences;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const validated: GSDPreferences = {};

  // ─── Unknown Key Detection ──────────────────────────────────────────
  for (const key of Object.keys(preferences)) {
    if (!KNOWN_PREFERENCE_KEYS.has(key)) {
      warnings.push(`unknown preference key "${key}" — ignored`);
    }
  }

  if (preferences.version !== undefined) {
    if (preferences.version === 1) {
      validated.version = 1;
    } else {
      errors.push(`unsupported version ${preferences.version}`);
    }
  }

  // ─── Workflow Mode ──────────────────────────────────────────────────
  if (preferences.mode !== undefined) {
    const validModes = new Set<string>(["solo", "team"]);
    if (typeof preferences.mode === "string" && validModes.has(preferences.mode)) {
      validated.mode = preferences.mode as WorkflowMode;
    } else {
      errors.push(`invalid mode "${preferences.mode}" — must be one of: solo, team`);
    }
  }

  const validDiscoveryModes = new Set(["auto", "suggest", "off"]);
  if (preferences.skill_discovery) {
    if (validDiscoveryModes.has(preferences.skill_discovery)) {
      validated.skill_discovery = preferences.skill_discovery;
    } else {
      errors.push(`invalid skill_discovery value: ${preferences.skill_discovery}`);
    }
  }

  if (preferences.skill_staleness_days !== undefined) {
    const days = Number(preferences.skill_staleness_days);
    if (Number.isFinite(days) && days >= 0) {
      validated.skill_staleness_days = Math.floor(days);
    } else {
      errors.push(`invalid skill_staleness_days: must be a non-negative number`);
    }
  }

  validated.always_use_skills = normalizeStringList(preferences.always_use_skills);
  validated.prefer_skills = normalizeStringList(preferences.prefer_skills);
  validated.avoid_skills = normalizeStringList(preferences.avoid_skills);
  validated.custom_instructions = normalizeStringList(preferences.custom_instructions);

  if (preferences.skill_rules) {
    const validRules: GSDSkillRule[] = [];
    for (const rule of preferences.skill_rules) {
      if (!rule || typeof rule !== "object") {
        errors.push("invalid skill_rules entry");
        continue;
      }
      const when = typeof rule.when === "string" ? rule.when.trim() : "";
      if (!when) {
        errors.push("skill_rules entry missing when");
        continue;
      }
      const validatedRule: GSDSkillRule = { when };
      for (const action of SKILL_ACTIONS) {
        const values = normalizeStringList((rule as unknown as Record<string, unknown>)[action]);
        if (values.length > 0) {
          validatedRule[action as keyof GSDSkillRule] = values as never;
        }
      }
      if (!validatedRule.use && !validatedRule.prefer && !validatedRule.avoid) {
        errors.push(`skill rule has no actions: ${when}`);
        continue;
      }
      validRules.push(validatedRule);
    }
    if (validRules.length > 0) {
      validated.skill_rules = validRules;
    }
  }

  for (const key of ["always_use_skills", "prefer_skills", "avoid_skills", "custom_instructions"] as const) {
    if (validated[key] && validated[key]!.length === 0) {
      delete validated[key];
    }
  }

  if (preferences.uat_dispatch !== undefined) {
    validated.uat_dispatch = !!preferences.uat_dispatch;
  }

  if (preferences.unique_milestone_ids !== undefined) {
    validated.unique_milestone_ids = !!preferences.unique_milestone_ids;
  }

  if (preferences.budget_ceiling !== undefined) {
    const raw = preferences.budget_ceiling;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      validated.budget_ceiling = raw;
    } else if (typeof raw === "string" && Number.isFinite(Number(raw))) {
      validated.budget_ceiling = Number(raw);
    } else {
      errors.push("budget_ceiling must be a finite number");
    }
  }

  // ─── Budget Enforcement ──────────────────────────────────────────────
  if (preferences.budget_enforcement !== undefined) {
    const validModes = new Set(["warn", "pause", "halt"]);
    if (typeof preferences.budget_enforcement === "string" && validModes.has(preferences.budget_enforcement)) {
      validated.budget_enforcement = preferences.budget_enforcement;
    } else {
      errors.push(`budget_enforcement must be one of: warn, pause, halt`);
    }
  }

  // ─── Token Profile ─────────────────────────────────────────────────
  if (preferences.token_profile !== undefined) {
    if (typeof preferences.token_profile === "string" && VALID_TOKEN_PROFILES.has(preferences.token_profile as TokenProfile)) {
      validated.token_profile = preferences.token_profile as TokenProfile;
    } else {
      errors.push(`token_profile must be one of: budget, balanced, quality`);
    }
  }

  // ─── Phase Skip Preferences ─────────────────────────────────────────
  if (preferences.phases !== undefined) {
    if (typeof preferences.phases === "object" && preferences.phases !== null) {
      const validatedPhases: PhaseSkipPreferences = {};
      const p = preferences.phases as Record<string, unknown>;
      if (p.skip_research !== undefined) validatedPhases.skip_research = !!p.skip_research;
      if (p.skip_reassess !== undefined) validatedPhases.skip_reassess = !!p.skip_reassess;
      if (p.skip_slice_research !== undefined) validatedPhases.skip_slice_research = !!p.skip_slice_research;
      if (p.skip_milestone_validation !== undefined) validatedPhases.skip_milestone_validation = !!p.skip_milestone_validation;
      if ((p as any).require_slice_discussion !== undefined) (validatedPhases as any).require_slice_discussion = !!(p as any).require_slice_discussion;
      // Warn on unknown phase keys
      const knownPhaseKeys = new Set(["skip_research", "skip_reassess", "skip_slice_research", "skip_milestone_validation", "require_slice_discussion"]);
      for (const key of Object.keys(p)) {
        if (!knownPhaseKeys.has(key)) {
          warnings.push(`unknown phases key "${key}" — ignored`);
        }
      }
      validated.phases = validatedPhases;
    } else {
      errors.push(`phases must be an object`);
    }
  }

  // ─── Context Pause Threshold ────────────────────────────────────────
  if (preferences.context_pause_threshold !== undefined) {
    const raw = preferences.context_pause_threshold;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      validated.context_pause_threshold = raw;
    } else if (typeof raw === "string" && Number.isFinite(Number(raw))) {
      validated.context_pause_threshold = Number(raw);
    } else {
      errors.push("context_pause_threshold must be a finite number");
    }
  }

  // ─── Models ─────────────────────────────────────────────────────────
  if (preferences.models !== undefined) {
    if (preferences.models && typeof preferences.models === "object") {
      validated.models = preferences.models;
    } else {
      errors.push("models must be an object");
    }
  }

  // ─── Auto Supervisor ────────────────────────────────────────────────
  if (preferences.auto_supervisor !== undefined) {
    if (preferences.auto_supervisor && typeof preferences.auto_supervisor === "object") {
      validated.auto_supervisor = preferences.auto_supervisor;
    } else {
      errors.push("auto_supervisor must be an object");
    }
  }

  // ─── Notifications ──────────────────────────────────────────────────
  if (preferences.notifications !== undefined) {
    if (preferences.notifications && typeof preferences.notifications === "object") {
      validated.notifications = preferences.notifications;
    } else {
      errors.push("notifications must be an object");
    }
  }

  // ─── Remote Questions ───────────────────────────────────────────────
  if (preferences.remote_questions !== undefined) {
    if (preferences.remote_questions && typeof preferences.remote_questions === "object") {
      validated.remote_questions = preferences.remote_questions;
    } else {
      errors.push("remote_questions must be an object");
    }
  }

  // ─── Post-Unit Hooks ─────────────────────────────────────────────────
  if (preferences.post_unit_hooks && Array.isArray(preferences.post_unit_hooks)) {
    const validHooks: PostUnitHookConfig[] = [];
    const seenNames = new Set<string>();
    const knownUnitTypes = new Set([
      "research-milestone", "plan-milestone", "research-slice", "plan-slice",
      "execute-task", "complete-slice", "replan-slice", "reassess-roadmap",
      "run-uat", "complete-milestone",
    ]);
    for (const hook of preferences.post_unit_hooks) {
      if (!hook || typeof hook !== "object") {
        errors.push("post_unit_hooks entry must be an object");
        continue;
      }
      const name = typeof hook.name === "string" ? hook.name.trim() : "";
      if (!name) {
        errors.push("post_unit_hooks entry missing name");
        continue;
      }
      if (seenNames.has(name)) {
        errors.push(`duplicate post_unit_hooks name: ${name}`);
        continue;
      }
      const after = normalizeStringList(hook.after);
      if (after.length === 0) {
        errors.push(`post_unit_hooks "${name}" missing after`);
        continue;
      }
      for (const ut of after) {
        if (!knownUnitTypes.has(ut)) {
          errors.push(`post_unit_hooks "${name}" unknown unit type in after: ${ut}`);
        }
      }
      const prompt = typeof hook.prompt === "string" ? hook.prompt.trim() : "";
      if (!prompt) {
        errors.push(`post_unit_hooks "${name}" missing prompt`);
        continue;
      }
      const validHook: PostUnitHookConfig = { name, after, prompt };
      if (hook.max_cycles !== undefined) {
        const mc = typeof hook.max_cycles === "number" ? hook.max_cycles : Number(hook.max_cycles);
        validHook.max_cycles = Number.isFinite(mc) ? Math.max(1, Math.min(10, Math.round(mc))) : 1;
      }
      if (typeof hook.model === "string" && hook.model.trim()) {
        validHook.model = hook.model.trim();
      }
      if (typeof hook.artifact === "string" && hook.artifact.trim()) {
        validHook.artifact = hook.artifact.trim();
      }
      if (typeof hook.retry_on === "string" && hook.retry_on.trim()) {
        validHook.retry_on = hook.retry_on.trim();
      }
      if (typeof hook.agent === "string" && hook.agent.trim()) {
        validHook.agent = hook.agent.trim();
      }
      if (hook.enabled !== undefined) {
        validHook.enabled = !!hook.enabled;
      }
      seenNames.add(name);
      validHooks.push(validHook);
    }
    if (validHooks.length > 0) {
      validated.post_unit_hooks = validHooks;
    }
  }

  // ─── Pre-Dispatch Hooks ─────────────────────────────────────────────────
  if (preferences.pre_dispatch_hooks && Array.isArray(preferences.pre_dispatch_hooks)) {
    const validPreHooks: PreDispatchHookConfig[] = [];
    const seenPreNames = new Set<string>();
    const knownUnitTypes = new Set([
      "research-milestone", "plan-milestone", "research-slice", "plan-slice",
      "execute-task", "complete-slice", "replan-slice", "reassess-roadmap",
      "run-uat", "complete-milestone",
    ]);
    const validActions = new Set(["modify", "skip", "replace"]);
    for (const hook of preferences.pre_dispatch_hooks) {
      if (!hook || typeof hook !== "object") {
        errors.push("pre_dispatch_hooks entry must be an object");
        continue;
      }
      const name = typeof hook.name === "string" ? hook.name.trim() : "";
      if (!name) {
        errors.push("pre_dispatch_hooks entry missing name");
        continue;
      }
      if (seenPreNames.has(name)) {
        errors.push(`duplicate pre_dispatch_hooks name: ${name}`);
        continue;
      }
      const before = normalizeStringList(hook.before);
      if (before.length === 0) {
        errors.push(`pre_dispatch_hooks "${name}" missing before`);
        continue;
      }
      for (const ut of before) {
        if (!knownUnitTypes.has(ut)) {
          errors.push(`pre_dispatch_hooks "${name}" unknown unit type in before: ${ut}`);
        }
      }
      const action = typeof hook.action === "string" ? hook.action.trim() : "";
      if (!validActions.has(action)) {
        errors.push(`pre_dispatch_hooks "${name}" invalid action: ${action} (must be modify, skip, or replace)`);
        continue;
      }
      const validHook: PreDispatchHookConfig = { name, before, action: action as PreDispatchHookConfig["action"] };
      if (typeof hook.prepend === "string" && hook.prepend.trim()) validHook.prepend = hook.prepend.trim();
      if (typeof hook.append === "string" && hook.append.trim()) validHook.append = hook.append.trim();
      if (typeof hook.prompt === "string" && hook.prompt.trim()) validHook.prompt = hook.prompt.trim();
      if (typeof hook.unit_type === "string" && hook.unit_type.trim()) validHook.unit_type = hook.unit_type.trim();
      if (typeof hook.skip_if === "string" && hook.skip_if.trim()) validHook.skip_if = hook.skip_if.trim();
      if (typeof hook.model === "string" && hook.model.trim()) validHook.model = hook.model.trim();
      if (hook.enabled !== undefined) validHook.enabled = !!hook.enabled;

      // Validation: action-specific required fields
      if (action === "replace" && !validHook.prompt) {
        errors.push(`pre_dispatch_hooks "${name}" action "replace" requires prompt`);
        continue;
      }
      if (action === "modify" && !validHook.prepend && !validHook.append) {
        errors.push(`pre_dispatch_hooks "${name}" action "modify" requires prepend or append`);
        continue;
      }

      seenPreNames.add(name);
      validPreHooks.push(validHook);
    }
    if (validPreHooks.length > 0) {
      validated.pre_dispatch_hooks = validPreHooks;
    }
  }

  // ─── Dynamic Routing ─────────────────────────────────────────────────
  if (preferences.dynamic_routing !== undefined) {
    if (typeof preferences.dynamic_routing === "object" && preferences.dynamic_routing !== null) {
      const dr = preferences.dynamic_routing as unknown as Record<string, unknown>;
      const validDr: Partial<DynamicRoutingConfig> = {};

      if (dr.enabled !== undefined) {
        if (typeof dr.enabled === "boolean") validDr.enabled = dr.enabled;
        else errors.push("dynamic_routing.enabled must be a boolean");
      }
      if (dr.escalate_on_failure !== undefined) {
        if (typeof dr.escalate_on_failure === "boolean") validDr.escalate_on_failure = dr.escalate_on_failure;
        else errors.push("dynamic_routing.escalate_on_failure must be a boolean");
      }
      if (dr.budget_pressure !== undefined) {
        if (typeof dr.budget_pressure === "boolean") validDr.budget_pressure = dr.budget_pressure;
        else errors.push("dynamic_routing.budget_pressure must be a boolean");
      }
      if (dr.cross_provider !== undefined) {
        if (typeof dr.cross_provider === "boolean") validDr.cross_provider = dr.cross_provider;
        else errors.push("dynamic_routing.cross_provider must be a boolean");
      }
      if (dr.hooks !== undefined) {
        if (typeof dr.hooks === "boolean") validDr.hooks = dr.hooks;
        else errors.push("dynamic_routing.hooks must be a boolean");
      }
      if (dr.tier_models !== undefined) {
        if (typeof dr.tier_models === "object" && dr.tier_models !== null) {
          const tm = dr.tier_models as Record<string, unknown>;
          const validTm: Record<string, string> = {};
          for (const tier of ["light", "standard", "heavy"]) {
            if (tm[tier] !== undefined) {
              if (typeof tm[tier] === "string") validTm[tier] = tm[tier] as string;
              else errors.push(`dynamic_routing.tier_models.${tier} must be a string`);
            }
          }
          if (Object.keys(validTm).length > 0) validDr.tier_models = validTm as DynamicRoutingConfig["tier_models"];
        } else {
          errors.push("dynamic_routing.tier_models must be an object");
        }
      }

      if (Object.keys(validDr).length > 0) {
        validated.dynamic_routing = validDr as unknown as DynamicRoutingConfig;
      }
    } else {
      errors.push("dynamic_routing must be an object");
    }
  }

  // ─── Parallel Config ────────────────────────────────────────────────────
  if (preferences.parallel && typeof preferences.parallel === "object") {
    const p = preferences.parallel as unknown as Record<string, unknown>;
    const parallel: Record<string, unknown> = {};

    if (p.enabled !== undefined) {
      if (typeof p.enabled === "boolean") parallel.enabled = p.enabled;
      else errors.push("parallel.enabled must be a boolean");
    }
    if (p.max_workers !== undefined) {
      if (typeof p.max_workers === "number" && p.max_workers >= 1 && p.max_workers <= 4) {
        parallel.max_workers = Math.floor(p.max_workers);
      } else {
        errors.push("parallel.max_workers must be a number between 1 and 4");
      }
    }
    if (p.budget_ceiling !== undefined) {
      if (typeof p.budget_ceiling === "number" && p.budget_ceiling > 0) {
        parallel.budget_ceiling = p.budget_ceiling;
      } else {
        errors.push("parallel.budget_ceiling must be a positive number");
      }
    }
    if (p.merge_strategy !== undefined) {
      const validStrategies = new Set(["per-slice", "per-milestone"]);
      if (typeof p.merge_strategy === "string" && validStrategies.has(p.merge_strategy)) {
        parallel.merge_strategy = p.merge_strategy;
      } else {
        errors.push("parallel.merge_strategy must be one of: per-slice, per-milestone");
      }
    }
    if (p.auto_merge !== undefined) {
      const validModes = new Set(["auto", "confirm", "manual"]);
      if (typeof p.auto_merge === "string" && validModes.has(p.auto_merge)) {
        parallel.auto_merge = p.auto_merge;
      } else {
        errors.push("parallel.auto_merge must be one of: auto, confirm, manual");
      }
    }

    if (Object.keys(parallel).length > 0) {
      validated.parallel = parallel as unknown as import("./types.js").ParallelConfig;
    }
  }

  // ─── Verification Preferences ───────────────────────────────────────────
  if (preferences.verification_commands !== undefined) {
    if (Array.isArray(preferences.verification_commands)) {
      const allStrings = preferences.verification_commands.every(
        (item: unknown) => typeof item === "string",
      );
      if (allStrings) {
        validated.verification_commands = preferences.verification_commands;
      } else {
        errors.push("verification_commands must be an array of strings");
      }
    } else {
      errors.push("verification_commands must be an array of strings");
    }
  }

  if (preferences.verification_auto_fix !== undefined) {
    if (typeof preferences.verification_auto_fix === "boolean") {
      validated.verification_auto_fix = preferences.verification_auto_fix;
    } else {
      errors.push("verification_auto_fix must be a boolean");
    }
  }

  if (preferences.verification_max_retries !== undefined) {
    const raw = preferences.verification_max_retries;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      validated.verification_max_retries = Math.floor(raw);
    } else {
      errors.push("verification_max_retries must be a non-negative number");
    }
  }

  // ─── Git Preferences ───────────────────────────────────────────────────
  if (preferences.git && typeof preferences.git === "object") {
    const git: Record<string, unknown> = {};
    const g = preferences.git as Record<string, unknown>;

    if (g.auto_push !== undefined) {
      if (typeof g.auto_push === "boolean") git.auto_push = g.auto_push;
      else errors.push("git.auto_push must be a boolean");
    }
    if (g.push_branches !== undefined) {
      if (typeof g.push_branches === "boolean") git.push_branches = g.push_branches;
      else errors.push("git.push_branches must be a boolean");
    }
    if (g.remote !== undefined) {
      if (typeof g.remote === "string" && g.remote.trim() !== "") git.remote = g.remote.trim();
      else errors.push("git.remote must be a non-empty string");
    }
    if (g.snapshots !== undefined) {
      if (typeof g.snapshots === "boolean") git.snapshots = g.snapshots;
      else errors.push("git.snapshots must be a boolean");
    }
    if (g.pre_merge_check !== undefined) {
      if (typeof g.pre_merge_check === "boolean") {
        git.pre_merge_check = g.pre_merge_check;
      } else if (typeof g.pre_merge_check === "string" && g.pre_merge_check.trim() !== "") {
        git.pre_merge_check = g.pre_merge_check.trim();
      } else {
        errors.push("git.pre_merge_check must be a boolean or a non-empty string command");
      }
    }
    if (g.commit_type !== undefined) {
      const validCommitTypes = new Set([
        "feat", "fix", "refactor", "docs", "test", "chore", "perf", "ci", "build", "style",
      ]);
      if (typeof g.commit_type === "string" && validCommitTypes.has(g.commit_type)) {
        git.commit_type = g.commit_type;
      } else {
        errors.push(`git.commit_type must be one of: feat, fix, refactor, docs, test, chore, perf, ci, build, style`);
      }
    }
    if (g.merge_strategy !== undefined) {
      const validStrategies = new Set(["squash", "merge"]);
      if (typeof g.merge_strategy === "string" && validStrategies.has(g.merge_strategy)) {
        git.merge_strategy = g.merge_strategy as "squash" | "merge";
      } else {
        errors.push("git.merge_strategy must be one of: squash, merge");
      }
    }
    if (g.main_branch !== undefined) {
      if (typeof g.main_branch === "string" && g.main_branch.trim() !== "" && VALID_BRANCH_NAME.test(g.main_branch)) {
        git.main_branch = g.main_branch;
      } else {
        errors.push("git.main_branch must be a valid branch name (alphanumeric, _, -, /, .)");
      }
    }
    if (g.isolation !== undefined) {
      const validIsolation = new Set(["worktree", "branch", "none"]);
      if (typeof g.isolation === "string" && validIsolation.has(g.isolation)) {
        git.isolation = g.isolation as "worktree" | "branch" | "none";
      } else {
        errors.push("git.isolation must be one of: worktree, branch, none");
      }
    }
    if (g.commit_docs !== undefined) {
      if (typeof g.commit_docs === "boolean") git.commit_docs = g.commit_docs;
      else errors.push("git.commit_docs must be a boolean");
    }
    if (g.worktree_post_create !== undefined) {
      if (typeof g.worktree_post_create === "string" && g.worktree_post_create.trim()) {
        git.worktree_post_create = g.worktree_post_create.trim();
      } else {
        errors.push("git.worktree_post_create must be a non-empty string (path to script)");
      }
    }
    // Deprecated: merge_to_main is ignored (branchless architecture).
    if (g.merge_to_main !== undefined) {
      warnings.push("git.merge_to_main is deprecated — milestone-level merge is now always used. Remove this setting.");
    }

    if (Object.keys(git).length > 0) {
      validated.git = git as GitPreferences;
    }
  }

  return { preferences: validated, errors, warnings };
}

function mergeStringLists(base?: unknown, override?: unknown): string[] | undefined {
  const merged = [
    ...normalizeStringList(base),
    ...normalizeStringList(override),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
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

/**
 * Resolve enabled post-unit hooks from effective preferences.
 * Returns an empty array when no hooks are configured.
 */
export function resolvePostUnitHooks(): PostUnitHookConfig[] {
  const prefs = loadEffectiveGSDPreferences();
  return (prefs?.preferences.post_unit_hooks ?? [])
    .filter(h => h.enabled !== false);
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

/**
 * Resolve enabled pre-dispatch hooks from effective preferences.
 * Returns an empty array when no hooks are configured.
 */
export function resolvePreDispatchHooks(): PreDispatchHookConfig[] {
  const prefs = loadEffectiveGSDPreferences();
  return (prefs?.preferences.pre_dispatch_hooks ?? [])
    .filter(h => h.enabled !== false);
}

/**
 * Validate a model ID string.
 * Returns true if the ID looks like a valid model identifier.
 */
export function validateModelId(modelId: string): boolean {
  if (!modelId || typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  // Allow alphanumeric, hyphens, underscores, dots, slashes, colons
  return /^[a-zA-Z0-9\-_./:]+$/.test(trimmed);
}

/**
 * Update the models section of the global GSD preferences file.
 * Performs a safe read-modify-write: reads current content, updates the models
 * YAML block, and writes back. Creates the file if it doesn't exist.
 */
export function updatePreferencesModels(models: GSDModelConfigV2): void {
  const prefsPath = getGlobalGSDPreferencesPath();

  let content = "";
  if (existsSync(prefsPath)) {
    content = readFileSync(prefsPath, "utf-8");
  }

  // Build the new models block
  const lines: string[] = ["models:"];
  for (const [phase, value] of Object.entries(models)) {
    if (typeof value === "string") {
      lines.push(`  ${phase}: ${value}`);
    } else if (value && typeof value === "object") {
      const config = value as GSDPhaseModelConfig;
      lines.push(`  ${phase}:`);
      lines.push(`    model: ${config.model}`);
      if (config.provider) {
        lines.push(`    provider: ${config.provider}`);
      }
      if (config.fallbacks && config.fallbacks.length > 0) {
        lines.push(`    fallbacks:`);
        for (const fb of config.fallbacks) {
          lines.push(`      - ${fb}`);
        }
      }
    }
  }
  const modelsBlock = lines.join("\n");

  // Replace existing models block or append
  const modelsRegex = /^models:[\s\S]*?(?=\n[a-z_]|\n*$)/m;
  if (modelsRegex.test(content)) {
    content = content.replace(modelsRegex, modelsBlock);
  } else {
    content = content.trimEnd() + "\n\n" + modelsBlock + "\n";
  }

  writeFileSync(prefsPath, content, "utf-8");
}

// ─── Parallel Config Resolver ──────────────────────────────────────────────

export function resolveParallelConfig(prefs: GSDPreferences | undefined): import("./types.js").ParallelConfig {
  return {
    enabled: prefs?.parallel?.enabled ?? false,
    max_workers: Math.max(1, Math.min(4, prefs?.parallel?.max_workers ?? 2)),
    budget_ceiling: prefs?.parallel?.budget_ceiling,
    merge_strategy: prefs?.parallel?.merge_strategy ?? "per-milestone",
    auto_merge: prefs?.parallel?.auto_merge ?? "confirm",
  };
}
