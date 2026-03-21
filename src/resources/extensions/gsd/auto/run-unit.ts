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
  _setSessionSwitchInFlight(true);
  try {
    const sessionPromise = s.cmdCtx!.newSession().finally(() => {
      _setSessionSwitchInFlight(false);
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
    return { status: "cancelled" };
  }
  if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);

  if (sessionResult.cancelled) {
    debugLog("runUnit-session-timeout", { unitType, unitId });
    return { status: "cancelled" };
  }

  if (!s.active) {
    return { status: "cancelled" };
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
  } catch { /* non-fatal — chdir may fail if dir was removed */ }

  // ── Send the prompt ──
  debugLog("runUnit", { phase: "send-message", unitType, unitId });

  pi.sendMessage(
    { customType: "gsd-auto", content: prompt, display: s.verbose },
    { triggerTurn: true },
  );

  // ── Await agent_end ──
  debugLog("runUnit", { phase: "awaiting-agent-end", unitType, unitId });
  const result = await unitPromise;
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
  } catch {
    // Non-fatal — clearQueue may not be available in all contexts
  }

  return result;
}
