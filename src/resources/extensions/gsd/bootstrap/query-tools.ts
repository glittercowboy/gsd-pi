// GSD2 — Read-only query tools exposing DB state to the LLM via the WAL connection

import { Type } from "@sinclair/typebox";
import type { AgentToolResult, ExtensionAPI } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";
import { hasSpansTable, _getAdapter } from "../gsd-db.js";
import {
  querySpans, getTrace, getRecentTraces, getTraceByPrefix,
  formatTraceTree, formatTraceSummaries,
  shortcutToQuery, parseTimeWindow,
  type TraceShortcut,
} from "../tracing/query.js";

interface MilestoneStatusDetails {
  operation: "milestone_status";
  error?: string;
  milestoneId?: string;
  found?: boolean;
  sliceCount?: number;
}

interface TraceQueryDetails {
  operation: "trace_query";
  error?: string;
  shortcut?: string;
  trace_id?: string;
  found?: boolean;
  count?: number;
  spanCount?: number;
  traceCount?: number;
  showedSummaries?: boolean;
}

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
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<MilestoneStatusDetails>> {
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
            details: { operation: "milestone_status", error: "db_unavailable" },
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
              details: { operation: "milestone_status", milestoneId: params.milestoneId, found: false },
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
            details: { operation: "milestone_status", milestoneId: milestone.id, sliceCount: slices.length },
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
          details: { operation: "milestone_status", error: msg },
        };
      }
    },
  });

  // ─── gsd_trace_query — OTel trace inspection (#3732) ──────────────────────

  pi.registerTool({
    name: "gsd_trace_query",
    label: "Trace Query",
    description:
      "Query GSD execution traces to understand why GSD made specific decisions. " +
      "Returns formatted trace trees with decision metadata (model selection, dispatch routing, " +
      "guard evaluation, context assembly). Use this when the user asks about GSD behavior.",
    promptSnippet: "Query execution traces for model selection, dispatch, guards, and context assembly decisions",
    promptGuidelines: [
      "Use this tool when the user asks why GSD chose a model, stopped, or behaved unexpectedly.",
      "Use the 'shortcut' parameter for common questions: model-decisions, why-stopped, errors, guards, recent.",
    ],
    parameters: Type.Object({
      trace_id: Type.Optional(Type.String({ description: "Get full trace tree for a specific trace ID (or prefix)" })),
      span_name: Type.Optional(Type.String({ description: "Filter by span name pattern, supports * glob (e.g. 'gsd.model.*')" })),
      unit_type: Type.Optional(Type.String({ description: "Filter by unit type (e.g. 'execute-task')" })),
      unit_id: Type.Optional(Type.String({ description: "Filter by unit ID (e.g. 'M001-S02-T003')" })),
      since: Type.Optional(Type.String({ description: "Time window: '1h', '30m', '2h', '7d', or ISO date" })),
      shortcut: Type.Optional(Type.Union([
        Type.Literal("model-decisions"),
        Type.Literal("why-stopped"),
        Type.Literal("errors"),
        Type.Literal("guards"),
        Type.Literal("recent"),
      ], { description: "Predefined query for common diagnostic questions" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
    }),
    async execute(_toolCallId, params, _signal): Promise<AgentToolResult<TraceQueryDetails>> {
      try {
        if (!hasSpansTable()) {
          return {
            content: [{ type: "text" as const, text: "No trace data available. Run /gsd auto to generate traces." }],
            details: { operation: "trace_query", error: "no_spans_table" },
          };
        }

        const db = _getAdapter();
        if (!db) {
          return {
            content: [{ type: "text" as const, text: "Database unavailable." }],
            details: { operation: "trace_query", error: "db_unavailable" },
          };
        }

        // Shortcut handling
        if (params.shortcut) {
          const since = params.since ? parseTimeWindow(params.since) : undefined;
          const query = shortcutToQuery(params.shortcut as TraceShortcut, since);
          query.limit = params.limit ?? 20;
          const spans = querySpans(db, query);
          if (spans.length === 0) {
            return {
              content: [{ type: "text" as const, text: `No ${params.shortcut} traces found.` }],
              details: { operation: "trace_query", shortcut: params.shortcut, count: 0 },
            };
          }
          const traceIds = [...new Set(spans.map(s => s.trace_id))];
          const trees = traceIds.slice(0, 5).map(tid => formatTraceTree(getTrace(db, tid)));
          return {
            content: [{ type: "text" as const, text: trees.join("\n\n") }],
            details: { operation: "trace_query", shortcut: params.shortcut, spanCount: spans.length, traceCount: traceIds.length },
          };
        }

        // Specific trace ID (exact or prefix match)
        if (params.trace_id) {
          const traceSpans = getTraceByPrefix(db, params.trace_id);
          if (traceSpans.length === 0) {
            return {
              content: [{ type: "text" as const, text: `No trace found matching "${params.trace_id}".` }],
              details: { operation: "trace_query", trace_id: params.trace_id, found: false },
            };
          }
          return {
            content: [{ type: "text" as const, text: formatTraceTree(traceSpans) }],
            details: { operation: "trace_query", trace_id: traceSpans[0].trace_id, spanCount: traceSpans.length },
          };
        }

        // General query
        const spans = querySpans(db, {
          spanName: params.span_name,
          unitType: params.unit_type,
          unitId: params.unit_id,
          since: params.since ? parseTimeWindow(params.since) : undefined,
          limit: params.limit ?? 20,
        });

        if (spans.length === 0) {
          // Fall back to recent summaries
          const summaries = getRecentTraces(db, 10);
          return {
            content: [{ type: "text" as const, text: summaries.length > 0 ? formatTraceSummaries(summaries) : "No traces recorded yet." }],
            details: { operation: "trace_query", count: 0, showedSummaries: summaries.length > 0 },
          };
        }

        const traceIds = [...new Set(spans.map(s => s.trace_id))];
        const trees = traceIds.slice(0, 5).map(tid => formatTraceTree(getTrace(db, tid)));
        return {
          content: [{ type: "text" as const, text: trees.join("\n\n") }],
          details: { operation: "trace_query", spanCount: spans.length, traceCount: traceIds.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarning("tool", `gsd_trace_query failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error querying traces: ${msg}` }],
          details: { operation: "trace_query", error: msg },
        };
      }
    },
  });
}
