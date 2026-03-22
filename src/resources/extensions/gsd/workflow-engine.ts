// GSD Extension — WorkflowEngine: single-writer state command API
// Wraps SQLite via the existing DbAdapter to provide typed query methods
// for milestones, slices, tasks, and verification evidence. Implements
// deriveState() to return GSDState from direct DB reads.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import type { DbAdapter } from "./gsd-db.js";
import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import type { GSDState, ActiveRef, Phase, MilestoneRegistryEntry } from "./types.js";
import { writeManifest } from "./workflow-manifest.js";
import { appendEvent, compactMilestoneEvents } from "./workflow-events.js";
import type { WorkflowEvent } from "./workflow-events.js";
import { renderAllProjections } from "./workflow-projections.js";
import {
  completeTask as _completeTask,
  completeSlice as _completeSlice,
  planSlice as _planSlice,
  saveDecision as _saveDecision,
  startTask as _startTask,
  recordVerification as _recordVerification,
  reportBlocker as _reportBlocker,
  _milestoneProgress,
} from "./workflow-commands.js";
import type {
  CompleteTaskParams,
  CompleteTaskResult,
  CompleteSliceParams,
  CompleteSliceResult,
  PlanSliceParams,
  PlanSliceResult,
  SaveDecisionParams,
  SaveDecisionResult,
  StartTaskParams,
  StartTaskResult,
  RecordVerificationParams,
  RecordVerificationResult,
  ReportBlockerParams,
  ReportBlockerResult,
} from "./workflow-commands.js";

// Re-export param/result types so consumers can import from one place
export type {
  CompleteTaskParams,
  CompleteTaskResult,
  CompleteSliceParams,
  CompleteSliceResult,
  PlanSliceParams,
  PlanSliceResult,
  SaveDecisionParams,
  SaveDecisionResult,
  StartTaskParams,
  StartTaskResult,
  RecordVerificationParams,
  RecordVerificationResult,
  ReportBlockerParams,
  ReportBlockerResult,
} from "./workflow-commands.js";

// ─── Row Interfaces ──────────────────────────────────────────────────────

export interface MilestoneRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export interface SliceRow {
  id: string;
  milestone_id: string;
  title: string;
  status: string;
  risk: string;
  depends_on: string;
  summary: string | null;
  uat_result: string | null;
  created_at: string;
  completed_at: string | null;
  seq: number;
}

export interface TaskRow {
  id: string;
  slice_id: string;
  milestone_id: string;
  title: string;
  description: string;
  status: string;
  estimate: string;
  summary: string | null;
  files: string;
  verify: string | null;
  started_at: string | null;
  completed_at: string | null;
  blocker: string | null;
  seq: number;
}

// ─── WorkflowEngine ─────────────────────────────────────────────────────

export class WorkflowEngine {
  private db: DbAdapter;
  readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    const adapter = _getAdapter();
    if (!adapter) throw new Error("WorkflowEngine: no database connection");
    this.db = adapter;
  }

  // ── Milestone queries ───────────────────────────────────────────────

  getMilestone(id: string): MilestoneRow | null {
    const row = this.db
      .prepare("SELECT * FROM milestones WHERE id = ?")
      .get(id);
    return row ? (row as unknown as MilestoneRow) : null;
  }

  getMilestones(): MilestoneRow[] {
    return this.db
      .prepare("SELECT * FROM milestones ORDER BY id")
      .all() as unknown as MilestoneRow[];
  }

  // ── Slice queries ───────────────────────────────────────────────────

  getSlice(milestoneId: string, sliceId: string): SliceRow | null {
    const row = this.db
      .prepare("SELECT * FROM slices WHERE milestone_id = ? AND id = ?")
      .get(milestoneId, sliceId);
    return row ? (row as unknown as SliceRow) : null;
  }

  getSlices(milestoneId: string): SliceRow[] {
    return this.db
      .prepare("SELECT * FROM slices WHERE milestone_id = ? ORDER BY seq, id")
      .all(milestoneId) as unknown as SliceRow[];
  }

  // ── Task queries ────────────────────────────────────────────────────

  getTask(
    milestoneId: string,
    sliceId: string,
    taskId: string,
  ): TaskRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
      )
      .get(milestoneId, sliceId, taskId);
    return row ? (row as unknown as TaskRow) : null;
  }

  getTasks(milestoneId: string, sliceId: string): TaskRow[] {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? ORDER BY seq, id",
      )
      .all(milestoneId, sliceId) as unknown as TaskRow[];
  }

  // ── Post-command hook (manifest, event log, projections) ────────────

  /**
   * Called after every command to render projections, write manifest,
   * and append event log entry. All operations are non-fatal.
   */
  private afterCommand(cmd: string, params: Record<string, unknown>): void {
    // Render projections after every command (ENG-04, PROJ-01..05)
    const milestoneId = (params as { milestoneId?: string }).milestoneId;
    if (milestoneId) {
      try {
        renderAllProjections(this.basePath, milestoneId);
      } catch (err) {
        process.stderr.write(`workflow-engine: projection render failed (non-fatal): ${(err as Error).message}\n`);
      }
    }
    // Write manifest after every command (MAN-03, D-08)
    try {
      writeManifest(this.basePath, this.db);
    } catch (err) {
      process.stderr.write(`workflow-engine: manifest write failed (non-fatal): ${(err as Error).message}\n`);
    }
    // Append event (EVT-01, D-09)
    try {
      appendEvent(this.basePath, { cmd, params, ts: new Date().toISOString(), actor: "agent" });
    } catch (err) {
      process.stderr.write(`workflow-engine: event append failed (non-fatal): ${(err as Error).message}\n`);
    }
  }

  // ── Command handlers (delegated to workflow-commands.ts) ───────────

  completeTask(params: CompleteTaskParams): CompleteTaskResult {
    const result = _completeTask(this.db, params);
    this.afterCommand("complete_task", params as unknown as Record<string, unknown>);
    return result;
  }

  completeSlice(params: CompleteSliceParams): CompleteSliceResult {
    const result = _completeSlice(this.db, params);
    this.afterCommand("complete_slice", params as unknown as Record<string, unknown>);

    // Event log compaction (EVT-03, D-16):
    // When all slices in the milestone are done, archive the milestone's events
    // to keep the active event log bounded for fork-point detection.
    const progress = _milestoneProgress(this.db, params.milestoneId);
    if (progress.pct === 100) {
      try {
        compactMilestoneEvents(this.basePath, params.milestoneId);
      } catch (err) {
        // Non-fatal: compaction failure must not block slice completion
        process.stderr.write(
          `event-compaction: failed for ${params.milestoneId}: ${(err as Error).message}\n`,
        );
      }
    }

    return result;
  }

  planSlice(params: PlanSliceParams): PlanSliceResult {
    const result = _planSlice(this.db, params);
    this.afterCommand("plan_slice", params as unknown as Record<string, unknown>);
    return result;
  }

  saveDecision(params: SaveDecisionParams): SaveDecisionResult {
    const result = _saveDecision(this.db, params);
    this.afterCommand("save_decision", params as unknown as Record<string, unknown>);
    return result;
  }

  startTask(params: StartTaskParams): StartTaskResult {
    const result = _startTask(this.db, params);
    this.afterCommand("start_task", params as unknown as Record<string, unknown>);
    return result;
  }

  recordVerification(params: RecordVerificationParams): RecordVerificationResult {
    const result = _recordVerification(this.db, params);
    this.afterCommand("record_verification", params as unknown as Record<string, unknown>);
    return result;
  }

  reportBlocker(params: ReportBlockerParams): ReportBlockerResult {
    const result = _reportBlocker(this.db, params);
    this.afterCommand("report_blocker", params as unknown as Record<string, unknown>);
    return result;
  }

  // ── Event replay (cross-worktree reconciliation) ──────────────────

  /**
   * Replay a single event from another engine's log.
   * Dispatches to the matching command handler but suppresses afterCommand
   * side effects (no event append, no manifest write). Projections still render.
   * Per D-10: lenient — unknown/failing events are skipped with stderr warning.
   */
  replay(event: WorkflowEvent): void {
    const handlers: Record<string, (p: Record<string, unknown>) => unknown> = {
      complete_task: (p) => _completeTask(this.db, p as unknown as CompleteTaskParams),
      complete_slice: (p) => _completeSlice(this.db, p as unknown as CompleteSliceParams),
      plan_slice: (p) => _planSlice(this.db, p as unknown as PlanSliceParams),
      save_decision: (p) => _saveDecision(this.db, p as unknown as SaveDecisionParams),
      start_task: (p) => _startTask(this.db, p as unknown as StartTaskParams),
      record_verification: (p) => _recordVerification(this.db, p as unknown as RecordVerificationParams),
      report_blocker: (p) => _reportBlocker(this.db, p as unknown as ReportBlockerParams),
    };

    const handler = handlers[event.cmd];
    if (!handler) {
      process.stderr.write(`workflow-engine: replay skipping unknown cmd: ${event.cmd}\n`);
      return;
    }

    try {
      handler(event.params);
      // D-11: render projections but do NOT call afterCommand
      const milestoneId = (event.params as { milestoneId?: string }).milestoneId;
      if (milestoneId) {
        try { renderAllProjections(this.basePath, milestoneId); } catch { /* non-fatal */ }
      }
    } catch (err) {
      process.stderr.write(`workflow-engine: replay skipping ${event.cmd} (${event.hash ?? "?"}): ${(err as Error).message}\n`);
    }
  }

  /**
   * Replay multiple events in order. Per D-12: if one fails, log and continue.
   */
  replayAll(events: WorkflowEvent[]): void {
    for (const event of events) {
      this.replay(event);
    }
  }

  // ── State derivation ───────────────────────────────────────────────

  /**
   * Derive the current GSD workflow state from database reads.
   * Returns a typed GSDState with active milestone/slice/task refs,
   * phase detection, recent decisions, blockers, and progress.
   */
  deriveState(): GSDState {
    // Active milestone
    const activeMilestoneRow = this.db
      .prepare("SELECT * FROM milestones WHERE status = 'active' LIMIT 1")
      .get() as Record<string, unknown> | undefined;

    const activeMilestone: ActiveRef | null = activeMilestoneRow
      ? {
          id: activeMilestoneRow["id"] as string,
          title: activeMilestoneRow["title"] as string,
        }
      : null;

    // Active slice (within active milestone)
    let activeSlice: ActiveRef | null = null;
    if (activeMilestone) {
      const activeSliceRow = this.db
        .prepare(
          "SELECT * FROM slices WHERE milestone_id = ? AND status = 'active' ORDER BY seq LIMIT 1",
        )
        .get(activeMilestone.id) as Record<string, unknown> | undefined;
      if (activeSliceRow) {
        activeSlice = {
          id: activeSliceRow["id"] as string,
          title: activeSliceRow["title"] as string,
        };
      }
    }

    // Active task (in-progress first, then first pending)
    let activeTask: ActiveRef | null = null;
    if (activeMilestone && activeSlice) {
      const inProgressTask = this.db
        .prepare(
          "SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND status = 'in-progress' ORDER BY seq LIMIT 1",
        )
        .get(activeMilestone.id, activeSlice.id) as
        | Record<string, unknown>
        | undefined;
      if (inProgressTask) {
        activeTask = {
          id: inProgressTask["id"] as string,
          title: inProgressTask["title"] as string,
        };
      } else {
        const pendingTask = this.db
          .prepare(
            "SELECT * FROM tasks WHERE milestone_id = ? AND slice_id = ? AND status = 'pending' ORDER BY seq LIMIT 1",
          )
          .get(activeMilestone.id, activeSlice.id) as
          | Record<string, unknown>
          | undefined;
        if (pendingTask) {
          activeTask = {
            id: pendingTask["id"] as string,
            title: pendingTask["title"] as string,
          };
        }
      }
    }

    // Phase detection
    const phase = this.detectPhase(activeMilestone, activeSlice, activeTask);

    // Recent decisions (last 5 from existing decisions table)
    const recentDecisions: string[] = [];
    try {
      const decRows = this.db
        .prepare(
          "SELECT decision, choice FROM active_decisions ORDER BY seq DESC LIMIT 5",
        )
        .all();
      for (const row of decRows) {
        recentDecisions.push(
          `${row["decision"] as string}: ${row["choice"] as string}`,
        );
      }
    } catch {
      // active_decisions view may not exist in edge cases — non-fatal
    }

    // Blockers (tasks with status='blocked')
    const blockers: string[] = [];
    const blockerRows = this.db
      .prepare("SELECT milestone_id, slice_id, id, title, blocker FROM tasks WHERE status = 'blocked'")
      .all();
    for (const row of blockerRows) {
      const label = `${row["milestone_id"]}/${row["slice_id"]}/${row["id"]}: ${row["title"]}`;
      const reason = row["blocker"] ? ` — ${row["blocker"]}` : "";
      blockers.push(`${label}${reason}`);
    }

    // Next action hint
    const nextAction = this.deriveNextAction(
      activeMilestone,
      activeSlice,
      activeTask,
      phase,
    );

    // Milestone registry
    const registry: MilestoneRegistryEntry[] = this.db
      .prepare("SELECT id, title, status FROM milestones ORDER BY id")
      .all()
      .map((row) => ({
        id: row["id"] as string,
        title: row["title"] as string,
        status: row["status"] as MilestoneRegistryEntry["status"],
      }));

    // Progress
    const milestoneRows = this.db
      .prepare("SELECT COUNT(*) as total FROM milestones")
      .get() as Record<string, unknown> | undefined;
    const milestoneDoneRows = this.db
      .prepare("SELECT COUNT(*) as done FROM milestones WHERE status = 'complete'")
      .get() as Record<string, unknown> | undefined;
    const milestoneTotal = (milestoneRows?.["total"] as number) ?? 0;
    const milestoneDone = (milestoneDoneRows?.["done"] as number) ?? 0;

    let sliceProgress: { done: number; total: number } | undefined;
    let taskProgress: { done: number; total: number } | undefined;

    if (activeMilestone) {
      const sliceTotal = this.db
        .prepare("SELECT COUNT(*) as cnt FROM slices WHERE milestone_id = ?")
        .get(activeMilestone.id) as Record<string, unknown> | undefined;
      const sliceDone = this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM slices WHERE milestone_id = ? AND status = 'done'",
        )
        .get(activeMilestone.id) as Record<string, unknown> | undefined;
      sliceProgress = {
        total: (sliceTotal?.["cnt"] as number) ?? 0,
        done: (sliceDone?.["cnt"] as number) ?? 0,
      };

      if (activeSlice) {
        const taskTotal = this.db
          .prepare(
            "SELECT COUNT(*) as cnt FROM tasks WHERE milestone_id = ? AND slice_id = ?",
          )
          .get(activeMilestone.id, activeSlice.id) as
          | Record<string, unknown>
          | undefined;
        const taskDone = this.db
          .prepare(
            "SELECT COUNT(*) as cnt FROM tasks WHERE milestone_id = ? AND slice_id = ? AND status = 'done'",
          )
          .get(activeMilestone.id, activeSlice.id) as
          | Record<string, unknown>
          | undefined;
        taskProgress = {
          total: (taskTotal?.["cnt"] as number) ?? 0,
          done: (taskDone?.["cnt"] as number) ?? 0,
        };
      }
    }

    return {
      activeMilestone,
      activeSlice,
      activeTask,
      phase,
      recentDecisions,
      blockers,
      nextAction,
      registry,
      progress: {
        milestones: { done: milestoneDone, total: milestoneTotal },
        ...(sliceProgress ? { slices: sliceProgress } : {}),
        ...(taskProgress ? { tasks: taskProgress } : {}),
      },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private detectPhase(
    activeMilestone: ActiveRef | null,
    activeSlice: ActiveRef | null,
    activeTask: ActiveRef | null,
  ): Phase {
    if (!activeMilestone) return "pre-planning";
    if (!activeSlice) return "planning";
    if (!activeTask) return "planning";
    return "executing";
  }

  private deriveNextAction(
    activeMilestone: ActiveRef | null,
    activeSlice: ActiveRef | null,
    activeTask: ActiveRef | null,
    phase: Phase,
  ): string {
    if (!activeMilestone) return "Create or activate a milestone to begin";
    if (!activeSlice) return `Plan slices for milestone ${activeMilestone.id}`;
    if (!activeTask) return `Plan tasks for slice ${activeSlice.id}`;
    return `Execute task ${activeTask.id}: ${activeTask.title}`;
  }
}

// ─── Module-level singleton ──────────────────────────────────────────────

let _engineInstance: WorkflowEngine | null = null;
let _engineBasePath: string | null = null;

/**
 * Get or create a WorkflowEngine singleton for the given base path.
 * Reuses existing instance if the base path matches.
 */
export function getEngine(basePath: string): WorkflowEngine {
  if (_engineInstance && _engineBasePath === basePath) {
    return _engineInstance;
  }
  _engineInstance = new WorkflowEngine(basePath);
  _engineBasePath = basePath;
  return _engineInstance;
}

/**
 * Check whether the WorkflowEngine can be instantiated for the given path.
 * Verifies DB is available AND the v5 milestones table exists.
 */
export function isEngineAvailable(basePath: string): boolean {
  if (!isDbAvailable()) return false;
  try {
    const adapter = _getAdapter();
    if (!adapter) return false;
    const row = adapter
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='milestones'",
      )
      .get();
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Reset the engine singleton (testing only).
 */
export function resetEngine(): void {
  _engineInstance = null;
  _engineBasePath = null;
}
