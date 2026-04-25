/**
 * Worktree telemetry — #4764
 *
 * Thin emit helpers + aggregator on top of the existing journal. Separate
 * module so callers import a tiny surface and don't have to assemble
 * JournalEntry records by hand. Kernighan: the underlying emit path
 * (emitJournalEvent) is already battle-tested; this module is just
 * structured call sites + a summarizer.
 *
 * Emitted event types (see journal.ts):
 *   - worktree-created           worktree entered/created for a milestone
 *   - worktree-merged            worktree merge back to main completed
 *   - worktree-orphaned          audit detected an orphaned branch/worktree
 *   - auto-exit                  auto-mode exited (pause/stop/blocked/error)
 *   - worktree-sync              syncStateToProjectRoot snapshot
 *   - canonical-root-redirect    resolveCanonicalMilestoneRoot redirected
 *
 * These events are purely observational. They never block, never throw,
 * and never carry code content — only IDs, counts, durations, and reasons.
 */

import { randomUUID } from "node:crypto";
import { emitJournalEvent, queryJournal } from "./journal.js";
import type { JournalEntry } from "./journal.js";

function now(): string {
  return new Date().toISOString();
}

function baseEntry(eventType: JournalEntry["eventType"], data: Record<string, unknown>): JournalEntry {
  return {
    ts: now(),
    flowId: (typeof data.flowId === "string" ? data.flowId : undefined) ?? randomUUID(),
    seq: typeof data.seq === "number" ? data.seq : 0,
    eventType,
    data,
  };
}

// ─── Reason literal unions ───────────────────────────────────────────────
// Closed sets so typos at call sites are rejected at compile time and can't
// silently fragment the telemetry buckets produced by summarizeWorktreeTelemetry.

export type WorktreeCreatedReason = "create-milestone" | "enter-milestone";
export type AutoExitReason =
  | "pause"
  | "stop"
  | "blocked"
  | "merge-conflict"
  | "merge-failed"
  | "slice-merge-conflict"
  | "all-complete"
  | "no-active-milestone"
  | "other";

// ─── Emitters ────────────────────────────────────────────────────────────

export function emitWorktreeCreated(
  projectRoot: string,
  milestoneId: string,
  meta: { flowId?: string; reason?: WorktreeCreatedReason } = {},
): void {
  emitJournalEvent(projectRoot, baseEntry("worktree-created", {
    milestoneId,
    startedAt: now(),
    flowId: meta.flowId,
    reason: meta.reason ?? "enter-milestone",
  }));
}

export function emitWorktreeMerged(
  projectRoot: string,
  milestoneId: string,
  meta: {
    flowId?: string;
    reason?: "milestone-complete" | "all-complete" | "stop-fallback" | "transition" | "other";
    startedAt?: string;
    durationMs?: number;
    sliceCount?: number;
    taskCount?: number;
    conflict?: boolean;
    conflictedFiles?: number;
  } = {},
): void {
  emitJournalEvent(projectRoot, baseEntry("worktree-merged", {
    milestoneId,
    endedAt: now(),
    flowId: meta.flowId,
    reason: meta.reason ?? "other",
    startedAt: meta.startedAt,
    durationMs: meta.durationMs,
    sliceCount: meta.sliceCount,
    taskCount: meta.taskCount,
    conflict: meta.conflict ?? false,
    conflictedFiles: meta.conflictedFiles ?? 0,
  }));
}

export function emitWorktreeOrphaned(
  projectRoot: string,
  milestoneId: string,
  meta: {
    flowId?: string;
    reason: "in-progress-unmerged" | "complete-unmerged" | "stale-branch";
    commitsAhead?: number;
    worktreeDirExists?: boolean;
  },
): void {
  emitJournalEvent(projectRoot, baseEntry("worktree-orphaned", {
    milestoneId,
    flowId: meta.flowId,
    reason: meta.reason,
    commitsAhead: meta.commitsAhead,
    worktreeDirExists: meta.worktreeDirExists ?? false,
    detectedAt: now(),
  }));
}

export function emitAutoExit(
  projectRoot: string,
  meta: {
    flowId?: string;
    /** Must come from the closed AutoExitReason set. Callers with free-form
     *  reasons (e.g. stopAuto's `reason?: string` parameter) should map to
     *  the closed set before emitting. */
    reason: AutoExitReason;
    milestoneId?: string;
    milestoneMerged: boolean;
  },
): void {
  emitJournalEvent(projectRoot, baseEntry("auto-exit", {
    reason: meta.reason,
    flowId: meta.flowId,
    milestoneId: meta.milestoneId,
    milestoneMerged: meta.milestoneMerged,
    exitedAt: now(),
  }));
}

export function emitWorktreeSync(
  projectRoot: string,
  milestoneId: string,
  meta: {
    flowId?: string;
    filesCopied?: number;
    bytesCopied?: number;
    commitsAhead?: number;
    worktreeAgeMs?: number;
  },
): void {
  emitJournalEvent(projectRoot, baseEntry("worktree-sync", {
    milestoneId,
    flowId: meta.flowId,
    filesCopied: meta.filesCopied,
    bytesCopied: meta.bytesCopied,
    commitsAhead: meta.commitsAhead,
    worktreeAgeMs: meta.worktreeAgeMs,
  }));
}

export function emitCanonicalRootRedirect(
  projectRoot: string,
  milestoneId: string,
  redirectedTo: string,
  meta: { flowId?: string } = {},
): void {
  emitJournalEvent(projectRoot, baseEntry("canonical-root-redirect", {
    milestoneId,
    redirectedTo,
    flowId: meta.flowId,
  }));
}

// #4765 — slice-cadence collapse events

export function emitSliceMerged(
  projectRoot: string,
  milestoneId: string,
  sliceId: string,
  meta: { durationMs?: number; conflict?: boolean; commitSha?: string; flowId?: string } = {},
): void {
  emitJournalEvent(projectRoot, baseEntry("slice-merged", {
    milestoneId,
    sliceId,
    mergedAt: now(),
    durationMs: meta.durationMs,
    conflict: meta.conflict ?? false,
    commitSha: meta.commitSha,
    flowId: meta.flowId,
  }));
}

export function emitMilestoneResquash(
  projectRoot: string,
  milestoneId: string,
  meta: { sliceCount: number; startSha?: string; endSha?: string; flowId?: string } = { sliceCount: 0 },
): void {
  emitJournalEvent(projectRoot, baseEntry("milestone-resquash", {
    milestoneId,
    sliceCount: meta.sliceCount,
    startSha: meta.startSha,
    endSha: meta.endSha,
    resquashedAt: now(),
    flowId: meta.flowId,
  }));
}

// ─── Aggregator ──────────────────────────────────────────────────────────

export interface WorktreeTelemetrySummary {
  /** Count of worktrees created within the window */
  worktreesCreated: number;
  /** Count of worktrees merged within the window */
  worktreesMerged: number;
  /** Count of orphan detections within the window */
  orphansDetected: number;
  /** Breakdown by orphan reason */
  orphansByReason: Record<string, number>;
  /** Merge durations in milliseconds, sorted ascending */
  mergeDurationsMs: number[];
  /** Number of merges that hit a conflict */
  mergeConflicts: number;
  /** Auto-exit reasons and their counts */
  exitsByReason: Record<string, number>;
  /** Auto-exits where the milestone was NOT merged before exit — the #4761 producer metric */
  exitsWithUnmergedWork: number;
  /** Count of canonical-root-redirects (how often #4761 validation would have read stale state) */
  canonicalRedirects: number;
  /** #4765 — count of successful slice-level merges (slice-cadence feature) */
  slicesMerged: number;
  /** #4765 — count of slice-level merge conflicts */
  sliceMergeConflicts: number;
  /** #4765 — count of milestone-level re-squash operations */
  milestoneResquashes: number;
}

/**
 * Summarize worktree telemetry across the journal. Optional time window
 * via filters.after / filters.before (ISO-8601).
 */
export function summarizeWorktreeTelemetry(
  projectRoot: string,
  filters?: { after?: string; before?: string },
): WorktreeTelemetrySummary {
  const entries = queryJournal(projectRoot, filters);

  const summary: WorktreeTelemetrySummary = {
    worktreesCreated: 0,
    worktreesMerged: 0,
    orphansDetected: 0,
    orphansByReason: {},
    mergeDurationsMs: [],
    mergeConflicts: 0,
    exitsByReason: {},
    exitsWithUnmergedWork: 0,
    canonicalRedirects: 0,
    slicesMerged: 0,
    sliceMergeConflicts: 0,
    milestoneResquashes: 0,
  };

  for (const e of entries) {
    const d = e.data ?? {};
    switch (e.eventType) {
      case "worktree-created":
        summary.worktreesCreated++;
        break;
      case "worktree-merged":
        summary.worktreesMerged++;
        if (typeof d.durationMs === "number") summary.mergeDurationsMs.push(d.durationMs);
        if (d.conflict === true) summary.mergeConflicts++;
        break;
      case "worktree-orphaned": {
        summary.orphansDetected++;
        const reason = typeof d.reason === "string" ? d.reason : "unknown";
        summary.orphansByReason[reason] = (summary.orphansByReason[reason] ?? 0) + 1;
        break;
      }
      case "auto-exit": {
        const reason = typeof d.reason === "string" ? d.reason : "unknown";
        summary.exitsByReason[reason] = (summary.exitsByReason[reason] ?? 0) + 1;
        if (d.milestoneMerged === false) summary.exitsWithUnmergedWork++;
        break;
      }
      case "canonical-root-redirect":
        summary.canonicalRedirects++;
        break;
      case "slice-merged":
        summary.slicesMerged++;
        if (d.conflict === true) summary.sliceMergeConflicts++;
        break;
      case "milestone-resquash":
        summary.milestoneResquashes++;
        break;
      default:
        break;
    }
  }

  summary.mergeDurationsMs.sort((a, b) => a - b);
  return summary;
}

/**
 * Return the p{quantile} of a sorted array using the nearest-rank method.
 * Quantile in [0,1].
 *
 * Prior implementation used Math.floor(q*n), which overstates exact-rank
 * quantiles by one sample (e.g. p95 of 20 values returned the max instead
 * of the 19th value). The nearest-rank index is ceil(q*n) - 1, clamped to
 * [0, n-1].
 */
export function percentile(sortedValues: number[], q: number): number | null {
  if (sortedValues.length === 0) return null;
  if (q <= 0) return sortedValues[0];
  if (q >= 1) return sortedValues[sortedValues.length - 1];
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(q * sortedValues.length) - 1),
  );
  return sortedValues[idx];
}
