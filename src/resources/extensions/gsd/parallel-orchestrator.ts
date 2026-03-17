/**
 * GSD Parallel Orchestrator — Core engine for parallel milestone orchestration.
 *
 * Manages worker lifecycle, budget tracking, and coordination. Workers are
 * separate processes spawned via child_process, each running in its own git
 * worktree with GSD_MILESTONE_LOCK env var set. The coordinator monitors
 * workers via session status files (see session-status-io.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gsdRoot } from "./paths.js";
import { createWorktree, worktreePath } from "./worktree-manager.js";
import { autoWorktreeBranch, runWorktreePostCreateHook } from "./auto-worktree.js";
import { nativeBranchExists } from "./native-git-bridge.js";
import { readIntegrationBranch } from "./git-service.js";
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
 * Creates worktrees, spawns worker processes, and begins monitoring.
 */
export async function startParallel(
  basePath: string,
  milestoneIds: string[],
  prefs: GSDPreferences | undefined,
): Promise<{ started: string[]; errors: Array<{ mid: string; error: string }> }> {
  // Prevent workers from spawning nested parallel sessions
  if (process.env.GSD_PARALLEL_WORKER) {
    return { started: [], errors: [{ mid: "all", error: "Cannot start parallel from within a parallel worker" }] };
  }

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
    // Check budget ceiling before each spawn
    if (isBudgetExceeded()) {
      errors.push({ mid, error: `Budget ceiling ($${config.budget_ceiling}) reached — skipping` });
      continue;
    }

    try {
      // Create the worktree (without chdir — coordinator stays in project root)
      let wtPath: string;
      try {
        wtPath = createMilestoneWorktree(basePath, mid);
      } catch {
        // Worktree creation may fail in test environments or when git
        // is not available. Fall back to a placeholder path.
        wtPath = worktreePath(basePath, mid);
      }

      const worker: WorkerInfo = {
        milestoneId: mid,
        title: mid,
        pid: process.pid,
        process: null,
        worktreePath: wtPath,
        startedAt: now,
        state: "running",
        completedUnits: 0,
        cost: 0,
      };

      state.workers.set(mid, worker);

      // Write initial session status
      const sessionStatus: SessionStatus = {
        milestoneId: mid,
        pid: worker.pid,
        state: "running",
        currentUnit: null,
        completedUnits: 0,
        cost: 0,
        lastHeartbeat: now,
        startedAt: now,
        worktreePath: wtPath,
      };
      writeSessionStatus(basePath, sessionStatus);

      // Attempt to spawn the worker process.
      // Spawning may fail if the CLI binary is not available (e.g., in tests).
      // The worker is still tracked and can be spawned later via spawnWorker().
      const spawned = spawnWorker(basePath, mid);
      if (!spawned) {
        // Worker tracked but not yet running a process.
        // State stays "running" so coordinator can retry or user can investigate.
      }

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

// ─── Worktree Creation ────────────────────────────────────────────────────

/**
 * Create a git worktree for a milestone without changing the coordinator's cwd.
 * Uses milestone/<MID> branch naming (same as auto-worktree.ts).
 */
function createMilestoneWorktree(basePath: string, milestoneId: string): string {
  const branch = autoWorktreeBranch(milestoneId);
  const branchExists = nativeBranchExists(basePath, branch);

  let info: { name: string; path: string; branch: string; exists: boolean };
  if (branchExists) {
    info = createWorktree(basePath, milestoneId, { branch, reuseExistingBranch: true });
  } else {
    const integrationBranch = readIntegrationBranch(basePath, milestoneId) ?? undefined;
    info = createWorktree(basePath, milestoneId, { branch, startPoint: integrationBranch });
  }

  // Run post-create hook if configured
  runWorktreePostCreateHook(basePath, info.path);

  return info.path;
}

// ─── Worker Spawning ───────────────────────────────────────────────────

/**
 * Spawn a worker process for a milestone.
 * The worker runs `gsd --print "/gsd auto"` in the milestone's worktree
 * with GSD_MILESTONE_LOCK set to isolate state derivation.
 */
export function spawnWorker(
  basePath: string,
  milestoneId: string,
): boolean {
  if (!state) return false;
  const worker = state.workers.get(milestoneId);
  if (!worker) return false;
  if (worker.process) return true; // already spawned

  // Resolve the GSD CLI binary path
  const binPath = resolveGsdBin();
  if (!binPath) return false;

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [binPath, "--mode", "json", "--print", "/gsd auto"], {
      cwd: worker.worktreePath,
      env: {
        ...process.env,
        GSD_MILESTONE_LOCK: milestoneId,
        // Prevent workers from spawning their own parallel sessions
        GSD_PARALLEL_WORKER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
  } catch {
    return false;
  }

  // Handle spawn errors (e.g., ENOENT when binary doesn't exist)
  child.on("error", () => {
    if (!state) return;
    const w = state.workers.get(milestoneId);
    if (w) {
      w.process = null;
      // Don't change state — spawn failure is non-fatal, coordinator can retry
    }
  });

  worker.process = child;
  worker.pid = child.pid ?? 0;

  if (!child.pid) {
    // Spawn returned but no PID — process failed to start
    worker.process = null;
    return false;
  }

  // ── NDJSON stdout monitoring ────────────────────────────────────────
  // Workers run with --mode json, emitting one JSON event per line.
  // We parse message_end events to extract cost/token usage, keeping
  // the coordinator's cost tracking in sync with actual API spend.
  if (child.stdout) {
    let stdoutBuffer = "";
    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        processWorkerLine(basePath, milestoneId, line);
      }
    });
    // Flush remaining buffer on close
    child.stdout.on("close", () => {
      if (stdoutBuffer.trim()) {
        processWorkerLine(basePath, milestoneId, stdoutBuffer);
      }
    });
  }

  // Update session status with real PID
  writeSessionStatus(basePath, {
    milestoneId,
    pid: worker.pid,
    state: "running",
    currentUnit: null,
    completedUnits: worker.completedUnits,
    cost: worker.cost,
    lastHeartbeat: Date.now(),
    startedAt: worker.startedAt,
    worktreePath: worker.worktreePath,
  });

  // Handle worker exit
  child.on("exit", (code) => {
    if (!state) return;
    const w = state.workers.get(milestoneId);
    if (!w) return;

    w.process = null;
    if (w.state === "stopped") return; // graceful stop, already handled

    if (code === 0) {
      w.state = "stopped";
    } else {
      w.state = "error";
    }

    // Update session status
    writeSessionStatus(basePath, {
      milestoneId,
      pid: w.pid,
      state: w.state,
      currentUnit: null,
      completedUnits: w.completedUnits,
      cost: w.cost,
      lastHeartbeat: Date.now(),
      startedAt: w.startedAt,
      worktreePath: w.worktreePath,
    });
  });

  return true;
}

/**
 * Resolve the GSD CLI binary path.
 * Uses GSD_BIN_PATH env var (set by loader.ts) or falls back to
 * finding the binary relative to the current module.
 */
function resolveGsdBin(): string | null {
  // GSD_BIN_PATH is set by loader.ts to the absolute path of dist/loader.js
  if (process.env.GSD_BIN_PATH && existsSync(process.env.GSD_BIN_PATH)) {
    return process.env.GSD_BIN_PATH;
  }

  // Fallback: try to find loader.js relative to this file
  // This file is at dist/resources/extensions/gsd/parallel-orchestrator.js
  // loader.js is at dist/loader.js
  let thisDir: string;
  try {
    thisDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    thisDir = process.cwd();
  }
  const candidates = [
    join(thisDir, "..", "..", "..", "loader.js"),
    join(thisDir, "..", "..", "..", "..", "dist", "loader.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// ─── NDJSON Processing ──────────────────────────────────────────────────────

/**
 * Process a single NDJSON line from a worker's stdout.
 * Extracts cost and token usage from message_end events and updates
 * the worker's tracking state + session status file.
 */
function processWorkerLine(basePath: string, milestoneId: string, line: string): void {
  if (!line.trim() || !state) return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return; // Not valid JSON — skip (stderr leakage, debug output, etc.)
  }

  const type = String(event.type ?? "");

  // message_end carries usage data with cost
  if (type === "message_end" && event.message) {
    const msg = event.message as Record<string, unknown>;
    const usage = msg.usage as Record<string, unknown> | undefined;

    if (usage) {
      const cost = (usage.cost as Record<string, unknown>)?.total;
      if (typeof cost === "number") {
        const worker = state.workers.get(milestoneId);
        if (worker) {
          worker.cost += cost;
          // Update aggregate
          state.totalCost = 0;
          for (const w of state.workers.values()) {
            state.totalCost += w.cost;
          }
        }
      }
    }

    // Track completed units (each message_end from assistant = progress)
    if (msg.role === "assistant") {
      const worker = state.workers.get(milestoneId);
      if (worker) {
        worker.completedUnits++;
      }
    }

    // Update session status file so dashboard sees live cost
    const worker = state.workers.get(milestoneId);
    if (worker) {
      writeSessionStatus(basePath, {
        milestoneId,
        pid: worker.pid,
        state: worker.state,
        currentUnit: null,
        completedUnits: worker.completedUnits,
        cost: worker.cost,
        lastHeartbeat: Date.now(),
        startedAt: worker.startedAt,
        worktreePath: worker.worktreePath,
      });
    }
  }

  // tool_execution_start can track current unit
  if (type === "extension_ui_request" && event.method === "notify") {
    // GSD auto-mode sends notifications about current unit
    const worker = state.workers.get(milestoneId);
    if (worker) {
      writeSessionStatus(basePath, {
        milestoneId,
        pid: worker.pid,
        state: worker.state,
        currentUnit: null,
        completedUnits: worker.completedUnits,
        cost: worker.cost,
        lastHeartbeat: Date.now(),
        startedAt: worker.startedAt,
        worktreePath: worker.worktreePath,
      });
    }
  }
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

    // Send stop signal via file-based IPC (worker checks on next dispatch)
    sendSignal(basePath, mid, "stop");

    // Send SIGTERM to the process for immediate response.
    // Use process handle when available, fall back to PID-based kill
    // (handles are null after coordinator restart / deserialization).
    if (worker.pid > 0) {
      try {
        if (worker.process) {
          worker.process.kill("SIGTERM");
        } else {
          process.kill(worker.pid, "SIGTERM");
        }
      } catch { /* process may already be dead */ }
    }

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
