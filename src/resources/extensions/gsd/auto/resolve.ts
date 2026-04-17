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

export function isSessionSwitchInFlight(): boolean {
  return _sessionSwitchInFlight;
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

/**
 * No-op for backward compatibility with tests that previously set the
 * active session. The module no longer holds a session reference.
 */
export function _setActiveSession(_session: AutoSession | null): void {
  // No-op — kept for test backward compatibility
}
