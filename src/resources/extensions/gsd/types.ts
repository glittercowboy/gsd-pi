// GSD Extension — Core Type Definitions
// Types consumed by state derivation, file parsing, and status display.
// Pure interfaces — no logic, no runtime dependencies.

// ─── Enums & Literal Unions ────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high';
export type Phase = 'pre-planning' | 'needs-discussion' | 'discussing' | 'researching' | 'planning' | 'executing' | 'verifying' | 'summarizing' | 'advancing' | 'completing-milestone' | 'replanning-slice' | 'complete' | 'paused' | 'blocked';
export type ContinueStatus = 'in_progress' | 'interrupted' | 'compacted';

// ─── Roadmap (Milestone-level) ─────────────────────────────────────────────

export interface RoadmapSliceEntry {
  id: string;          // e.g. "S01"
  title: string;       // e.g. "Types + File I/O + Git Operations"
  risk: RiskLevel;
  depends: string[];   // e.g. ["S01", "S02"]
  done: boolean;
  demo: string;        // the "After this:" sentence
}

export interface BoundaryMapEntry {
  fromSlice: string;   // e.g. "S01"
  toSlice: string;     // e.g. "S02" or "terminal"
  produces: string;    // raw text block of what this slice produces
  consumes: string;    // raw text block of what it consumes (or "nothing")
}

export interface Roadmap {
  title: string;       // e.g. "M001: GSD Extension — Hierarchical Planning with Auto Mode"
  vision: string;
  successCriteria: string[];
  slices: RoadmapSliceEntry[];
  boundaryMap: BoundaryMapEntry[];
}

// ─── Slice Plan ────────────────────────────────────────────────────────────

export interface TaskPlanEntry {
  id: string;          // e.g. "T01"
  title: string;       // e.g. "Core Type Definitions"
  description: string;
  done: boolean;
  estimate: string;    // e.g. "30m", "2h" — informational only
  files?: string[];    // e.g. ["types.ts", "files.ts"] — extracted from "- Files:" subline
  verify?: string;     // e.g. "run tests" — extracted from "- Verify:" subline
}

export interface SlicePlan {
  id: string;          // e.g. "S01"
  title: string;       // from the H1
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

export type SecretsManifestEntryStatus = 'pending' | 'collected' | 'skipped';

export interface SecretsManifestEntry {
  key: string;              // e.g. "OPENAI_API_KEY"
  service: string;          // e.g. "OpenAI"
  dashboardUrl: string;     // e.g. "https://platform.openai.com/api-keys" — empty if unknown
  guidance: string[];       // numbered setup steps
  formatHint: string;       // e.g. "starts with sk-" — empty if unknown
  status: SecretsManifestEntryStatus;
  destination: string;      // e.g. "dotenv", "vercel", "convex"
}

export interface SecretsManifest {
  milestone: string;        // e.g. "M001"
  generatedAt: string;      // ISO 8601 timestamp
  entries: SecretsManifestEntry[];
}

export interface ManifestStatus {
  pending: string[];    // manifest status = pending AND not in env
  collected: string[];  // manifest status = collected AND not in env
  skipped: string[];    // manifest status = skipped
  existing: string[];   // key present in .env or process.env (regardless of manifest status)
}

// ─── GSD State (Derived Dashboard) ────────────────────────────────────────

export interface ActiveRef {
  id: string;
  title: string;
}

export interface MilestoneRegistryEntry {
  id: string;
  title: string;
  status: 'complete' | 'active' | 'pending';
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

export type BudgetEnforcementMode = 'warn' | 'pause' | 'halt';

export type TokenProfile = 'budget' | 'balanced' | 'quality';

export type InlineLevel = 'full' | 'standard' | 'minimal';

export type ComplexityTier = 'light' | 'standard' | 'heavy';

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
}

export interface NotificationPreferences {
  enabled?: boolean;           // default true
  on_complete?: boolean;       // notify on each unit completion
  on_error?: boolean;          // notify on errors
  on_budget?: boolean;         // notify on budget thresholds
  on_milestone?: boolean;      // notify when milestone finishes
  on_attention?: boolean;      // notify when manual attention needed
}

// ─── Pre-Dispatch Hook Types ──────────────────────────────────────────────

export interface PreDispatchHookConfig {
  /** Unique hook identifier. */
  name: string;
  /** Unit types this hook intercepts before dispatch (e.g., ["execute-task"]). */
  before: string[];
  /** Action to take: "modify" mutates the prompt, "skip" skips the unit, "replace" swaps it. */
  action: 'modify' | 'skip' | 'replace';
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
  action: 'proceed' | 'skip' | 'replace';
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
  type: 'post' | 'pre';
  /** Whether hook is enabled. */
  enabled: boolean;
  /** What unit types it targets. */
  targets: string[];
  /** Current cycle counts for active triggers. */
  activeCycles: Record<string, number>;
}

// ─── Database Types (Decisions & Requirements) ────────────────────────────

export interface Decision {
  seq: number;              // auto-increment primary key
  id: string;               // e.g. "D001"
  when_context: string;     // when/context of the decision
  scope: string;            // scope (milestone, slice, global, etc.)
  decision: string;         // what was decided
  choice: string;           // the specific choice made
  rationale: string;        // why this choice
  revisable: string;        // whether/when revisable
  superseded_by: string | null;  // ID of superseding decision, or null
}

export interface Requirement {
  id: string;               // e.g. "R001"
  class: string;            // requirement class (functional, non-functional, etc.)
  status: string;           // active, validated, deferred, etc.
  description: string;      // short description
  why: string;              // rationale
  source: string;           // origin (milestone, user, etc.)
  primary_owner: string;    // owning slice/milestone
  supporting_slices: string; // other slices that touch this
  validation: string;       // how to validate
  notes: string;            // additional notes
  full_content: string;     // full requirement text
  superseded_by: string | null;  // ID of superseding requirement, or null
}
