/**
 * auto/resolve.ts — Per-unit one-shot promise state and resolution.
 *
 * Module-level mutable state: `_currentResolve` and `_sessionSwitchInFlight`.
 * Setter functions are exported because ES modules can't mutate `let` vars
 * across module boundaries.
 *
 * Imports from: auto/types
 */

import type { UnitResult, AgentEndEvent, ErrorContext } from "./types.js";
import type { AutoSession } from "./session.js";
import { debugLog } from "../debug-logger.js";
import { bumpTurnGeneration } from "./turn-epoch.js";

// ─── Per-unit one-shot promise state ────────────────────────────────────────
//
// A single module-level resolve function scoped to the current unit execution.
// No queue — if an agent_end arrives with no pending resolver, it is dropped
// (logged as warning). This is simpler and safer than the previous session-
// scoped pendingResolve + pendingAgentEndQueue pattern.

let _currentResolve: ((result: UnitResult) => void) | null = null;
let _sessionSwitchInFlight = false;

// ─── Setters (needed for cross-module mutation) ─────────────────────────────

export function _setCurrentResolve(fn: ((result: UnitResult) => void) | null): void {
  _currentResolve = fn;
}

export function _setSessionSwitchInFlight(v: boolean): void {
  _sessionSwitchInFlight = v;
}

export function _clearCurrentResolve(): void {
  _currentResolve = null;
}

// ─── resolveAgentEnd ─────────────────────────────────────────────────────────

/**
 * Called from the agent_end event handler in index.ts to resolve the
 * in-flight unit promise. One-shot: the resolver is nulled before calling
 * to prevent double-resolution from model fallback retries.
 *
 * If no resolver exists (event arrived between loop iterations or during
 * session switch), the event is dropped with a debug warning.
 */
export function resolveAgentEnd(event: AgentEndEvent): void {
  if (_sessionSwitchInFlight) {
    debugLog("resolveAgentEnd", { status: "ignored-during-switch" });
    return;
  }
  if (_currentResolve) {
    debugLog("resolveAgentEnd", { status: "resolving", hasEvent: true });
    const r = _currentResolve;
    _currentResolve = null;
    r({ status: "completed", event });
  } else {
    debugLog("resolveAgentEnd", {
      status: "no-pending-resolve",
      warning: "agent_end with no pending unit",
    });
  }
}

/**
 * Cancel the current unit's pending agent_end wait without treating the turn
 * like a successful completion.
 *
 * Contract:
 * - Safe to call only from explicit pause paths while an auto unit may be
 *   awaiting agent_end, currently abort handling and provider-error pause.
 * - Resolves at most the one in-flight unit promise; it does not mutate
 *   AutoSession state, release locks, close unit records, or persist pause
 *   metadata. Callers must still run pauseAuto() or an equivalent owner.
 * - Safe when no unit is pending: logs a debug no-op and returns.
 * - Ignored during session switches so a late provider/abort signal cannot
 *   cancel the next unit's promise.
 */
export function cancelPendingUnit(reason: "aborted" | "provider-error"): void {
  if (_sessionSwitchInFlight) {
    debugLog("cancelPendingUnit", { status: "ignored-during-switch", reason });
    return;
  }
  if (_currentResolve) {
    debugLog("cancelPendingUnit", { status: "resolving-cancelled", reason });
    const r = _currentResolve;
    _currentResolve = null;
    r({
      status: "cancelled",
      errorContext: {
        message: reason === "aborted" ? "Agent aborted during unit execution" : "Provider error paused auto-mode",
        category: reason === "aborted" ? "aborted" : "provider",
      },
    });
  } else {
    debugLog("cancelPendingUnit", {
      status: "no-pending-resolve",
      reason,
    });
  }
}

export function isSessionSwitchInFlight(): boolean {
  return _sessionSwitchInFlight;
}

// ─── bumpAndResolveSynthetic ────────────────────────────────────────────────

/**
 * Bump the turn epoch and synthetically resolve the pending unit promise —
 * the exact sequence timeout recovery must perform when it advances past a
 * timed-out unit. Using this helper enforces the invariant "bump iff we are
 * actually superseding the turn" so a future caller cannot resolve without
 * bumping (orphaned writes leak) or bump without resolving (next turn starts
 * already stale).
 *
 * NOT to be used for steering retries that keep the same turn alive — those
 * do not supersede the turn and must not bump.
 */
export function bumpAndResolveSynthetic(reason: string): void {
  bumpTurnGeneration(reason);
  resolveAgentEnd({ messages: [], _synthetic: reason } as unknown as AgentEndEvent);
}

// ─── resolveAgentEndCancelled ─────────────────────────────────────────────────

/**
 * Force-resolve the pending unit promise with { status: "cancelled" }.
 *
 * Used by pauseAuto and supervision catch
 * blocks to ensure the autoLoop is never stuck awaiting a promise that
 * will never resolve. Safe to call when no resolver is pending (no-op).
 */
export function resolveAgentEndCancelled(errorContext?: ErrorContext): void {
  if (_currentResolve) {
    // Cancellation supersedes the in-flight turn the same way timeout
    // recovery does — bump the turn epoch so any lingering writes from the
    // cancelled turn drop themselves.
    bumpTurnGeneration(
      `cancelled:${errorContext?.category ?? "unknown"}`,
    );
    debugLog("resolveAgentEndCancelled", { status: "resolving-cancelled" });
    const r = _currentResolve;
    _currentResolve = null;
    r({ status: "cancelled", ...(errorContext ? { errorContext } : {}) });
  }
}

// ─── resetPendingResolve (test helper) ───────────────────────────────────────

/**
 * Reset module-level promise state. Only exported for test cleanup —
 * production code should never call this.
 */
export function _resetPendingResolve(): void {
  _currentResolve = null;
  _sessionSwitchInFlight = false;
}

export function _hasPendingResolveForTest(): boolean {
  return _currentResolve !== null;
}

/**
 * No-op for backward compatibility with tests that previously set the
 * active session. The module no longer holds a session reference.
 */
export function _setActiveSession(_session: AutoSession | null): void {
  // No-op — kept for test backward compatibility
}
