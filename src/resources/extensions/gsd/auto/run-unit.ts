/**
 * auto/run-unit.ts — Single unit execution: session create → prompt → await agent_end.
 *
 * Imports from: auto/types, auto/resolve
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession } from "./session.js";
import { NEW_SESSION_TIMEOUT_MS } from "./session.js";
import type { UnitResult } from "./types.js";
import { _setCurrentResolve, _setSessionSwitchInFlight } from "./resolve.js";
import { debugLog } from "../debug-logger.js";
import { logWarning, logError } from "../workflow-logger.js";
import { resolveAutoSupervisorConfig } from "../preferences.js";

// Tracks the latest session-switch attempt so a late timeout settlement from an
// older runUnit() call cannot clear the guard for a newer one.
let sessionSwitchGeneration = 0;

/**
 * Execute a single unit: create a new session, send the prompt, and await
 * the agent_end promise. Returns a UnitResult describing what happened.
 *
 * The promise is one-shot: resolveAgentEnd() is the only way to resolve it.
 * On session creation failure or timeout, returns { status: 'cancelled' }
 * without awaiting the promise.
 */
export async function runUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  unitType: string,
  unitId: string,
  prompt: string,
): Promise<UnitResult> {
  debugLog("runUnit", { phase: "start", unitType, unitId });

  // ── Session creation with timeout ──
  debugLog("runUnit", { phase: "session-create", unitType, unitId });

  let sessionResult: { cancelled: boolean };
  let sessionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const mySessionSwitchGeneration = ++sessionSwitchGeneration;
  _setSessionSwitchInFlight(true);
  try {
    const sessionPromise = s.cmdCtx!.newSession().finally(() => {
      if (sessionSwitchGeneration === mySessionSwitchGeneration) {
        _setSessionSwitchInFlight(false);
      }
    });
    const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
      sessionTimeoutHandle = setTimeout(
        () => resolve({ cancelled: true }),
        NEW_SESSION_TIMEOUT_MS,
      );
    });
    sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
  } catch (sessionErr) {
    if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);
    const msg =
      sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
    debugLog("runUnit", {
      phase: "session-error",
      unitType,
      unitId,
      error: msg,
    });
    return { status: "cancelled", errorContext: { message: `Session creation failed: ${msg}`, category: "session-failed", isTransient: true } };
  }
  if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);

  if (sessionResult.cancelled) {
    debugLog("runUnit-session-timeout", { unitType, unitId });
    return { status: "cancelled", errorContext: { message: "Session creation timed out", category: "timeout", isTransient: true } };
  }

  if (!s.active) {
    return { status: "cancelled" };
  }

  if (s.currentUnitModel && typeof pi.setModel === "function") {
    const restored = await pi.setModel(s.currentUnitModel, { persist: false });
    if (!restored) {
      const message =
        `Failed to restore configured model ${s.currentUnitModel.provider}/${s.currentUnitModel.id} after session creation`;
      ctx.ui.notify(
        `${message}. Cancelling unit before dispatch.`,
        "warning",
      );
      return {
        status: "cancelled",
        errorContext: {
          message,
          category: "session-failed",
          isTransient: false,
        },
      };
    }
  }

  // ── Create the agent_end promise (per-unit one-shot) ──
  // This happens after newSession completes so session-switch agent_end events
  // from the previous session cannot resolve the new unit.
  _setSessionSwitchInFlight(false);
  const unitPromise = new Promise<UnitResult>((resolve) => {
    _setCurrentResolve(resolve);
  });

  // Ensure cwd matches basePath before dispatch (#1389).
  // async_bash and background jobs can drift cwd away from the worktree.
  // Realigning here prevents commits from landing on the wrong branch.
  try {
    if (process.cwd() !== s.basePath) {
      process.chdir(s.basePath);
    }
  } catch (e) {
    logWarning("engine", "Failed to chdir to basePath before dispatch", { basePath: s.basePath, error: String(e) });
  }

  // ── Send the prompt ──
  debugLog("runUnit", { phase: "send-message", unitType, unitId });

  pi.sendMessage(
    { customType: "gsd-auto", content: prompt, display: s.verbose },
    { triggerTurn: true },
  );

  // ── Await agent_end with absolute timeout (H4 fix) ──
  // If supervision fails to resolve unitPromise within 30s, treat as cancelled.
  // Without this, a crashed agent that never emits agent_end hangs the loop (#3161).
  debugLog("runUnit", { phase: "awaiting-agent-end", unitType, unitId });
  const supervisor = resolveAutoSupervisorConfig();
  const UNIT_HARD_TIMEOUT_MS = Math.max(
    30_000,
    ((supervisor.hard_timeout_minutes ?? 30) * 60 * 1000) + 30_000,
  );
  let unitTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<UnitResult>((resolve) => {
    unitTimeoutHandle = setTimeout(() => {
      resolve({ status: "cancelled", errorContext: { message: "Unit hard timeout — supervision may have failed", category: "timeout", isTransient: true } });
    }, UNIT_HARD_TIMEOUT_MS);
  });
  const result = await Promise.race([unitPromise, timeoutResult]);
  if (unitTimeoutHandle) clearTimeout(unitTimeoutHandle);
  debugLog("runUnit", {
    phase: "agent-end-received",
    unitType,
    unitId,
    status: result.status,
  });

  // Discard trailing follow-up messages (e.g. async_job_result notifications)
  // from the completed unit. Without this, queued follow-ups trigger wasteful
  // LLM turns before the next session can start (#1642).
  // clearQueue() lives on AgentSession but isn't part of the typed
  // ExtensionCommandContext interface — call it via runtime check.
  try {
    const cmdCtxAny = s.cmdCtx as Record<string, unknown> | null;
    if (typeof cmdCtxAny?.clearQueue === "function") {
      (cmdCtxAny.clearQueue as () => unknown)();
    }
  } catch (e) {
    logWarning("engine", "clearQueue failed after unit completion", { error: String(e) });
  }

  return result;
}
