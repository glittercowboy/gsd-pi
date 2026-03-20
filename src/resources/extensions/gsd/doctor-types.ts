export type DoctorSeverity = "info" | "warning" | "error";
export type DoctorIssueCode =
  | "invalid_preferences"
  | "missing_tasks_dir"
  | "missing_slice_plan"
  | "task_done_missing_summary"
  | "task_summary_without_done_checkbox"
  | "all_tasks_done_missing_slice_summary"
  | "all_tasks_done_missing_slice_uat"
  | "all_tasks_done_roadmap_not_checked"
  | "slice_checked_missing_summary"
  | "slice_checked_missing_uat"
  | "all_slices_done_missing_milestone_validation"
  | "all_slices_done_missing_milestone_summary"
  | "task_done_must_haves_not_verified"
  | "active_requirement_missing_owner"
  | "blocked_requirement_missing_reason"
  | "blocker_discovered_no_replan"
  | "delimiter_in_title"
  | "orphaned_auto_worktree"
  | "stale_milestone_branch"
  | "corrupt_merge_state"
  | "tracked_runtime_files"
  | "legacy_slice_branches"
  | "stale_crash_lock"
  | "stale_parallel_session"
  | "orphaned_completed_units"
  | "stale_hook_state"
  | "activity_log_bloat"
  | "state_file_stale"
  | "state_file_missing"
  | "gitignore_missing_patterns"
  | "unresolvable_dependency"
  | "failed_migration"
  | "broken_symlink"
  // Environment health checks (#1221)
  | "env_node_version"
  | "env_dependencies"
  | "env_env_file"
  | "env_port_conflict"
  | "env_disk_space"
  | "env_docker"
  | "env_package_manager"
  | "env_typescript"
  | "env_python"
  | "env_cargo"
  | "env_go"
  | "env_git_remote"
  // Provider / auth checks
  | "provider_key_missing"
  | "provider_key_backedoff"
  // Lock infrastructure checks
  | "stranded_lock_directory"
  // Git / worktree integrity checks
  | "integration_branch_missing"
  | "worktree_directory_orphaned"
  // GSD state structural checks
  | "circular_slice_dependency"
  | "orphaned_slice_directory"
  | "duplicate_task_id"
  | "task_file_not_in_plan"
  | "stale_replan_file"
  | "future_timestamp"
  // Runtime data integrity
  | "metrics_ledger_corrupt"
  | "large_planning_file"
  // Slow environment checks (opt-in via --build / --test flags)
  | "env_build"
  | "env_test";

/**
 * Issue codes that represent expected completion-transition states.
 * These are detected by the doctor but should NOT be auto-fixed at task level —
 * they are resolved by the complete-slice/complete-milestone dispatch units.
 * Consumers (e.g. auto-post-unit health tracking) should exclude these from
 * error counts when running at task fixLevel to avoid false escalation.
 */
export const COMPLETION_TRANSITION_CODES = new Set<DoctorIssueCode>([
  "all_tasks_done_missing_slice_summary",
  "all_tasks_done_missing_slice_uat",
  "all_tasks_done_roadmap_not_checked",
]);

export interface DoctorIssue {
  severity: DoctorSeverity;
  code: DoctorIssueCode;
  scope: "project" | "milestone" | "slice" | "task";
  unitId: string;
  message: string;
  file?: string;
  fixable: boolean;
}

export interface DoctorReport {
  ok: boolean;
  basePath: string;
  issues: DoctorIssue[];
  fixesApplied: string[];
  /** Per-domain check durations in milliseconds. Present on explicit /gsd doctor runs. */
  timing?: { git: number; runtime: number; environment: number; gsdState: number };
}

export interface DoctorSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  fixable: number;
  byCode: Array<{ code: DoctorIssueCode; count: number }>;
}
