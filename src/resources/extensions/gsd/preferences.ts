import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const GLOBAL_PREFERENCES_PATH = join(homedir(), ".gsd", "preferences.md");
const LEGACY_GLOBAL_PREFERENCES_PATH = join(homedir(), ".pi", "agent", "gsd-preferences.md");
const PROJECT_PREFERENCES_PATH = join(process.cwd(), ".gsd", "preferences.md");
const SKILL_ACTIONS = new Set(["use", "prefer", "avoid"]);

export interface GSDSkillRule {
  when: string;
  use?: string[];
  prefer?: string[];
  avoid?: string[];
}

export interface GSDModelConfig {
  research?: string;   // e.g. "claude-sonnet-4-6"
  planning?: string;   // e.g. "claude-opus-4-6"
  execution?: string;  // e.g. "claude-sonnet-4-6"
  completion?: string; // e.g. "claude-sonnet-4-6"
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
  budget_ceiling?: number;
  remote_questions?: RemoteQuestionsConfig;
  main_branch?: string;
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

/**
 * Get the configured main branch from preferences.
 * Checks project preferences first, then global, then defaults to "main".
 */
export function getConfiguredMainBranch(basePath: string): string {
  const prefs = loadProjectGSDPreferences();
  if (prefs?.preferences?.main_branch) {
    return prefs.preferences.main_branch;
  }
  const globalPrefs = loadGlobalGSDPreferences();
  if (globalPrefs?.preferences?.main_branch) {
    return globalPrefs.preferences.main_branch;
  }
  return "main";
}

export function loadGlobalGSDPreferences(): LoadedGSDPreferences | null {
  return loadPreferencesFile(GLOBAL_PREFERENCES_PATH, "global")
    ?? loadPreferencesFile(LEGACY_GLOBAL_PREFERENCES_PATH, "global");
}

export function loadProjectGSDPreferences(): LoadedGSDPreferences | null {
  return loadPreferencesFile(PROJECT_PREFERENCES_PATH, "project");
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

function parseScalar(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    // Keep large integers (e.g. Discord channel IDs) as strings to avoid precision loss
    if (Number.isSafeInteger(n)) return n;
    return value;
  }
  return value.replace(/^['\"]|['\"]$/g, "");
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
  const prefs = loadEffectiveGSDPreferences();
  if (!prefs?.preferences.models) return undefined;
  const m = prefs.preferences.models;

  switch (unitType) {
    case "research-milestone":
    case "research-slice":
      return m.research;
    case "plan-milestone":
    case "plan-slice":
    case "replan-slice":
      return m.planning;
    case "execute-task":
      return m.execution;
    case "complete-slice":
    case "run-uat":
      return m.completion;
    default:
      return undefined;
  }
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
    budget_ceiling: override.budget_ceiling ?? base.budget_ceiling,
    remote_questions: override.remote_questions
      ? { ...(base.remote_questions ?? {}), ...override.remote_questions }
      : base.remote_questions,
  };
}

function validatePreferences(preferences: GSDPreferences): {
  preferences: GSDPreferences;
  errors: string[];
} {
  const errors: string[] = [];
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
        const values = normalizeStringList((rule as Record<string, unknown>)[action]);
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

  return { preferences: validated, errors };
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
