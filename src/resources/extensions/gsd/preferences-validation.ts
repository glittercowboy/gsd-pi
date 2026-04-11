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
      if (dr.capability_routing !== undefined) {
        if (typeof dr.capability_routing === "boolean") validDr.capability_routing = dr.capability_routing;
        else errors.push("dynamic_routing.capability_routing must be a boolean");
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

  // ─── Context Management ──────────────────────────────────────────────
  if (preferences.context_management !== undefined) {
    if (typeof preferences.context_management === "object" && preferences.context_management !== null) {
      const cm = preferences.context_management as unknown as Record<string, unknown>;
      const validCm: Record<string, unknown> = {};

      if (cm.observation_masking !== undefined) {
        if (typeof cm.observation_masking === "boolean") validCm.observation_masking = cm.observation_masking;
        else errors.push("context_management.observation_masking must be a boolean");
      }
      if (cm.observation_mask_turns !== undefined) {
        const turns = cm.observation_mask_turns;
        if (typeof turns === "number" && turns >= 1 && turns <= 50) validCm.observation_mask_turns = turns;
        else errors.push("context_management.observation_mask_turns must be a number between 1 and 50");
      }
      if (cm.compaction_threshold_percent !== undefined) {
        const pct = cm.compaction_threshold_percent;
        if (typeof pct === "number" && pct >= 0.5 && pct <= 0.95) validCm.compaction_threshold_percent = pct;
        else errors.push("context_management.compaction_threshold_percent must be a number between 0.5 and 0.95");
      }
      if (cm.tool_result_max_chars !== undefined) {
        const chars = cm.tool_result_max_chars;
        if (typeof chars === "number" && chars >= 200 && chars <= 10000) validCm.tool_result_max_chars = chars;
        else errors.push("context_management.tool_result_max_chars must be a number between 200 and 10000");
      }

      if (Object.keys(validCm).length > 0) {
        validated.context_management = validCm as any;
      }
    } else {
      errors.push("context_management must be an object");
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

    if (p.worker_model !== undefined) {
      if (typeof p.worker_model === "string" && p.worker_model.length > 0) {
        parallel.worker_model = p.worker_model;
      } else {
        errors.push("parallel.worker_model must be a non-empty string");
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

      if (re.subagent_model !== undefined) {
        if (typeof re.subagent_model === "string" && re.subagent_model.length > 0) {
          validRe.subagent_model = re.subagent_model;
        } else {
          errors.push("reactive_execution.subagent_model must be a non-empty string");
        }
      }

      const knownReKeys = new Set(["enabled", "max_parallel", "isolation_mode", "subagent_model"]);
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

  // ─── Gate Evaluation ─────────────────────────────────────────────────────
  if (preferences.gate_evaluation !== undefined) {
    if (typeof preferences.gate_evaluation === "object" && preferences.gate_evaluation !== null) {
      const ge = preferences.gate_evaluation as unknown as Record<string, unknown>;
      const validGe: Record<string, unknown> = {};

      if (ge.enabled !== undefined) {
        if (typeof ge.enabled === "boolean") validGe.enabled = ge.enabled;
        else errors.push("gate_evaluation.enabled must be a boolean");
      }
      if (ge.slice_gates !== undefined) {
        if (Array.isArray(ge.slice_gates) && ge.slice_gates.every((g: unknown) => typeof g === "string")) {
          validGe.slice_gates = ge.slice_gates;
        } else {
          errors.push("gate_evaluation.slice_gates must be an array of strings");
        }
      }
      if (ge.task_gates !== undefined) {
        if (typeof ge.task_gates === "boolean") validGe.task_gates = ge.task_gates;
        else errors.push("gate_evaluation.task_gates must be a boolean");
      }

      const knownGeKeys = new Set(["enabled", "slice_gates", "task_gates"]);
      for (const key of Object.keys(ge)) {
        if (!knownGeKeys.has(key)) {
          warnings.push(`unknown gate_evaluation key "${key}" — ignored`);
        }
      }

      if (Object.keys(validGe).length > 0) {
        validated.gate_evaluation = validGe as unknown as import("./types.js").GateEvaluationConfig;
      }
    } else {
      errors.push("gate_evaluation must be an object");
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

  // ─── GitHub Sync ────────────────────────────────────────────────────────
  if (preferences.github !== undefined) {
    if (typeof preferences.github === "object" && preferences.github !== null) {
      const gh = preferences.github as unknown as Record<string, unknown>;
      const validGh: Record<string, unknown> = {};

      if (gh.enabled !== undefined) {
        if (typeof gh.enabled === "boolean") validGh.enabled = gh.enabled;
        else errors.push("github.enabled must be a boolean");
      }
      if (gh.repo !== undefined) {
        if (typeof gh.repo === "string" && gh.repo.includes("/")) validGh.repo = gh.repo;
        else errors.push('github.repo must be a string in "owner/repo" format');
      }
      if (gh.project !== undefined) {
        const p = typeof gh.project === "number" ? gh.project : Number(gh.project);
        if (Number.isFinite(p) && p > 0) validGh.project = Math.floor(p);
        else errors.push("github.project must be a positive number");
      }
      if (gh.labels !== undefined) {
        if (Array.isArray(gh.labels) && gh.labels.every((l: unknown) => typeof l === "string")) {
          validGh.labels = gh.labels;
        } else {
          errors.push("github.labels must be an array of strings");
        }
      }
      if (gh.auto_link_commits !== undefined) {
        if (typeof gh.auto_link_commits === "boolean") validGh.auto_link_commits = gh.auto_link_commits;
        else errors.push("github.auto_link_commits must be a boolean");
      }
      if (gh.slice_prs !== undefined) {
        if (typeof gh.slice_prs === "boolean") validGh.slice_prs = gh.slice_prs;
        else errors.push("github.slice_prs must be a boolean");
      }

      const knownGhKeys = new Set(["enabled", "repo", "project", "labels", "auto_link_commits", "slice_prs"]);
      for (const key of Object.keys(gh)) {
        if (!knownGhKeys.has(key)) {
          warnings.push(`unknown github key "${key}" — ignored`);
        }
      }

      if (Object.keys(validGh).length > 0) {
        validated.github = validGh as unknown as import("../github-sync/types.js").GitHubSyncConfig;
      }
    } else {
      errors.push("github must be an object");
    }
  }

  // ─── Show Token Cost ──────────────────────────────────────────────
  if (preferences.show_token_cost !== undefined) {
    if (typeof preferences.show_token_cost === "boolean") {
      validated.show_token_cost = preferences.show_token_cost;
    } else {
      errors.push("show_token_cost must be a boolean");
    }
  }

  // ─── Experimental Features ────────────────────────────────────────
  if (preferences.experimental !== undefined) {
    if (typeof preferences.experimental === "object" && preferences.experimental !== null) {
      const exp = preferences.experimental as unknown as Record<string, unknown>;
      const validExp: import("./preferences-types.js").ExperimentalPreferences = {};

      if (exp.rtk !== undefined) {
        if (typeof exp.rtk === "boolean") validExp.rtk = exp.rtk;
        else errors.push("experimental.rtk must be a boolean");
      }

      const knownExpKeys = new Set(["rtk"]);
      for (const key of Object.keys(exp)) {
        if (!knownExpKeys.has(key)) {
          warnings.push(`unknown experimental key "${key}" — ignored`);
        }
      }

      if (Object.keys(validExp).length > 0) {
        validated.experimental = validExp;
      }
    } else {
      errors.push("experimental must be an object");
    }
  }

  // ─── Codebase Map ──────────────────────────────────────────────────
  if (preferences.codebase !== undefined) {
    if (typeof preferences.codebase === "object" && preferences.codebase !== null) {
      const cb = preferences.codebase as Record<string, unknown>;
      const validCb: import("./preferences-types.js").CodebaseMapPreferences = {};

      if (cb.exclude_patterns !== undefined) {
        if (Array.isArray(cb.exclude_patterns) && cb.exclude_patterns.every((p: unknown) => typeof p === "string")) {
          validCb.exclude_patterns = cb.exclude_patterns as string[];
        } else {
          errors.push("codebase.exclude_patterns must be an array of strings");
        }
      }
      if (cb.max_files !== undefined) {
        const mf = typeof cb.max_files === "number" ? cb.max_files : Number(cb.max_files);
        if (Number.isFinite(mf) && mf >= 1) {
          validCb.max_files = Math.floor(mf);
        } else {
          errors.push("codebase.max_files must be a positive integer");
        }
      }
      if (cb.collapse_threshold !== undefined) {
        const ct = typeof cb.collapse_threshold === "number" ? cb.collapse_threshold : Number(cb.collapse_threshold);
        if (Number.isFinite(ct) && ct >= 1) {
          validCb.collapse_threshold = Math.floor(ct);
        } else {
          errors.push("codebase.collapse_threshold must be a positive integer");
        }
      }

      const knownCbKeys = new Set(["exclude_patterns", "max_files", "collapse_threshold"]);
      for (const key of Object.keys(cb)) {
        if (!knownCbKeys.has(key)) {
          warnings.push(`unknown codebase key "${key}" — ignored`);
        }
      }

      if (Object.keys(validCb).length > 0) {
        validated.codebase = validCb;
      }
    } else {
      errors.push("codebase must be an object");
    }
  }

  // ─── Enhanced Verification ──────────────────────────────────────────────────
  if (preferences.enhanced_verification !== undefined) {
    if (typeof preferences.enhanced_verification === "boolean") {
      validated.enhanced_verification = preferences.enhanced_verification;
    } else {
      errors.push("enhanced_verification must be a boolean");
    }
  }

  if (preferences.enhanced_verification_pre !== undefined) {
    if (typeof preferences.enhanced_verification_pre === "boolean") {
      validated.enhanced_verification_pre = preferences.enhanced_verification_pre;
    } else {
      errors.push("enhanced_verification_pre must be a boolean");
    }
  }

  if (preferences.enhanced_verification_post !== undefined) {
    if (typeof preferences.enhanced_verification_post === "boolean") {
      validated.enhanced_verification_post = preferences.enhanced_verification_post;
    } else {
      errors.push("enhanced_verification_post must be a boolean");
    }
  }

  if (preferences.enhanced_verification_strict !== undefined) {
    if (typeof preferences.enhanced_verification_strict === "boolean") {
      validated.enhanced_verification_strict = preferences.enhanced_verification_strict;
    } else {
      errors.push("enhanced_verification_strict must be a boolean");
    }
  }

  // ─── Discuss Preparation ────────────────────────────────────────────
  if (preferences.discuss_preparation !== undefined) {
    if (typeof preferences.discuss_preparation === "boolean") {
      validated.discuss_preparation = preferences.discuss_preparation;
    } else {
      errors.push("discuss_preparation must be a boolean");
    }
  }

  // ─── Discuss Web Research ───────────────────────────────────────────
  if (preferences.discuss_web_research !== undefined) {
    if (typeof preferences.discuss_web_research === "boolean") {
      validated.discuss_web_research = preferences.discuss_web_research;
    } else {
      errors.push("discuss_web_research must be a boolean");
    }
  }

  // ─── Discuss Depth ──────────────────────────────────────────────────
  if (preferences.discuss_depth !== undefined) {
    const validDepths = new Set(["quick", "standard", "thorough"]);
    if (typeof preferences.discuss_depth === "string" && validDepths.has(preferences.discuss_depth)) {
      validated.discuss_depth = preferences.discuss_depth as GSDPreferences["discuss_depth"];
    } else {
      errors.push(`discuss_depth must be one of: quick, standard, thorough`);
    }
  }

  return { preferences: validated, errors, warnings };
}
