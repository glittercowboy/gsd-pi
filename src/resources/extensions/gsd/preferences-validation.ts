/**
 * Validation logic for GSD preferences.
 *
 * Pure validation -- no filesystem access, no loading, no merging.
 * Accepts a raw GSDPreferences object and returns a sanitized copy
 * together with any errors and warnings.
 */

import type { GitPreferences } from "./git-service.js";
import type { PostUnitHookConfig, PreDispatchHookConfig, TokenProfile, PhaseSkipPreferences } from "./types.js";
import type { DynamicRoutingConfig } from "./model-router.js";
import { VALID_BRANCH_NAME } from "./git-service.js";
import { normalizeStringArray } from "../shared/format-utils.js";

import {
  KNOWN_PREFERENCE_KEYS,
  KNOWN_UNIT_TYPES,
  SKILL_ACTIONS,
  type WorkflowMode,
  type GSDPreferences,
  type GSDSkillRule,
} from "./preferences-types.js";

const VALID_TOKEN_PROFILES = new Set<TokenProfile>(["budget", "balanced", "quality"]);

export function validatePreferences(preferences: GSDPreferences): {
  preferences: GSDPreferences;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const validated: GSDPreferences = {};

  // ─── Unknown Key Detection ──────────────────────────────────────────
  // Common key migration hints for pi-level settings that don't map to GSD prefs
  const KEY_MIGRATION_HINTS: Record<string, string> = {
    taskIsolation: 'use "git.isolation" instead (values: worktree, branch, none)',
    task_isolation: 'use "git.isolation" instead (values: worktree, branch, none)',
    isolation: 'use "git.isolation" instead (values: worktree, branch, none)',
    manage_gitignore: 'use "git.manage_gitignore" instead',
    auto_push: 'use "git.auto_push" instead',
    main_branch: 'use "git.main_branch" instead',
  };

  for (const key of Object.keys(preferences)) {
    if (!KNOWN_PREFERENCE_KEYS.has(key)) {
      const hint = KEY_MIGRATION_HINTS[key];
      if (hint) {
        warnings.push(`unknown preference key "${key}" — ${hint}`);
      } else {
        warnings.push(`unknown preference key "${key}" — ignored`);
      }
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

  validated.always_use_skills = normalizeStringArray(preferences.always_use_skills);
  validated.prefer_skills = normalizeStringArray(preferences.prefer_skills);
  validated.avoid_skills = normalizeStringArray(preferences.avoid_skills);
  validated.custom_instructions = normalizeStringArray(preferences.custom_instructions);

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
        const values = normalizeStringArray((rule as unknown as Record<string, unknown>)[action]);
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

  // ─── Search Provider ─────────────────────────────────────────────
  if (preferences.search_provider !== undefined) {
    const validSearchProviders = new Set(["brave", "tavily", "ollama", "native", "auto"]);
    if (typeof preferences.search_provider === "string" && validSearchProviders.has(preferences.search_provider)) {
      validated.search_provider = preferences.search_provider as GSDPreferences["search_provider"];
    } else {
      errors.push(`search_provider must be one of: brave, tavily, ollama, native, auto`);
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
      if (p.reassess_after_slice !== undefined) validatedPhases.reassess_after_slice = !!p.reassess_after_slice;
      if ((p as any).require_slice_discussion !== undefined) (validatedPhases as any).require_slice_discussion = !!(p as any).require_slice_discussion;
      // Warn on unknown phase keys
      const knownPhaseKeys = new Set(["skip_research", "skip_reassess", "skip_slice_research", "skip_milestone_validation", "reassess_after_slice", "require_slice_discussion"]);
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

  // ─── Cmux ───────────────────────────────────────────────────────────────
  if (preferences.cmux !== undefined) {
    if (preferences.cmux && typeof preferences.cmux === "object") {
      const cmux = preferences.cmux as Record<string, unknown>;
      const validatedCmux: NonNullable<GSDPreferences["cmux"]> = {};
      if (cmux.enabled !== undefined) validatedCmux.enabled = !!cmux.enabled;
      if (cmux.notifications !== undefined) validatedCmux.notifications = !!cmux.notifications;
      if (cmux.sidebar !== undefined) validatedCmux.sidebar = !!cmux.sidebar;
      if (cmux.splits !== undefined) validatedCmux.splits = !!cmux.splits;
      if (cmux.browser !== undefined) validatedCmux.browser = !!cmux.browser;

      const knownCmuxKeys = new Set(["enabled", "notifications", "sidebar", "splits", "browser"]);
      for (const key of Object.keys(cmux)) {
        if (!knownCmuxKeys.has(key)) {
          warnings.push(`unknown cmux key "${key}" — ignored`);
        }
      }

      if (Object.keys(validatedCmux).length > 0) {
        validated.cmux = validatedCmux;
      }
    } else {
      errors.push("cmux must be an object");
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
    const knownUnitTypes = new Set<string>(KNOWN_UNIT_TYPES);
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
      const after = normalizeStringArray(hook.after);
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
    const knownUnitTypes = new Set<string>(KNOWN_UNIT_TYPES);
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
      const before = normalizeStringArray(hook.before);
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

  // ─── Reactive Execution ─────────────────────────────────────────────────
  if (preferences.reactive_execution !== undefined) {
    if (typeof preferences.reactive_execution === "object" && preferences.reactive_execution !== null) {
      const re = preferences.reactive_execution as unknown as Record<string, unknown>;
      const validRe: Record<string, unknown> = {};

      if (re.enabled !== undefined) {
        if (typeof re.enabled === "boolean") validRe.enabled = re.enabled;
        else errors.push("reactive_execution.enabled must be a boolean");
      }
      if (re.max_parallel !== undefined) {
        const mp = typeof re.max_parallel === "number" ? re.max_parallel : Number(re.max_parallel);
        if (Number.isFinite(mp) && mp >= 1 && mp <= 8) {
          validRe.max_parallel = Math.floor(mp);
        } else {
          errors.push("reactive_execution.max_parallel must be a number between 1 and 8");
        }
      }
      if (re.isolation_mode !== undefined) {
        if (re.isolation_mode === "same-tree") {
          validRe.isolation_mode = "same-tree";
        } else {
          errors.push('reactive_execution.isolation_mode must be "same-tree"');
        }
      }

      const knownReKeys = new Set(["enabled", "max_parallel", "isolation_mode"]);
      for (const key of Object.keys(re)) {
        if (!knownReKeys.has(key)) {
          warnings.push(`unknown reactive_execution key "${key}" — ignored`);
        }
      }

      if (Object.keys(validRe).length > 0) {
        validated.reactive_execution = validRe as unknown as import("./types.js").ReactiveExecutionConfig;
      }
    } else {
      errors.push("reactive_execution must be an object");
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
      warnings.push("git.commit_docs is deprecated — .gsd/ is managed externally and always gitignored. Remove this setting.");
    }
    if (g.manage_gitignore !== undefined) {
      if (typeof g.manage_gitignore === "boolean") git.manage_gitignore = g.manage_gitignore;
      else errors.push("git.manage_gitignore must be a boolean");
    }
    if (g.worktree_post_create !== undefined) {
      if (typeof g.worktree_post_create === "string" && g.worktree_post_create.trim()) {
        git.worktree_post_create = g.worktree_post_create.trim();
      } else {
        errors.push("git.worktree_post_create must be a non-empty string (path to script)");
      }
    }
    if (g.auto_pr !== undefined) {
      if (typeof g.auto_pr === "boolean") git.auto_pr = g.auto_pr;
      else errors.push("git.auto_pr must be a boolean");
    }
    if (g.pr_target_branch !== undefined) {
      if (typeof g.pr_target_branch === "string" && g.pr_target_branch.trim()) {
        git.pr_target_branch = g.pr_target_branch.trim();
      } else {
        errors.push("git.pr_target_branch must be a non-empty string (branch name)");
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

  // ─── Auto Visualize ─────────────────────────────────────────────────
  if (preferences.auto_visualize !== undefined) {
    if (typeof preferences.auto_visualize === "boolean") {
      validated.auto_visualize = preferences.auto_visualize;
    } else {
      errors.push("auto_visualize must be a boolean");
    }
  }

  // ─── Auto Report ────────────────────────────────────────────────────
  if (preferences.auto_report !== undefined) {
    if (typeof preferences.auto_report === "boolean") {
      validated.auto_report = preferences.auto_report;
    } else {
      errors.push("auto_report must be a boolean");
    }
  }

  // ─── Context Selection ──────────────────────────────────────────────
  if (preferences.context_selection !== undefined) {
    const validModes = new Set(["full", "smart"]);
    if (typeof preferences.context_selection === "string" && validModes.has(preferences.context_selection)) {
      validated.context_selection = preferences.context_selection as GSDPreferences["context_selection"];
    } else {
      errors.push(`context_selection must be one of: full, smart`);
    }
  }

  return { preferences: validated, errors, warnings };
}
