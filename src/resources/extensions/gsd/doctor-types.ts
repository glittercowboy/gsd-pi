export type DoctorSeverity = "info" | "warning" | "error";
export type DoctorIssueCode =
  | "invalid_preferences"
  | "missing_tasks_dir"
  | "missing_slice_plan"
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
  | "numbered_gsd_variant"
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
  | "missing_slice_dir"
  | "duplicate_task_id"
  | "task_file_not_in_plan"
  | "stale_replan_file"
  | "future_timestamp"
  // Worktree lifecycle checks
  | "worktree_branch_merged"
  | "worktree_stale"
  | "worktree_dirty"
  | "worktree_unpushed"
  // Stale commit safety check
  | "stale_uncommitted_changes"
  // Snapshot ref bloat
  | "snapshot_ref_bloat"
  // Runtime data integrity
  | "orphaned_project_state"
  | "metrics_ledger_bloat"
  | "metrics_ledger_corrupt"
  | "large_planning_file"
  // Slow environment checks (opt-in via --build / --test flags)
  | "env_build"
  | "env_test"
  // Engine health checks (Phase 4)
  | "db_orphaned_task"
  | "db_orphaned_slice"
  | "db_done_task_no_summary"
  | "db_duplicate_id"
  | "projection_drift";

/**
 * Issue codes that represent global or completion-critical state.
 * These must NOT be auto-fixed when fixLevel is "task" — automated
 * post-task health checks must never delete external project state directories
 * or remove completed-unit keys (which causes state reversion / data loss).
 *
 * orphaned_completed_units: Removing completed-unit keys causes deriveState to
 * consider those tasks incomplete, reverting the user to an earlier slice and
 * effectively discarding all work past that point (#1809). This must only be
 * fixed by an explicit manual doctor run (fixLevel="all").
 */
export const GLOBAL_STATE_CODES = new Set<DoctorIssueCode>([
  "orphaned_project_state",
  "orphaned_completed_units",
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
