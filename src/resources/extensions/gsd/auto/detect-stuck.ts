/**
 * auto/detect-stuck.ts — Sliding-window stuck detection for the auto-loop.
 *
 * Leaf node in the import DAG.
 */

import type { WindowEntry } from "./types.js";

/**
 * Pattern matching ENOENT errors with a file path.
 * Matches: "ENOENT: no such file or directory, access '/path/to/file'"
 * and similar Node.js filesystem error messages.
 */
const ENOENT_PATH_RE = /ENOENT[^']*'([^']+)'/;

/**
 * Analyze a sliding window of recent unit dispatches for stuck patterns.
 * Returns a signal with reason if stuck, null otherwise.
 *
 * Rule 1: Same error string twice in a row → stuck immediately.
 * Rule 2: Same unit key 3+ consecutive times → stuck (preserves prior behavior).
 * Rule 3: Oscillation A→B→A→B in last 4 entries → stuck.
 * Rule 4: Same ENOENT path in any 2 entries within the window → stuck (#3575).
 *         Missing files don't self-heal between retries — retrying wastes budget.
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

  // Rule 3: Oscillation (A→B→A→B in last 4)
  if (window.length >= 4) {
    const w = window.slice(-4);
    if (
      w[0].key === w[2].key &&
      w[1].key === w[3].key &&
      w[0].key !== w[1].key
    ) {
      return {
        stuck: true,
        reason: `Oscillation detected: ${w[0].key} ↔ ${w[1].key}`,
      };
    }
  }

  // Rule 4: Same ENOENT path seen twice in window (#3575)
  // Missing files don't appear between retries — stop immediately.
  const enoentPaths = new Map<string, number>();
  for (const entry of window) {
    if (!entry.error) continue;
    const match = ENOENT_PATH_RE.exec(entry.error);
    if (!match) continue;
    const filePath = match[1];
    const count = (enoentPaths.get(filePath) ?? 0) + 1;
    if (count >= 2) {
      return {
        stuck: true,
        reason: `Missing file referenced twice: ${filePath} (ENOENT)`,
      };
    }
    enoentPaths.set(filePath, count);
  }

  return null;
}
