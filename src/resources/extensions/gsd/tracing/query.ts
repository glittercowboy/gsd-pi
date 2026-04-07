/**
 * Trace query API (#3732).
 *
 * Provides typed queries and formatting for the `spans` table.
 * Used by: doctor trace checks, `/gsd traces` CLI, `gsd_trace_query` tool,
 * and the MCP `gsd_traces` tool.
 */

import type { DbAdapter } from "../gsd-db.js";

/**
 * OTel trace IDs are 32 hex chars. Prefix lookups require at least this many
 * characters to avoid matching unrelated traces.
 */
export const TRACE_ID_MIN_PREFIX_LENGTH = 8;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time: number;
  end_time: number | null;
  duration_ms: number | null;
  status: string;
  unit_type: string | null;
  unit_id: string | null;
  attributes: Record<string, unknown>;
}

export interface TraceQuery {
  traceId?: string;
  spanName?: string;
  unitType?: string;
  unitId?: string;
  since?: number;        // epoch ms
  until?: number;        // epoch ms
  status?: "ok" | "error";
  limit?: number;        // default 50
}

export interface TraceSummary {
  traceId: string;
  iteration: number | null;
  unitType: string | null;
  unitId: string | null;
  modelConfigured: string | null;
  modelResolved: string | null;
  modelDowngraded: boolean;
  startTime: number;
  durationMs: number | null;
  status: string;
  spanCount: number;
}

// ─── Query Shortcuts ────────────────────────────────────────────────────────

export type TraceShortcut =
  | "model-decisions"
  | "why-stopped"
  | "errors"
  | "guards"
  | "cwd-mismatch"
  | "recent";

export function shortcutToQuery(shortcut: TraceShortcut, since?: number): TraceQuery {
  const defaultSince = since ?? Date.now() - 3_600_000; // 1 hour
  switch (shortcut) {
    case "model-decisions":
      return { spanName: "gsd.unit.model_selection", since: defaultSince, limit: 20 };
    case "why-stopped":
      return { spanName: "gsd.auto.iteration", since: defaultSince, limit: 5 };
    case "errors":
      return { status: "error", since: defaultSince, limit: 20 };
    case "guards":
      return { spanName: "gsd.guards", since: defaultSince, limit: 20 };
    case "cwd-mismatch":
      return { spanName: "gsd.auto.iteration", since: defaultSince, limit: 20 };
    case "recent":
      return { spanName: "gsd.auto.iteration", since: defaultSince, limit: 10 };
  }
}

// ─── Core Query ─────────────────────────────────────────────────────────────

/**
 * Flatten a nested object back to dot-separated keys.
 * Inverse of flatToNested in exporter.ts.
 * e.g. {gsd: {model: {configured: "opus"}}} → {"gsd.model.configured": "opus"}
 */
function nestedToFlat(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, nestedToFlat(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

function parseRow(row: Record<string, unknown>): SpanRow {
  let attrs: Record<string, unknown> = {};
  try {
    const raw = typeof row["attributes"] === "string"
      ? JSON.parse(row["attributes"] as string)
      : (row["attributes"] as Record<string, unknown>) ?? {};
    // DB stores nested JSON (for json_extract compatibility).
    // Consumer-facing API uses flat dotted keys for consistency with GSD attribute constants.
    attrs = nestedToFlat(raw);
  } catch { /* malformed JSON — use empty */ }

  return {
    trace_id: row["trace_id"] as string,
    span_id: row["span_id"] as string,
    parent_span_id: (row["parent_span_id"] as string) ?? null,
    name: row["name"] as string,
    start_time: row["start_time"] as number,
    end_time: (row["end_time"] as number) ?? null,
    duration_ms: (row["duration_ms"] as number) ?? null,
    status: row["status"] as string,
    unit_type: (row["unit_type"] as string) ?? null,
    unit_id: (row["unit_id"] as string) ?? null,
    attributes: attrs,
  };
}

/**
 * Query spans from the DB. Builds a WHERE clause from the query parameters.
 */
export function querySpans(db: DbAdapter, query: TraceQuery): SpanRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.traceId) {
    conditions.push("trace_id = ?");
    params.push(query.traceId);
  }
  if (query.spanName) {
    if (query.spanName.includes("*")) {
      conditions.push("name LIKE ?");
      params.push(query.spanName.replace(/\*/g, "%"));
    } else {
      conditions.push("name = ?");
      params.push(query.spanName);
    }
  }
  if (query.unitType) {
    conditions.push("unit_type = ?");
    params.push(query.unitType);
  }
  if (query.unitId) {
    conditions.push("unit_id = ?");
    params.push(query.unitId);
  }
  if (query.since) {
    conditions.push("start_time >= ?");
    params.push(query.since);
  }
  if (query.until) {
    conditions.push("start_time <= ?");
    params.push(query.until);
  }
  if (query.status) {
    conditions.push("status = ?");
    params.push(query.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = query.limit ?? 50;

  const sql = `SELECT * FROM spans ${where} ORDER BY start_time DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return rows.map(parseRow);
}

/**
 * Get all spans for a single trace, ordered by start time.
 */
export function getTrace(db: DbAdapter, traceId: string): SpanRow[] {
  const rows = db.prepare(
    "SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time ASC",
  ).all(traceId);
  return rows.map(parseRow);
}

/**
 * Resolve a trace by exact ID or prefix match.
 * Returns all spans for the matching trace, or empty array if not found.
 */
export function getTraceByPrefix(db: DbAdapter, prefix: string): SpanRow[] {
  // Try exact match first
  const exact = getTrace(db, prefix);
  if (exact.length > 0) return exact;

  // Fall back to prefix match
  const prefixRows = db.prepare(
    "SELECT DISTINCT trace_id FROM spans WHERE trace_id LIKE ? LIMIT 1",
  ).all(`${prefix}%`);
  if (prefixRows.length > 0) {
    return getTrace(db, prefixRows[0]["trace_id"] as string);
  }

  return [];
}

/**
 * Get recent trace summaries (one entry per root span / iteration).
 */
export function getRecentTraces(db: DbAdapter, n = 10): TraceSummary[] {
  // Single query: join iteration spans with span counts and model selection data
  const rows = db.prepare(`
    SELECT
      iter.*,
      COALESCE(counts.cnt, 1)   AS span_count,
      model.attributes          AS model_attributes
    FROM spans iter
    LEFT JOIN (
      SELECT trace_id, count(*) AS cnt FROM spans GROUP BY trace_id
    ) counts ON counts.trace_id = iter.trace_id
    LEFT JOIN spans model
      ON model.trace_id = iter.trace_id
      AND model.name = 'gsd.unit.model_selection'
    WHERE iter.name = 'gsd.auto.iteration'
    ORDER BY iter.start_time DESC
    LIMIT ?
  `).all(n);

  return rows.map((row) => {
    const span = parseRow(row);
    const attrs = span.attributes;
    const spanCount = (row["span_count"] as number) ?? 1;

    let modelAttrs: Record<string, unknown> = {};
    const modelRaw = row["model_attributes"];
    if (modelRaw) {
      try {
        const raw = typeof modelRaw === "string" ? JSON.parse(modelRaw) : modelRaw;
        modelAttrs = nestedToFlat(raw as Record<string, unknown>);
      } catch { /* ignore */ }
    }

    return {
      traceId: span.trace_id,
      iteration: (attrs["gsd.loop.iteration"] as number) ?? null,
      unitType: span.unit_type,
      unitId: span.unit_id,
      modelConfigured: (modelAttrs["gsd.model.configured"] as string) ?? null,
      modelResolved: (modelAttrs["gsd.model.resolved"] as string) ?? null,
      modelDowngraded: (modelAttrs["gsd.model.downgraded"] as boolean) ?? false,
      startTime: span.start_time,
      durationMs: span.duration_ms,
      status: span.status,
      spanCount,
    };
  });
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format a set of spans (from the same trace) into a human/LLM-readable tree.
 */
export function formatTraceTree(spans: SpanRow[]): string {
  if (spans.length === 0) return "(no spans)";

  // Build parent→children map
  const childMap = new Map<string | null, SpanRow[]>();
  for (const span of spans) {
    const parent = span.parent_span_id;
    if (!childMap.has(parent)) childMap.set(parent, []);
    childMap.get(parent)!.push(span);
  }

  // Find root spans (no parent or parent not in this set)
  const spanIds = new Set(spans.map(s => s.span_id));
  const roots = spans.filter(
    s => s.parent_span_id === null || !spanIds.has(s.parent_span_id),
  ).sort((a, b) => a.start_time - b.start_time);

  const lines: string[] = [];

  // Header from first root
  const first = roots[0];
  if (first) {
    const ts = new Date(first.start_time).toISOString();
    const iter = first.attributes["gsd.loop.iteration"];
    const unitDesc = first.unit_type
      ? ` (${first.unit_type}${first.unit_id ? ` / ${first.unit_id}` : ""})`
      : "";
    lines.push(`Trace ${first.trace_id.slice(0, 8)}..${iter != null ? ` — iteration #${iter}` : ""} ${ts}${unitDesc}`);
    lines.push("");
  }

  function renderSpan(span: SpanRow, prefix: string, isLast: boolean): void {
    const connector = isLast ? "└─" : "├─";
    const duration = span.duration_ms != null ? ` [${formatDuration(span.duration_ms)}]` : "";
    const statusMark = span.status === "error" ? " ERROR" : "";
    lines.push(`${prefix}${connector} ${span.name}${duration}${statusMark}`);

    const childPrefix = prefix + (isLast ? "   " : "│  ");

    // Render key attributes (skip internal/redundant ones)
    const attrLines = formatSpanAttributes(span);
    for (const al of attrLines) {
      lines.push(`${childPrefix}  ${al}`);
    }

    // Render children
    const children = childMap.get(span.span_id) ?? [];
    children.sort((a, b) => a.start_time - b.start_time);
    for (let i = 0; i < children.length; i++) {
      renderSpan(children[i], childPrefix, i === children.length - 1);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    renderSpan(roots[i], "", i === roots.length - 1);
  }

  return lines.join("\n");
}

/**
 * Format recent trace summaries as a table.
 */
export function formatTraceSummaries(summaries: TraceSummary[]): string {
  if (summaries.length === 0) return "No traces found.";

  const lines: string[] = [];
  lines.push("Recent traces:");
  lines.push("");
  lines.push("  #  Trace ID   Iter  Unit Type            Unit ID              Model                    Duration  Status");
  lines.push("  " + "─".repeat(110));

  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    const traceId = s.traceId.slice(0, 8) + "..";
    const iter = s.iteration != null ? String(s.iteration).padStart(4) : "   -";
    const unitType = (s.unitType ?? "-").padEnd(20);
    const unitId = (s.unitId ?? "-").padEnd(20);
    const model = formatModelColumn(s);
    const duration = s.durationMs != null ? formatDuration(s.durationMs).padStart(8) : "       -";
    const status = s.status;

    lines.push(`  ${String(i + 1).padStart(2)} ${traceId}  ${iter}  ${unitType} ${unitId} ${model.padEnd(24)} ${duration}  ${status}`);
  }

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function formatModelColumn(s: TraceSummary): string {
  if (!s.modelResolved) return "-";
  const model = s.modelResolved.split("/").pop() ?? s.modelResolved;
  if (s.modelDowngraded && s.modelConfigured) {
    const configured = s.modelConfigured.split("/").pop() ?? s.modelConfigured;
    return `${model} (↓ ${configured})`;
  }
  return model;
}

/** Extract interesting attributes from a span for display. */
function formatSpanAttributes(span: SpanRow): string[] {
  const attrs = span.attributes;
  const lines: string[] = [];
  const skip = new Set([
    "gsd.unit.type", "gsd.unit.id", "gsd.dispatch.unit_type", "gsd.dispatch.unit_id",
    "gsd.loop.iteration", "gsd.loop.flow_id",
  ]);

  // Group by prefix for readability
  const entries = Object.entries(attrs)
    .filter(([k]) => !skip.has(k))
    .filter(([, v]) => v !== null && v !== undefined && v !== "none");

  for (const [key, value] of entries) {
    const shortKey = key.replace(/^gsd\./, "");
    lines.push(`${shortKey}=${formatValue(value)}`);
  }

  return lines;
}

function formatValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * Parse a human-friendly time window string to epoch ms.
 * Supports: "30m", "1h", "2h", "1d", "7d", ISO date strings.
 */
export function parseTimeWindow(window: string): number {
  const match = window.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return Date.now() - ms;
  }
  // Try ISO date
  const ts = new Date(window).getTime();
  if (!isNaN(ts)) return ts;
  // Default: 1 hour
  return Date.now() - 3_600_000;
}
