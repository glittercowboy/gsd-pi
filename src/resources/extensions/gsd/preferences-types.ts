/**
 * Type definitions, constants, and configuration shapes for GSD preferences.
 *
 * All interfaces, type aliases, and static lookup tables live here so that
 * both the validation and runtime modules can import them without pulling
 * in filesystem or loading logic.
 */

import type { GitPreferences } from "./git-service.js";
import type {
  PostUnitHookConfig,
  PreDispatchHookConfig,
  BudgetEnforcementMode,
  NotificationPreferences,
  TokenProfile,
  InlineLevel,
  PhaseSkipPreferences,
  ParallelConfig,
  ContextSelectionMode,
  ReactiveExecutionConfig,
  GateEvaluationConfig,
} from "./types.js";
import type { DynamicRoutingConfig } from "./model-router.js";
import type { GitHubSyncConfig } from "../github-sync/types.js";

// ─── Workflow Modes ──────────────────────────────────────────────────────────

export type WorkflowMode = "solo" | "team";

/** Default preference values for each workflow mode. */
export const MODE_DEFAULTS: Record<WorkflowMode, Partial<GSDPreferences>> = {
  solo: {
    git: {
      auto_push: true,
      push_branches: false,
      pre_merge_check: "auto",
      merge_strategy: "squash",
      isolation: "none",
    },
    unique_milestone_ids: false,
  },
  team: {
    git: {
      auto_push: false,
      push_branches: true,
      pre_merge_check: true,
      merge_strategy: "squash",
      isolation: "none",
    },
    unique_milestone_ids: true,
  },
};

/** All recognized top-level keys in GSDPreferences. Used to detect typos / stale config. */
export const KNOWN_PREFERENCE_KEYS = new Set<string>([
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
  "cmux",
  "remote_questions",
  "git",
  "post_unit_hooks",
  "pre_dispatch_hooks",
  "dynamic_routing",
  "token_profile",
  "phases",
  "auto_visualize",
  "auto_report",
  "parallel",
  "verification_commands",
  "verification_auto_fix",
  "verification_max_retries",
  "search_provider",
  "context_selection",
  "widget_mode",
  "reactive_execution",
  "gate_evaluation",
  "github",
  "service_tier",
  "forensics_dedup",
  "show_token_cost",
  "experimental",
]);

/** Canonical list of all dispatch unit types. */
export const KNOWN_UNIT_TYPES = [
  "research-milestone", "plan-milestone", "research-slice", "plan-slice",
  "execute-task", "reactive-execute", "gate-evaluate", "complete-slice", "replan-slice", "reassess-roadmap",
  "run-uat", "complete-milestone", "validate-milestone", "rewrite-docs",
  "discuss-milestone", "discuss-slice", "worktree-merge",
] as const;
export type UnitType = (typeof KNOWN_UNIT_TYPES)[number];


export const SKILL_ACTIONS = new Set(["use", "prefer", "avoid"]);

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
 * Legacy model config -- simple string per phase.
 * Kept for backward compatibility; will be migrated to GSDModelConfigV2 on load.
 */
export interface GSDModelConfig {
  research?: string;
  planning?: string;
  discuss?: string;
  execution?: string;
  execution_simple?: string;
  completion?: string;
  validation?: string;
  subagent?: string;
}

/**
 * Extended model config with per-phase fallback support.
 * Each phase can specify a primary model and ordered fallbacks.
 */
export interface GSDModelConfigV2 {
  research?: string | GSDPhaseModelConfig;
  planning?: string | GSDPhaseModelConfig;
  discuss?: string | GSDPhaseModelConfig;
  execution?: string | GSDPhaseModelConfig;
  execution_simple?: string | GSDPhaseModelConfig;
  completion?: string | GSDPhaseModelConfig;
  validation?: string | GSDPhaseModelConfig;
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

export interface CmuxPreferences {
  enabled?: boolean;
  notifications?: boolean;
  sidebar?: boolean;
  splits?: boolean;
  browser?: boolean;
}

/**
 * Opt-in experimental features. All features in this block are disabled by
 * default and must be explicitly enabled. They may change or be removed without
 * a deprecation cycle while in experimental status.
 */
export interface ExperimentalPreferences {
  /**
   * Enable RTK (Real-Time Kompression) shell-command compression.
   * RTK wraps shell commands to reduce token usage during command execution.
   * Default: false (opt-in required).
   */
  rtk?: boolean;
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
  cmux?: CmuxPreferences;
  remote_questions?: RemoteQuestionsConfig;
  git?: GitPreferences;
  post_unit_hooks?: PostUnitHookConfig[];
  pre_dispatch_hooks?: PreDispatchHookConfig[];
  dynamic_routing?: DynamicRoutingConfig;
  token_profile?: TokenProfile;
  phases?: PhaseSkipPreferences;
  auto_visualize?: boolean;
  /** Generate HTML report snapshot after each milestone completion. Default: true. Set false to disable. */
  auto_report?: boolean;
  parallel?: ParallelConfig;
  verification_commands?: string[];
  verification_auto_fix?: boolean;
  verification_max_retries?: number;
  /** Search provider preference. "brave"/"tavily"/"ollama" force that backend and disable native Anthropic search. "native" forces native only. "auto" = current default behavior. */
  search_provider?: "brave" | "tavily" | "ollama" | "native" | "auto";
  /** Context selection mode for file inlining. "full" inlines entire files, "smart" uses semantic chunking. Default derived from token profile. */
  context_selection?: ContextSelectionMode;
  /** Default widget display mode for auto-mode dashboard. "full" | "small" | "min" | "off". Default: "full". */
  widget_mode?: "full" | "small" | "min" | "off";
  /** Reactive (graph-derived parallel) task execution within slices. Disabled by default. */
  reactive_execution?: ReactiveExecutionConfig;
  /** Parallel quality gate evaluation during slice planning. Disabled by default. */
  gate_evaluation?: GateEvaluationConfig;
  /** GitHub sync configuration. Opt-in: syncs GSD events to GitHub Issues, Milestones, and PRs. */
  github?: GitHubSyncConfig;
  /** OpenAI service tier preference. "priority" = 2x cost, faster. "flex" = 0.5x cost, slower. Only affects gpt-5.4 models. */
  service_tier?: "priority" | "flex";
  /** Opt-in: search existing issues and PRs before filing from /gsd forensics. Uses additional AI tokens. */
  forensics_dedup?: boolean;
  /** Opt-in: show per-prompt and cumulative session token cost in the footer. Default: false. */
  show_token_cost?: boolean;
  /**
   * Opt-in experimental features. All features here are disabled by default.
   * See the preferences reference for details on each feature.
   */
  experimental?: ExperimentalPreferences;
}

export interface LoadedGSDPreferences {
  path: string;
  scope: "global" | "project";
  preferences: GSDPreferences;
  /** Validation warnings (unknown keys, type mismatches, deprecations). Empty when preferences are clean. */
  warnings?: string[];
}

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
