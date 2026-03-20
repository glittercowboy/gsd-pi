/**
 * Engine-polymorphic types for the WorkflowEngine / ExecutionPolicy abstraction.
 *
 * ⚠️  LEAF NODE — this file must NOT import from any existing GSD module
 * (types.ts, auto-dispatch.ts, etc.) to prevent import cycles. Only standard
 * library or node: imports are permitted.
 *
 * These types are intentionally minimal. S02 will prove whether additional
 * fields are needed when building the DevWorkflowEngine implementation.
 */

// ─── Engine State ────────────────────────────────────────────────────────────

/**
 * Generic engine state — the engine-polymorphic view of "where are we?"
 *
 * Each engine implementation populates this from its own state source.
 * For the dev engine, `raw` carries the full `GSDState` from `state.ts`.
 * For custom engines, `raw` carries whatever the engine needs.
 */
export interface EngineState {
  /** Current lifecycle phase (e.g. "research-milestone", "execute-task"). */
  phase: string;
  /** Active milestone, or null if none resolved yet. */
  currentMilestoneId: string | null;
  /** Active slice within the milestone, or null. */
  activeSliceId: string | null;
  /** Active task within the slice, or null. */
  activeTaskId: string | null;
  /** Whether the engine considers the current milestone (or workflow) complete. */
  isComplete: boolean;
  /**
   * Engine-specific full state payload.
   * For the dev engine this is `GSDState`; custom engines carry their own shape.
   * Typed as `unknown` to avoid coupling this leaf module to any specific state type.
   */
  raw: unknown;
}

// ─── Step Contract ───────────────────────────────────────────────────────────

/**
 * What a single step/unit of work must satisfy for dispatch.
 *
 * Mirrors the data carried by the existing `DispatchAction.action === "dispatch"`
 * variant in `auto-dispatch.ts`, but without importing that module.
 */
export interface StepContract {
  /** Unit type identifier (e.g. "research-milestone", "execute-task"). */
  unitType: string;
  /** Unit identifier (e.g. "M001:S01:T01"). */
  unitId: string;
  /** The full prompt to send to the agent session. */
  prompt: string;
}

// ─── Display Metadata ────────────────────────────────────────────────────────

/**
 * TUI display data produced by the engine for dashboard rendering.
 *
 * Wraps the kind of data currently assembled by `auto-dashboard.ts` into
 * an engine-polymorphic shape.
 */
export interface DisplayMetadata {
  /** Human-readable engine label (e.g. "GSD Dev", "Custom Pipeline"). */
  engineLabel: string;
  /** Current phase description for the dashboard header. */
  currentPhase: string;
  /** One-line progress summary (e.g. "M001 → S02 → T03"). */
  progressSummary: string;
  /** Step progress, or null if the engine doesn't track discrete steps. */
  stepCount: { completed: number; total: number } | null;
}

// ─── Dispatch Action ─────────────────────────────────────────────────────────

/**
 * Engine-polymorphic dispatch action — what the engine tells the auto-loop to do next.
 *
 * Separate from the existing `DispatchAction` in `auto-dispatch.ts` to avoid
 * import cycles. S02 bridges between this type and the existing one.
 */
export type EngineDispatchAction =
  | { action: "dispatch"; step: StepContract }
  | { action: "stop"; reason: string; level: "info" | "warning" | "error" }
  | { action: "skip" };

// ─── Reconcile Result ────────────────────────────────────────────────────────

/**
 * Result of post-step reconciliation — what should happen after a unit completes.
 *
 * Maps to the control-flow decisions currently made in `auto-post-unit.ts`.
 */
export interface ReconcileResult {
  /** What the loop should do next. */
  outcome: "continue" | "milestone-complete" | "pause" | "stop";
  /** Optional human-readable reason, surfaced in logs/dashboard. */
  reason?: string;
}

// ─── Recovery Action ─────────────────────────────────────────────────────────

/**
 * What the recovery subsystem recommends after a failure.
 *
 * Maps to recovery decisions in `auto-recovery.ts` and `auto-stuck-detection.ts`.
 */
export interface RecoveryAction {
  /** Recommended recovery action. */
  outcome: "retry" | "skip" | "stop" | "pause";
  /** Optional human-readable reason for the recommendation. */
  reason?: string;
}

// ─── Closeout Result ─────────────────────────────────────────────────────────

/**
 * Result of unit closeout — commit and artifact bookkeeping.
 *
 * Maps to the return shape of `closeoutUnit()` in `auto-unit-closeout.ts`.
 */
export interface CloseoutResult {
  /** Whether a git commit was created for this unit. */
  committed: boolean;
  /** Paths to artifacts written during closeout (activity logs, summaries, etc.). */
  artifacts: string[];
}

// ─── Completed Step ──────────────────────────────────────────────────────────

/**
 * Record of a completed step/unit — timing and identification.
 *
 * Mirrors the existing `CompletedUnit` in `auto/session.ts` but lives here
 * to keep engine-types as a self-contained leaf module.
 */
export interface CompletedStep {
  /** Unit type that completed (e.g. "execute-task"). */
  unitType: string;
  /** Unit identifier that completed. */
  unitId: string;
  /** Unix timestamp (ms) when the unit started. */
  startedAt: number;
  /** Unix timestamp (ms) when the unit finished. */
  finishedAt: number;
}
