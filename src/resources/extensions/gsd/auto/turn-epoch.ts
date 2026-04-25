/**
 * auto/turn-epoch.ts — Turn generation counter + AsyncLocalStorage-backed
 * capture for stale-turn write dropping.
 *
 * Problem: when auto-timeout-recovery synthetically resolves a timed-out
 * unit so the loop can advance, the original LLM turn keeps running in the
 * background. Its subsequent writes (journal events, audit events, tool
 * calls that flow through closeout) then race the replacement unit's
 * writes. DB-level guards (complete-task/complete-slice) block double
 * state transitions, but journal/audit/closeout side-effects still fire
 * with fresh identifiers and pollute forensics.
 *
 * Containment: every time we decide a turn is done (timeout recovery,
 * explicit cancellation), bump a module-level generation counter.
 * Turn-aware call sites wrap their body in `runWithTurnGeneration`, which
 * captures the generation into AsyncLocalStorage. Write sites deep in the
 * stack call `isStaleWrite` — if the captured generation is older than
 * current, the turn has been superseded and the write is dropped.
 *
 * Failure mode: if AsyncLocalStorage context is lost across some exotic
 * async boundary (e.g. a native-side worker callback), the write site sees
 * `no-store` and falls through to current behavior — the write proceeds
 * normally. That is a safe default; the correctness regression is only
 * "noisier forensics under rare boundary loss," not duplicated state.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { debugLog } from "../debug-logger.js";

let _currentGeneration = 0;

const turnContext = new AsyncLocalStorage<{ capturedGen: number }>();

/** Current turn generation. Mutated only by bumpTurnGeneration. */
export function getCurrentTurnGeneration(): number {
  return _currentGeneration;
}

/**
 * Bump the turn generation and return the new value. Every caller should
 * pass a short `reason` string so forensics can reconstruct why a given
 * turn was marked stale.
 */
export function bumpTurnGeneration(reason: string): number {
  _currentGeneration += 1;
  debugLog("turnEpoch.bump", { reason, newGeneration: _currentGeneration });
  return _currentGeneration;
}

/**
 * Run fn() with `capturedGen` attached to AsyncLocalStorage so that any
 * write site reached from within fn() can check for staleness without
 * parameter threading.
 */
export function runWithTurnGeneration<T>(capturedGen: number, fn: () => T): T {
  return turnContext.run({ capturedGen }, fn);
}

/**
 * True when the current async context was started at a turn generation
 * older than the current one — meaning the turn has been superseded by
 * recovery/cancellation since it began.
 *
 * Returns false when there is no captured generation (e.g. the write is
 * happening outside any wrapped turn). That is the safe default: writes
 * proceed as they did before this epoch was introduced.
 */
export function isStaleWrite(component?: string): boolean {
  const store = turnContext.getStore();
  if (!store) return false;
  const captured = store.capturedGen;
  const current = _currentGeneration;
  if (captured < current) {
    debugLog("turnEpoch.stale", {
      component: component ?? "unknown",
      captured,
      current,
    });
    return true;
  }
  return false;
}

/**
 * Snapshot of both the captured turn generation and the current one.
 * Used by closeoutUnit to persist an orphan-marker entry instead of
 * silently skipping the full closeout on a stale turn.
 */
export function describeTurnEpoch(): {
  captured: number | null;
  current: number;
  stale: boolean;
} {
  const store = turnContext.getStore();
  const captured = store?.capturedGen ?? null;
  const current = _currentGeneration;
  return {
    captured,
    current,
    stale: captured !== null && captured < current,
  };
}

/** Test helper — resets module state so tests start from a known baseline. */
export function _resetTurnEpoch(): void {
  _currentGeneration = 0;
}
