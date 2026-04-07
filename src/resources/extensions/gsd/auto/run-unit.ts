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
import { logWarning } from "../workflow-logger.js";

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
  label?: string,
): Promise<UnitResult> {
  debugLog("runUnit", { phase: "start", unitType, unitId });

  // ── Session creation with timeout ──
  debugLog("runUnit", { phase: "session-create", unitType, unitId });

  let sessionResult: { cancelled: boolean };
  let sessionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  _setSessionSwitchInFlight(true);
  try {
    const sessionName = buildSessionName(unitType, unitId, s.currentMilestoneId, label);
    const sessionPromise = s.cmdCtx!.newSession({
      setup: async (sm) => { sm.appendSessionInfo(sessionName); },
    }).finally(() => {
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
      ctx.ui.notify(
        `Failed to restore ${s.currentUnitModel.provider}/${s.currentUnitModel.id} after session creation. Using session default.`,
        "warning",
      );
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
  } catch (e) {
    logWarning("engine", "clearQueue failed after unit completion", { error: String(e) });
  }

  return result;
}

/**
 * Build a human-readable session name from the executing unit context.
 * Examples:
 *   "execute-task T03 · S02 · M001"
 *   "plan-slice S02 · M001"
 *   "validate-milestone M001"
 *   "hook/post-unit"
 */
function buildSessionName(
  unitType: string,
  unitId: string,
  milestoneId: string | null,
  label?: string,
): string {
  const parts: string[] = [unitType];
  if (unitId) parts.push(unitId);
  if (milestoneId) parts.push(milestoneId);
  if (label) parts.push(label);
  return parts.join(" · ");
}
