/**
 * GSD Event Journal — structured JSONL event log for auto-mode iterations.
 *
 * Writes daily-rotated JSONL files to `.gsd/journal/YYYY-MM-DD.jsonl`.
 * Zero imports from `auto/` — depends only on node:fs, node:path, and paths.ts.
 *
 * Observability:
 * - Each line in the JSONL file is a self-contained JournalEntry
 * - Events are grouped by flowId (one per iteration) with monotonic seq numbers
 * - causedBy references enable causal chain reconstruction
 * - queryJournal() enables programmatic filtering by flowId, eventType, unitId, time range
 * - Silent failure: journal writes never throw — absence of events is the failure signal
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { isStaleWrite } from "./auto/turn-epoch.js";
import { withFileLockSync } from "./file-lock.js";
import { gsdRoot } from "./paths.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./uok/audit.js";
import { isUnifiedAuditEnabled } from "./uok/audit-toggle.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Event types emitted by the auto-mode loop and phases. */
export type JournalEventType =
  | "iteration-start"
  | "dispatch-match"
  | "dispatch-stop"
  | "pre-dispatch-hook"
  | "unit-start"
  | "unit-end"
  | "post-unit-hook"
  | "terminal"
  | "guard-block"
  | "milestone-transition"
  | "stuck-detected"
  | "sidecar-dequeue"
  | "iteration-end"
  | "worktree-enter"
  | "worktree-create-failed"
  | "worktree-skip"
  | "worktree-merge-start"
  | "worktree-merge-failed"
  | "artifact-verification-retry"
  // #4764 — worktree lifespan / divergence telemetry
  | "worktree-created"
  | "worktree-merged"
  | "worktree-orphaned"
  | "auto-exit"
  | "worktree-sync"
  | "canonical-root-redirect"
  // #4765 — slice-cadence collapse
  | "slice-merged"
  | "milestone-resquash";

/** A single structured event in the journal. */
export interface JournalEntry {
  /** ISO-8601 timestamp */
  ts: string;
  /** UUID grouping all events from one iteration */
  flowId: string;
  /** Monotonically increasing sequence number within a flow */
  seq: number;
  /** The kind of event */
  eventType: JournalEventType;
  /** Name of the matched rule (from the unified registry), if applicable */
  rule?: string;
  /** Causal reference to a prior event in this or another flow */
  causedBy?: { flowId: string; seq: number };
  /** Arbitrary structured payload (e.g. unitId, status, action details) */
  data?: Record<string, unknown>;
}

/** Filters for querying journal entries. */
export interface JournalQueryFilters {
  flowId?: string;
  eventType?: string;
  unitId?: string;
  /** Filter by the rule name that produced the event */
  rule?: string;
  /** ISO-8601 lower bound (inclusive) */
  after?: string;
  /** ISO-8601 upper bound (inclusive) */
  before?: string;
}

// ─── Emit ─────────────────────────────────────────────────────────────────────

/**
 * Append a journal event to the daily JSONL file.
 *
 * File path: `<gsdRoot>/journal/<YYYY-MM-DD>.jsonl`
 * where the date is extracted from `entry.ts.slice(0, 10)`.
 *
 * Never throws — all errors are silently caught.
 */
export function emitJournalEvent(basePath: string, entry: JournalEntry): void {
  // Drop writes from a turn superseded by timeout recovery / cancellation.
  // See auto/turn-epoch.ts for the full rationale.
  if (isStaleWrite("journal")) return;
  try {
    const journalDir = join(gsdRoot(basePath), "journal");
    mkdirSync(journalDir, { recursive: true });
    const dateStr = entry.ts.slice(0, 10);
    const filePath = join(journalDir, `${dateStr}.jsonl`);
    // Ensure file exists so proper-lockfile can acquire a lock against it.
    if (!existsSync(filePath)) closeSync(openSync(filePath, "a"));
    // onLocked: "skip" — journal writes are best-effort. POSIX O_APPEND
    // atomicity still protects small entries; the lock mainly serializes
    // larger writes and gives cross-process exclusivity on platforms where
    // O_APPEND semantics are weaker (Windows).
    withFileLockSync(
      filePath,
      () => {
        appendFileSync(filePath, JSON.stringify(entry) + "\n");
      },
      { onLocked: "skip" },
    );
  } catch {
    // Silent failure — journal must never break auto-mode
  }

  if (!isUnifiedAuditEnabled()) return;
  try {
    const causedBy = entry.causedBy
      ? `${entry.causedBy.flowId}:${entry.causedBy.seq}`
      : undefined;
    const turnId =
      typeof entry.data?.turnId === "string"
        ? entry.data.turnId
        : undefined;
    emitUokAuditEvent(
      basePath,
      buildAuditEnvelope({
        traceId: entry.flowId,
        turnId,
        causedBy,
        category: "orchestration",
        type: `journal-${entry.eventType}`,
        payload: {
          seq: entry.seq,
          rule: entry.rule,
          data: entry.data ?? {},
        },
      }),
    );
  } catch {
    // Best-effort: audit projection must never block journal writes.
  }
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Read and filter journal entries from all daily JSONL files.
 *
 * Returns an empty array on any error (missing directory, corrupt files, etc.).
 */
export function queryJournal(
  basePath: string,
  filters?: JournalQueryFilters,
): JournalEntry[] {
  try {
    const journalDir = join(gsdRoot(basePath), "journal");
    const files = readdirSync(journalDir).filter(f => f.endsWith(".jsonl")).sort();

    const entries: JournalEntry[] = [];
    for (const file of files) {
      const raw = readFileSync(join(journalDir, file), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as JournalEntry;
          entries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }
    }

    if (!filters) return entries;

    return entries.filter(e => {
      if (filters.flowId && e.flowId !== filters.flowId) return false;
      if (filters.eventType && e.eventType !== filters.eventType) return false;
      if (filters.rule && e.rule !== filters.rule) return false;
      if (filters.unitId && (e.data as Record<string, unknown> | undefined)?.unitId !== filters.unitId) return false;
      if (filters.after && e.ts < filters.after) return false;
      if (filters.before && e.ts > filters.before) return false;
      return true;
    });
  } catch {
    // Missing directory, permission errors, etc. — return empty
    return [];
  }
}
