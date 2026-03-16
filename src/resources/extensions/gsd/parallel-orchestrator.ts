/**
 * GSD Parallel Orchestrator — Core engine for parallel milestone orchestration.
 *
 * Manages worker lifecycle, budget tracking, and coordination. Workers are
 * separate processes spawned via child_process, each running in its own git
 * worktree with GSD_MILESTONE_LOCK env var set. The coordinator monitors
 * workers via session status files (see session-status-io.ts).
 */

import { type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { resolveParallelConfig } from "./preferences.js";
import type { GSDPreferences } from "./preferences.js";
import type { ParallelConfig } from "./types.js";
import {
  writeSessionStatus,
  readAllSessionStatuses,
  removeSessionStatus,
  sendSignal,
  cleanupStaleSessions,
  type SessionStatus,
} from "./session-status-io.js";
import {
  analyzeParallelEligibility,
  type ParallelCandidates,
} from "./parallel-eligibility.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WorkerInfo {
  milestoneId: string;
  title: string;
  pid: number;
  process: ChildProcess | null; // null after process exits
  worktreePath: string;
  startedAt: number;
  state: "running" | "paused" | "stopped" | "error";
  completedUnits: number;
  cost: number;
}

export interface OrchestratorState {
  active: boolean;
  workers: Map<string, WorkerInfo>;
  config: ParallelConfig;
  totalCost: number;
  startedAt: number;
}

// ─── Module State ──────────────────────────────────────────────────────────

let state: OrchestratorState | null = null;

// ─── Accessors ─────────────────────────────────────────────────────────────

/** Returns true if the orchestrator is active and has been initialized. */
export function isParallelActive(): boolean {
  return state?.active ?? false;
}

/** Returns the current orchestrator state, or null if not initialized. */
export function getOrchestratorState(): OrchestratorState | null {
  return state;
}

/** Returns a snapshot of all tracked workers as an array. */
export function getWorkerStatuses(): WorkerInfo[] {
  if (!state) return [];
  return [...state.workers.values()];
}

// ─── Preparation ───────────────────────────────────────────────────────────

/**
 * Analyze eligibility and prepare for parallel start.
 * Returns the candidates report without actually starting workers.
 */
export async function prepareParallelStart(
  basePath: string,
  _prefs: GSDPreferences | undefined,
): Promise<ParallelCandidates> {
  return analyzeParallelEligibility(basePath);
}

// ─── Start ─────────────────────────────────────────────────────────────────

/**
 * Start parallel execution with the given eligible milestones.
 * Creates tracking structures and writes initial session status files.
 *
 * Actual worker process spawning is deferred to the auto-mode integration
 * layer; this function sets up the orchestrator state and bookkeeping only.
 */
export async function startParallel(
  basePath: string,
  milestoneIds: string[],
  prefs: GSDPreferences | undefined,
): Promise<{ started: string[]; errors: Array<{ mid: string; error: string }> }> {
  const config = resolveParallelConfig(prefs);
  const now = Date.now();

  // Initialize orchestrator state
  state = {
    active: true,
    workers: new Map(),
    config,
    totalCost: 0,
    startedAt: now,
  };

  const started: string[] = [];
  const errors: Array<{ mid: string; error: string }> = [];

  // Cap to max_workers
  const toStart = milestoneIds.slice(0, config.max_workers);

  for (const mid of toStart) {
    try {
      const worktreePath = join(gsdRoot(basePath), "worktrees", mid);

      const worker: WorkerInfo = {
        milestoneId: mid,
        title: mid,
        pid: process.pid,
        process: null,
        worktreePath,
        startedAt: now,
        state: "running",
        completedUnits: 0,
        cost: 0,
      };

      state.workers.set(mid, worker);

      // Write initial session status so the coordinator can track it
      const sessionStatus: SessionStatus = {
        milestoneId: mid,
        pid: process.pid,
        state: "running",
        currentUnit: null,
        completedUnits: 0,
        cost: 0,
        lastHeartbeat: now,
        startedAt: now,
        worktreePath,
      };
      writeSessionStatus(basePath, sessionStatus);

      started.push(mid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ mid, error: message });
    }
  }

  // If nothing started successfully, deactivate
  if (started.length === 0) {
    state.active = false;
  }

  return { started, errors };
}

// ─── Stop ──────────────────────────────────────────────────────────────────

/**
 * Stop all workers or a specific milestone's worker.
 * Sends stop signals and updates tracking state.
 */
export async function stopParallel(
  basePath: string,
  milestoneId?: string,
): Promise<void> {
  if (!state) return;

  const targets = milestoneId
    ? [milestoneId]
    : [...state.workers.keys()];

  for (const mid of targets) {
    const worker = state.workers.get(mid);
    if (!worker) continue;

    // Send stop signal to the worker process
    sendSignal(basePath, mid, "stop");

    // Update in-memory state
    worker.state = "stopped";
    worker.process = null;

    // Clean up session status file
    removeSessionStatus(basePath, mid);
  }

  // If stopping all workers, deactivate the orchestrator
  if (!milestoneId) {
    state.active = false;
  }
}

// ─── Pause / Resume ────────────────────────────────────────────────────────

/** Pause a specific worker or all workers. */
export function pauseWorker(
  basePath: string,
  milestoneId?: string,
): void {
  if (!state) return;

  const targets = milestoneId
    ? [milestoneId]
    : [...state.workers.keys()];

  for (const mid of targets) {
    const worker = state.workers.get(mid);
    if (!worker || worker.state !== "running") continue;

    sendSignal(basePath, mid, "pause");
    worker.state = "paused";
  }
}

/** Resume a specific worker or all workers. */
export function resumeWorker(
  basePath: string,
  milestoneId?: string,
): void {
  if (!state) return;

  const targets = milestoneId
    ? [milestoneId]
    : [...state.workers.keys()];

  for (const mid of targets) {
    const worker = state.workers.get(mid);
    if (!worker || worker.state !== "paused") continue;

    sendSignal(basePath, mid, "resume");
    worker.state = "running";
  }
}

// ─── Status Refresh ────────────────────────────────────────────────────────

/**
 * Poll worker statuses from disk and update orchestrator state.
 * Call this periodically from the dashboard refresh cycle.
 */
export function refreshWorkerStatuses(basePath: string): void {
  if (!state) return;

  // Clean up stale sessions first
  const staleIds = cleanupStaleSessions(basePath);
  for (const mid of staleIds) {
    const worker = state.workers.get(mid);
    if (worker) {
      worker.state = "error";
      worker.process = null;
    }
  }

  // Read all live session statuses from disk
  const statuses = readAllSessionStatuses(basePath);
  const statusMap = new Map<string, SessionStatus>();
  for (const s of statuses) {
    statusMap.set(s.milestoneId, s);
  }

  // Update in-memory worker state from disk data
  for (const [mid, worker] of state.workers) {
    const diskStatus = statusMap.get(mid);
    if (!diskStatus) continue;

    worker.state = diskStatus.state;
    worker.completedUnits = diskStatus.completedUnits;
    worker.cost = diskStatus.cost;
    worker.pid = diskStatus.pid;
  }

  // Recalculate aggregate cost
  state.totalCost = 0;
  for (const worker of state.workers.values()) {
    state.totalCost += worker.cost;
  }
}

// ─── Budget ────────────────────────────────────────────────────────────────

/** Get aggregate cost across all workers. */
export function getAggregateCost(): number {
  if (!state) return 0;
  return state.totalCost;
}

/** Check if budget ceiling has been reached. */
export function isBudgetExceeded(): boolean {
  if (!state) return false;
  if (state.config.budget_ceiling == null) return false;
  return state.totalCost >= state.config.budget_ceiling;
}

// ─── Reset ─────────────────────────────────────────────────────────────────

/** Reset orchestrator state. Called on clean shutdown. */
export function resetOrchestrator(): void {
  state = null;
}
