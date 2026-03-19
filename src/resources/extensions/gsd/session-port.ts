/**
 * session-port.ts — Full port/detach lifecycle management.
 *
 * Wraps switchSession() (which destroys all agent in-flight state) with
 * safety rails that ensure the coordinator's state survives the round-trip.
 *
 * Port lifecycle:
 *   1. Verify worker exists and has a sessionFile
 *   2. Pause coordinator's auto-mode dispatch loop
 *   3. Send pause signal + wait for confirmed handshake
 *   4. Set context tracker port state
 *   5. Persist portState to orchestrator.json (crash recovery)
 *   6. Call switchSession() to worker's session file
 *   7. (User interacts with worker session)
 *   8. On detach: switchSession back → clear port state → resume worker → resume auto-mode
 *
 * Import chain: context-tracker, session-status-io, parallel-orchestrator.
 * Does NOT import auto.ts, dashboard-overlay.ts, or agent-session.ts —
 * switchSession comes via opts.cmdCtx to avoid circular deps and enable testing.
 */

import {
  setPortState,
  getPortState,
  clearPortState,
  isPortActive,
  getPortedWorkerId,
} from "./context-tracker.js";

import {
  waitForWorkerPause,
  sendSignal,
  readSessionStatus,
} from "./session-status-io.js";

import {
  getOrchestratorState,
  persistState,
} from "./parallel-orchestrator.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PortOptions {
  cmdCtx: {
    sessionManager: {
      switchSession: (path: string) => Promise<void>;
      getSessionFile: () => string;
    };
  };
  basePath: string;
  pauseAutoMode: () => void;
  resumeAutoMode: () => void;
}

export interface PortResult {
  success: boolean;
  error?: string;
  elapsedMs?: number;
}

// ─── Port Into Worker ──────────────────────────────────────────────────────

/**
 * Port into a worker session. The coordinator pauses its auto-mode dispatch,
 * waits for the worker to confirm pause, then switches to the worker's session.
 *
 * On any error after auto-mode is paused, auto-mode is resumed and port state
 * is cleaned up via try/finally.
 */
export async function portIntoWorker(
  workerId: string,
  opts: PortOptions,
): Promise<PortResult> {
  const startedAt = Date.now();

  // ── Pre-checks (before pausing anything) ─────────────────────────────
  const orchState = getOrchestratorState();
  if (!orchState) {
    return { success: false, error: "Orchestrator not active" };
  }

  const workerInfo = orchState.workers.get(workerId);
  if (!workerInfo) {
    return { success: false, error: `Worker ${workerId} not found` };
  }
  if (workerInfo.state !== "running") {
    return { success: false, error: `Worker ${workerId} is ${workerInfo.state}, expected running` };
  }

  // Verify worker has a sessionFile via status file on disk
  const workerStatus = readSessionStatus(opts.basePath, workerId);
  if (!workerStatus?.sessionFile) {
    return { success: false, error: `Worker ${workerId} has no session file` };
  }
  const workerSessionFile = workerStatus.sessionFile;

  // ── Pause auto-mode FIRST ────────────────────────────────────────────
  opts.pauseAutoMode();

  // Everything after this point must resume auto-mode on error
  try {
    // ── Wait for worker pause handshake ────────────────────────────────
    const handshake = await waitForWorkerPause(opts.basePath, workerId);
    if (!handshake.paused) {
      return {
        success: false,
        error: "Worker did not pause within timeout",
        elapsedMs: Date.now() - startedAt,
      };
    }

    // ── Save coordinator state and set port state ──────────────────────
    const coordinatorSessionFile = opts.cmdCtx.sessionManager.getSessionFile();

    // Set port state in context tracker BEFORE persisting
    // (persistState reads isPortActive() + getPortState())
    setPortState({
      coordinatorSessionFile,
      portedWorkerMid: workerId,
      portedAt: new Date().toISOString(),
    });

    // Persist to orchestrator.json for crash recovery
    persistState(opts.basePath);

    // ── Switch to worker session ───────────────────────────────────────
    try {
      await opts.cmdCtx.sessionManager.switchSession(workerSessionFile);
    } catch (err) {
      // switchSession failed — clean up port state and re-throw to outer finally
      clearPortState();
      persistState(opts.basePath);
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `switchSession failed: ${message}`,
        elapsedMs: Date.now() - startedAt,
      };
    }

    return { success: true, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    // Unexpected error — clean up port state if it was set
    if (isPortActive()) {
      clearPortState();
      persistState(opts.basePath);
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Port failed: ${message}`,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    // On any error path (success: false returned above), resume auto-mode.
    // On success, auto-mode stays paused — user is interacting with worker.
    // We detect this by checking: if port state was cleared (error happened),
    // then auto-mode needs resuming. If port state is still set (success),
    // leave auto-mode paused.
    if (!isPortActive()) {
      opts.resumeAutoMode();
    }
  }
}

// ─── Detach From Worker ────────────────────────────────────────────────────

/**
 * Detach from a worker session and return to the coordinator.
 * Switches back to coordinator session, clears port state, resumes worker,
 * and resumes auto-mode dispatch.
 *
 * Best-effort recovery: if switchSession throws during detach, still tries
 * to resume the worker and auto-mode.
 */
export async function detachFromWorker(opts: PortOptions): Promise<PortResult> {
  const startedAt = Date.now();

  const currentPortState = getPortState();
  if (!currentPortState) {
    return { success: false, error: "No active port" };
  }

  const { coordinatorSessionFile, portedWorkerMid } = currentPortState;

  let switchError: string | undefined;

  // ── Switch back to coordinator session ───────────────────────────────
  try {
    await opts.cmdCtx.sessionManager.switchSession(coordinatorSessionFile);
  } catch (err) {
    // Log but continue — best-effort recovery
    switchError = err instanceof Error ? err.message : String(err);
  }

  // ── Clear port state ─────────────────────────────────────────────────
  clearPortState();
  persistState(opts.basePath);

  // ── Resume worker ────────────────────────────────────────────────────
  sendSignal(opts.basePath, portedWorkerMid, "resume");

  // ── Resume auto-mode ─────────────────────────────────────────────────
  opts.resumeAutoMode();

  if (switchError) {
    return {
      success: false,
      error: `switchSession failed during detach: ${switchError}`,
      elapsedMs: Date.now() - startedAt,
    };
  }

  return { success: true, elapsedMs: Date.now() - startedAt };
}

// ─── Convenience re-exports ────────────────────────────────────────────────

export { isPortActive, getPortedWorkerId };
