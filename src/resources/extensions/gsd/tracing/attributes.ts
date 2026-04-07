/**
 * Typed semantic attribute constants for GSD OTel tracing (#3732).
 *
 * Every decision-point span sets attributes from this map.
 * Keys follow OTel semantic conventions: dot-separated, lowercase,
 * prefixed with "gsd." to avoid collisions.
 */

export const GSD = {
  // ─── Loop Lifecycle ───────────────────────────────────────────
  LOOP_ITERATION:       'gsd.loop.iteration',
  LOOP_FLOW_ID:         'gsd.loop.flow_id',
  LOOP_EXIT_REASON:     'gsd.loop.exit_reason',
  LOOP_ERROR_STREAK:    'gsd.loop.error_streak',

  // ─── State Derivation ─────────────────────────────────────────
  STATE_PHASE:          'gsd.state.phase',
  STATE_MILESTONE:      'gsd.state.milestone_id',
  STATE_SLICE:          'gsd.state.slice_id',
  STATE_TASK:           'gsd.state.task_id',
  STATE_BLOCKERS:       'gsd.state.blockers',

  // ─── Dispatch ─────────────────────────────────────────────────
  DISPATCH_RULE:        'gsd.dispatch.rule',
  DISPATCH_UNIT_TYPE:   'gsd.dispatch.unit_type',
  DISPATCH_UNIT_ID:     'gsd.dispatch.unit_id',
  DISPATCH_ACTION:      'gsd.dispatch.action',
  DISPATCH_STUCK:       'gsd.dispatch.stuck',
  DISPATCH_STUCK_RULE:  'gsd.dispatch.stuck_rule',
  DISPATCH_RECOVERY:    'gsd.dispatch.recovery_level',

  // ─── Guards ───────────────────────────────────────────────────
  GUARD_NAME:           'gsd.guard.name',
  GUARD_RESULT:         'gsd.guard.result',
  BUDGET_PCT:           'gsd.budget.percent',
  BUDGET_ENFORCEMENT:   'gsd.budget.enforcement',
  CONTEXT_USAGE_PCT:    'gsd.context.usage_percent',

  // ─── Model Selection ──────────────────────────────────────────
  MODEL_CONFIGURED:     'gsd.model.configured',
  MODEL_RESOLVED:       'gsd.model.resolved',
  MODEL_PROVIDER:       'gsd.model.provider',
  MODEL_DOWNGRADED:     'gsd.model.downgraded',
  MODEL_FALLBACK_USED:  'gsd.model.fallback_used',
  MODEL_FLAT_RATE:      'gsd.model.flat_rate_provider',
  COMPLEXITY_TIER:      'gsd.complexity.tier',
  COMPLEXITY_REASON:    'gsd.complexity.reason',
  ROUTING_ENABLED:      'gsd.routing.enabled',
  ROUTING_METHOD:       'gsd.routing.method',

  // ─── Context Assembly ─────────────────────────────────────────
  CONTEXT_INLINE_LEVEL: 'gsd.context.inline_level',
  CONTEXT_SKILLS:       'gsd.context.skills_count',
  CONTEXT_KNOWLEDGE:    'gsd.context.knowledge_bytes',
  CONTEXT_CODEBASE:     'gsd.context.codebase_bytes',
  CONTEXT_MEMORY:       'gsd.context.memory_count',
  CONTEXT_GUIDED:       'gsd.context.guided_execute',
  CONTEXT_WRITE_GATED:  'gsd.context.write_gated',
  CONTEXT_PROMPT_CHARS: 'gsd.context.prompt_chars',

  // ─── Worktree ─────────────────────────────────────────────────
  WORKTREE_ACTIVE:      'gsd.worktree.active',
  WORKTREE_ACTION:      'gsd.worktree.action',
  WORKTREE_MERGE_OK:    'gsd.worktree.merge_ok',
  WORKTREE_PATH:        'gsd.worktree.path',

  // ─── Working Directory ───────────────────────────────────────
  CWD:                  'gsd.cwd',

  // ─── Command Dispatch ─────────────────────────────────────────
  COMMAND_NAME:         'gsd.command.name',
  COMMAND_ARGS:         'gsd.command.args',
  COMMAND_HANDLER:      'gsd.command.handler',
  COMMAND_AUTO_STATE:   'gsd.command.auto_state',

  // ─── Parallel Orchestration ────────────────────────────────────
  PARALLEL_SCOPE:           'gsd.parallel.scope',
  PARALLEL_MILESTONES:      'gsd.parallel.milestones',
  PARALLEL_SLICES:          'gsd.parallel.slices',
  PARALLEL_WORKERS_STARTED: 'gsd.parallel.workers_started',
  PARALLEL_WORKERS_STOPPED: 'gsd.parallel.workers_stopped',
  PARALLEL_WORKERS_ERRORS:  'gsd.parallel.workers_errors',
  PARALLEL_MAX_WORKERS:     'gsd.parallel.max_workers',
  PARALLEL_BUDGET_CEILING:  'gsd.parallel.budget_ceiling',
  PARALLEL_WORKER_MID:      'gsd.parallel.worker.milestone_id',
  PARALLEL_WORKER_SID:      'gsd.parallel.worker.slice_id',
  PARALLEL_WORKER_PID:      'gsd.parallel.worker.pid',
  PARALLEL_WORKER_STATE:    'gsd.parallel.worker.state',
  PARALLEL_MERGE_RESULT:    'gsd.parallel.merge.result',
  PARALLEL_MERGE_CONFLICT:  'gsd.parallel.merge.conflict_files',

  // ─── Unit Execution ───────────────────────────────────────────
  UNIT_TYPE:            'gsd.unit.type',
  UNIT_ID:              'gsd.unit.id',
  UNIT_RETRY:           'gsd.unit.is_retry',
  UNIT_DISPATCH_COUNT:  'gsd.unit.dispatch_count',
  UNIT_DURATION_MS:     'gsd.unit.duration_ms',
  UNIT_RESULT:          'gsd.unit.result',
} as const;

/** Union type of all attribute keys for type-safe usage. */
export type GSDAttributeKey = typeof GSD[keyof typeof GSD];
