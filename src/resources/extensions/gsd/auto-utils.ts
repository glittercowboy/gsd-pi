// Shared utilities for the auto-loop modules (auto-post-unit, auto, etc.).

import { debugLog } from "./debug-logger.js";

/**
 * Run a non-fatal operation, logging any error via `debugLog` and continuing.
 *
 * Replaces the repeated try-catch-debugLog-continue boilerplate that wraps
 * operations whose failure should not abort the post-unit pipeline.
 *
 * @param context - The debugLog event name (e.g. "postUnit")
 * @param phase   - The phase label attached to the debug entry
 * @param fn      - The operation to execute (may be sync or async)
 */
export async function runSafely(
  context: string,
  phase: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    debugLog(context, { phase, error: String(e) });
  }
}
