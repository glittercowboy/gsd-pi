/**
 * Shared types for the file-to-state pipeline.
 * Used by watcher, state-deriver, differ, and ws-server.
 */

// -- Project State (from STATE.md frontmatter) --

export interface ProjectState {
  milestone: string;
  milestone_name: string;
  status: string;
  stopped_at: string;
  last_updated: string;
  last_activity: string;
  branch: string;
  progress: {
    total_phases: number;
    completed_phases: number;
    total_plans: number;
    completed_plans: number;
    percent: number;
  };
}

// -- Roadmap State (from ROADMAP.md) --

export interface RoadmapPhase {
  completed: boolean;
  number: number;
  name: string;
  description: string;
}

export interface RoadmapState {
  phases: RoadmapPhase[];
}

// -- Phase & Plan State (from PLAN.md files) --

export type PhaseStatus = "not_started" | "in_progress" | "complete";

export interface MustHavesArtifact {
  path: string;
  provides: string;
  exports?: string[];
  contains?: string;
  min_lines?: number;
}

export interface MustHavesKeyLink {
  from: string;
  to: string;
  via: string;
  pattern?: string;
}

export interface MustHaves {
  truths: string[];
  artifacts: MustHavesArtifact[];
  key_links: MustHavesKeyLink[];
}

export interface VerificationTruth {
  truth: string;
  status: "pass" | "fail" | "skip";
}

export interface VerificationState {
  score: number;
  status: string;
  truths: VerificationTruth[];
}

export interface PlanState {
  phase: string;
  plan: number;
  wave: number;
  requirements: string[];
  autonomous: boolean;
  type: string;
  files_modified: string[];
  depends_on: string[];
  must_haves?: MustHaves;
  task_count: number;
}

export interface PhaseState {
  number: number;
  name: string;
  status: PhaseStatus;
  completedPlans: number;
  plans: PlanState[];
  verifications: VerificationState[];
}

// -- Config State (from config.json) --

export interface ConfigState {
  model_profile: string;
  commit_docs: boolean;
  search_gitignored: boolean;
  branching_strategy: string;
  phase_branch_template: string;
  milestone_branch_template: string;
  workflow: {
    research: boolean;
    plan_check: boolean;
    verifier: boolean;
    nyquist_validation: boolean;
    _auto_chain_active: boolean;
  };
  parallelization: boolean;
  brave_search: boolean;
  mode: string;
  granularity: string;
  worktree_enabled?: boolean;
  skip_permissions?: boolean;
}

export const DEFAULT_CONFIG_STATE: Partial<ConfigState> = {
  skip_permissions: true,
  worktree_enabled: false,
};

// -- Requirement State (from REQUIREMENTS.md) --

export interface RequirementState {
  id: string;
  description: string;
  completed: boolean;
}

// -- State Diff (for WebSocket push) --

export interface StateDiff {
  type: "full" | "diff";
  changes: Partial<PlanningState>;
  timestamp: number;
  sequence: number;
}

// -- Top-level Planning State --

export interface PlanningState {
  roadmap: RoadmapState;
  state: ProjectState;
  config: ConfigState;
  phases: PhaseState[];
  requirements: RequirementState[];
}

// -- Watcher Options --

export interface WatcherOptions {
  planningDir: string;
  debounceMs?: number;
  onChange: (changedFiles: Set<string>) => void;
}
