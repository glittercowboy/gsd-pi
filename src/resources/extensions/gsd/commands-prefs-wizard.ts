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
  let modelsSummary = "(not configured)";
  if (models && Object.keys(models).length > 0) {
    const parts = Object.entries(models).map(([phase, model]) => `${phase}: ${formatConfiguredModel(model)}`);
    modelsSummary = parts.join(", ");
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
  let skillsSummary = "(not configured)";
  if (discovery || uat !== undefined) {
    const parts: string[] = [];
    if (discovery) parts.push(`discovery: ${discovery}`);
    if (uat !== undefined) parts.push(`uat: ${uat}`);
    skillsSummary = parts.join(", ");
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
  let advancedSummary = "(defaults)";
  if (uniqueIds !== undefined) {
    advancedSummary = `unique IDs: ${uniqueIds ? "on" : "off"}`;
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
  const currentDiscovery = (prefs.skill_discovery as string) ?? "";
  const discoveryChoice = await ctx.ui.select(
    `Skill discovery mode${currentDiscovery ? ` (current: ${currentDiscovery})` : ""}:`,
    ["auto", "suggest", "off", "(keep current)"],
  );
  if (discoveryChoice && discoveryChoice !== "(keep current)") {
    prefs.skill_discovery = discoveryChoice;
  }

  // UAT dispatch
  const currentUat = prefs.uat_dispatch;
  const uatChoice = await ctx.ui.select(
    `UAT dispatch mode${currentUat !== undefined ? ` (current: ${currentUat})` : " (default: false)"}:`,
    ["true", "false", "(keep current)"],
  );
  if (uatChoice && uatChoice !== "(keep current)") {
    prefs.uat_dispatch = uatChoice === "true";
  }
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
  const currentUnique = prefs.unique_milestone_ids;
  const uniqueChoice = await ctx.ui.select(
    `Unique milestone IDs${currentUnique !== undefined ? ` (current: ${currentUnique})` : ""}:`,
    ["true", "false", "(keep current)"],
  );
  if (uniqueChoice && uniqueChoice !== "(keep current)") {
    prefs.unique_milestone_ids = uniqueChoice === "true";
  }
}

// ─── Main wizard with category menu ─────────────────────────────────────────

export async function handlePrefsWizard(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
): Promise<void> {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  const existing = scope === "project" ? loadProjectGSDPreferences() : loadGlobalGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : {};

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
    else if (choice.startsWith("Advanced"))      await configureAdvanced(ctx, prefs);
  }

  // ─── Serialize to frontmatter ───────────────────────────────────────────
  prefs.version = prefs.version || 1;
  const frontmatter = serializePreferencesToFrontmatter(prefs);

  // Preserve existing body content (everything after closing ---)
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

/** Wrap a YAML value in double quotes if it contains special characters. */
export function yamlSafeString(val: unknown): string {
  if (typeof val !== "string") return String(val);
  if (/[:#{\[\]'"`,|>&*!?@%]/.test(val) || val.trim() !== val || val === "") {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
    "post_unit_hooks", "pre_dispatch_hooks",
    "dynamic_routing", "token_profile", "phases", "parallel",
    "auto_visualize", "auto_report",
    "verification_commands", "verification_auto_fix", "verification_max_retries",
    "search_provider", "context_selection",
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
