/**
 * GSD Parallel Orchestrator — Core engine for parallel milestone orchestration.
 *
 * Manages worker lifecycle, budget tracking, and coordination. Workers are
 * separate processes spawned via child_process, each running in its own git
 * worktree with GSD_MILESTONE_LOCK env var set. The coordinator monitors
 * workers via session status files (see session-status-io.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gsdRoot } from "./paths.js";
import { createWorktree, worktreePath } from "./worktree-manager.js";
import { autoWorktreeBranch, runWorktreePostCreateHook, syncGsdStateToWorktree } from "./auto-worktree.js";
import { nativeBranchExists } from "./native-git-bridge.js";
import { readIntegrationBranch } from "./git-service.js";
import { resolveParallelConfig } from "./preferences.js";
import type { GSDPreferences } from "./preferences.js";
import type { ParallelConfig } from "./types.js";
import {
  writeSessionStatus,
  readAllSessionStatuses,
  readSessionStatus,
  removeSessionStatus,
  sendSignal,
  cleanupStaleSessions,
  type SessionStatus,
} from "./session-status-io.js";
import {
  analyzeParallelEligibility,
  type ParallelCandidates,
} from "./parallel-eligibility.js";
import { getErrorMessage } from "./error-utils.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WorkerInfo {
  milestoneId: string;
  title: string;
  pid: number;
  process: ChildProcess | null; // null after process exits
  worktreePath: string;
  startedAt: number;
  state: "running" | "paused" | "stopped" | "error";
  cost: number;
  cleanup?: () => void;
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

// ─── Persistence ──────────────────────────────────────────────────────────

const ORCHESTRATOR_STATE_FILE = "orchestrator.json";
const TMP_SUFFIX = ".tmp";

export interface PersistedState {
  active: boolean;
  workers: Array<{
    milestoneId: string;
    title: string;
    pid: number;
    worktreePath: string;
    startedAt: number;
    state: "running" | "paused" | "stopped" | "error";
    cost: number;
  }>;
  totalCost: number;
  startedAt: number;
  configSnapshot: { max_workers: number; budget_ceiling?: number };
}

function stateFilePath(basePath: string): string {
  return join(gsdRoot(basePath), ORCHESTRATOR_STATE_FILE);
}

/**
 * Persist the current orchestrator state to .gsd/orchestrator.json.
 * Uses atomic write (tmp + rename) to prevent partial reads.
 */
export function persistState(basePath: string): void {
  if (!state) return;
  try {
    const dir = gsdRoot(basePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const persisted: PersistedState = {
      active: state.active,
      workers: [...state.workers.values()].map((w) => ({
        milestoneId: w.milestoneId,
        title: w.title,
        pid: w.pid,
        worktreePath: w.worktreePath,
        startedAt: w.startedAt,
        state: w.state,
        cost: w.cost,
      })),
      totalCost: state.totalCost,
      startedAt: state.startedAt,
      configSnapshot: {
        max_workers: state.config.max_workers,
        budget_ceiling: state.config.budget_ceiling,
      },
    };

    const dest = stateFilePath(basePath);
    const tmp = dest + TMP_SUFFIX;
    writeFileSync(tmp, JSON.stringify(persisted, null, 2), "utf-8");
    renameSync(tmp, dest);
  } catch { /* non-fatal */ }
}

/**
 * Remove the persisted state file.
 */
function removeStateFile(basePath: string): void {
  try {
    const p = stateFilePath(basePath);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* non-fatal */ }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore orchestrator state from .gsd/orchestrator.json.
 * Checks PID liveness for each worker:
 * - Living PID → state "running", process stays null (no handle)
 * - Dead PID → removed from restored state
 * Returns null if no state file exists or no workers survive.
 */
export function restoreState(basePath: string): PersistedState | null {
  try {
    const p = stateFilePath(basePath);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const persisted = JSON.parse(raw) as PersistedState;

    // Filter to only workers with living PIDs
    persisted.workers = persisted.workers.filter((w) => {
      if (w.state === "stopped" || w.state === "error") return false;
      return isPidAlive(w.pid);
    });

    if (persisted.workers.length === 0) {
      // No surviving workers — clean up and return null
      removeStateFile(basePath);
      return null;
    }

    return persisted;
  } catch {
    return null;
  }
}

function workerLogPath(basePath: string, milestoneId: string): string {
  return join(gsdRoot(basePath), "parallel", `${milestoneId}.stderr.log`);
}

function appendWorkerLog(basePath: string, milestoneId: string, chunk: string): void {
  try {
    const dir = join(gsdRoot(basePath), "parallel");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(workerLogPath(basePath, milestoneId), chunk, "utf-8");
  } catch {
    // Non-fatal — diagnostics should never break orchestration.
  }
}

function restoreRuntimeState(basePath: string): boolean {
  if (state?.active) {
    // Verify at least one worker is alive — if all are in terminal states,
    // the cached state is stale and we should fall through to cleanup.
    const hasLiveWorker = [...state.workers.values()].some(
      (w) => w.state !== "error" && w.state !== "stopped",
    );
    if (hasLiveWorker) return true;

    // All workers dead — clear stale state so restoreState() can clean up.
    state = null;
  }

  const restored = restoreState(basePath);
  if (restored && restored.workers.length > 0) {
    const config = resolveParallelConfig(undefined);
    state = {
      active: restored.active,
      workers: new Map(),
      config: {
        ...config,
        max_workers: restored.configSnapshot.max_workers,
        budget_ceiling: restored.configSnapshot.budget_ceiling,
      },
      totalCost: restored.totalCost,
      startedAt: restored.startedAt,
    };

    for (const w of restored.workers) {
      const diskStatus = readSessionStatus(basePath, w.milestoneId);
      state.workers.set(w.milestoneId, {
        milestoneId: w.milestoneId,
        title: w.title,
        pid: diskStatus?.pid ?? w.pid,
        process: null,
        worktreePath: diskStatus?.worktreePath ?? w.worktreePath,
        startedAt: w.startedAt,
        state: diskStatus?.state ?? w.state,
        cost: diskStatus?.cost ?? w.cost,
      });
    }

    return true;
  }

  // Fallback: rebuild coordinator state from live session status files.
  // This covers cases where orchestrator.json is missing/corrupt but workers are
  // still running and writing heartbeats under .gsd/parallel/.
  cleanupStaleSessions(basePath);
  const statuses = readAllSessionStatuses(basePath);
  if (statuses.length === 0) {
    return false;
  }

  const config = resolveParallelConfig(undefined);
  state = {
    active: true,
    workers: new Map(),
    config,
    totalCost: 0,
    startedAt: Math.min(...statuses.map((status) => status.startedAt)),
  };

  for (const status of statuses) {
    state.workers.set(status.milestoneId, {
      milestoneId: status.milestoneId,
      title: status.milestoneId,
      pid: status.pid,
      process: null,
      worktreePath: status.worktreePath,
      startedAt: status.startedAt,
      state: status.state,
      cost: status.cost,
    });
    state.totalCost += status.cost;
  }

  return true;
}

async function waitForWorkerExit(worker: WorkerInfo, timeoutMs: number): Promise<boolean> {
  if (worker.process) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, timeoutMs);
      worker.process!.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return worker.process === null || !isPidAlive(worker.pid);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(worker.pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(worker.pid);
}


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
export function getWorkerStatuses(basePath?: string): WorkerInfo[] {
  if (basePath) {
    refreshWorkerStatuses(basePath, { restoreIfNeeded: true });
  }
  if (!state) return [];
  return [...state.workers.values()];
}

// ─── Preparation ───────────────────────────────────────────────────────────

/**
 * Analyze eligibility and prepare for parallel start.
 * Returns the candidates report without actually starting workers.
 * Also detects orphaned sessions from prior crashes.
 */
export async function prepareParallelStart(
  basePath: string,
  _prefs: GSDPreferences | undefined,
): Promise<ParallelCandidates & { orphans?: Array<{ milestoneId: string; pid: number; alive: boolean }> }> {
  // Detect orphaned sessions before eligibility analysis
  const sessions = readAllSessionStatuses(basePath);
  const orphans: Array<{ milestoneId: string; pid: number; alive: boolean }> = [];
  for (const session of sessions) {
    const alive = isPidAlive(session.pid);
    orphans.push({ milestoneId: session.milestoneId, pid: session.pid, alive });
    if (!alive) {
      // Clean up dead session
      removeSessionStatus(basePath, session.milestoneId);
    }
  }

  const candidates = await analyzeParallelEligibility(basePath);
  return orphans.length > 0 ? { ...candidates, orphans } : candidates;
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

  // Release any leftover state from a previous session before reassigning
  if (state) {
    for (const w of state.workers.values()) {
      w.cleanup?.();
      w.cleanup = undefined;
      w.process = null;
    }
    state.workers.clear();
  }

  // Try to restore from a previous crash
  const restored = restoreState(basePath);
  if (restored && restored.workers.length > 0) {
    // Adopt surviving workers instead of starting new ones
    state = {
      active: true,
      workers: new Map(),
      config,
      totalCost: restored.totalCost,
      startedAt: restored.startedAt,
    };
    const adopted: string[] = [];
    for (const w of restored.workers) {
      state.workers.set(w.milestoneId, {
        milestoneId: w.milestoneId,
        title: w.title,
        pid: w.pid,
        process: null, // no handle for adopted workers
        worktreePath: w.worktreePath,
        startedAt: w.startedAt,
        state: "running",
        cost: w.cost,
      });
      adopted.push(w.milestoneId);
    }
    return { started: adopted, errors: [] };
  }

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
        pid: 0,  // placeholder — real PID set by spawnWorker()
        process: null,
        worktreePath: wtPath,
        startedAt: now,
        state: "running",
        cost: 0,
      };

      state.workers.set(mid, worker);

      // Spawn BEFORE writing session status so the file gets the real worker PID.
      const spawned = spawnWorker(basePath, mid);
      if (!spawned) {
        worker.state = "error";
      }

      // Write session status with real PID (or 0 if spawn failed)
      writeSessionStatus(basePath, {
        milestoneId: mid,
        pid: worker.pid,
        state: worker.state,
        currentUnit: null,
        completedUnits: 0,
        cost: 0,
        lastHeartbeat: now,
        startedAt: now,
        worktreePath: wtPath,
      });

      started.push(mid);
    } catch (err) {
      const message = getErrorMessage(err);
      errors.push({ mid, error: message });
    }
  }

  // If nothing started successfully, deactivate
  if (started.length === 0) {
    state.active = false;
  }

  // Persist state for crash recovery
  persistState(basePath);

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

  // Copy .gsd/ planning artifacts (milestones, CONTEXT, ROADMAP, etc.) from the
  // project root into the worktree. Without this, workers for newly-planned
  // milestones can't find their roadmap and exit immediately (#2184 Bug 4).
  syncGsdStateToWorktree(basePath, info.path);

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
        // Pass the real project root so workers don't need to re-derive it.
        // Without this, process.cwd() resolves symlinks and the worktree
        // path heuristic can match the user-level ~/.gsd instead of the
        // project .gsd, causing writes to ~ and corrupting user config.
        GSD_PROJECT_ROOT: basePath,
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

  if (child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      appendWorkerLog(basePath, milestoneId, data.toString());
    });
  }

  // Update session status with real PID
  writeSessionStatus(basePath, {
    milestoneId,
    pid: worker.pid,
    state: "running",
    currentUnit: null,
    completedUnits: 0,
    cost: worker.cost,
    lastHeartbeat: Date.now(),
    startedAt: worker.startedAt,
    worktreePath: worker.worktreePath,
  });

  // Store cleanup function to remove all listeners from the child process.
  // This prevents listener accumulation when workers are respawned, since
  // handler closures capture milestoneId and other data that would otherwise
  // be retained indefinitely.
  worker.cleanup = () => {
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
  };

  // Handle worker exit
  child.on("exit", (code) => {
    if (!state) return;
    const w = state.workers.get(milestoneId);
    if (!w) return;

    // Remove all stream listeners to release closure references
    w.cleanup?.();
    w.cleanup = undefined;

    w.process = null;
    if (w.state === "stopped") return; // graceful stop, already handled

    if (code === 0) {
      w.state = "stopped";
    } else {
      w.state = "error";
      appendWorkerLog(basePath, milestoneId, `\n[orchestrator] worker exited with code ${code ?? "null"}\n`);
    }

    // Update session status and persist orchestrator state for crash recovery
    writeSessionStatus(basePath, {
      milestoneId,
      pid: w.pid,
      state: w.state,
      currentUnit: null,
      completedUnits: 0,
      cost: w.cost,
      lastHeartbeat: Date.now(),
      startedAt: w.startedAt,
      worktreePath: w.worktreePath,
    });
    persistState(basePath);
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

    // Update session status file so dashboard sees live cost
    const worker = state.workers.get(milestoneId);
    if (worker) {
      writeSessionStatus(basePath, {
        milestoneId,
        pid: worker.pid,
        state: worker.state,
        currentUnit: null,
        completedUnits: 0,
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
        completedUnits: 0,
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
        } else if (worker.pid !== process.pid) {
          process.kill(worker.pid, "SIGTERM");
        }
      } catch { /* process may already be dead */ }
    }

    const exitedAfterTerm = await waitForWorkerExit(worker, 750);
    if (!exitedAfterTerm && worker.pid > 0) {
      try {
        if (worker.process) {
          worker.process.kill("SIGKILL");
        } else if (worker.pid !== process.pid) {
          process.kill(worker.pid, "SIGKILL");
        }
      } catch { /* process may already be dead */ }
      await waitForWorkerExit(worker, 250);
    }

    // Remove stream listeners before releasing the process handle
    worker.cleanup?.();
    worker.cleanup = undefined;

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

  // Persist final state and clean up state file
  removeStateFile(basePath);
}

export async function shutdownParallel(basePath: string): Promise<void> {
  if (!state) return;
  await stopParallel(basePath);
  resetOrchestrator();
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
export function refreshWorkerStatuses(
  basePath: string,
  options: { restoreIfNeeded?: boolean } = {},
): void {
  if (!state && options.restoreIfNeeded) {
    restoreRuntimeState(basePath);
  }
  if (!state) return;

  // Clean up stale sessions first
  const staleIds = cleanupStaleSessions(basePath);
  for (const mid of staleIds) {
    const worker = state.workers.get(mid);
    if (worker) {
      worker.cleanup?.();
      worker.cleanup = undefined;
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
    if (!diskStatus) {
      if (!isPidAlive(worker.pid)) {
        worker.cleanup?.();
        worker.cleanup = undefined;
        worker.state = "error";
        worker.process = null;
      }
      continue;
    }

    worker.state = diskStatus.state;
    worker.cost = diskStatus.cost;
    worker.pid = diskStatus.pid;
  }

  // Recalculate aggregate cost
  state.totalCost = 0;
  for (const worker of state.workers.values()) {
    state.totalCost += worker.cost;
  }

  // If all workers are in a terminal state (error/stopped), the orchestration
  // is finished — deactivate and clean up so zombie workers don't persist.
  const allDead = [...state.workers.values()].every(
    (w) => w.state === "error" || w.state === "stopped",
  );
  if (allDead) {
    state.active = false;
    removeStateFile(basePath);
    state = null;
    return;
  }

  // Persist updated state for crash recovery
  persistState(basePath);
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
  if (state) {
    // Explicitly release all WorkerInfo references and run any pending
    // cleanup callbacks so child process stream closures are freed.
    for (const w of state.workers.values()) {
      w.cleanup?.();
      w.cleanup = undefined;
      w.process = null;
    }
    state.workers.clear();
  }
  state = null;
}
