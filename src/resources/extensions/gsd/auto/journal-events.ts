/**
 * auto/journal-events.ts — Typed builder functions for journal events.
 *
 * Centralises the journal event schema so call sites are readable
 * single-line or short multi-line calls instead of 200-char object literals.
 *
 * Each builder stamps `ts: new Date().toISOString()` at call time and returns
 * a complete JournalEntry ready to pass to `deps.emitJournalEvent`.
 */

import type { JournalEntry } from "../journal.js";
import type { ErrorContext } from "./types.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

/** Resource descriptor stamped on every iteration-start event. */
export interface JournalResource {
  gsdVersion: string;
  model: string;
  cwd: string;
}

export function isJournalResource(value: unknown): value is JournalResource {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).gsdVersion === "string" &&
    typeof (value as Record<string, unknown>).model === "string" &&
    typeof (value as Record<string, unknown>).cwd === "string"
  );
}

// ─── Error type ───────────────────────────────────────────────────────────────

/** Classification of why a unit ended in a non-completed state. */
export type JournalErrorType =
  | "tool-error"
  | "timeout"
  | "context-overflow"
  | "provider-error"
  | "network-error"
  | "aborted"
  | "session-failed"
  | "unknown";

// ─── Error classification ─────────────────────────────────────────────────────

const MAX_ERROR_DETAIL_LENGTH = 200;

/**
 * Maps ErrorContext.category to JournalErrorType exhaustively.
 * The switch is intentionally exhaustive: if a new category is added to
 * ErrorContext, TypeScript will error here, forcing an explicit mapping decision.
 */
export function errorContextCategoryToJournalType(category: ErrorContext["category"]): JournalErrorType {
  switch (category) {
    case "timeout":
    case "idle":
      return "timeout";
    case "provider":
      return "provider-error";
    case "network":
      return "network-error";
    case "aborted":
      return "aborted";
    case "session-failed":
      return "session-failed";
    case "unknown":
      return "unknown";
    default: {
      // TypeScript errors here if a new category is added to ErrorContext without
      // updating this switch. At runtime we fall back gracefully — journal annotation
      // is best-effort and must never crash the auto-loop.
      const _: never = category;
      return "unknown";
    }
  }
}

const ERROR_PATTERNS: Array<[RegExp, JournalErrorType]> = [
  [/context.*overflow|token.*limit|context.*window/i, "context-overflow"],
  [/tool.*(?:error|fail)|permission denied|command failed/i, "tool-error"],
  [/timeout|timed? out/i, "timeout"],
];

// Returns the last error found — in a failing unit the most recent error is the most diagnostic
// (earlier errors may have been recovered from).
export function classifyMessageError(messages: unknown[]): { detail: string; type: JournalErrorType } | undefined {
  const RE_INDICATOR = /error|fail|exception/i;
  let result: { detail: string; type: JournalErrorType } | undefined;
  for (const msg of messages) {
    const str = typeof msg === "string" ? msg : JSON.stringify(msg);
    if (!RE_INDICATOR.test(str)) continue;
    const type = ERROR_PATTERNS.find(([re]) => re.test(str))?.[1] ?? "unknown";
    result = { detail: str.slice(0, MAX_ERROR_DETAIL_LENGTH), type };
  }
  return result;
}

// ─── Builder functions ────────────────────────────────────────────────────────

export interface IterationStartParams {
  flowId: string;
  seq: number;
  iteration: number;
  resource: JournalResource;
  causedBy?: { flowId: string; seq: number };
}

export function buildIterationStartEvent(p: IterationStartParams): JournalEntry {
  return {
    ts: new Date().toISOString(),
    flowId: p.flowId,
    seq: p.seq,
    eventType: "iteration-start",
    data: { iteration: p.iteration, resource: p.resource },
    ...(p.causedBy && { causedBy: p.causedBy }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export interface UnitStartParams {
  flowId: string;
  seq: number;
  unitType: string;
  unitId: string;
  sessionId: string;
  messageOffset: number;
}

export function buildUnitStartEvent(p: UnitStartParams): JournalEntry {
  return {
    ts: new Date().toISOString(),
    flowId: p.flowId,
    seq: p.seq,
    eventType: "unit-start",
    data: {
      unitType: p.unitType,
      unitId: p.unitId,
      sessionId: p.sessionId,
      messageOffset: p.messageOffset,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export interface UnitEndParams {
  flowId: string;
  seq: number;
  unitType: string;
  unitId: string;
  status: string;
  artifactVerified: boolean;
  durationMs: number;
  error?: string;
  errorType?: JournalErrorType;
  errorContext?: ErrorContext;
  causedBy: { flowId: string; seq: number };
}

export function buildUnitEndEvent(p: UnitEndParams): JournalEntry {
  return {
    ts: new Date().toISOString(),
    flowId: p.flowId,
    seq: p.seq,
    eventType: "unit-end",
    causedBy: p.causedBy,
    data: {
      unitType: p.unitType,
      unitId: p.unitId,
      status: p.status,
      artifactVerified: p.artifactVerified,
      durationMs: p.durationMs,
      ...(p.error && { error: p.error, errorType: p.errorType }),
      ...(p.errorContext && { errorContext: p.errorContext }),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export interface StuckDetectedParams {
  flowId: string;
  seq: number;
  unitType: string;
  unitId: string;
  reason: string;
  level: 1 | 2;
}

export function buildStuckDetectedEvent(p: StuckDetectedParams): JournalEntry {
  return {
    ts: new Date().toISOString(),
    flowId: p.flowId,
    seq: p.seq,
    eventType: "stuck-detected",
    data: {
      unitType: p.unitType,
      unitId: p.unitId,
      reason: p.reason,
      level: p.level,
    },
  };
}
