/**
 * /gsd traces — Browse OTel execution traces stored in gsd.db (#3732).
 *
 * Subcommands:
 *   /gsd traces                       — last 10 trace summaries
 *   /gsd traces <traceId>             — full trace tree
 *   /gsd traces --unit <unitId>       — traces for a specific unit
 *   /gsd traces --span <pattern>      — filter by span name (supports *)
 *   /gsd traces --since <window>      — time window (1h, 30m, 2h, 7d)
 *   /gsd traces --errors              — only error spans
 *   /gsd traces --model-decisions     — model selection decision chain
 *   /gsd traces --why-stopped         — find loop exit reason
 *   /gsd traces --guards              — guard evaluations
 *   /gsd traces --cwd-mismatch       — iterations where cwd != worktree path
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { hasSpansTable, _getAdapter } from "./gsd-db.js";
import {
  querySpans, getTrace, getRecentTraces, getTraceByPrefix,
  formatTraceTree, formatTraceSummaries,
  shortcutToQuery, parseTimeWindow,
  TRACE_ID_MIN_PREFIX_LENGTH,
  type TraceQuery, type TraceShortcut,
} from "./tracing/query.js";

export async function handleTraces(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!hasSpansTable()) {
    ctx.ui.notify(
      "No trace data available.\n\n" +
      "Traces are recorded automatically during /gsd auto sessions.\n" +
      "Run at least one auto-mode session to populate the trace store.",
      "info",
    );
    return;
  }

  const db = _getAdapter();
  if (!db) {
    ctx.ui.notify("Database unavailable — cannot query traces.", "warning");
    return;
  }

  const parts = args.trim().split(/\s+/).filter(Boolean);

  // Parse flags
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("--")) {
      const key = p.slice(2);
      if (["errors", "model-decisions", "why-stopped", "guards", "cwd-mismatch", "json"].includes(key)) {
        flags.set(key, "true");
      } else if (i + 1 < parts.length) {
        flags.set(key, parts[++i]);
      }
    } else {
      positional.push(p);
    }
  }

  // Shortcut flags
  const shortcuts: TraceShortcut[] = ["model-decisions", "why-stopped", "errors", "guards", "cwd-mismatch"];
  for (const sc of shortcuts) {
    if (flags.has(sc)) {
      const since = flags.has("since") ? parseTimeWindow(flags.get("since")!) : undefined;
      const query = shortcutToQuery(sc, since);
      const spans = querySpans(db, query);
      if (spans.length === 0) {
        ctx.ui.notify(`No ${sc} traces found.`, "info");
        return;
      }
      const traceIds = [...new Set(spans.map(s => s.trace_id))];
      const lines: string[] = [`${sc} traces (${spans.length} spans across ${traceIds.length} trace(s)):\n`];
      for (const tid of traceIds.slice(0, 5)) {
        const traceSpans = getTrace(db, tid);
        lines.push(formatTraceTree(traceSpans));
        lines.push("");
      }
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }
  }

  // /gsd traces <traceId> — full trace tree
  if (positional.length === 1 && positional[0].length >= TRACE_ID_MIN_PREFIX_LENGTH) {
    const traceSpans = getTraceByPrefix(db, positional[0]);
    if (traceSpans.length > 0) {
      ctx.ui.notify(formatTraceTree(traceSpans), "info");
      return;
    }
    ctx.ui.notify(`No trace found matching "${positional[0]}".`, "warning");
    return;
  }

  // Build query from flags
  if (flags.has("unit") || flags.has("span") || flags.has("since")) {
    const query: TraceQuery = {};
    if (flags.has("unit")) query.unitId = flags.get("unit");
    if (flags.has("span")) query.spanName = flags.get("span");
    if (flags.has("since")) query.since = parseTimeWindow(flags.get("since")!);
    if (flags.has("errors")) query.status = "error";
    query.limit = 30;

    const spans = querySpans(db, query);
    if (spans.length === 0) {
      ctx.ui.notify("No matching traces found.", "info");
      return;
    }

    const traceIds = [...new Set(spans.map(s => s.trace_id))];
    const lines: string[] = [`Found ${spans.length} span(s) across ${traceIds.length} trace(s):\n`];
    for (const tid of traceIds.slice(0, 5)) {
      const traceSpans = getTrace(db, tid);
      lines.push(formatTraceTree(traceSpans));
      lines.push("");
    }
    if (traceIds.length > 5) {
      lines.push(`... and ${traceIds.length - 5} more trace(s). Use --since to narrow.`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  // Default: recent trace summaries
  const summaries = getRecentTraces(db, 10);
  if (summaries.length === 0) {
    ctx.ui.notify("No traces recorded yet. Run /gsd auto to generate traces.", "info");
    return;
  }

  const output = formatTraceSummaries(summaries);
  ctx.ui.notify(
    output + "\n\nView details: /gsd traces <traceId>\nShortcuts: --model-decisions, --why-stopped, --errors, --guards, --cwd-mismatch",
    "info",
  );
}
