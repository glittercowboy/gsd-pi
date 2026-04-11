/**
 * In-flight tool call tracking for auto-mode idle detection.
 * Tracks which tool calls are currently executing so the idle watchdog
 * can distinguish "waiting for tool completion" from "truly idle".
 */

interface InFlightTool {
  startedAt: number;
  toolName: string;
}

const inFlightTools = new Map<string, InFlightTool>();

/**
 * Tools that block waiting for human input by design.
 * The idle watchdog must not treat these as stalled.
 */
const INTERACTIVE_TOOLS = new Set(["ask_user_questions", "secure_env_collect"]);

/**
 * Mark a tool execution as in-flight.
 * Records start time and tool name so the idle watchdog can detect tools
 * hung longer than the idle timeout while exempting interactive tools.
 */
export function markToolStart(toolCallId: string, isActive: boolean, toolName?: string): void {
  if (!isActive) return;
  inFlightTools.set(toolCallId, { startedAt: Date.now(), toolName: toolName ?? "unknown" });
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
    if (t.startedAt < oldestStart) oldestStart = t.startedAt;
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
    if (t.startedAt < oldest) oldest = t.startedAt;
  }
  return oldest;
}

/**
 * Returns true if any currently in-flight tool is a user-interactive tool
 * (e.g. ask_user_questions, secure_env_collect) that blocks waiting for
 * human input. These must be exempt from idle stall detection.
 */
export function hasInteractiveToolInFlight(): boolean {
  for (const { toolName } of inFlightTools.values()) {
    if (INTERACTIVE_TOOLS.has(toolName)) return true;
  }
  return false;
}

/**
 * Clear all in-flight tool tracking state.
 */
export function clearInFlightTools(): void {
  inFlightTools.clear();
}

// ─── Tool invocation error classification (#2883) ────────────────────────

/**
 * Patterns that indicate a tool invocation failed due to malformed or truncated
 * JSON arguments — as opposed to a normal business-logic error from the tool
 * handler. When these errors occur, retrying the same unit will produce the same
 * failure, so the retry loop must be broken.
 */
const TOOL_INVOCATION_ERROR_RE = /Validation failed for tool|Expected ',' or '\}' in JSON|Unexpected end of JSON|Unexpected token.*in JSON/i;

/**
 * Returns true if the error message indicates a tool invocation failure due to
 * malformed/truncated arguments (as opposed to a normal tool execution error).
 */
export function isToolInvocationError(errorMsg: string): boolean {
  if (!errorMsg) return false;
  return TOOL_INVOCATION_ERROR_RE.test(errorMsg);
}

/**
 * Returns true if the error message indicates the tool was skipped because
 * a queued user message interrupted the turn (#3595).  Retrying will produce
 * the same skip, so the unit should be paused rather than retried.
 */
export function isQueuedUserMessageSkip(errorMsg: string): boolean {
  if (!errorMsg) return false;
  return /^Skipped due to queued user message\.?$/i.test(errorMsg.trim());
}
