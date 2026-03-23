/**
 * auto/detect-stuck.ts — Sliding-window stuck detection for the auto-loop.
 *
 * Leaf node in the import DAG.
 */

import type { WindowEntry } from "./types.js";

/**
 * Analyze a sliding window of recent unit dispatches for stuck patterns.
 * Returns a signal with reason if stuck, null otherwise.
 *
 * Rule 1: Same error string twice in a row → stuck immediately.
 * Rule 2: Same unit key 3+ consecutive times → stuck (preserves prior behavior).
 */
export function detectStuck(
  window: readonly WindowEntry[],
): { stuck: true; reason: string } | null {
  if (window.length < 2) return null;

  const last = window[window.length - 1];
  const prev = window[window.length - 2];

  // Rule 1: Same error repeated consecutively
  if (last.error && prev.error && last.error === prev.error) {
    return {
      stuck: true,
      reason: `Same error repeated: ${last.error.slice(0, 200)}`,
    };
  }

  // Rule 2: Same unit 3+ consecutive times
  if (window.length >= 3) {
    const lastThree = window.slice(-3);
    if (lastThree.every((u) => u.key === last.key)) {
      return {
        stuck: true,
        reason: `${last.key} derived 3 consecutive times without progress`,
      };
    }
  }

  return null;
}
