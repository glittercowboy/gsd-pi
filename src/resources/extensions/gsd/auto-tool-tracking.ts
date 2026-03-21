/**
 * In-flight tool call tracking for auto-mode idle detection.
 * Tracks which tool calls are currently executing so the idle watchdog
 * can distinguish "waiting for tool completion" from "truly idle".
 */

const inFlightTools = new Map<string, number>();

/**
 * Mark a tool execution as in-flight.
 * Records start time so the idle watchdog can detect tools hung longer than the idle timeout.
 */
export function markToolStart(toolCallId: string, isActive: boolean): void {
  if (!isActive) return;
  inFlightTools.set(toolCallId, Date.now());
}

/**
 * Mark a tool execution as completed.
 */
export function markToolEnd(toolCallId: string): void {
  inFlightTools.delete(toolCallId);
}

/**
 * Returns the age (ms) of the oldest currently in-flight tool, or 0 if none.
 */
export function getOldestInFlightToolAgeMs(): number {
  if (inFlightTools.size === 0) return 0;
  let oldestStart = Infinity;
  for (const t of inFlightTools.values()) {
    if (t < oldestStart) oldestStart = t;
  }
  return Date.now() - oldestStart;
}

/**
 * Returns the number of currently in-flight tools.
 */
export function getInFlightToolCount(): number {
  return inFlightTools.size;
}

/**
 * Returns the start timestamp of the oldest in-flight tool, or undefined if none.
 */
export function getOldestInFlightToolStart(): number | undefined {
  if (inFlightTools.size === 0) return undefined;
  let oldest = Infinity;
  for (const t of inFlightTools.values()) {
    if (t < oldest) oldest = t;
  }
  return oldest;
}

/**
 * Clear all in-flight tool tracking state.
 */
export function clearInFlightTools(): void {
  inFlightTools.clear();
}
