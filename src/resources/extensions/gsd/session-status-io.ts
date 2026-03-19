/**
 * GSD Session Status I/O
 *
 * File-based IPC protocol for coordinator-worker communication in
 * parallel milestone orchestration. Each worker writes its status to a
 * file; the coordinator reads all status files to monitor progress.
 *
 * Atomic writes (write to .tmp, then rename) prevent partial reads.
 * Signal files let the coordinator send pause/resume/stop/rebase to workers.
 * Stale detection combines PID liveness checks with heartbeat timeouts.
 */

import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { loadJsonFileOrNull, writeJsonFileAtomic } from "./json-persistence.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionStatus {
  milestoneId: string;
  pid: number;
  state: "running" | "paused" | "stopped" | "error";
  currentUnit: { type: string; id: string; startedAt: number } | null;
  completedUnits: number;
  cost: number;
  lastHeartbeat: number;
  startedAt: number;
  worktreePath: string;
  /** Path to the worker's Pi session file (.jsonl). Omitted if session not yet created. */
  sessionFile?: string;
}

export type SessionSignal = "pause" | "resume" | "stop" | "rebase";

export interface SignalMessage {
  signal: SessionSignal;
  sentAt: number;
  from: "coordinator";
}

// ─── Team Signal Types ─────────────────────────────────────────────────────

export type TeamSignalType =
  | "contract-change"
  | "slice-complete"
  | "api-available"
  | "schema-update"
  | "pattern-discovered";

export interface TeamSignal {
  type: TeamSignalType;
  /** Emitting worker's milestone ID */
  source: string;
  /** Target worker's milestone ID, or "*" for broadcast */
  workerMid: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export const TEAM_SIGNAL_SUFFIX = ".team-signals.ndjson";

// ─── Constants ─────────────────────────────────────────────────────────────

const PARALLEL_DIR = "parallel";
const STATUS_SUFFIX = ".status.json";
const SIGNAL_SUFFIX = ".signal.json";
const TMP_SUFFIX = ".tmp";
const DEFAULT_STALE_TIMEOUT_MS = 60_000;

function isSessionStatus(data: unknown): data is SessionStatus {
  return data !== null && typeof data === "object" && "milestoneId" in data && "pid" in data;
}

function isSignalMessage(data: unknown): data is SignalMessage {
  return data !== null && typeof data === "object" && "signal" in data && "sentAt" in data;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parallelDir(basePath: string): string {
  return join(gsdRoot(basePath), PARALLEL_DIR);
}

function statusPath(basePath: string, milestoneId: string): string {
  return join(parallelDir(basePath), `${milestoneId}${STATUS_SUFFIX}`);
}

function signalPath(basePath: string, milestoneId: string): string {
  return join(parallelDir(basePath), `${milestoneId}${SIGNAL_SUFFIX}`);
}

function ensureParallelDir(basePath: string): void {
  const dir = parallelDir(basePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Status I/O ────────────────────────────────────────────────────────────

/** Write session status atomically (write to .tmp, then rename). */
export function writeSessionStatus(basePath: string, status: SessionStatus): void {
  ensureParallelDir(basePath);
  writeJsonFileAtomic(statusPath(basePath, status.milestoneId), status);
}

/** Read a specific milestone's session status. */
export function readSessionStatus(basePath: string, milestoneId: string): SessionStatus | null {
  return loadJsonFileOrNull(statusPath(basePath, milestoneId), isSessionStatus);
}

/** Read all session status files from .gsd/parallel/. */
export function readAllSessionStatuses(basePath: string): SessionStatus[] {
  const dir = parallelDir(basePath);
  if (!existsSync(dir)) return [];

  const results: SessionStatus[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(STATUS_SUFFIX)) continue;
      const status = loadJsonFileOrNull(join(dir, entry), isSessionStatus);
      if (status) results.push(status);
    }
  } catch { /* non-fatal */ }
  return results;
}

/** Remove a milestone's session status file. */
export function removeSessionStatus(basePath: string, milestoneId: string): void {
  try {
    const p = statusPath(basePath, milestoneId);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* non-fatal */ }
}

// ─── Signal I/O ────────────────────────────────────────────────────────────

/** Write a signal file for a worker to consume. */
export function sendSignal(basePath: string, milestoneId: string, signal: SessionSignal): void {
  ensureParallelDir(basePath);
  const msg: SignalMessage = { signal, sentAt: Date.now(), from: "coordinator" };
  writeJsonFileAtomic(signalPath(basePath, milestoneId), msg);
}

/** Read and delete a signal file (atomic consume). Returns null if no signal pending. */
export function consumeSignal(basePath: string, milestoneId: string): SignalMessage | null {
  const p = signalPath(basePath, milestoneId);
  const msg = loadJsonFileOrNull(p, isSignalMessage);
  if (msg) {
    try { unlinkSync(p); } catch { /* non-fatal */ }
  }
  return msg;
}

// ─── Stale Detection ───────────────────────────────────────────────────────

/** Check whether a session is stale (PID dead or heartbeat timed out). */
export function isSessionStale(
  status: SessionStatus,
  timeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): boolean {
  if (!isPidAlive(status.pid)) return true;
  const elapsed = Date.now() - status.lastHeartbeat;
  return elapsed > timeoutMs;
}

/** Find and remove stale sessions. Returns the milestone IDs that were cleaned up. */
export function cleanupStaleSessions(
  basePath: string,
  timeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): string[] {
  const removed: string[] = [];
  const statuses = readAllSessionStatuses(basePath);

  for (const status of statuses) {
    if (isSessionStale(status, timeoutMs)) {
      removeSessionStatus(basePath, status.milestoneId);
      // Also clean up any lingering signal file
      try {
        const sig = signalPath(basePath, status.milestoneId);
        if (existsSync(sig)) unlinkSync(sig);
      } catch { /* non-fatal */ }
      removed.push(status.milestoneId);
    }
  }

  return removed;
}

// ─── Team Signal I/O ───────────────────────────────────────────────────────

function teamSignalPath(basePath: string, milestoneId: string): string {
  return join(parallelDir(basePath), `${milestoneId}${TEAM_SIGNAL_SUFFIX}`);
}

/**
 * Append a team signal to a worker's NDJSON signal file.
 * Uses appendFileSync for append-log semantics — multiple signals
 * accumulate between reads, unlike the existing consume-once signal channel.
 * Non-fatal: failures are silently caught (same pattern as writeSessionStatus).
 */
export function writeTeamSignal(
  basePath: string,
  targetMid: string,
  signal: TeamSignal,
): void {
  try {
    ensureParallelDir(basePath);
    const dest = teamSignalPath(basePath, targetMid);
    appendFileSync(dest, JSON.stringify(signal) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

/**
 * Read all accumulated team signals for a milestone.
 * Parses each NDJSON line independently — corrupt lines are silently skipped.
 * Returns empty array if file doesn't exist or is unreadable.
 */
export function readTeamSignals(basePath: string, mid: string): TeamSignal[] {
  try {
    const p = teamSignalPath(basePath, mid);
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf-8");
    const lines = raw.split("\n");
    const signals: TeamSignal[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        signals.push(JSON.parse(line) as TeamSignal);
      } catch { /* skip corrupt line */ }
    }
    return signals;
  } catch {
    return [];
  }
}

/**
 * Delete the team signal file for a milestone.
 * Used after signals have been consumed and routed.
 * Non-fatal: failures are silently caught.
 */
export function clearTeamSignals(basePath: string, mid: string): void {
  try {
    const p = teamSignalPath(basePath, mid);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* non-fatal */ }
}

// ─── Pause Handshake ───────────────────────────────────────────────────────

export interface PauseHandshakeResult {
  paused: boolean;
  sessionFile?: string;
  elapsedMs: number;
}

const DEFAULT_PAUSE_TIMEOUT_MS = 30_000;
const PAUSE_POLL_INTERVAL_MS = 500;

/**
 * Send a pause signal to a worker and wait for it to confirm the pause
 * by writing state: "paused" to its status file.
 *
 * Returns immediately with paused: false if the worker PID is dead.
 * Returns paused: false after timeout if the worker never pauses.
 */
export async function waitForWorkerPause(
  basePath: string,
  milestoneId: string,
  timeoutMs: number = DEFAULT_PAUSE_TIMEOUT_MS,
): Promise<PauseHandshakeResult> {
  const startedAt = Date.now();

  // Send the pause signal first
  sendSignal(basePath, milestoneId, "pause");

  // Poll status file until paused or timeout
  while (Date.now() - startedAt < timeoutMs) {
    const status = readSessionStatus(basePath, milestoneId);
    if (status) {
      // If worker PID is dead, bail immediately
      if (!isPidAlive(status.pid)) {
        return { paused: false, elapsedMs: Date.now() - startedAt };
      }
      if (status.state === "paused") {
        return {
          paused: true,
          sessionFile: status.sessionFile,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
    await new Promise<void>((r) => setTimeout(r, PAUSE_POLL_INTERVAL_MS));
  }

  return { paused: false, elapsedMs: Date.now() - startedAt };
}
