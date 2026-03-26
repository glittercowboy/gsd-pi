// GSD Extension — Core Type Definitions
// Types consumed by state derivation, file parsing, and status display.
// Pure interfaces — no logic, no runtime dependencies.

// ─── Enums & Literal Unions ────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high";
export type Phase =
  | "pre-planning"
  | "needs-discussion"
  | "discussing"
  | "researching"
  | "planning"
  | "evaluating-gates"
  | "executing"
  | "verifying"
  | "summarizing"
  | "advancing"
  | "validating-milestone"
  | "completing-milestone"
  | "replanning-slice"
  | "complete"
  | "paused"
  | "blocked";
export type ContinueStatus = "in_progress" | "interrupted" | "compacted";

// ─── Roadmap (Milestone-level) ─────────────────────────────────────────────

export interface RoadmapSliceEntry {
  id: string; // e.g. "S01"
  title: string; // e.g. "Types + File I/O + Git Operations"
  risk: RiskLevel;
  depends: string[]; // e.g. ["S01", "S02"]
  done: boolean;
  demo: string; // the "After this:" sentence
}

export interface BoundaryMapEntry {
  fromSlice: string; // e.g. "S01"
  toSlice: string; // e.g. "S02" or "terminal"
  produces: string; // raw text block of what this slice produces
  consumes: string; // raw text block of what it consumes (or "nothing")
}

export interface Roadmap {
  title: string; // e.g. "M001: GSD Extension — Hierarchical Planning with Auto Mode"
  vision: string;
  successCriteria: string[];
  slices: RoadmapSliceEntry[];
  boundaryMap: BoundaryMapEntry[];
}

// ─── Slice Plan ────────────────────────────────────────────────────────────

export interface TaskPlanEntry {
  id: string; // e.g. "T01"
  title: string; // e.g. "Core Type Definitions"
  description: string;
  done: boolean;
  estimate: string; // e.g. "30m", "2h" — informational only
  files?: string[]; // e.g. ["types.ts", "files.ts"] — extracted from "- Files:" subline
  verify?: string; // e.g. "run tests" — extracted from "- Verify:" subline
}

export interface TaskPlanFrontmatter {
  estimated_steps?: number; // optional scope estimate for plan quality validator
  estimated_files?: number; // optional file-count estimate for scope warning heuristics
  skills_used: string[]; // installed skill slugs/names to hand off to execute-task prompts
}

export interface TaskPlanFile {
  frontmatter: TaskPlanFrontmatter;
}

// ─── Verification Gate ─────────────────────────────────────────────────────

/** Result of a single verification command execution */
export interface VerificationCheck {
  command: string; // e.g. "npm run lint"
  exitCode: number; // 0 = pass
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** A runtime error captured from bg-shell processes or browser console */
export interface RuntimeError {
  source: "bg-shell" | "browser";
  severity: "crash" | "error" | "warning";
  message: string;
  blocking: boolean;
}

/** A dependency vulnerability warning from npm audit */
export interface AuditWarning {
  name: string;
  severity: "low" | "moderate" | "high" | "critical";
  title: string;
  url: string;
  fixAvailable: boolean;
}

/** Aggregate result from the verification gate */
export interface VerificationResult {
  passed: boolean; // true if all checks passed (or no checks discovered)
  checks: VerificationCheck[]; // per-command results
  discoverySource: "preference" | "task-plan" | "package-json" | "none";
  timestamp: number; // Date.now() at gate start
  runtimeErrors?: RuntimeError[]; // optional — populated by captureRuntimeErrors()
  auditWarnings?: AuditWarning[]; // optional — populated by runDependencyAudit()
}

export interface SlicePlan {
  id: string; // e.g. "S01"
  title: string; // from the H1
  goal: string;
  demo: string;
  mustHaves: string[]; // top-level must-have bullet points
  tasks: TaskPlanEntry[];
  filesLikelyTouched: string[];
}

// ─── Summary (Task & Slice level) ──────────────────────────────────────────

export interface SummaryRequires {
  slice: string;
  provides: string;
}

export interface SummaryFrontmatter {
  id: string;
  parent: string;
  milestone: string;
  provides: string[];
  requires: SummaryRequires[];
  affects: string[];
  key_files: string[];
  key_decisions: string[];
  patterns_established: string[];
  drill_down_paths: string[];
  observability_surfaces: string[];
  duration: string;
  verification_result: string;
  completed_at: string;
  blocker_discovered: boolean;
}

export interface FileModified {
  path: string;
  description: string;
}

export interface Summary {
  frontmatter: SummaryFrontmatter;
  title: string;
  oneLiner: string;
  whatHappened: string;
  deviations: string;
  filesModified: FileModified[];
  followUps: string;
  knownLimitations: string;
}

// ─── Continue-Here ─────────────────────────────────────────────────────────

export interface ContinueFrontmatter {
  milestone: string;
  slice: string;
  task: string;
  step: number;
  totalSteps: number;
  status: ContinueStatus;
  savedAt: string;
}

export interface Continue {
  frontmatter: ContinueFrontmatter;
  completedWork: string;
  remainingWork: string;
  decisions: string;
  context: string;
  nextAction: string;
}

// ─── Secrets Manifest ──────────────────────────────────────────────────────

export type SecretsManifestEntryStatus = "pending" | "collected" | "skipped";

export interface SecretsManifestEntry {
  key: string; // e.g. "OPENAI_API_KEY"
  service: string; // e.g. "OpenAI"
  dashboardUrl: string; // e.g. "https://platform.openai.com/api-keys" — empty if unknown
  guidance: string[]; // numbered setup steps
  formatHint: string; // e.g. "starts with sk-" — empty if unknown
  status: SecretsManifestEntryStatus;
  destination: string; // e.g. "dotenv", "vercel", "convex"
}

export interface SecretsManifest {
  milestone: string; // e.g. "M001"
  generatedAt: string; // ISO 8601 timestamp
  entries: SecretsManifestEntry[];
}

export interface ManifestStatus {
  pending: string[]; // manifest status = pending AND not in env
  collected: string[]; // manifest status = collected AND not in env
  skipped: string[]; // manifest status = skipped
  existing: string[]; // key present in .env or process.env (regardless of manifest status)
}

// ─── GSD State (Derived Dashboard) ────────────────────────────────────────

export interface ActiveRef {
  id: string;
  title: string;
}

export interface MilestoneRegistryEntry {
  id: string;
  title: string;
  status: "complete" | "active" | "pending" | "parked";
  /** Milestone IDs that must be complete before this milestone becomes active. Populated from CONTEXT.md YAML frontmatter. */
  dependsOn?: string[];
}

export interface RequirementCounts {
  active: number;
  validated: number;
  deferred: number;
  outOfScope: number;
  blocked: number;
  total: number;
}

export interface GSDState {
  activeMilestone: ActiveRef | null;
  activeSlice: ActiveRef | null;
  activeTask: ActiveRef | null;
  phase: Phase;
  recentDecisions: string[];
  blockers: string[];
  nextAction: string;
  activeWorkspace?: string;
  registry: MilestoneRegistryEntry[];
  requirements?: RequirementCounts;
  progress?: {
    milestones: { done: number; total: number };
    slices?: { done: number; total: number };
    tasks?: { done: number; total: number };
  };
}

// ─── Post-Unit Hook Types ─────────────────────────────────────────────────

export interface PostUnitHookConfig {
  /** Unique hook identifier — used in idempotency keys and logging. */
  name: string;
  /** Unit types that trigger this hook (e.g., ["execute-task"]). */
  after: string[];
  /** Prompt sent to the LLM session. Supports {milestoneId}, {sliceId}, {taskId} substitutions. */
  prompt: string;
  /** Max times this hook can fire for the same trigger unit. Default 1, max 10. */
  max_cycles?: number;
  /** Model override for hook sessions. */
  model?: string;
  /** Expected output file name (relative to task/slice dir). Used for idempotency — skip if exists. */
  artifact?: string;
  /** If this file is produced instead of artifact, re-run the trigger unit then re-run hooks. */
  retry_on?: string;
  /** Agent definition file to use. */
  agent?: string;
  /** Set false to disable without removing config. Default true. */
  enabled?: boolean;
}

export interface HookExecutionState {
  /** Hook name. */
  hookName: string;
  /** The unit type that triggered this hook. */
  triggerUnitType: string;
  /** The unit ID that triggered this hook. */
  triggerUnitId: string;
  /** Current cycle (1-based). */
  cycle: number;
  /** Whether the hook completed with a retry signal (retry_on artifact found). */
  pendingRetry: boolean;
}

export interface HookDispatchResult {
  /** Hook name for display. */
  hookName: string;
  /** The prompt to send. */
  prompt: string;
  /** Model override, if configured. */
  model?: string;
  /** Synthetic unit type, e.g. "hook/code-review". */
  unitType: string;
  /** The trigger unit's ID, reused for the hook. */
  unitId: string;
}

// ─── Budget & Notification Types ──────────────────────────────────────────

export type BudgetEnforcementMode = "warn" | "pause" | "halt";

export type TokenProfile = "budget" | "balanced" | "quality";

export type InlineLevel = "full" | "standard" | "minimal";

export type ComplexityTier = "light" | "standard" | "heavy";

export interface ClassificationResult {
  tier: ComplexityTier;
  reason: string;
  downgraded: boolean;
}

export interface TaskMetadata {
  fileCount?: number;
  dependencyCount?: number;
  isNewFile?: boolean;
  tags?: string[];
  estimatedLines?: number;
  codeBlockCount?: number;
  complexityKeywords?: string[];
}

export interface PhaseSkipPreferences {
  skip_research?: boolean;
  skip_reassess?: boolean;
  skip_slice_research?: boolean;
  skip_milestone_validation?: boolean;
  reassess_after_slice?: boolean;
  /** When true, auto-mode pauses before each slice for discussion (#789). */
  require_slice_discussion?: boolean;
}

export interface NotificationPreferences {
  enabled?: boolean; // default true
  on_complete?: boolean; // notify on each unit completion
  on_error?: boolean; // notify on errors
  on_budget?: boolean; // notify on budget thresholds
  on_milestone?: boolean; // notify when milestone finishes
  on_attention?: boolean; // notify when manual attention needed
}

// ─── Pre-Dispatch Hook Types ──────────────────────────────────────────────

export interface PreDispatchHookConfig {
  /** Unique hook identifier. */
  name: string;
  /** Unit types this hook intercepts before dispatch (e.g., ["execute-task"]). */
  before: string[];
  /** Action to take: "modify" mutates the prompt, "skip" skips the unit, "replace" swaps it. */
  action: "modify" | "skip" | "replace";
  /** For "modify": text prepended to the unit prompt. Supports {milestoneId}, {sliceId}, {taskId}. */
  prepend?: string;
  /** For "modify": text appended to the unit prompt. Supports {milestoneId}, {sliceId}, {taskId}. */
  append?: string;
  /** For "replace": the replacement prompt. Supports {milestoneId}, {sliceId}, {taskId}. */
  prompt?: string;
  /** For "replace": override the unit type label. */
  unit_type?: string;
  /** For "skip": optional condition file — only skip if this file exists (relative to unit dir). */
  skip_if?: string;
  /** Model override when this hook fires. */
  model?: string;
  /** Set false to disable without removing config. Default true. */
  enabled?: boolean;
}

export interface PreDispatchResult {
  /** What happened: the unit proceeds with modifications, was skipped, or was replaced. */
  action: "proceed" | "skip" | "replace";
  /** Modified/replacement prompt (for "proceed" and "replace"). */
  prompt?: string;
  /** Override unit type (for "replace"). */
  unitType?: string;
  /** Model override. */
  model?: string;
  /** Names of hooks that fired, for logging. */
  firedHooks: string[];
}

// ─── Hook State Persistence Types ─────────────────────────────────────────

export interface PersistedHookState {
  /** Cycle counts keyed as "hookName/triggerUnitType/triggerUnitId". */
  cycleCounts: Record<string, number>;
  /** Timestamp of last state save. */
  savedAt: string;
}

export interface HookStatusEntry {
  /** Hook name. */
  name: string;
  /** Hook type: "post" or "pre". */
  type: "post" | "pre";
  /** Whether hook is enabled. */
  enabled: boolean;
  /** What unit types it targets. */
  targets: string[];
  /** Current cycle counts for active triggers. */
  activeCycles: Record<string, number>;
}

// ─── Database Types (Decisions & Requirements) ────────────────────────────

export type DecisionMadeBy = "human" | "agent" | "collaborative";

export interface Decision {
  seq: number; // auto-increment primary key
  id: string; // e.g. "D001"
  when_context: string; // when/context of the decision
  scope: string; // scope (milestone, slice, global, etc.)
  decision: string; // what was decided
  choice: string; // the specific choice made
  rationale: string; // why this choice
  revisable: string; // whether/when revisable
  made_by: DecisionMadeBy; // who made the decision: human, agent, or collaborative
  superseded_by: string | null; // ID of superseding decision, or null
}

export interface Requirement {
  id: string; // e.g. "R001"
  class: string; // requirement class (functional, non-functional, etc.)
  status: string; // active, validated, deferred, etc.
  description: string; // short description
  why: string; // rationale
  source: string; // origin (milestone, user, etc.)
  primary_owner: string; // owning slice/milestone
  supporting_slices: string; // other slices that touch this
  validation: string; // how to validate
  notes: string; // additional notes
  full_content: string; // full requirement text
  superseded_by: string | null; // ID of superseding requirement, or null
}

// ─── Parallel Orchestration Types ────────────────────────────────────────

export type ContextSelectionMode = "full" | "smart";

export type MergeStrategy = "per-slice" | "per-milestone";
export type AutoMergeMode = "auto" | "confirm" | "manual";

export interface ParallelConfig {
  enabled: boolean;
  max_workers: number;
  budget_ceiling?: number;
  merge_strategy: MergeStrategy;
  auto_merge: AutoMergeMode;
}

// ─── Reactive Task Execution Types ───────────────────────────────────────

/** IO signature extracted from a single task plan's Inputs/Expected Output sections. */
export interface TaskIO {
  id: string;        // e.g. "T01"
  title: string;
  inputFiles: string[];
  outputFiles: string[];
  done: boolean;
}

/** A task node with derived dependency edges from input/output intersection. */
export interface DerivedTaskNode extends TaskIO {
  /** IDs of tasks whose outputFiles overlap with this task's inputFiles. */
  dependsOn: string[];
}

/** Configuration for reactive (graph-derived parallel) task execution within a slice. */
export interface ReactiveExecutionConfig {
  enabled: boolean;
  /** Maximum number of tasks to dispatch in parallel. Clamped to 1–8. */
  max_parallel: number;
  /** Isolation mode for parallel tasks within a slice. Currently only "same-tree" is supported. */
  isolation_mode: "same-tree";
}

/** Per-slice reactive execution runtime state, persisted to disk. */
export interface ReactiveExecutionState {
  sliceId: string;
  /** Task IDs that have been verified as completed. */
  completed: string[];
  /** Task IDs dispatched in the current/most recent reactive batch. */
  dispatched: string[];
  /** Snapshot of the graph at last dispatch. */
  graphSnapshot: {
    taskCount: number;
    edgeCount: number;
    readySetSize: number;
    ambiguous: boolean;
  };
  updatedAt: string;
}

export interface BrowserFlowResult {
  url: string;
  passed: boolean;
  checksTotal: number;
  checksPassed: number;
  duration: number;
}

// ─── Complete Task Params (gsd_complete_task tool input) ─────────────────

export interface CompleteTaskParams {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  oneLiner: string;
  narrative: string;
  verification: string;
  keyFiles: string[];
  keyDecisions: string[];
  deviations: string;
  knownIssues: string;
  blockerDiscovered: boolean;
  verificationEvidence: Array<{
    command: string;
    exitCode: number;
    verdict: string;
    durationMs: number;
  }>;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

// ─── Complete Slice Params (gsd_complete_slice tool input) ───────────────

export interface CompleteSliceParams {
  sliceId: string;
  milestoneId: string;
  sliceTitle: string;
  oneLiner: string;
  narrative: string;
  verification: string;
  keyFiles: string[];
  keyDecisions: string[];
  patternsEstablished: string[];
  observabilitySurfaces: string[];
  deviations: string;
  knownLimitations: string;
  followUps: string;
  requirementsAdvanced: Array<{ id: string; how: string }>;
  requirementsValidated: Array<{ id: string; proof: string }>;
  requirementsSurfaced: string[];
  requirementsInvalidated: Array<{ id: string; what: string }>;
  filesModified: Array<{ path: string; description: string }>;
  uatContent: string;
  provides: string[];
  requires: Array<{ slice: string; provides: string }>;
  affects: string[];
  drillDownPaths: string[];
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

// ─── Quality Gates ───────────────────────────────────────────────────────

export type GateId = "Q3" | "Q4" | "Q5" | "Q6" | "Q7" | "Q8";
export type GateScope = "slice" | "task";
export type GateStatus = "pending" | "complete" | "omitted";
export type GateVerdict = "pass" | "flag" | "omitted" | "";

export interface GateRow {
  milestone_id: string;
  slice_id: string;
  gate_id: GateId;
  scope: GateScope;
  task_id: string;
  status: GateStatus;
  verdict: GateVerdict;
  rationale: string;
  findings: string;
  evaluated_at: string | null;
}

/** Configuration for parallel quality gate evaluation during slice planning. */
export interface GateEvaluationConfig {
  enabled: boolean;
  /** Which slice-scoped gates to evaluate in parallel. Default: ['Q3', 'Q4']. */
  slice_gates?: string[];
  /** Whether to evaluate task-level gates (Q5/Q6/Q7) via reactive-execute. Default: true when enabled. */
  task_gates?: boolean;
}
