// GSD2 — Read-only query tools exposing DB state to the LLM via the WAL connection

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";

export function registerQueryTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "gsd_milestone_status",
    label: "Milestone Status",
    description:
      "Read the current status of a milestone and all its slices from the GSD database. " +
      "Returns milestone metadata, per-slice status, and task counts per slice. " +
      "Use this instead of querying .gsd/gsd.db directly via sqlite3 or better-sqlite3.",
    promptSnippet: "Get milestone status, slice statuses, and task counts for a given milestoneId",
    promptGuidelines: [
      "Use this tool — not sqlite3 or better-sqlite3 — to inspect milestone or slice state from the DB.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID to query (e.g. M001)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        // Open the DB if not already open — safe for read-only use since
        // ensureDbOpen() only creates/migrates when .gsd/ has content (#3644).
        const { ensureDbOpen } = await import("./dynamic-tools.js");
        const dbAvailable = await ensureDbOpen();
        const {
          getMilestone,
          getSliceStatusSummary,
          getSliceTaskCounts,
          _getAdapter,
        } = await import("../gsd-db.js");

        if (!dbAvailable) {
          return {
            content: [{ type: "text" as const, text: "Error: GSD database is not available." }],
            details: { operation: "milestone_status", error: "db_unavailable" } as any,
          };
        }

        // Wrap all reads in a single transaction for snapshot consistency.
        // SQLite WAL mode guarantees reads within a transaction see a single
        // consistent snapshot, preventing torn reads from concurrent writes.
        const adapter = _getAdapter()!;
        adapter.exec("BEGIN");  // eslint-disable-line -- SQLite exec, not child_process
        try {
          const milestone = getMilestone(params.milestoneId);
          if (!milestone) {
            adapter.exec("COMMIT");  // eslint-disable-line
            return {
              content: [{ type: "text" as const, text: `Milestone ${params.milestoneId} not found in database.` }],
              details: { operation: "milestone_status", milestoneId: params.milestoneId, found: false } as any,
            };
          }

          const sliceStatuses = getSliceStatusSummary(params.milestoneId);

          const slices = sliceStatuses.map((s) => {
            const counts = getSliceTaskCounts(params.milestoneId, s.id);
            return {
              id: s.id,
              status: s.status,
              taskCounts: counts,
            };
          });

          adapter.exec("COMMIT");  // eslint-disable-line

          const result = {
            milestoneId: milestone.id,
            title: milestone.title,
            status: milestone.status,
            createdAt: milestone.created_at,
            completedAt: milestone.completed_at,
            sliceCount: slices.length,
            slices,
          };

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: { operation: "milestone_status", milestoneId: milestone.id, sliceCount: slices.length } as any,
          };
        } catch (txErr) {
          try { adapter.exec("ROLLBACK"); } catch { /* swallow */ }  // eslint-disable-line
          throw txErr;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarning("tool", `gsd_milestone_status tool failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error querying milestone status: ${msg}` }],
          details: { operation: "milestone_status", error: msg } as any,
        };
      }
    },
  });
}
