// Browser-safe TypeScript interfaces for the settings surface.
// Mirrors upstream types from src/resources/extensions/gsd/ modules:
//   preferences.ts, model-router.ts, context-budget.ts,
//   routing-history.ts, metrics.ts
// Do NOT import from those modules directly — they use Node.js APIs
// unavailable in the browser.

// ─── Preferences ──────────────────────────────────────────────────────────────

export type SettingsWorkflowMode = "solo" | "team"

export type SettingsTokenProfile = "budget" | "balanced" | "quality" | "burn-max"

export type SettingsBudgetEnforcement = "warn" | "pause" | "halt"
export type SettingsContextSelectionMode = "full" | "smart"
export type SettingsServiceTier = "priority" | "flex"

export interface SettingsPhaseSkipPreferences {
  skip_research?: boolean
  skip_reassess?: boolean
  skip_slice_research?: boolean
  skip_milestone_validation?: boolean
  reassess_after_slice?: boolean
  require_slice_discussion?: boolean
  mid_execution_escalation?: boolean
  progressive_planning?: boolean
}

export interface SettingsReactiveExecutionConfig {
  enabled?: boolean
  max_parallel?: number
  isolation_mode?: "same-tree"
  subagent_model?: string
}

export interface SettingsGateEvaluationConfig {
  enabled?: boolean
  slice_gates?: string[]
  task_gates?: boolean
}

export interface SettingsSliceParallelConfig {
  enabled?: boolean
  max_workers?: number
}

// ─── Dynamic Routing (mirrors DynamicRoutingConfig from model-router.ts) ─────

export interface SettingsDynamicRoutingConfig {
  enabled?: boolean
  tier_models?: {
    light?: string
    standard?: string
    heavy?: string
  }
  escalate_on_failure?: boolean
  budget_pressure?: boolean
  cross_provider?: boolean
  hooks?: boolean
}

// ─── Budget Allocation (mirrors BudgetAllocation from context-budget.ts) ─────

export interface SettingsBudgetAllocation {
  summaryBudgetChars: number
  inlineContextBudgetChars: number
  taskCountRange: { min: number; max: number }
  continueThresholdPercent: number
  verificationBudgetChars: number
}

// ─── Routing History (mirrors RoutingHistoryData from routing-history.ts) ─────

export interface SettingsTierOutcome {
  success: number
  fail: number
}

export interface SettingsPatternHistory {
  light: SettingsTierOutcome
  standard: SettingsTierOutcome
  heavy: SettingsTierOutcome
}

export interface SettingsFeedbackEntry {
  unitType: string
  unitId: string
  tier: string
  rating: "over" | "under" | "ok"
  timestamp: string
}

export interface SettingsRoutingHistory {
  patterns: Record<string, SettingsPatternHistory>
  feedback: SettingsFeedbackEntry[]
  updatedAt: string
}

// ─── Metrics (mirrors ProjectTotals from metrics.ts) ─────────────────────────

export interface SettingsProjectTotals {
  units: number
  cost: number
  duration: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  toolCalls: number
  assistantMessages: number
  userMessages: number
}

// ─── Effective Preferences ────────────────────────────────────────────────────

export interface SettingsPreferencesData {
  mode?: SettingsWorkflowMode
  models?: Record<string, string>
  budgetCeiling?: number
  budgetEnforcement?: SettingsBudgetEnforcement
  tokenProfile?: SettingsTokenProfile
  dynamicRouting?: SettingsDynamicRoutingConfig
  customInstructions?: string[]
  alwaysUseSkills?: string[]
  preferSkills?: string[]
  avoidSkills?: string[]
  autoSupervisor?: {
    enabled?: boolean
    softTimeoutMinutes?: number
  }
  uatDispatch?: boolean
  autoVisualize?: boolean
  phases?: SettingsPhaseSkipPreferences
  contextSelection?: SettingsContextSelectionMode
  reactiveExecution?: SettingsReactiveExecutionConfig
  gateEvaluation?: SettingsGateEvaluationConfig
  sliceParallel?: SettingsSliceParallelConfig
  serviceTier?: SettingsServiceTier
  showTokenCost?: boolean
  contextWindowOverride?: number
  language?: string
  remoteQuestions?: {
    channel?: "slack" | "discord" | "telegram"
    channelId?: string
    timeoutMinutes?: number
    pollIntervalSeconds?: number
  }
  experimental?: {
    rtk?: boolean
  }
  scope: "global" | "project"
  path: string
  warnings?: string[]
}

// ─── Combined Payload ─────────────────────────────────────────────────────────

export interface SettingsData {
  preferences: SettingsPreferencesData | null
  routingConfig: SettingsDynamicRoutingConfig
  budgetAllocation: SettingsBudgetAllocation
  routingHistory: SettingsRoutingHistory | null
  projectTotals: SettingsProjectTotals | null
}
