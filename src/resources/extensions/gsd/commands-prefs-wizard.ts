/**
 * GSD Preferences Wizard — TUI wizard for configuring GSD preferences.
 *
 * Contains: handlePrefsWizard, buildCategorySummaries, all configure* functions,
 * serializePreferencesToFrontmatter, yamlSafeString, ensurePreferencesFile,
 * handlePrefsMode, handleImportClaude, handlePrefs
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getGlobalGSDPreferencesPath,
  getLegacyGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  loadGlobalGSDPreferences,
  loadProjectGSDPreferences,
  loadEffectiveGSDPreferences,
  resolveAllSkillReferences,
} from "./preferences.js";
import { loadFile, saveFile, splitFrontmatter, parseFrontmatterMap } from "./files.js";
import { runClaudeImportFlow } from "./claude-import.js";

/** Extract body content after frontmatter closing delimiter, or null if none. */
function extractBodyAfterFrontmatter(content: string): string | null {
  const closingIdx = content.indexOf("\n---", content.indexOf("---"));
  if (closingIdx === -1) return null;
  const afterFrontmatter = content.slice(closingIdx + 4);
  return afterFrontmatter.trim() ? afterFrontmatter : null;
}

// ─── Numeric validation helpers ──────────────────────────────────────────────

/** Parse a string as a non-negative integer, or return null on failure. */
function tryParseInteger(val: string): number | null {
  return /^\d+$/.test(val) ? Number(val) : null;
}

/** Parse a string as a finite number, or return null on failure. */
function tryParseNumber(val: string): number | null {
  const n = Number(val);
  return !isNaN(n) && isFinite(n) ? n : null;
}

/** Parse a string as a number in the 0–100 range, or return null on failure. */
function tryParsePercentage(val: string): number | null {
  const n = Number(val);
  return !isNaN(n) && n >= 0 && n <= 100 ? n : null;
}

// ─── Prompt helpers (reduce boilerplate across configure* functions) ─────────

/** Ask for a boolean; returns the chosen value, or undefined if user kept current/escaped. */
async function promptBoolean(
  ctx: ExtensionCommandContext,
  label: string,
  current: unknown,
  defaultVal?: boolean,
): Promise<boolean | undefined> {
  const currentStr = typeof current === "boolean" ? String(current) : "";
  const suffix = currentStr
    ? ` (current: ${currentStr})`
    : defaultVal !== undefined ? ` (default: ${defaultVal})` : "";
  const choice = await ctx.ui.select(`${label}${suffix}:`, ["true", "false", "(keep current)"]);
  if (!choice || choice === "(keep current)") return undefined;
  return choice === "true";
}

/** Ask for an enum-style value; returns the chosen string, or undefined if kept. */
async function promptEnum(
  ctx: ExtensionCommandContext,
  label: string,
  current: unknown,
  values: readonly string[],
  defaultVal?: string,
): Promise<string | undefined> {
  const currentStr = typeof current === "string" ? current : "";
  const suffix = currentStr
    ? ` (current: ${currentStr})`
    : defaultVal ? ` (default: ${defaultVal})` : "";
  const options = [...values, "(keep current)"];
  const choice = await ctx.ui.select(`${label}${suffix}:`, options);
  if (!choice || typeof choice !== "string" || choice === "(keep current)") return undefined;
  return choice;
}

/**
 * Ask for a non-negative integer.
 * Returns parsed number on success; "clear" when the user explicitly cleared an existing value;
 * undefined on escape, empty-with-no-existing-value, or invalid input (warning emitted in the invalid case).
 */
async function promptInteger(
  ctx: ExtensionCommandContext,
  label: string,
  current: unknown,
  defaultVal?: string,
): Promise<number | "clear" | undefined> {
  const hadValue = current !== undefined && current !== null;
  const currentStr = hadValue ? String(current) : "";
  const suffix = currentStr ? ` (current: ${currentStr})` : defaultVal ? ` (default: ${defaultVal})` : "";
  const input = await ctx.ui.input(`${label}${suffix}:`, currentStr || (defaultVal ?? ""));
  if (input === null || input === undefined) return undefined;
  const val = input.trim();
  if (!val) return hadValue ? "clear" : undefined;
  const parsed = tryParseInteger(val);
  if (parsed === null) {
    ctx.ui.notify(`Invalid value "${val}" for ${label} — must be a whole number. Keeping previous value.`, "warning");
    return undefined;
  }
  return parsed;
}

/** Ask for a finite number. See promptInteger for return semantics. */
async function promptNumber(
  ctx: ExtensionCommandContext,
  label: string,
  current: unknown,
  defaultVal?: string,
): Promise<number | "clear" | undefined> {
  const hadValue = current !== undefined && current !== null;
  const currentStr = hadValue ? String(current) : "";
  const suffix = currentStr ? ` (current: ${currentStr})` : defaultVal ? ` (default: ${defaultVal})` : "";
  const input = await ctx.ui.input(`${label}${suffix}:`, currentStr || (defaultVal ?? ""));
  if (input === null || input === undefined) return undefined;
  const val = input.trim();
  if (!val) return hadValue ? "clear" : undefined;
  const parsed = tryParseNumber(val);
  if (parsed === null) {
    ctx.ui.notify(`Invalid value "${val}" for ${label} — must be a number. Keeping previous value.`, "warning");
    return undefined;
  }
  return parsed;
}

/** Apply a promptInteger/promptNumber result to a prefs dict. */
function applyNumber(prefs: Record<string, unknown>, key: string, result: number | "clear" | undefined): void {
  if (result === undefined) return;
  if (result === "clear") delete prefs[key];
  else prefs[key] = result;
}

/** Ask for a free-form string; returns the trimmed value, empty string to clear, or undefined if escaped. */
async function promptString(
  ctx: ExtensionCommandContext,
  label: string,
  current: unknown,
  defaultVal?: string,
): Promise<string | undefined> {
  const currentStr = typeof current === "string" ? current : "";
  const suffix = currentStr ? ` (current: ${currentStr})` : defaultVal ? ` (default: ${defaultVal})` : "";
  const input = await ctx.ui.input(`${label}${suffix}:`, currentStr || (defaultVal ?? ""));
  if (input === null || input === undefined) return undefined;
  return input.trim();
}

/** Parse comma- or newline-separated input into a deduplicated string array. */
function parseStringList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Sub-menu to edit a string list field (add / remove / clear / done). Mutates the parent prefs object. */
async function editStringListField(
  ctx: ExtensionCommandContext,
  prefs: Record<string, unknown>,
  key: string,
  label: string,
): Promise<void> {
  const current = Array.isArray(prefs[key]) ? [...prefs[key] as string[]] : [];
  let list = current;
  while (true) {
    const summary = list.length === 0 ? "(empty)" : `${list.length} item(s): ${list.slice(0, 3).join(", ")}${list.length > 3 ? "…" : ""}`;
    const choice = await ctx.ui.select(
      `${label} — ${summary}`,
      ["Add entries", "Remove entry", "Clear all", "Done"],
    );
    const pick = typeof choice === "string" ? choice : "";
    if (!pick || pick === "Done") break;
    if (pick === "Add entries") {
      const input = await ctx.ui.input(`Add to ${label} (comma- or newline-separated):`, "");
      if (input) {
        for (const item of parseStringList(input)) {
          if (!list.includes(item)) list.push(item);
        }
      }
    } else if (pick === "Remove entry") {
      if (list.length === 0) continue;
      const removeChoice = await ctx.ui.select(`Remove which entry?`, [...list, "(cancel)"]);
      const removeStr = typeof removeChoice === "string" ? removeChoice : "";
      if (removeStr && removeStr !== "(cancel)") {
        list = list.filter(x => x !== removeStr);
      }
    } else if (pick === "Clear all") {
      list = [];
    }
  }
  if (list.length > 0) {
    prefs[key] = list;
  } else if (prefs[key] !== undefined) {
    delete prefs[key];
  }
}

/** Set a nested object key, creating the parent object if needed, and deleting on undefined/empty. */
function setNested(parent: Record<string, unknown>, parentKey: string, childKey: string, value: unknown): void {
  let child = parent[parentKey] as Record<string, unknown> | undefined;
  if (!child || typeof child !== "object") child = {};
  if (value === undefined) return;
  (child as Record<string, unknown>)[childKey] = value;
  parent[parentKey] = child;
}

export async function handlePrefs(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();

  if (trimmed === "" || trimmed === "global" || trimmed === "wizard" || trimmed === "setup"
    || trimmed === "wizard global" || trimmed === "setup global") {
    await ensurePreferencesFile(getGlobalGSDPreferencesPath(), ctx, "global");
    await handlePrefsWizard(ctx, "global");
    return;
  }

  if (trimmed === "project" || trimmed === "wizard project" || trimmed === "setup project") {
    await ensurePreferencesFile(getProjectGSDPreferencesPath(), ctx, "project");
    await handlePrefsWizard(ctx, "project");
    return;
  }

  if (trimmed === "import-claude" || trimmed === "import-claude global") {
    await handleImportClaude(ctx, "global");
    return;
  }

  if (trimmed === "import-claude project") {
    await handleImportClaude(ctx, "project");
    return;
  }
  if (trimmed === "status") {
    const globalPrefs = loadGlobalGSDPreferences();
    const projectPrefs = loadProjectGSDPreferences();
    const canonicalGlobal = getGlobalGSDPreferencesPath();
    const legacyGlobal = getLegacyGlobalGSDPreferencesPath();
    const globalStatus = globalPrefs
      ? `present: ${globalPrefs.path}${globalPrefs.path === legacyGlobal ? " (legacy fallback)" : ""}`
      : `missing: ${canonicalGlobal}`;
    const projectStatus = projectPrefs ? `present: ${projectPrefs.path}` : `missing: ${getProjectGSDPreferencesPath()}`;

    const lines = [`GSD skill prefs — global ${globalStatus}; project ${projectStatus}`];

    const effective = loadEffectiveGSDPreferences();
    let hasUnresolved = false;
    if (effective) {
      const report = resolveAllSkillReferences(effective.preferences, process.cwd());
      const resolved = [...report.resolutions.values()].filter(r => r.method !== "unresolved");
      hasUnresolved = report.warnings.length > 0;
      if (resolved.length > 0 || hasUnresolved) {
        lines.push(`Skills: ${resolved.length} resolved, ${report.warnings.length} unresolved`);
      }
      if (hasUnresolved) {
        lines.push(`Unresolved: ${report.warnings.join(", ")}`);
      }
    }

    ctx.ui.notify(lines.join("\n"), hasUnresolved ? "warning" : "info");
    return;
  }

  ctx.ui.notify("Usage: /gsd prefs [global|project|status|wizard|setup|import-claude [global|project]]", "info");
}

export async function handleImportClaude(ctx: ExtensionCommandContext, scope: "global" | "project"): Promise<void> {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  if (!existsSync(path)) {
    await ensurePreferencesFile(path, ctx, scope);
  }

  const readPrefs = (): Record<string, unknown> => {
    if (!existsSync(path)) return { version: 1 };
    const content = readFileSync(path, "utf-8");
    const [frontmatterLines] = splitFrontmatter(content);
    return frontmatterLines ? parseFrontmatterMap(frontmatterLines) : { version: 1 };
  };

  const writePrefs = async (prefs: Record<string, unknown>): Promise<void> => {
    prefs.version = prefs.version || 1;
    const frontmatter = serializePreferencesToFrontmatter(prefs);
    let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
    if (existsSync(path)) {
      const preserved = extractBodyAfterFrontmatter(readFileSync(path, "utf-8"));
      if (preserved) body = preserved;
    }
    await saveFile(path, `---\n${frontmatter}---${body}`);
  };

  await runClaudeImportFlow(ctx, scope, readPrefs, writePrefs);
}

export async function handlePrefsMode(ctx: ExtensionCommandContext, scope: "global" | "project"): Promise<void> {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  const existing = scope === "project" ? loadProjectGSDPreferences() : loadGlobalGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : {};

  await configureMode(ctx, prefs);

  // Serialize and save
  prefs.version = prefs.version || 1;
  const frontmatter = serializePreferencesToFrontmatter(prefs);

  let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  if (existsSync(path)) {
    const preserved = extractBodyAfterFrontmatter(readFileSync(path, "utf-8"));
    if (preserved) body = preserved;
  }

  const content = `---\n${frontmatter}---${body}`;
  await saveFile(path, content);
  await ctx.waitForIdle();
  await ctx.reload();
  ctx.ui.notify(`Saved ${scope} preferences to ${path}`, "info");
}

/** Build short summary strings for each preference category. */
export function buildCategorySummaries(prefs: Record<string, unknown>): Record<string, string> {
  // Mode
  const mode = prefs.mode as string | undefined;
  const modeSummary = mode ?? "(not set)";

  // Models
  const models = prefs.models as Record<string, unknown> | undefined;
  const tokenProfile = prefs.token_profile as string | undefined;
  const serviceTier = prefs.service_tier as string | undefined;
  const flatRate = Array.isArray(prefs.flat_rate_providers) ? (prefs.flat_rate_providers as string[]).length : 0;
  const dynRouting = prefs.dynamic_routing as Record<string, unknown> | undefined;
  let modelsSummary = "(not configured)";
  {
    const parts: string[] = [];
    if (models && Object.keys(models).length > 0) {
      parts.push(`${Object.keys(models).length} phase(s)`);
    }
    if (tokenProfile) parts.push(`profile: ${tokenProfile}`);
    if (serviceTier) parts.push(`tier: ${serviceTier}`);
    if (flatRate) parts.push(`flat-rate: ${flatRate}`);
    if (dynRouting?.enabled) parts.push("routing: on");
    if (parts.length > 0) modelsSummary = parts.join(", ");
  }

  // Timeouts
  const autoSup = prefs.auto_supervisor as Record<string, unknown> | undefined;
  let timeoutsSummary = "(defaults)";
  if (autoSup && Object.keys(autoSup).length > 0) {
    const soft = autoSup.soft_timeout_minutes ?? "20";
    const idle = autoSup.idle_timeout_minutes ?? "10";
    const hard = autoSup.hard_timeout_minutes ?? "30";
    timeoutsSummary = `soft: ${soft}m, idle: ${idle}m, hard: ${hard}m`;
  }

  // Git
  const git = prefs.git as Record<string, unknown> | undefined;
  const staleThreshold = prefs.stale_commit_threshold_minutes;
  const absorbSnapshots = git?.absorb_snapshot_commits;
  let gitSummary = "(defaults)";
  {
    const parts: string[] = [];
    if (git && Object.keys(git).length > 0) {
      const branch = git.main_branch ?? "main";
      const push = git.auto_push ? "on" : "off";
      parts.push(`main: ${branch}, push: ${push}`);
    }
    if (staleThreshold !== undefined) {
      parts.push(`stale: ${staleThreshold === 0 ? "off" : `${staleThreshold}m`}`);
    }
    if (absorbSnapshots !== undefined) {
      parts.push(`absorb: ${absorbSnapshots ? "on" : "off"}`);
    }
    if (parts.length > 0) gitSummary = parts.join(", ");
  }

  // Skills
  const discovery = prefs.skill_discovery as string | undefined;
  const uat = prefs.uat_dispatch;
  const alwaysUse = Array.isArray(prefs.always_use_skills) ? (prefs.always_use_skills as string[]).length : 0;
  const preferS = Array.isArray(prefs.prefer_skills) ? (prefs.prefer_skills as string[]).length : 0;
  const avoidS = Array.isArray(prefs.avoid_skills) ? (prefs.avoid_skills as string[]).length : 0;
  const rulesCount = Array.isArray(prefs.skill_rules) ? (prefs.skill_rules as unknown[]).length : 0;
  const customInstr = Array.isArray(prefs.custom_instructions) ? (prefs.custom_instructions as string[]).length : 0;
  let skillsSummary = "(not configured)";
  {
    const parts: string[] = [];
    if (discovery) parts.push(`discovery: ${discovery}`);
    if (uat !== undefined) parts.push(`uat: ${uat}`);
    if (alwaysUse) parts.push(`always: ${alwaysUse}`);
    if (preferS) parts.push(`prefer: ${preferS}`);
    if (avoidS) parts.push(`avoid: ${avoidS}`);
    if (rulesCount) parts.push(`rules: ${rulesCount}`);
    if (customInstr) parts.push(`custom: ${customInstr}`);
    if (prefs.skill_staleness_days !== undefined) parts.push(`stale: ${prefs.skill_staleness_days}d`);
    if (parts.length > 0) skillsSummary = parts.join(", ");
  }

  // Budget
  const ceiling = prefs.budget_ceiling;
  const enforcement = prefs.budget_enforcement as string | undefined;
  let budgetSummary = "(no limit)";
  if (ceiling !== undefined) {
    budgetSummary = `$${ceiling}`;
    if (enforcement) budgetSummary += ` / ${enforcement}`;
  } else if (enforcement) {
    budgetSummary = enforcement;
  }

  // Notifications
  const notif = prefs.notifications as Record<string, boolean> | undefined;
  let notifSummary = "(defaults)";
  if (notif && Object.keys(notif).length > 0) {
    const allKeys = ["enabled", "on_complete", "on_error", "on_budget", "on_milestone", "on_attention"];
    const enabledCount = allKeys.filter(k => notif[k] !== false).length;
    notifSummary = `${enabledCount}/${allKeys.length} enabled`;
  }

  // Advanced
  const uniqueIds = prefs.unique_milestone_ids;
  const experimentalRtk = (prefs.experimental as Record<string, unknown> | undefined)?.rtk;
  let advancedSummary = "(defaults)";
  {
    const parts: string[] = [];
    if (uniqueIds !== undefined) parts.push(`unique: ${uniqueIds ? "on" : "off"}`);
    if (prefs.auto_visualize !== undefined) parts.push(`viz: ${prefs.auto_visualize ? "on" : "off"}`);
    if (prefs.auto_report !== undefined) parts.push(`report: ${prefs.auto_report ? "on" : "off"}`);
    if (prefs.show_token_cost) parts.push("cost-display");
    if (prefs.forensics_dedup) parts.push("forensics-dedup");
    if (prefs.widget_mode) parts.push(`widget: ${prefs.widget_mode}`);
    if (experimentalRtk) parts.push("rtk");
    if (parts.length > 0) advancedSummary = parts.join(", ");
  }

  // Phases
  const phases = prefs.phases as Record<string, unknown> | undefined;
  let phasesSummary = "(defaults)";
  if (phases && Object.keys(phases).length > 0) {
    const activeFlags = Object.entries(phases).filter(([, v]) => v === true).map(([k]) => k);
    phasesSummary = activeFlags.length === 0 ? "(no flags)" : `${activeFlags.length} flag(s): ${activeFlags.slice(0, 2).join(", ")}${activeFlags.length > 2 ? "…" : ""}`;
  }

  // Parallelism
  const parallel = prefs.parallel as Record<string, unknown> | undefined;
  const sliceParallel = prefs.slice_parallel as Record<string, unknown> | undefined;
  let parallelismSummary = "(defaults)";
  {
    const parts: string[] = [];
    if (parallel?.enabled) parts.push(`milestone: ${parallel.max_workers ?? 2}w`);
    if (sliceParallel?.enabled) parts.push(`slice: ${sliceParallel.max_workers ?? 2}w`);
    if (parts.length > 0) parallelismSummary = parts.join(", ");
  }

  // Verification
  const verifyCmds = Array.isArray(prefs.verification_commands) ? (prefs.verification_commands as string[]).length : 0;
  const safety = prefs.safety_harness as Record<string, unknown> | undefined;
  let verificationSummary = "(defaults)";
  {
    const parts: string[] = [];
    if (verifyCmds) parts.push(`${verifyCmds} cmd(s)`);
    if (prefs.verification_auto_fix) parts.push("auto-fix");
    if (prefs.enhanced_verification === false) parts.push("enhanced: off");
    if (prefs.enhanced_verification_strict) parts.push("strict");
    if (safety?.enabled === false) parts.push("harness: off");
    else if (safety && Object.keys(safety).length > 0) parts.push("harness: custom");
    if (parts.length > 0) verificationSummary = parts.join(", ");
  }

  // Discuss
  let discussSummary = "(defaults)";
  {
    const parts: string[] = [];
    if (prefs.discuss_preparation === false) parts.push("prep: off");
    if (prefs.discuss_web_research === false) parts.push("web: off");
    if (prefs.discuss_depth) parts.push(`depth: ${prefs.discuss_depth}`);
    if (parts.length > 0) discussSummary = parts.join(", ");
  }

  // Context & Codebase
  const ctxMgmt = prefs.context_management as Record<string, unknown> | undefined;
  const codebase = prefs.codebase as Record<string, unknown> | undefined;
  let contextSummary = "(defaults)";
  {
    const parts: string[] = [];
    if (prefs.context_selection) parts.push(`selection: ${prefs.context_selection}`);
    if (ctxMgmt && Object.keys(ctxMgmt).length > 0) parts.push(`mgmt: ${Object.keys(ctxMgmt).length} field(s)`);
    if (prefs.context_window_override !== undefined) parts.push(`override: ${prefs.context_window_override}`);
    if (codebase && Object.keys(codebase).length > 0) parts.push("codebase: custom");
    if (parts.length > 0) contextSummary = parts.join(", ");
  }

  // Hooks & Reactive
  const reactive = prefs.reactive_execution as Record<string, unknown> | undefined;
  const gateEval = prefs.gate_evaluation as Record<string, unknown> | undefined;
  const postHooks = Array.isArray(prefs.post_unit_hooks) ? (prefs.post_unit_hooks as unknown[]).length : 0;
  const preHooks = Array.isArray(prefs.pre_dispatch_hooks) ? (prefs.pre_dispatch_hooks as unknown[]).length : 0;
  let hooksSummary = "(defaults)";
  {
    const parts: string[] = [];
    if (postHooks) parts.push(`post: ${postHooks}`);
    if (preHooks) parts.push(`pre: ${preHooks}`);
    if (reactive?.enabled) parts.push("reactive: on");
    if (gateEval?.enabled) parts.push("gate-eval: on");
    if (parts.length > 0) hooksSummary = parts.join(", ");
  }

  // UoK
  const uok = prefs.uok as Record<string, unknown> | undefined;
  let uokSummary = "(defaults)";
  if (uok && Object.keys(uok).length > 0) {
    if (uok.enabled === false) uokSummary = "off";
    else uokSummary = `${Object.keys(uok).length} setting(s)`;
  }

  // Integrations
  const cmux = prefs.cmux as Record<string, unknown> | undefined;
  const remote = prefs.remote_questions as Record<string, unknown> | undefined;
  const github = prefs.github as Record<string, unknown> | undefined;
  let integrationsSummary = "(defaults)";
  {
    const parts: string[] = [];
    if (prefs.language) parts.push(`lang: ${prefs.language}`);
    if (prefs.search_provider) parts.push(`search: ${prefs.search_provider}`);
    if (cmux?.enabled) parts.push("cmux");
    if (remote?.channel) parts.push(`remote: ${remote.channel}`);
    if (github?.enabled) parts.push("github");
    if (parts.length > 0) integrationsSummary = parts.join(", ");
  }

  return {
    mode: modeSummary,
    models: modelsSummary,
    timeouts: timeoutsSummary,
    git: gitSummary,
    skills: skillsSummary,
    budget: budgetSummary,
    notifications: notifSummary,
    advanced: advancedSummary,
    phases: phasesSummary,
    parallelism: parallelismSummary,
    verification: verificationSummary,
    discuss: discussSummary,
    context: contextSummary,
    hooks: hooksSummary,
    uok: uokSummary,
    integrations: integrationsSummary,
  };
}

// ─── Category configuration functions ────────────────────────────────────────

export function formatConfiguredModel(config: unknown): string {
  if (typeof config === "string") return config;
  if (!config || typeof config !== "object") return "(invalid)";
  const maybeConfig = config as { model?: unknown; provider?: unknown };
  if (typeof maybeConfig.model !== "string" || maybeConfig.model.trim() === "") return "(invalid)";
  if (typeof maybeConfig.provider === "string" && maybeConfig.provider && !maybeConfig.model.includes("/")) {
    return `${maybeConfig.provider}/${maybeConfig.model}`;
  }
  return maybeConfig.model;
}

export function toPersistedModelId(provider: string, modelId: string): string {
  if (!provider.trim()) return modelId;
  const normalizedProvider = provider.trim();
  const normalizedModelId = modelId.trim();
  return normalizedModelId.startsWith(`${normalizedProvider}/`)
    ? normalizedModelId
    : `${normalizedProvider}/${normalizedModelId}`;
}

async function configureModels(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const modelPhases = [
    "research",
    "planning",
    "discuss",
    "execution",
    "execution_simple",
    "completion",
    "validation",
    "subagent",
  ] as const;
  const models: Record<string, unknown> = (prefs.models as Record<string, unknown>) ?? {};

  const availableModels = ctx.modelRegistry.getAvailable();
  if (availableModels.length > 0) {
    // Group models by provider, sorted alphabetically
    const byProvider = new Map<string, typeof availableModels>();
    for (const m of availableModels) {
      let group = byProvider.get(m.provider);
      if (!group) {
        group = [];
        byProvider.set(m.provider, group);
      }
      group.push(m);
    }
    const providers = Array.from(byProvider.keys()).sort((a, b) => a.localeCompare(b));
    // Sort models within each provider
    for (const group of byProvider.values()) {
      group.sort((a, b) => a.id.localeCompare(b.id));
    }

    // Display names for providers in the preferences wizard UI.
    const PROVIDER_DISPLAY_NAMES: Record<string, string> = { anthropic: "anthropic-api" };
    const displayName = (p: string) => PROVIDER_DISPLAY_NAMES[p] ?? p;

    // Build provider menu with model counts (display name → real name lookup)
    const displayToReal = new Map<string, string>();
    const providerOptions = providers.map(p => {
      const count = byProvider.get(p)!.length;
      const label = `${displayName(p)} (${count} models)`;
      displayToReal.set(label, p);
      return label;
    });
    providerOptions.push("(keep current)", "(clear)", "(type manually)");

    for (const phase of modelPhases) {
      const current = formatConfiguredModel(models[phase]);
      const phaseLabel = `Model for ${phase} phase${current ? ` (current: ${current})` : ""}`;

      // Step 1: pick provider
      const providerChoice = await ctx.ui.select(`${phaseLabel} — choose provider:`, providerOptions);
      if (!providerChoice || typeof providerChoice !== "string" || providerChoice === "(keep current)") continue;

      if (providerChoice === "(clear)") {
        delete models[phase];
        continue;
      }

      if (providerChoice === "(type manually)") {
        const input = await ctx.ui.input(
          `${phaseLabel} — enter model ID:`,
          current || "e.g. claude-sonnet-4-20250514",
        );
        if (input !== null && input !== undefined) {
          const val = input.trim();
          if (val) models[phase] = val;
        }
        continue;
      }

      // Step 2: pick model within provider
      const providerName = displayToReal.get(providerChoice) ?? providerChoice.replace(/ \(\d+ models?\)$/, "");
      const group = byProvider.get(providerName);
      if (!group) continue;

      const modelOptions = group.map(m => m.id);
      modelOptions.push("(keep current)", "(clear)");

      const modelChoice = await ctx.ui.select(`${phaseLabel} — ${displayName(providerName)}:`, modelOptions);
      if (modelChoice && typeof modelChoice === "string" && modelChoice !== "(keep current)") {
        if (modelChoice === "(clear)") {
          delete models[phase];
        } else {
          models[phase] = toPersistedModelId(providerName, modelChoice);
        }
      }
    }
  } else {
    for (const phase of modelPhases) {
      const current = formatConfiguredModel(models[phase]);
      const input = await ctx.ui.input(
        `Model for ${phase} phase${current ? ` (current: ${current})` : ""}:`,
        current || "e.g. claude-sonnet-4-20250514",
      );
      if (input !== null && input !== undefined) {
        const val = input.trim();
        if (val) {
          models[phase] = val;
        } else if (current) {
          delete models[phase];
        }
      }
    }
  }
  if (Object.keys(models).length > 0) {
    prefs.models = models;
  } else {
    delete prefs.models;
  }

  // ─── Extra routing-level model preferences ────────────────────────────────
  const tokenProfile = await promptEnum(
    ctx,
    "Token profile (cost/quality tradeoff)",
    prefs.token_profile,
    ["budget", "balanced", "quality", "burn-max"],
  );
  if (tokenProfile !== undefined) prefs.token_profile = tokenProfile;

  const serviceTier = await promptEnum(
    ctx,
    "OpenAI service tier (gpt-5.4 only)",
    prefs.service_tier,
    ["priority", "flex"],
  );
  if (serviceTier !== undefined) prefs.service_tier = serviceTier;

  await editStringListField(ctx, prefs, "flat_rate_providers", "Flat-rate providers (suppress dynamic routing)");

  await configureDynamicRouting(ctx, prefs);
}

async function configureDynamicRouting(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const dr = (prefs.dynamic_routing as Record<string, unknown> | undefined) ?? {};

  const enabled = await promptBoolean(ctx, "Enable dynamic routing (tier-based model selection)", dr.enabled);
  if (enabled !== undefined) dr.enabled = enabled;

  if (dr.enabled !== true) {
    // If routing is disabled / kept-off, still let the user configure sub-fields (they may enable later).
  }

  const cap = await promptBoolean(ctx, "Capability-aware routing", dr.capability_routing, false);
  if (cap !== undefined) dr.capability_routing = cap;

  const escalate = await promptBoolean(ctx, "Escalate to heavier tier on failure", dr.escalate_on_failure, true);
  if (escalate !== undefined) dr.escalate_on_failure = escalate;

  const pressure = await promptBoolean(ctx, "Downgrade under budget pressure", dr.budget_pressure, true);
  if (pressure !== undefined) dr.budget_pressure = pressure;

  const cross = await promptBoolean(ctx, "Cross-provider routing", dr.cross_provider, true);
  if (cross !== undefined) dr.cross_provider = cross;

  const hooks = await promptBoolean(ctx, "Route hook sessions dynamically", dr.hooks, true);
  if (hooks !== undefined) dr.hooks = hooks;

  const flatRate = await promptBoolean(ctx, "Allow dynamic routing for flat-rate providers", dr.allow_flat_rate_providers, false);
  if (flatRate !== undefined) dr.allow_flat_rate_providers = flatRate;

  // tier_models.light / standard / heavy — optional model IDs
  const tierModels = (dr.tier_models as Record<string, unknown> | undefined) ?? {};
  for (const tier of ["light", "standard", "heavy"] as const) {
    const current = typeof tierModels[tier] === "string" ? tierModels[tier] as string : "";
    const input = await promptString(ctx, `Model for ${tier} tier (e.g. claude-haiku-4-5)`, current);
    if (input === undefined) continue;
    if (input) tierModels[tier] = input;
    else if (current) delete tierModels[tier];
  }
  if (Object.keys(tierModels).length > 0) dr.tier_models = tierModels;
  else delete (dr as Record<string, unknown>).tier_models;

  if (Object.keys(dr).length > 0) prefs.dynamic_routing = dr;
  else if (prefs.dynamic_routing !== undefined) delete prefs.dynamic_routing;
}

async function configureTimeouts(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const autoSup: Record<string, unknown> = (prefs.auto_supervisor as Record<string, unknown>) ?? {};
  const timeoutFields = [
    { key: "soft_timeout_minutes", label: "Soft timeout (minutes)", defaultVal: "20" },
    { key: "idle_timeout_minutes", label: "Idle timeout (minutes)", defaultVal: "10" },
    { key: "hard_timeout_minutes", label: "Hard timeout (minutes)", defaultVal: "30" },
  ] as const;

  for (const field of timeoutFields) {
    const current = autoSup[field.key];
    const currentStr = current !== undefined && current !== null ? String(current) : "";
    const input = await ctx.ui.input(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      currentStr || field.defaultVal,
    );
    if (input !== null && input !== undefined) {
      const val = input.trim();
      const parsed = tryParseInteger(val);
      if (val && parsed !== null) {
        autoSup[field.key] = parsed;
      } else if (val) {
        ctx.ui.notify(`Invalid value "${val}" for ${field.label} — must be a whole number. Keeping previous value.`, "warning");
      } else if (!val && currentStr) {
        delete autoSup[field.key];
      }
    }
  }
  if (Object.keys(autoSup).length > 0) {
    prefs.auto_supervisor = autoSup;
  }
}

async function configureGit(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const git: Record<string, unknown> = (prefs.git as Record<string, unknown>) ?? {};

  // main_branch
  const currentBranch = git.main_branch ? String(git.main_branch) : "";
  const branchInput = await ctx.ui.input(
    `Git main branch${currentBranch ? ` (current: ${currentBranch})` : ""}:`,
    currentBranch || "main",
  );
  if (branchInput !== null && branchInput !== undefined) {
    const val = branchInput.trim();
    if (val) {
      git.main_branch = val;
    } else if (currentBranch) {
      delete git.main_branch;
    }
  }

  // Boolean git toggles
  const gitBooleanFields = [
    { key: "auto_push", label: "Auto-push commits after committing", defaultVal: false },
    { key: "push_branches", label: "Push milestone branches to remote", defaultVal: false },
    { key: "snapshots", label: "Create WIP snapshot commits during long tasks", defaultVal: true },
  ] as const;

  for (const field of gitBooleanFields) {
    const current = git[field.key];
    const currentStr = current !== undefined ? String(current) : "";
    const choice = await ctx.ui.select(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      ["true", "false", "(keep current)"],
    );
    if (choice && choice !== "(keep current)") {
      git[field.key] = choice === "true";
    }
  }

  // remote
  const currentRemote = git.remote ? String(git.remote) : "";
  const remoteInput = await ctx.ui.input(
    `Git remote name${currentRemote ? ` (current: ${currentRemote})` : " (default: origin)"}:`,
    currentRemote || "origin",
  );
  if (remoteInput !== null && remoteInput !== undefined) {
    const val = remoteInput.trim();
    if (val && val !== "origin") {
      git.remote = val;
    } else if (!val && currentRemote) {
      delete git.remote;
    }
  }

  // pre_merge_check
  const currentPreMerge = git.pre_merge_check !== undefined ? String(git.pre_merge_check) : "";
  const preMergeChoice = await ctx.ui.select(
    `Pre-merge check${currentPreMerge ? ` (current: ${currentPreMerge})` : " (default: auto)"}:`,
    ["true", "false", "auto", "(keep current)"],
  );
  if (preMergeChoice && preMergeChoice !== "(keep current)") {
    if (preMergeChoice === "auto") {
      git.pre_merge_check = "auto";
    } else {
      git.pre_merge_check = preMergeChoice === "true";
    }
  }

  // commit_type
  const currentCommitType = git.commit_type ? String(git.commit_type) : "";
  const commitTypes = ["feat", "fix", "refactor", "docs", "test", "chore", "perf", "ci", "build", "style", "(inferred — default)", "(keep current)"];
  const commitChoice = await ctx.ui.select(
    `Default commit type${currentCommitType ? ` (current: ${currentCommitType})` : ""}:`,
    commitTypes,
  );
  if (commitChoice && typeof commitChoice === "string" && commitChoice !== "(keep current)") {
    if ((commitChoice as string).startsWith("(inferred")) {
      delete git.commit_type;
    } else {
      git.commit_type = commitChoice;
    }
  }

  // merge_strategy
  const currentMerge = git.merge_strategy ? String(git.merge_strategy) : "";
  const mergeChoice = await ctx.ui.select(
    `Merge strategy${currentMerge ? ` (current: ${currentMerge})` : ""}:`,
    ["squash", "merge", "(keep current)"],
  );
  if (mergeChoice && mergeChoice !== "(keep current)") {
    git.merge_strategy = mergeChoice;
  }

  // isolation
  const currentIsolation = git.isolation ? String(git.isolation) : "";
  const isolationChoice = await ctx.ui.select(
    `Git isolation strategy${currentIsolation ? ` (current: ${currentIsolation})` : " (default: worktree)"}:`,
    ["worktree", "branch", "none", "(keep current)"],
  );
  if (isolationChoice && isolationChoice !== "(keep current)") {
    git.isolation = isolationChoice;
  }

  // absorb_snapshot_commits (git sub-key)
  const currentAbsorb = git.absorb_snapshot_commits;
  const absorbStr = currentAbsorb !== undefined ? String(currentAbsorb) : "";
  const absorbChoice = await ctx.ui.select(
    `Absorb snapshot commits into real commits${absorbStr ? ` (current: ${absorbStr})` : " (default: true)"}:`,
    ["true", "false", "(keep current)"],
  );
  if (absorbChoice && absorbChoice !== "(keep current)") {
    git.absorb_snapshot_commits = absorbChoice === "true";
  }

  if (Object.keys(git).length > 0) {
    prefs.git = git;
  }

  // stale_commit_threshold_minutes (top-level pref, shown in Git section)
  const currentThreshold = prefs.stale_commit_threshold_minutes;
  const thresholdStr = currentThreshold !== undefined ? String(currentThreshold) : "";
  const thresholdInput = await ctx.ui.input(
    `Stale commit threshold (minutes, 0 to disable)${thresholdStr ? ` (current: ${thresholdStr})` : " (default: 30)"}:`,
    thresholdStr || "30",
  );
  if (thresholdInput !== null && thresholdInput !== undefined) {
    const val = thresholdInput.trim();
    const parsed = tryParseInteger(val);
    if (val && parsed !== null && parsed >= 0) {
      prefs.stale_commit_threshold_minutes = parsed;
    } else if (val && parsed === null) {
      ctx.ui.notify(`Invalid value "${val}" — must be a whole number. Keeping previous value.`, "warning");
    } else if (!val && currentThreshold !== undefined) {
      delete prefs.stale_commit_threshold_minutes;
    }
  }
}

async function configureSkills(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  // Skill discovery mode
  const discovery = await promptEnum(ctx, "Skill discovery mode", prefs.skill_discovery, ["auto", "suggest", "off"]);
  if (discovery !== undefined) prefs.skill_discovery = discovery;

  // UAT dispatch
  const uat = await promptBoolean(ctx, "UAT dispatch mode", prefs.uat_dispatch, false);
  if (uat !== undefined) prefs.uat_dispatch = uat;

  // Skill lists — edit via sub-menus
  await editStringListField(ctx, prefs, "always_use_skills", "Always-use skills");
  await editStringListField(ctx, prefs, "prefer_skills", "Preferred skills");
  await editStringListField(ctx, prefs, "avoid_skills", "Avoided skills");
  await editStringListField(ctx, prefs, "custom_instructions", "Custom instructions");

  // Skill rules (array of {when, use?, prefer?, avoid?})
  await configureSkillRules(ctx, prefs);

  // Skill staleness days
  const staleness = await promptInteger(ctx, "Skill staleness days (0 to disable)", prefs.skill_staleness_days, "60");
  applyNumber(prefs, "skill_staleness_days", staleness);
}

async function configureSkillRules(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  type Rule = { when: string; use?: string[]; prefer?: string[]; avoid?: string[] };
  let rules: Rule[] = Array.isArray(prefs.skill_rules) ? [...prefs.skill_rules as Rule[]] : [];
  while (true) {
    const summary = rules.length === 0
      ? "(no rules)"
      : `${rules.length} rule(s)`;
    const listLabels = rules.map((r, i) => `#${i + 1} when: ${r.when}`);
    const options = [...listLabels, "Add rule", "Done"];
    const choice = await ctx.ui.select(`Skill rules — ${summary}`, options);
    const pick = typeof choice === "string" ? choice : "";
    if (!pick || pick === "Done") break;
    if (pick === "Add rule") {
      const whenInput = await ctx.ui.input("Rule condition (free text, e.g. 'frontend tasks'):", "");
      const when = typeof whenInput === "string" ? whenInput.trim() : "";
      if (!when) continue;
      const rule: Rule = { when };
      for (const field of ["use", "prefer", "avoid"] as const) {
        const listInput = await ctx.ui.input(`Skills to ${field} (comma- or newline-separated, blank to skip):`, "");
        if (listInput) {
          const parsed = parseStringList(listInput);
          if (parsed.length > 0) rule[field] = parsed;
        }
      }
      if (rule.use || rule.prefer || rule.avoid) rules.push(rule);
      else ctx.ui.notify("Rule discarded — must have at least one of use/prefer/avoid.", "warning");
    } else if (pick.startsWith("#")) {
      const idx = Number(pick.slice(1, pick.indexOf(" "))) - 1;
      if (idx < 0 || idx >= rules.length) continue;
      const editChoice = await ctx.ui.select(
        `Rule #${idx + 1}`,
        ["Edit condition", "Edit use list", "Edit prefer list", "Edit avoid list", "Delete rule", "Cancel"],
      );
      const ec = typeof editChoice === "string" ? editChoice : "";
      if (!ec || ec === "Cancel") continue;
      if (ec === "Delete rule") {
        rules = rules.filter((_, i) => i !== idx);
        continue;
      }
      if (ec === "Edit condition") {
        const newWhen = await promptString(ctx, "Rule condition", rules[idx].when);
        if (newWhen !== undefined && newWhen !== "") rules[idx].when = newWhen;
      } else {
        const fieldKey = ec === "Edit use list" ? "use" : ec === "Edit prefer list" ? "prefer" : "avoid";
        const currentList = rules[idx][fieldKey] ?? [];
        const listInput = await ctx.ui.input(
          `${fieldKey} list (comma- or newline-separated, blank to clear):`,
          currentList.join(", "),
        );
        if (listInput === null || listInput === undefined) continue;
        const parsed = parseStringList(listInput);
        if (parsed.length > 0) rules[idx][fieldKey] = parsed;
        else delete rules[idx][fieldKey];
      }
    }
  }
  if (rules.length > 0) prefs.skill_rules = rules;
  else if (prefs.skill_rules !== undefined) delete prefs.skill_rules;
}

async function configureBudget(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const currentCeiling = prefs.budget_ceiling;
  const ceilingStr = currentCeiling !== undefined ? String(currentCeiling) : "";
  const ceilingInput = await ctx.ui.input(
    `Budget ceiling (USD)${ceilingStr ? ` (current: $${ceilingStr})` : " (default: no limit)"}:`,
    ceilingStr || "",
  );
  if (ceilingInput !== null && ceilingInput !== undefined) {
    const val = ceilingInput.trim().replace(/^\$/, "");
    const parsed = tryParseNumber(val);
    if (val && parsed !== null) {
      prefs.budget_ceiling = parsed;
    } else if (val) {
      ctx.ui.notify(`Invalid budget ceiling "${val}" — must be a number. Keeping previous value.`, "warning");
    } else if (!val && ceilingStr) {
      delete prefs.budget_ceiling;
    }
  }

  const currentEnforcement = (prefs.budget_enforcement as string) ?? "";
  const enforcementChoice = await ctx.ui.select(
    `Budget enforcement${currentEnforcement ? ` (current: ${currentEnforcement})` : " (default: pause)"}:`,
    ["warn", "pause", "halt", "(keep current)"],
  );
  if (enforcementChoice && enforcementChoice !== "(keep current)") {
    prefs.budget_enforcement = enforcementChoice;
  }

  const currentContextPause = prefs.context_pause_threshold;
  const contextPauseStr = currentContextPause !== undefined ? String(currentContextPause) : "";
  const contextPauseInput = await ctx.ui.input(
    `Context pause threshold (0-100%, 0=disabled)${contextPauseStr ? ` (current: ${contextPauseStr}%)` : " (default: 0)"}:`,
    contextPauseStr || "0",
  );
  if (contextPauseInput !== null && contextPauseInput !== undefined) {
    const val = contextPauseInput.trim().replace(/%$/, "");
    const parsed = tryParsePercentage(val);
    if (val && parsed !== null) {
      if (parsed === 0) {
        delete prefs.context_pause_threshold;
      } else {
        prefs.context_pause_threshold = parsed;
      }
    } else if (val) {
      ctx.ui.notify(`Invalid context pause threshold "${val}" — must be 0-100. Keeping previous value.`, "warning");
    }
  }
}

async function configureNotifications(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const notif: Record<string, boolean> = (prefs.notifications as Record<string, boolean>) ?? {};
  const notifFields = [
    { key: "enabled", label: "Notifications enabled (master toggle)", defaultVal: true },
    { key: "on_complete", label: "Notify on unit completion", defaultVal: true },
    { key: "on_error", label: "Notify on errors", defaultVal: true },
    { key: "on_budget", label: "Notify on budget thresholds", defaultVal: true },
    { key: "on_milestone", label: "Notify on milestone completion", defaultVal: true },
    { key: "on_attention", label: "Notify when manual attention needed", defaultVal: true },
  ] as const;

  for (const field of notifFields) {
    const current = notif[field.key];
    const currentStr = current !== undefined && typeof current === "boolean" ? String(current) : "";
    const choice = await ctx.ui.select(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      ["true", "false", "(keep current)"],
    );
    if (choice && choice !== "(keep current)") {
      notif[field.key] = choice === "true";
    }
  }
  if (Object.keys(notif).length > 0) {
    prefs.notifications = notif;
  }
}

async function configurePhases(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const phases = (prefs.phases as Record<string, unknown> | undefined) ?? {};
  const fields = [
    { key: "skip_research", label: "Skip research phase" },
    { key: "skip_reassess", label: "Skip roadmap reassessment" },
    { key: "skip_slice_research", label: "Skip slice-level research" },
    { key: "skip_milestone_validation", label: "Skip milestone validation" },
    { key: "reassess_after_slice", label: "Reassess roadmap after each slice" },
    { key: "require_slice_discussion", label: "Pause for discussion before each slice" },
    { key: "mid_execution_escalation", label: "Allow mid-execution escalation (ADR-011 P2)" },
    { key: "progressive_planning", label: "Progressive planning (S01 full, S02+ sketches)" },
  ] as const;
  for (const field of fields) {
    const val = await promptBoolean(ctx, field.label, phases[field.key]);
    if (val !== undefined) phases[field.key] = val;
  }
  if (Object.keys(phases).length > 0) prefs.phases = phases;
  else if (prefs.phases !== undefined) delete prefs.phases;
}

async function configureParallelism(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  // parallel: milestone-level
  const parallel = (prefs.parallel as Record<string, unknown> | undefined) ?? {};
  const pEnabled = await promptBoolean(ctx, "Parallel milestone execution", parallel.enabled, false);
  if (pEnabled !== undefined) parallel.enabled = pEnabled;

  const pWorkers = await promptInteger(ctx, "Max parallel workers (1–4)", parallel.max_workers, "2");
  if (pWorkers !== undefined && pWorkers !== "clear") parallel.max_workers = Math.max(1, Math.min(4, pWorkers));
  else if (pWorkers === "clear") delete parallel.max_workers;

  const pBudget = await promptNumber(ctx, "Per-worker budget ceiling (USD, blank = no limit)", parallel.budget_ceiling);
  if (pBudget !== undefined && pBudget !== "clear") parallel.budget_ceiling = pBudget;
  else if (pBudget === "clear") delete parallel.budget_ceiling;

  const pMerge = await promptEnum(ctx, "Parallel merge strategy", parallel.merge_strategy, ["per-slice", "per-milestone"]);
  if (pMerge !== undefined) parallel.merge_strategy = pMerge;

  const pAuto = await promptEnum(ctx, "Auto-merge mode", parallel.auto_merge, ["auto", "confirm", "manual"]);
  if (pAuto !== undefined) parallel.auto_merge = pAuto;

  const pWorkerModel = await promptString(ctx, "Worker model override (e.g. claude-haiku-4-5)", parallel.worker_model);
  if (pWorkerModel !== undefined) {
    if (pWorkerModel) parallel.worker_model = pWorkerModel;
    else delete parallel.worker_model;
  }

  if (Object.keys(parallel).length > 0) prefs.parallel = parallel;
  else if (prefs.parallel !== undefined) delete prefs.parallel;

  // slice_parallel: slice-level
  const sp = (prefs.slice_parallel as Record<string, unknown> | undefined) ?? {};
  const spEnabled = await promptBoolean(ctx, "Slice-level parallel execution", sp.enabled, false);
  if (spEnabled !== undefined) sp.enabled = spEnabled;

  const spWorkers = await promptInteger(ctx, "Slice max workers", sp.max_workers, "2");
  if (spWorkers !== undefined && spWorkers !== "clear") sp.max_workers = spWorkers;
  else if (spWorkers === "clear") delete sp.max_workers;

  if (Object.keys(sp).length > 0) prefs.slice_parallel = sp;
  else if (prefs.slice_parallel !== undefined) delete prefs.slice_parallel;
}

async function configureVerification(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  await editStringListField(ctx, prefs, "verification_commands", "Verification commands");

  const autoFix = await promptBoolean(ctx, "Auto-fix on verification failure", prefs.verification_auto_fix);
  if (autoFix !== undefined) prefs.verification_auto_fix = autoFix;

  const maxRetries = await promptInteger(ctx, "Verification max retries", prefs.verification_max_retries, "2");
  applyNumber(prefs, "verification_max_retries", maxRetries);

  const ev = await promptBoolean(ctx, "Enhanced verification (master toggle)", prefs.enhanced_verification, true);
  if (ev !== undefined) prefs.enhanced_verification = ev;
  const evPre = await promptBoolean(ctx, "Enhanced verification — pre-execution checks", prefs.enhanced_verification_pre, true);
  if (evPre !== undefined) prefs.enhanced_verification_pre = evPre;
  const evPost = await promptBoolean(ctx, "Enhanced verification — post-execution checks", prefs.enhanced_verification_post, true);
  if (evPost !== undefined) prefs.enhanced_verification_post = evPost;
  const evStrict = await promptBoolean(ctx, "Enhanced verification — strict mode (fail on any issue)", prefs.enhanced_verification_strict, false);
  if (evStrict !== undefined) prefs.enhanced_verification_strict = evStrict;

  // safety_harness
  const sh = (prefs.safety_harness as Record<string, unknown> | undefined) ?? {};
  const shFields = [
    { key: "enabled", label: "Safety harness enabled" },
    { key: "evidence_collection", label: "Collect tool evidence" },
    { key: "file_change_validation", label: "Validate file change descriptions" },
    { key: "evidence_cross_reference", label: "Cross-reference evidence across tools" },
    { key: "destructive_command_warnings", label: "Warn on destructive commands" },
    { key: "content_validation", label: "Validate written content" },
    { key: "checkpoints", label: "Create safety checkpoints" },
    { key: "auto_rollback", label: "Auto-rollback on safety violation" },
  ] as const;
  for (const field of shFields) {
    const val = await promptBoolean(ctx, `Safety harness — ${field.label}`, sh[field.key]);
    if (val !== undefined) sh[field.key] = val;
  }
  const cap = await promptNumber(ctx, "Safety harness timeout scale cap", sh.timeout_scale_cap);
  if (cap !== undefined && cap !== "clear") sh.timeout_scale_cap = cap;
  else if (cap === "clear") delete sh.timeout_scale_cap;
  if (Object.keys(sh).length > 0) prefs.safety_harness = sh;
  else if (prefs.safety_harness !== undefined) delete prefs.safety_harness;
}

async function configureDiscuss(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const prep = await promptBoolean(ctx, "Discuss — run preparation phase", prefs.discuss_preparation, true);
  if (prep !== undefined) prefs.discuss_preparation = prep;
  const web = await promptBoolean(ctx, "Discuss — web research during preparation", prefs.discuss_web_research, true);
  if (web !== undefined) prefs.discuss_web_research = web;
  const depth = await promptEnum(ctx, "Discuss preparation depth", prefs.discuss_depth, ["quick", "standard", "thorough"], "standard");
  if (depth !== undefined) prefs.discuss_depth = depth;
}

async function configureContextCodebase(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const sel = await promptEnum(ctx, "Context selection mode", prefs.context_selection, ["full", "smart"]);
  if (sel !== undefined) prefs.context_selection = sel;

  // context_management nested
  const cm = (prefs.context_management as Record<string, unknown> | undefined) ?? {};
  const mask = await promptBoolean(ctx, "Observation masking (hide stale tool outputs)", cm.observation_masking, true);
  if (mask !== undefined) cm.observation_masking = mask;
  const maskTurns = await promptInteger(ctx, "Observation mask turns (1–50)", cm.observation_mask_turns, "8");
  if (maskTurns !== undefined && maskTurns !== "clear") cm.observation_mask_turns = maskTurns;
  else if (maskTurns === "clear") delete cm.observation_mask_turns;
  const thresh = await promptNumber(ctx, "Compaction threshold percent (0.5–0.95)", cm.compaction_threshold_percent, "0.70");
  if (thresh !== undefined && thresh !== "clear") cm.compaction_threshold_percent = thresh;
  else if (thresh === "clear") delete cm.compaction_threshold_percent;
  const toolMax = await promptInteger(ctx, "Tool result max chars (200–10000)", cm.tool_result_max_chars, "800");
  if (toolMax !== undefined && toolMax !== "clear") cm.tool_result_max_chars = toolMax;
  else if (toolMax === "clear") delete cm.tool_result_max_chars;
  if (Object.keys(cm).length > 0) prefs.context_management = cm;
  else if (prefs.context_management !== undefined) delete prefs.context_management;

  const override = await promptInteger(ctx, "Context window override (tokens, blank = use model default)", prefs.context_window_override);
  applyNumber(prefs, "context_window_override", override);

  // codebase map
  const cb = (prefs.codebase as Record<string, unknown> | undefined) ?? {};
  const currentExcludes = Array.isArray(cb.exclude_patterns) ? cb.exclude_patterns as string[] : [];
  const excludesInput = await ctx.ui.input(
    `Codebase map — extra exclude patterns (comma- or newline-separated, blank to keep)${currentExcludes.length ? ` (current: ${currentExcludes.join(", ")})` : ""}:`,
    currentExcludes.join(", "),
  );
  if (excludesInput !== null && excludesInput !== undefined) {
    const parsed = parseStringList(excludesInput);
    if (parsed.length > 0) cb.exclude_patterns = parsed;
    else if (currentExcludes.length > 0 && excludesInput.trim() === "") delete cb.exclude_patterns;
  }
  const maxFiles = await promptInteger(ctx, "Codebase map — max files", cb.max_files, "500");
  if (maxFiles !== undefined && maxFiles !== "clear") cb.max_files = maxFiles;
  else if (maxFiles === "clear") delete cb.max_files;
  const collapse = await promptInteger(ctx, "Codebase map — collapse threshold", cb.collapse_threshold, "20");
  if (collapse !== undefined && collapse !== "clear") cb.collapse_threshold = collapse;
  else if (collapse === "clear") delete cb.collapse_threshold;
  if (Object.keys(cb).length > 0) prefs.codebase = cb;
  else if (prefs.codebase !== undefined) delete prefs.codebase;
}

async function configureHooks(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  // reactive_execution
  const re = (prefs.reactive_execution as Record<string, unknown> | undefined) ?? {};
  const reEnabled = await promptBoolean(ctx, "Reactive (graph-parallel) task execution", re.enabled, false);
  if (reEnabled !== undefined) re.enabled = reEnabled;
  const reMax = await promptInteger(ctx, "Reactive max parallel (1–8)", re.max_parallel, "3");
  if (reMax !== undefined && reMax !== "clear") re.max_parallel = Math.max(1, Math.min(8, reMax));
  else if (reMax === "clear") delete re.max_parallel;
  const reModel = await promptString(ctx, "Reactive subagent model override", re.subagent_model);
  if (reModel !== undefined) {
    if (reModel) re.subagent_model = reModel;
    else delete re.subagent_model;
  }
  if (Object.keys(re).length > 0) {
    // isolation_mode is currently only "same-tree"; set it when enabled to satisfy the schema.
    if (re.enabled === true && !re.isolation_mode) re.isolation_mode = "same-tree";
    prefs.reactive_execution = re;
  } else if (prefs.reactive_execution !== undefined) {
    delete prefs.reactive_execution;
  }

  // gate_evaluation
  const ge = (prefs.gate_evaluation as Record<string, unknown> | undefined) ?? {};
  const geEnabled = await promptBoolean(ctx, "Parallel gate evaluation during planning", ge.enabled, false);
  if (geEnabled !== undefined) ge.enabled = geEnabled;
  const currentSliceGates = Array.isArray(ge.slice_gates) ? ge.slice_gates as string[] : [];
  const sgInput = await ctx.ui.input(
    `Slice gates to evaluate (comma-separated, blank keeps)${currentSliceGates.length ? ` (current: ${currentSliceGates.join(", ")})` : " (default: Q3,Q4)"}:`,
    currentSliceGates.join(", "),
  );
  if (sgInput !== null && sgInput !== undefined) {
    const parsed = parseStringList(sgInput);
    if (parsed.length > 0) ge.slice_gates = parsed;
    else if (currentSliceGates.length > 0 && sgInput.trim() === "") delete ge.slice_gates;
  }
  const geTask = await promptBoolean(ctx, "Evaluate task-level gates (Q5/Q6/Q7)", ge.task_gates, true);
  if (geTask !== undefined) ge.task_gates = geTask;
  if (Object.keys(ge).length > 0) prefs.gate_evaluation = ge;
  else if (prefs.gate_evaluation !== undefined) delete prefs.gate_evaluation;

  // post_unit_hooks[]
  await configureHookList(ctx, prefs, "post_unit_hooks", "Post-unit hooks", "after");

  // pre_dispatch_hooks[]
  await configureHookList(ctx, prefs, "pre_dispatch_hooks", "Pre-dispatch hooks", "before");
}

async function configureHookList(
  ctx: ExtensionCommandContext,
  prefs: Record<string, unknown>,
  key: "post_unit_hooks" | "pre_dispatch_hooks",
  label: string,
  triggerField: "after" | "before",
): Promise<void> {
  type Hook = Record<string, unknown>;
  let hooks: Hook[] = Array.isArray(prefs[key]) ? [...prefs[key] as Hook[]] : [];
  while (true) {
    const summary = hooks.length === 0 ? "(none)" : `${hooks.length} hook(s)`;
    const labels = hooks.map((h, i) => `#${i + 1} ${h.name ?? "(unnamed)"}${h.enabled === false ? " [disabled]" : ""}`);
    const choice = await ctx.ui.select(`${label} — ${summary}`, [...labels, "Add hook", "Done"]);
    const pick = typeof choice === "string" ? choice : "";
    if (!pick || pick === "Done") break;
    if (pick === "Add hook") {
      const nameInput = await ctx.ui.input("Hook name (unique identifier):", "");
      const name = typeof nameInput === "string" ? nameInput.trim() : "";
      if (!name) continue;
      const triggerInput = await ctx.ui.input(
        `Unit types this hook ${triggerField === "after" ? "runs after" : "intercepts before"} (comma-separated, e.g. execute-task):`,
        "",
      );
      const triggers = triggerInput ? parseStringList(triggerInput) : [];
      if (triggers.length === 0) {
        ctx.ui.notify("Hook discarded — trigger list cannot be empty.", "warning");
        continue;
      }
      const hook: Hook = { name, [triggerField]: triggers, enabled: true };
      if (key === "post_unit_hooks") {
        const promptInput = await ctx.ui.input("Hook prompt (sent to LLM; supports {milestoneId}, {sliceId}, {taskId}):", "");
        if (promptInput) hook.prompt = promptInput;
      } else {
        const actionChoice = await ctx.ui.select("Action:", ["modify", "skip", "replace"]);
        if (actionChoice) hook.action = actionChoice;
      }
      hooks.push(hook);
    } else if (pick.startsWith("#")) {
      const idx = Number(pick.slice(1, pick.indexOf(" "))) - 1;
      if (idx < 0 || idx >= hooks.length) continue;
      const editChoice = await ctx.ui.select(
        `Hook #${idx + 1}: ${hooks[idx].name ?? ""}`,
        ["Toggle enabled", "Edit prompt/action", "Edit model override", "Delete hook", "Cancel"],
      );
      const ec = typeof editChoice === "string" ? editChoice : "";
      if (!ec || ec === "Cancel") continue;
      if (ec === "Delete hook") {
        hooks = hooks.filter((_, i) => i !== idx);
      } else if (ec === "Toggle enabled") {
        hooks[idx].enabled = hooks[idx].enabled === false;
      } else if (ec === "Edit prompt/action") {
        if (key === "post_unit_hooks") {
          const newPrompt = await promptString(ctx, "Prompt", hooks[idx].prompt);
          if (newPrompt !== undefined && newPrompt) hooks[idx].prompt = newPrompt;
        } else {
          const newAction = await promptEnum(ctx, "Action", hooks[idx].action, ["modify", "skip", "replace"]);
          if (newAction !== undefined) hooks[idx].action = newAction;
        }
      } else if (ec === "Edit model override") {
        const m = await promptString(ctx, "Model override (blank to clear)", hooks[idx].model);
        if (m !== undefined) {
          if (m) hooks[idx].model = m;
          else delete hooks[idx].model;
        }
      }
    }
  }
  if (hooks.length > 0) prefs[key] = hooks;
  else if (prefs[key] !== undefined) delete prefs[key];
}

async function configureUoK(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const uok = (prefs.uok as Record<string, unknown> | undefined) ?? {};

  const enabled = await promptBoolean(ctx, "UoK (Unified Orchestration Kernel) enabled", uok.enabled);
  if (enabled !== undefined) uok.enabled = enabled;

  const subsections = ["legacy_fallback", "gates", "model_policy", "execution_graph", "audit_unified", "plan_v2"] as const;
  for (const sub of subsections) {
    const existing = (uok[sub] as Record<string, unknown> | undefined) ?? {};
    const val = await promptBoolean(ctx, `UoK — ${sub.replace(/_/g, " ")} enabled`, existing.enabled);
    if (val !== undefined) {
      existing.enabled = val;
      uok[sub] = existing;
    } else if (Object.keys(existing).length > 0) {
      uok[sub] = existing;
    }
  }

  // gitops has extra fields
  const gitops = (uok.gitops as Record<string, unknown> | undefined) ?? {};
  const gitopsEnabled = await promptBoolean(ctx, "UoK — gitops enabled", gitops.enabled);
  if (gitopsEnabled !== undefined) gitops.enabled = gitopsEnabled;
  const turnAction = await promptEnum(ctx, "UoK gitops — turn action", gitops.turn_action, ["commit", "snapshot", "status-only"]);
  if (turnAction !== undefined) gitops.turn_action = turnAction;
  const turnPush = await promptBoolean(ctx, "UoK gitops — turn push", gitops.turn_push);
  if (turnPush !== undefined) gitops.turn_push = turnPush;
  if (Object.keys(gitops).length > 0) uok.gitops = gitops;

  if (Object.keys(uok).length > 0) prefs.uok = uok;
  else if (prefs.uok !== undefined) delete prefs.uok;
}

async function configureIntegrations(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  // Language
  const lang = await promptString(ctx, "Response language (e.g. Chinese, zh, German — blank to clear)", prefs.language);
  if (lang !== undefined) {
    if (lang) prefs.language = lang;
    else delete prefs.language;
  }

  // Search provider
  const search = await promptEnum(
    ctx,
    "Search provider",
    prefs.search_provider,
    ["auto", "brave", "tavily", "ollama", "native"],
    "auto",
  );
  if (search !== undefined) prefs.search_provider = search;

  // cmux
  const cmux = (prefs.cmux as Record<string, unknown> | undefined) ?? {};
  for (const field of ["enabled", "notifications", "sidebar", "splits", "browser"] as const) {
    const val = await promptBoolean(ctx, `cmux — ${field}`, cmux[field]);
    if (val !== undefined) cmux[field] = val;
  }
  if (Object.keys(cmux).length > 0) prefs.cmux = cmux;
  else if (prefs.cmux !== undefined) delete prefs.cmux;

  // remote_questions
  await configureRemoteQuestions(ctx, prefs);

  // github sync
  await configureGitHubSync(ctx, prefs);
}

async function configureRemoteQuestions(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const existing = (prefs.remote_questions as Record<string, unknown> | undefined) ?? {};
  const channel = await promptEnum(ctx, "Remote questions channel", existing.channel, ["slack", "discord", "telegram"]);
  const channelId = await promptString(ctx, "Remote questions channel_id", existing.channel_id);
  const timeout = await promptInteger(ctx, "Remote questions timeout (minutes, 1–30)", existing.timeout_minutes, "10");
  const poll = await promptInteger(ctx, "Remote questions poll interval (seconds, 2–30)", existing.poll_interval_seconds, "5");

  if (channel !== undefined) existing.channel = channel;
  if (channelId !== undefined) {
    if (channelId) existing.channel_id = channelId;
    else delete existing.channel_id;
  }
  applyNumber(existing, "timeout_minutes", timeout);
  applyNumber(existing, "poll_interval_seconds", poll);

  // Required pair: channel + channel_id. If either is missing, keep whatever existed unchanged.
  if (existing.channel && existing.channel_id) {
    prefs.remote_questions = existing;
  } else if (!existing.channel && !existing.channel_id) {
    if (prefs.remote_questions !== undefined) delete prefs.remote_questions;
  } else {
    // Partial config — hold it so user can finish, but warn.
    ctx.ui.notify("remote_questions requires both channel and channel_id; keeping partial config.", "warning");
    prefs.remote_questions = existing;
  }
}

async function configureGitHubSync(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const gh = (prefs.github as Record<string, unknown> | undefined) ?? {};
  const enabled = await promptBoolean(ctx, "GitHub sync enabled", gh.enabled, false);
  if (enabled !== undefined) gh.enabled = enabled;
  const repo = await promptString(ctx, "GitHub repo (owner/repo, blank = auto-detect from git remote)", gh.repo);
  if (repo !== undefined) {
    if (repo) gh.repo = repo;
    else delete gh.repo;
  }
  const project = await promptInteger(ctx, "GitHub Projects v2 number (blank = none)", gh.project);
  if (project !== undefined && project !== "clear") gh.project = project;
  else if (project === "clear") delete gh.project;
  // labels
  const currentLabels = Array.isArray(gh.labels) ? gh.labels as string[] : [];
  const labelsInput = await ctx.ui.input(
    `GitHub default labels (comma-separated)${currentLabels.length ? ` (current: ${currentLabels.join(", ")})` : ""}:`,
    currentLabels.join(", "),
  );
  if (labelsInput !== null && labelsInput !== undefined) {
    const parsed = parseStringList(labelsInput);
    if (parsed.length > 0) gh.labels = parsed;
    else if (currentLabels.length > 0 && labelsInput.trim() === "") delete gh.labels;
  }
  const autoLink = await promptBoolean(ctx, "GitHub — auto-link commits with Resolves #N", gh.auto_link_commits, true);
  if (autoLink !== undefined) gh.auto_link_commits = autoLink;
  const slicePrs = await promptBoolean(ctx, "GitHub — create per-slice draft PRs", gh.slice_prs, true);
  if (slicePrs !== undefined) gh.slice_prs = slicePrs;

  if (gh.enabled === true || Object.keys(gh).length > 1) prefs.github = gh;
  else if (prefs.github !== undefined && Object.keys(gh).length === 0) delete prefs.github;
  else if (Object.keys(gh).length > 0) prefs.github = gh;
}

export async function configureMode(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const currentMode = prefs.mode as string | undefined;
  const modeChoice = await ctx.ui.select(
    `Workflow mode${currentMode ? ` (current: ${currentMode})` : ""}:`,
    [
      "solo — auto-push, squash, simple IDs (personal projects)",
      "team — unique IDs, push branches, pre-merge checks (shared repos)",
      "(none) — configure everything manually",
      "(keep current)",
    ],
  );
  const modeStr = typeof modeChoice === "string" ? modeChoice : "";
  if (modeStr && modeStr !== "(keep current)") {
    if (modeStr.startsWith("solo")) {
      prefs.mode = "solo";
      ctx.ui.notify(
        "Mode: solo — defaults: auto_push=true, push_branches=false, pre_merge_check=auto, merge_strategy=squash, isolation=worktree, unique_milestone_ids=false",
        "info",
      );
    } else if (modeStr.startsWith("team")) {
      prefs.mode = "team";
      ctx.ui.notify(
        "Mode: team — defaults: auto_push=false, push_branches=true, pre_merge_check=true, merge_strategy=squash, isolation=worktree, unique_milestone_ids=true",
        "info",
      );
    } else {
      delete prefs.mode;
    }
  }
}

async function configureAdvanced(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const unique = await promptBoolean(ctx, "Unique milestone IDs", prefs.unique_milestone_ids);
  if (unique !== undefined) prefs.unique_milestone_ids = unique;

  const autoViz = await promptBoolean(ctx, "Auto-visualize milestones (open HTML visualizer)", prefs.auto_visualize);
  if (autoViz !== undefined) prefs.auto_visualize = autoViz;

  const autoReport = await promptBoolean(ctx, "Auto-generate milestone HTML report", prefs.auto_report, true);
  if (autoReport !== undefined) prefs.auto_report = autoReport;

  const forensics = await promptBoolean(ctx, "Forensics dedup (search GitHub before filing)", prefs.forensics_dedup, false);
  if (forensics !== undefined) prefs.forensics_dedup = forensics;

  const tokenCost = await promptBoolean(ctx, "Show token cost in footer", prefs.show_token_cost, false);
  if (tokenCost !== undefined) prefs.show_token_cost = tokenCost;

  const widget = await promptEnum(ctx, "Auto-mode widget display", prefs.widget_mode, ["full", "small", "min", "off"], "full");
  if (widget !== undefined) prefs.widget_mode = widget;

  const experimental = (prefs.experimental as Record<string, unknown> | undefined) ?? {};
  const rtk = await promptBoolean(ctx, "Experimental: RTK shell-command compression", experimental.rtk, false);
  if (rtk !== undefined) experimental.rtk = rtk;
  if (Object.keys(experimental).length > 0) prefs.experimental = experimental;
  else if (prefs.experimental !== undefined) delete prefs.experimental;
}

// ─── Main wizard with category menu ─────────────────────────────────────────

export async function handlePrefsWizard(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
  prefill?: Record<string, unknown>,
  opts?: { pathOverride?: string },
): Promise<void> {
  // pathOverride lets callers like /gsd init pass a basePath-derived target
  // path so the wizard doesn't fall back to cwd-based getProjectGSDPreferencesPath
  // when the init target diverges from the current working directory.
  const path = opts?.pathOverride
    ?? (scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath());
  const existing = scope === "project" ? loadProjectGSDPreferences() : loadGlobalGSDPreferences();
  // Order: existing-on-disk values, overlaid with prefill (caller's seeded answers).
  // Callers like /gsd init pass freshly-collected init answers as prefill so the
  // wizard menu shows them populated and writeable in one place.
  const prefs: Record<string, unknown> = {
    ...(existing?.preferences ?? {}),
    ...(prefill ?? {}),
  };

  ctx.ui.notify(`GSD preferences (${scope}) — pick a category to configure.`, "info");

  while (true) {
    const summaries = buildCategorySummaries(prefs);
    const options = [
      `Workflow Mode   ${summaries.mode}`,
      `Models          ${summaries.models}`,
      `Timeouts        ${summaries.timeouts}`,
      `Git             ${summaries.git}`,
      `Skills          ${summaries.skills}`,
      `Budget          ${summaries.budget}`,
      `Notifications   ${summaries.notifications}`,
      `Phases          ${summaries.phases}`,
      `Parallelism     ${summaries.parallelism}`,
      `Verification    ${summaries.verification}`,
      `Discuss         ${summaries.discuss}`,
      `Context         ${summaries.context}`,
      `Hooks           ${summaries.hooks}`,
      `UoK             ${summaries.uok}`,
      `Integrations    ${summaries.integrations}`,
      `Advanced        ${summaries.advanced}`,
      `── Save & Exit ──`,
    ];

    const raw = await ctx.ui.select("GSD Preferences", options);
    const choice = typeof raw === "string" ? raw : "";
    if (!choice || choice.includes("Save & Exit")) break;

    if (choice.startsWith("Workflow Mode"))      await configureMode(ctx, prefs);
    else if (choice.startsWith("Models"))        await configureModels(ctx, prefs);
    else if (choice.startsWith("Timeouts"))      await configureTimeouts(ctx, prefs);
    else if (choice.startsWith("Git"))           await configureGit(ctx, prefs);
    else if (choice.startsWith("Skills"))        await configureSkills(ctx, prefs);
    else if (choice.startsWith("Budget"))        await configureBudget(ctx, prefs);
    else if (choice.startsWith("Notifications")) await configureNotifications(ctx, prefs);
    else if (choice.startsWith("Phases"))        await configurePhases(ctx, prefs);
    else if (choice.startsWith("Parallelism"))   await configureParallelism(ctx, prefs);
    else if (choice.startsWith("Verification"))  await configureVerification(ctx, prefs);
    else if (choice.startsWith("Discuss"))       await configureDiscuss(ctx, prefs);
    else if (choice.startsWith("Context"))       await configureContextCodebase(ctx, prefs);
    else if (choice.startsWith("Hooks"))         await configureHooks(ctx, prefs);
    else if (choice.startsWith("UoK"))           await configureUoK(ctx, prefs);
    else if (choice.startsWith("Integrations"))  await configureIntegrations(ctx, prefs);
    else if (choice.startsWith("Advanced"))      await configureAdvanced(ctx, prefs);
  }

  await writePreferencesFile(path, prefs, ctx, { scope });
}

/**
 * Single source of truth for writing a PREFERENCES.md file.
 *
 * Both `/gsd init` and the prefs wizard route through this helper so we can't
 * drift on serialization, body preservation, or post-write reload. Callers
 * pass `ctx` for the reload/notify side effects; the function is safe to call
 * without a full UI context for tests via `ctx: null` (skips reload/notify).
 */
export async function writePreferencesFile(
  path: string,
  prefs: Record<string, unknown>,
  ctx: ExtensionCommandContext | null,
  opts?: { scope?: "global" | "project"; defaultBody?: string; notifyOnSave?: boolean },
): Promise<void> {
  const next = { ...prefs, version: prefs.version || 1 };
  const frontmatter = serializePreferencesToFrontmatter(next);

  const fallbackBody = opts?.defaultBody
    ?? "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";

  // Preserve existing body content (everything after closing ---) so users
  // who edited the markdown body don't lose their notes.
  let body = fallbackBody;
  if (existsSync(path)) {
    const preserved = extractBodyAfterFrontmatter(readFileSync(path, "utf-8"));
    if (preserved) body = preserved;
  }

  const content = `---\n${frontmatter}---${body}`;
  await saveFile(path, content);

  if (ctx) {
    await ctx.waitForIdle();
    await ctx.reload();
    if (opts?.notifyOnSave !== false) {
      const scopeLabel = opts?.scope ? `${opts.scope} ` : "";
      ctx.ui.notify(`Saved ${scopeLabel}preferences to ${path}`, "info");
    }
  }
}

/** Wrap a YAML value in double quotes if it contains special characters. */
export function yamlSafeString(val: unknown): string {
  if (typeof val !== "string") return String(val);
  if (/[:#{\[\]'"`,|>&*!?@%\r\n]/.test(val) || val.trim() !== val || val === "") {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  }
  return val;
}

export function serializePreferencesToFrontmatter(prefs: Record<string, unknown>): string {
  const lines: string[] = [];

  function serializeValue(key: string, value: unknown, indent: number): void {
    const prefix = "  ".repeat(indent);
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return; // Omit empty arrays — avoids parse/serialize cycle bug with "[]" strings
      }
      lines.push(`${prefix}${key}:`);
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          const entries = Object.entries(item as Record<string, unknown>);
          if (entries.length > 0) {
            const [firstKey, firstVal] = entries[0];
            lines.push(`${prefix}  - ${firstKey}: ${yamlSafeString(firstVal)}`);
            for (let i = 1; i < entries.length; i++) {
              const [k, v] = entries[i];
              if (Array.isArray(v)) {
                lines.push(`${prefix}    ${k}:`);
                for (const arrItem of v) {
                  lines.push(`${prefix}      - ${yamlSafeString(arrItem)}`);
                }
              } else {
                lines.push(`${prefix}    ${k}: ${yamlSafeString(v)}`);
              }
            }
          }
        } else {
          lines.push(`${prefix}  - ${yamlSafeString(item)}`);
        }
      }
      return;
    }

    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        return; // Omit empty objects — avoids parse/serialize cycle bug with "{}" strings
      }
      lines.push(`${prefix}${key}:`);
      for (const [k, v] of entries) {
        serializeValue(k, v, indent + 1);
      }
      return;
    }

    lines.push(`${prefix}${key}: ${yamlSafeString(value)}`);
  }

  // Ordered keys for consistent output
  const orderedKeys = [
    "version", "mode", "always_use_skills", "prefer_skills", "avoid_skills",
    "skill_rules", "custom_instructions", "models", "skill_discovery",
    "skill_staleness_days", "auto_supervisor", "uat_dispatch", "unique_milestone_ids",
    "budget_ceiling", "budget_enforcement", "context_pause_threshold",
    "notifications", "cmux", "remote_questions", "git",
    "stale_commit_threshold_minutes",
    "post_unit_hooks", "pre_dispatch_hooks",
    "dynamic_routing", "uok", "token_profile", "service_tier", "flat_rate_providers",
    "phases", "parallel", "slice_parallel",
    "reactive_execution", "gate_evaluation",
    "auto_visualize", "auto_report",
    "verification_commands", "verification_auto_fix", "verification_max_retries",
    "enhanced_verification", "enhanced_verification_pre",
    "enhanced_verification_post", "enhanced_verification_strict",
    "safety_harness",
    "discuss_preparation", "discuss_web_research", "discuss_depth",
    "search_provider", "context_selection", "context_management", "context_window_override",
    "codebase", "widget_mode", "forensics_dedup", "show_token_cost",
    "github", "experimental",
    "language",
  ];

  const seen = new Set<string>();
  for (const key of orderedKeys) {
    if (key in prefs) {
      serializeValue(key, prefs[key], 0);
      seen.add(key);
    }
  }
  // Any remaining keys not in the ordered list
  for (const [key, value] of Object.entries(prefs)) {
    if (!seen.has(key)) {
      serializeValue(key, value, 0);
    }
  }

  return lines.join("\n") + "\n";
}

export async function ensurePreferencesFile(
  path: string,
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
): Promise<void> {
  if (!existsSync(path)) {
    const template = await loadFile(join(dirname(fileURLToPath(import.meta.url)), "templates", "PREFERENCES.md"));
    if (!template) {
      ctx.ui.notify("Could not load GSD preferences template.", "error");
      return;
    }
    await saveFile(path, template);
    ctx.ui.notify(`Created ${scope} GSD skill preferences at ${path}`, "info");
  } else {
    ctx.ui.notify(`Using existing ${scope} GSD skill preferences at ${path}`, "info");
  }
}

/**
 * Handle `/gsd language [code]` — set or clear the global language preference.
 * Without an argument, shows the current setting.
 * Project-level override can be set by editing `.gsd/PREFERENCES.md` directly
 * (project language overrides global when both are set).
 */
export async function handleLanguage(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const path = getGlobalGSDPreferencesPath();
  const lang = args.trim();

  // Show current setting when called without argument
  if (!lang) {
    const loaded = loadGlobalGSDPreferences();
    const current = loaded?.preferences.language;
    if (current) {
      ctx.ui.notify(`Current language preference: ${current}\nUse /gsd language <name> to change, or /gsd language off to clear.`, "info");
    } else {
      ctx.ui.notify("No language preference set. Use /gsd language <name> to set one (e.g. /gsd language Chinese).", "info");
    }
    return;
  }

  // Ensure preferences file exists with the canonical template
  await ensurePreferencesFile(path, ctx, "global");

  // Read via the same validated path as other handlers
  const existing = loadGlobalGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : { version: 1 };

  if (lang === "off" || lang === "none" || lang === "clear") {
    delete prefs.language;
    ctx.ui.notify("Language preference cleared. GSD will use the default language.", "info");
  } else {
    // Validate before writing — reject values that would fail on next load
    if (lang.length > 50 || /[\r\n]/.test(lang)) {
      ctx.ui.notify(
        "Language value must be 50 characters or fewer with no newlines (e.g. /gsd language Chinese).",
        "warning",
      );
      return;
    }
    prefs.language = lang;
    ctx.ui.notify(`Language preference set to: ${lang}\nGSD will now respond in ${lang} across all sessions.`, "info");
  }

  const rawContent = existsSync(path) ? readFileSync(path, "utf-8") : `---\nversion: 1\n---\n`;
  const frontmatter = serializePreferencesToFrontmatter(prefs);
  const body = extractBodyAfterFrontmatter(rawContent)
    ?? "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  await saveFile(path, `---\n${frontmatter}---${body}`);
  await ctx.waitForIdle();
  await ctx.reload();
}
