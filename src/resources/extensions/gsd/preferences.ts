import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@gsd/pi-coding-agent";
import type { GitPreferences } from "./git-service.js";
import type { PostUnitHookConfig, PreDispatchHookConfig, BudgetEnforcementMode, NotificationPreferences } from "./types.js";
import { VALID_BRANCH_NAME } from "./git-service.js";

const GLOBAL_PREFERENCES_PATH = join(homedir(), ".gsd", "preferences.md");
const LEGACY_GLOBAL_PREFERENCES_PATH = join(homedir(), ".pi", "agent", "gsd-preferences.md");
const PROJECT_PREFERENCES_PATH = join(process.cwd(), ".gsd", "preferences.md");
// Bootstrap in gitignore.ts historically created PREFERENCES.md (uppercase) by mistake.
// Check uppercase as a fallback so those files aren't silently ignored.
const GLOBAL_PREFERENCES_PATH_UPPERCASE = join(homedir(), ".gsd", "PREFERENCES.md");
const PROJECT_PREFERENCES_PATH_UPPERCASE = join(process.cwd(), ".gsd", "PREFERENCES.md");
const SKILL_ACTIONS = new Set(["use", "prefer", "avoid"]);

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
  completion?: string;
}

/**
 * Extended model config with per-phase fallback support.
 * Each phase can specify a primary model and ordered fallbacks.
 */
export interface GSDModelConfigV2 {
  research?: string | GSDPhaseModelConfig;
  planning?: string | GSDPhaseModelConfig;
  execution?: string | GSDPhaseModelConfig;
  completion?: string | GSDPhaseModelConfig;
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
  channel: "slack" | "discord";
  channel_id: string | number;
  timeout_minutes?: number;        // clamped to 1-30
  poll_interval_seconds?: number;  // clamped to 2-30
}

export interface GSDPreferences {
  version?: number;
  always_use_skills?: string[];
  prefer_skills?: string[];
  avoid_skills?: string[];
  skill_rules?: GSDSkillRule[];
  custom_instructions?: string[];
  models?: GSDModelConfig;
  skill_discovery?: SkillDiscoveryMode;
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
}

export interface LoadedGSDPreferences {
  path: string;
  scope: "global" | "project";
  preferences: GSDPreferences;
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

export function loadEffectiveGSDPreferences(): LoadedGSDPreferences | null {
  const globalPreferences = loadGlobalGSDPreferences();
  const projectPreferences = loadProjectGSDPreferences();

  if (!globalPreferences && !projectPreferences) return null;
  if (!globalPreferences) return projectPreferences;
  if (!projectPreferences) return globalPreferences;

  return {
    path: projectPreferences.path,
    scope: "project",
    preferences: mergePreferences(globalPreferences.preferences, projectPreferences.preferences),
  };
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

  return {
    path,
    scope,
    preferences,
  };
}

function parsePreferencesMarkdown(content: string): GSDPreferences | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return parseFrontmatterBlock(match[1]);
}

function parseFrontmatterBlock(frontmatter: string): GSDPreferences {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];

  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].value;
    const keyMatch = trimmed.match(/^([A-Za-z0-9_]+):(.*)$/);
    if (!keyMatch) continue;

    const [, key, remainder] = keyMatch;
    const valuePart = remainder.trim();

    if (valuePart === "") {
      const nextLine = lines[i + 1] ?? "";
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed.startsWith("- ")) {
        const items: unknown[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const candidate = lines[j];
          const candidateIndent = candidate.match(/^\s*/)?.[0].length ?? 0;
          const candidateTrimmed = candidate.trim();
          if (!candidateTrimmed) {
            j++;
            continue;
          }
          if (candidateIndent <= indent || !candidateTrimmed.startsWith("- ")) break;

          const itemText = candidateTrimmed.slice(2).trim();
          const nextCandidate = lines[j + 1] ?? "";
          const nextCandidateIndent = nextCandidate.match(/^\s*/)?.[0].length ?? 0;
          const nextCandidateTrimmed = nextCandidate.trim();

          if (itemText.includes(":") || (nextCandidateTrimmed && nextCandidateIndent > candidateIndent)) {
            const obj: Record<string, unknown> = {};
            const firstMatch = itemText.match(/^([A-Za-z0-9_]+):(.*)$/);
            if (firstMatch) {
              obj[firstMatch[1]] = parseScalar(firstMatch[2].trim());
            }
            j++;
            while (j < lines.length) {
              const nested = lines[j];
              const nestedIndent = nested.match(/^\s*/)?.[0].length ?? 0;
              const nestedTrimmed = nested.trim();
              if (!nestedTrimmed) {
                j++;
                continue;
              }
              if (nestedIndent <= candidateIndent) break;
              const nestedMatch = nestedTrimmed.match(/^([A-Za-z0-9_]+):(.*)$/);
              if (nestedMatch) {
                const nestedValue = nestedMatch[2].trim();
                if (nestedValue === "") {
                  const nestedItems: string[] = [];
                  j++;
                  while (j < lines.length) {
                    const nestedArrayLine = lines[j];
                    const nestedArrayIndent = nestedArrayLine.match(/^\s*/)?.[0].length ?? 0;
                    const nestedArrayTrimmed = nestedArrayLine.trim();
                    if (!nestedArrayTrimmed) {
                      j++;
                      continue;
                    }
                    if (nestedArrayIndent <= nestedIndent || !nestedArrayTrimmed.startsWith("- ")) break;
                    nestedItems.push(String(parseScalar(nestedArrayTrimmed.slice(2).trim())));
                    j++;
                  }
                  obj[nestedMatch[1]] = nestedItems;
                  continue;
                }
                obj[nestedMatch[1]] = parseScalar(nestedValue);
              }
              j++;
            }
            items.push(obj);
            continue;
          }

          items.push(parseScalar(itemText));
          j++;
        }
        current[key] = items;
        i = j - 1;
      } else {
        const obj: Record<string, unknown> = {};
        current[key] = obj;
        stack.push({ indent, value: obj });
      }
      continue;
    }

    current[key] = parseScalar(valuePart);
  }

  return root as GSDPreferences;
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  // Recognize empty array/object literals (with or without surrounding quotes)
  const unquoted = value.replace(/^['\"]|['\"]$/g, "");
  if (unquoted === "[]") return [];
  if (unquoted === "{}") return {};
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    // Keep large integers (e.g. Discord channel IDs) as strings to avoid precision loss
    if (Number.isSafeInteger(n)) return n;
    return value;
  }
  return unquoted;
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
    case "complete-slice":
    case "run-uat":
      phaseConfig = m.completion;
      break;
    default:
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

function mergePreferences(base: GSDPreferences, override: GSDPreferences): GSDPreferences {
  return {
    version: override.version ?? base.version,
    always_use_skills: mergeStringLists(base.always_use_skills, override.always_use_skills),
    prefer_skills: mergeStringLists(base.prefer_skills, override.prefer_skills),
    avoid_skills: mergeStringLists(base.avoid_skills, override.avoid_skills),
    skill_rules: [...(base.skill_rules ?? []), ...(override.skill_rules ?? [])],
    custom_instructions: mergeStringLists(base.custom_instructions, override.custom_instructions),
    models: { ...(base.models ?? {}), ...(override.models ?? {}) },
    skill_discovery: override.skill_discovery ?? base.skill_discovery,
    auto_supervisor: { ...(base.auto_supervisor ?? {}), ...(override.auto_supervisor ?? {}) },
    uat_dispatch: override.uat_dispatch ?? base.uat_dispatch,
    unique_milestone_ids: override.unique_milestone_ids ?? base.unique_milestone_ids,
    budget_ceiling: override.budget_ceiling ?? base.budget_ceiling,
    remote_questions: override.remote_questions
      ? { ...(base.remote_questions ?? {}), ...override.remote_questions }
      : base.remote_questions,
    git: (base.git || override.git)
      ? { ...(base.git ?? {}), ...(override.git ?? {}) }
      : undefined,
    post_unit_hooks: mergePostUnitHooks(base.post_unit_hooks, override.post_unit_hooks),
    pre_dispatch_hooks: mergePreDispatchHooks(base.pre_dispatch_hooks, override.pre_dispatch_hooks),
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

  if (preferences.version !== undefined) {
    if (preferences.version === 1) {
      validated.version = 1;
    } else {
      errors.push(`unsupported version ${preferences.version}`);
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
    // Deprecated: isolation and merge_to_main are ignored (branchless architecture).
    // Emit warnings so users know to remove them from preferences.
    if (g.isolation !== undefined) {
      warnings.push("git.isolation is deprecated — worktree isolation is now always enabled. Remove this setting.");
    }
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
