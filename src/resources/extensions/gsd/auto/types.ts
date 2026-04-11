/**
 * auto/types.ts — Constants and types shared across auto-loop modules.
 *
 * Leaf node in the import DAG — no imports from auto/.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession } from "./session.js";
import type { GSDPreferences } from "../preferences.js";
import type { GSDState } from "../types.js";
import type { CmuxLogLevel } from "../../cmux/index.js";
import type { LoopDeps } from "./loop-deps.js";

/**
 * Maximum total loop iterations before forced stop. Prevents runaway loops
 * when units alternate IDs (bypassing the same-unit stuck detector).
 * A milestone with 20 slices × 5 tasks × 3 phases ≈ 300 units. 500 gives
 * generous headroom including retries and sidecar work.
 */
export const MAX_LOOP_ITERATIONS = 500;
/** Maximum characters of failure/crash context included in recovery prompts. */
export const MAX_RECOVERY_CHARS = 50_000;

/** Data-driven budget threshold notifications (descending). The 100% entry
 *  triggers special enforcement logic (halt/pause/warn); sub-100 entries fire
 *  a simple notification. */
export const BUDGET_THRESHOLDS: Array<{
  pct: number;
  label: string;
  notifyLevel: "info" | "warning" | "error";
  cmuxLevel: "progress" | "warning" | "error";
}> = [
  { pct: 100, label: "Budget ceiling reached", notifyLevel: "error", cmuxLevel: "error" },
  { pct: 90, label: "Budget 90%", notifyLevel: "warning", cmuxLevel: "warning" },
  { pct: 80, label: "Approaching budget ceiling — 80%", notifyLevel: "warning", cmuxLevel: "warning" },
  { pct: 75, label: "Budget 75%", notifyLevel: "info", cmuxLevel: "progress" },
];

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal shape of the event parameter from pi.on("agent_end", ...).
 * The full event has more fields, but the loop only needs messages.
 */
export interface AgentEndEvent {
  messages: unknown[];
}

/**
 * Structured error context attached to a UnitResult when the unit ends
 * due to an infrastructure or timeout error (not user-driven cancellation).
 */
export interface ErrorContext {
  message: string;
  category: "provider" | "timeout" | "idle" | "network" | "aborted" | "session-failed" | "unknown";
  stopReason?: string;
  isTransient?: boolean;
  retryAfterMs?: number;
}

/**
 * Result of a single unit execution (one iteration of the loop).
 */
export interface UnitResult {
  status: "completed" | "cancelled" | "error";
  event?: AgentEndEvent;
  errorContext?: ErrorContext;
}

// ─── Phase pipeline types ────────────────────────────────────────────────────

export type PhaseResult<T = void> =
  | { action: "continue" }
  | { action: "break"; reason: string }
  | { action: "next"; data: T }

export interface IterationContext {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  s: AutoSession;
  deps: LoopDeps;
  prefs: GSDPreferences | undefined;
  iteration: number;
  /** UUID grouping all journal events for this iteration. */
  flowId: string;
  /** Returns the next monotonically increasing sequence number (1-based, reset per iteration). */
  nextSeq: () => number;
}

export interface LoopState {
  recentUnits: Array<{ key: string; error?: string }>;
  stuckRecoveryAttempts: number;
  /** Consecutive finalize timeout count — stops auto-mode after threshold. */
  consecutiveFinalizeTimeouts: number;
}

/** Max consecutive finalize timeouts before hard-stopping auto-mode. */
export const MAX_FINALIZE_TIMEOUTS = 3;

export interface PreDispatchData {
  state: GSDState;
  mid: string;
  midTitle: string;
}

export interface IterationData {
  unitType: string;
  unitId: string;
  prompt: string;
  finalPrompt: string;
  pauseAfterUatDispatch: boolean;
  state: GSDState;
  mid: string | undefined;
  midTitle: string | undefined;
  isRetry: boolean;
  previousTier: string | undefined;
  /** Model override from pre-dispatch hooks (applied after standard model selection). */
  hookModelOverride?: string;
}

export type WindowEntry = { key: string; error?: string };
