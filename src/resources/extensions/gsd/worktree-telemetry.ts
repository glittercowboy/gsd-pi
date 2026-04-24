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

// ─── Emitters ────────────────────────────────────────────────────────────

export function emitWorktreeCreated(
  projectRoot: string,
  milestoneId: string,
  meta: { flowId?: string; reason?: string } = {},
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
    reason: string; // "pause" | "stop" | "blocked" | "merge-conflict" | "merge-error" | "all-complete" | ...
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
): void {
  emitJournalEvent(projectRoot, baseEntry("canonical-root-redirect", {
    milestoneId,
    redirectedTo,
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
      default:
        break;
    }
  }

  summary.mergeDurationsMs.sort((a, b) => a - b);
  return summary;
}

/** Return the p{quantile} of a sorted array. Quantile in [0,1]. */
export function percentile(sortedValues: number[], q: number): number | null {
  if (sortedValues.length === 0) return null;
  if (q <= 0) return sortedValues[0];
  if (q >= 1) return sortedValues[sortedValues.length - 1];
  const idx = Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length));
  return sortedValues[idx];
}
