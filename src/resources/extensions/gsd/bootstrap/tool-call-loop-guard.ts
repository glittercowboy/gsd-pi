/**
 * Tool-call loop guard.
 *
 * Detects when a model calls the same tool with identical arguments
 * repeatedly within a single agent turn. Works in both auto-mode and
 * interactive sessions by hooking into the `tool_call` event, which
 * fires before execution and can block the call.
 *
 * The guard uses a sliding window: it tracks the last N tool signatures
 * and blocks when the same signature appears more than MAX_CONSECUTIVE
 * times in a row. Resets on each agent turn (session_start, agent_end)
 * and when a different tool call breaks the streak.
 */

import { createHash } from "node:crypto";

const MAX_CONSECUTIVE_IDENTICAL_CALLS = 4;

/** Interactive/user-facing tools where even 1 duplicate is confusing. */
const STRICT_LOOP_TOOLS = new Set(["ask_user_questions"]);
const MAX_CONSECUTIVE_STRICT = 1;

let consecutiveCount = 0;
let lastSignature = "";
let lastToolName = "";
let enabled = true;

/** Hash tool name + args into a compact signature for comparison. */
function hashToolCall(toolName: string, args: Record<string, unknown>): string {
  const h = createHash("sha256");
  h.update(toolName);
  // Sort keys recursively for deterministic hashing regardless of object key order
  h.update(JSON.stringify(args, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort().reduce<Record<string, unknown>>((o, k) => {
          o[k] = value[k];
          return o;
        }, {})
      : value
  ));
  return h.digest("hex").slice(0, 16);
}

/**
 * Record a tool call and check if it should be blocked.
 *
 * Returns `{ block: false }` for allowed calls.
 * Returns `{ block: true, reason }` when the loop threshold is exceeded.
 */
export function checkToolCallLoop(
  toolName: string,
  args: Record<string, unknown>,
): { block: boolean; reason?: string; count?: number } {
  if (!enabled) return { block: false, count: 0 };

  const sig = hashToolCall(toolName, args);

  if (sig === lastSignature) {
    consecutiveCount++;
  } else {
    consecutiveCount = 1;
    lastSignature = sig;
    lastToolName = toolName;
  }

  const threshold = STRICT_LOOP_TOOLS.has(toolName)
    ? MAX_CONSECUTIVE_STRICT
    : MAX_CONSECUTIVE_IDENTICAL_CALLS;

  if (consecutiveCount > threshold) {
    return {
      block: true,
      reason:
        `Tool loop detected: ${toolName} called ${consecutiveCount} times ` +
        `with identical arguments. Blocking to prevent infinite loop. ` +
        `Try a different approach or modify your arguments.`,
      count: consecutiveCount,
    };
  }

  return { block: false, count: consecutiveCount };
}

/** Reset the guard state. Call at agent turn boundaries. */
export function resetToolCallLoopGuard(): void {
  consecutiveCount = 0;
  lastSignature = "";
  lastToolName = "";
  enabled = true;
}

/** Disable the guard (e.g. during shutdown). */
export function disableToolCallLoopGuard(): void {
  enabled = false;
  consecutiveCount = 0;
  lastSignature = "";
  lastToolName = "";
}

/** Get current consecutive count for diagnostics. */
export function getToolCallLoopCount(): number {
  return consecutiveCount;
}
