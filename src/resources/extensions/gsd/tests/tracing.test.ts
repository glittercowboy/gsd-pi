/**
 * Tests for OTel tracing infrastructure (#3732).
 *
 * Covers: DbSpanExporter, TracerProvider lifecycle, query API,
 * doctor trace checks, semantic attributes, and CLI formatting.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  hasSpansTable,
} from "../gsd-db.ts";
import type { DbAdapter } from "../gsd-db.ts";
import { DbSpanExporter, flatToNested } from "../tracing/exporter.ts";
import {
  querySpans,
  getTrace,
  getTraceByPrefix,
  getRecentTraces,
  formatTraceTree,
  formatTraceSummaries,
  shortcutToQuery,
  parseTimeWindow,
  TRACE_ID_MIN_PREFIX_LENGTH,
} from "../tracing/query.ts";
import type { SpanRow, TraceSummary } from "../tracing/query.ts";
import { GSD } from "../tracing/attributes.ts";
import type { GSDAttributeKey } from "../tracing/attributes.ts";
import { runTraceChecks } from "../doctor-trace-checks.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function openMemoryDb(): DbAdapter {
  openDatabase(":memory:");
  const adapter = _getAdapter();
  assert.ok(adapter, "Failed to open in-memory database");
  return adapter;
}

/** Insert a span row directly via SQL (bypasses exporter for query/doctor tests). */
function insertSpan(db: DbAdapter, span: Partial<SpanRow> & { trace_id: string; span_id: string; name: string }): void {
  // Store attributes as nested JSON (same as DbSpanExporter) so json_extract queries work.
  const nestedAttrs = flatToNested(span.attributes ?? {});
  db.prepare(`
    INSERT INTO spans (trace_id, span_id, parent_span_id, name, start_time, end_time,
                       duration_ms, status, unit_type, unit_id, attributes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    span.trace_id,
    span.span_id,
    span.parent_span_id ?? null,
    span.name,
    span.start_time ?? Date.now(),
    span.end_time ?? Date.now() + 100,
    span.duration_ms ?? 100,
    span.status ?? "ok",
    span.unit_type ?? null,
    span.unit_id ?? null,
    JSON.stringify(nestedAttrs),
  );
}

/** Build a minimal ReadableSpan-like object for the exporter. */
function fakeReadableSpan(overrides?: {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTime?: [number, number];
  endTime?: [number, number];
  status?: { code: number; message?: string };
  attributes?: Record<string, unknown>;
  ended?: boolean;
}) {
  const now = Date.now();
  const startSec = Math.floor(now / 1000);
  const startNano = (now % 1000) * 1_000_000;
  return {
    spanContext: () => ({
      traceId: overrides?.traceId ?? "aaaa0000bbbb1111cccc2222dddd3333",
      spanId: overrides?.spanId ?? randomSpanId(),
      traceFlags: 1,
      traceState: undefined,
    }),
    parentSpanContext: overrides?.parentSpanId
      ? { spanId: overrides.parentSpanId, traceId: overrides?.traceId ?? "aaaa0000bbbb1111cccc2222dddd3333", traceFlags: 1 }
      : undefined,
    name: overrides?.name ?? "test.span",
    startTime: overrides?.startTime ?? [startSec, startNano],
    endTime: overrides?.endTime ?? [startSec, startNano + 50_000_000], // +50ms
    ended: overrides?.ended ?? true,
    status: overrides?.status ?? { code: 1 }, // OK
    attributes: overrides?.attributes ?? {},
    resource: { attributes: {} },
    instrumentationLibrary: { name: "test" },
    events: [],
    links: [],
    kind: 0,
    duration: [0, 50_000_000],
  };
}

let spanCounter = 0;
function randomSpanId(): string {
  return `span${String(++spanCounter).padStart(12, "0")}`;
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

afterEach(() => {
  spanCounter = 0;
  closeDatabase();
});

// ─── DbSpanExporter ─────────────────────────────────────────────────────────

describe("DbSpanExporter", () => {
  test("writes a single span to the spans table", () => {
    const db = openMemoryDb();
    const exporter = new DbSpanExporter(db, { flushThreshold: 1, flushIntervalMs: 999_999 });

    const span = fakeReadableSpan({ name: "gsd.test.single" });
    exporter.export([span as any], (result) => {
      assert.equal(result.code, 0); // SUCCESS
    });

    const rows = db.prepare("SELECT * FROM spans").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]["name"], "gsd.test.single");
    assert.equal(rows[0]["trace_id"], "aaaa0000bbbb1111cccc2222dddd3333");
    assert.equal(rows[0]["status"], "ok");

    exporter.shutdown();
  });

  test("buffers spans and flushes on threshold", () => {
    const db = openMemoryDb();
    const exporter = new DbSpanExporter(db, { flushThreshold: 3, flushIntervalMs: 999_999 });

    // Export 2 spans — should stay buffered (threshold is 3)
    exporter.export(
      [fakeReadableSpan({ name: "span.1" }) as any, fakeReadableSpan({ name: "span.2" }) as any],
      () => {},
    );
    let rows = db.prepare("SELECT * FROM spans").all();
    assert.equal(rows.length, 0, "Should still be buffered");

    // Export 1 more — hits threshold, should flush all 3
    exporter.export([fakeReadableSpan({ name: "span.3" }) as any], () => {});
    rows = db.prepare("SELECT * FROM spans").all();
    assert.equal(rows.length, 3, "Should have flushed all 3 spans");

    exporter.shutdown();
  });

  test("shutdown flushes remaining buffer", () => {
    const db = openMemoryDb();
    const exporter = new DbSpanExporter(db, { flushThreshold: 100, flushIntervalMs: 999_999 });

    exporter.export([fakeReadableSpan({ name: "buffered.span" }) as any], () => {});
    let rows = db.prepare("SELECT * FROM spans").all();
    assert.equal(rows.length, 0, "Should be buffered");

    exporter.shutdown();
    rows = db.prepare("SELECT * FROM spans").all();
    assert.equal(rows.length, 1, "Shutdown should flush");
    assert.equal(rows[0]["name"], "buffered.span");
  });

  test("records error status from span", () => {
    const db = openMemoryDb();
    const exporter = new DbSpanExporter(db, { flushThreshold: 1, flushIntervalMs: 999_999 });

    const span = fakeReadableSpan({
      name: "gsd.error.span",
      status: { code: 2, message: "something broke" }, // ERROR
    });
    exporter.export([span as any], () => {});

    const rows = db.prepare("SELECT * FROM spans").all();
    assert.equal(rows[0]["status"], "error");

    exporter.shutdown();
  });

  test("denormalizes unit_type and unit_id from attributes", () => {
    const db = openMemoryDb();
    const exporter = new DbSpanExporter(db, { flushThreshold: 1, flushIntervalMs: 999_999 });

    const span = fakeReadableSpan({
      name: "gsd.unit.model_selection",
      attributes: {
        [GSD.UNIT_TYPE]: "execute-task",
        [GSD.UNIT_ID]: "M001-S02-T003",
        [GSD.MODEL_CONFIGURED]: "claude-opus-4-6",
      },
    });
    exporter.export([span as any], () => {});

    const rows = db.prepare("SELECT * FROM spans").all();
    assert.equal(rows[0]["unit_type"], "execute-task");
    assert.equal(rows[0]["unit_id"], "M001-S02-T003");

    // Attributes are stored as nested JSON for json_extract compatibility
    const nestedAttrs = JSON.parse(rows[0]["attributes"] as string);
    assert.equal(nestedAttrs?.gsd?.model?.configured, "claude-opus-4-6");

    // json_extract should work on the nested structure
    const extracted = db.prepare(
      "SELECT json_extract(attributes, '$.gsd.model.configured') as v FROM spans",
    ).get();
    assert.equal(extracted?.["v"], "claude-opus-4-6");

    exporter.shutdown();
  });

  test("records parent span ID", () => {
    const db = openMemoryDb();
    const exporter = new DbSpanExporter(db, { flushThreshold: 10, flushIntervalMs: 999_999 });

    const parentSpan = fakeReadableSpan({
      traceId: "trace00001111222233334444",
      spanId: "parentspan00001",
      name: "gsd.auto.iteration",
    });
    const childSpan = fakeReadableSpan({
      traceId: "trace00001111222233334444",
      spanId: "childspan000001",
      parentSpanId: "parentspan00001",
      name: "gsd.pre_dispatch",
    });

    exporter.export([parentSpan as any, childSpan as any], () => {});
    exporter.shutdown();

    const rows = db.prepare("SELECT * FROM spans ORDER BY name").all();
    assert.equal(rows.length, 2);

    const parent = rows.find(r => r["name"] === "gsd.auto.iteration")!;
    const child = rows.find(r => r["name"] === "gsd.pre_dispatch")!;

    assert.equal(parent["parent_span_id"], null);
    assert.equal(child["parent_span_id"], "parentspan00001");
    assert.equal(child["trace_id"], parent["trace_id"]);

    exporter.shutdown();
  });

  test("INSERT OR IGNORE prevents duplicate span_ids", () => {
    const db = openMemoryDb();
    const exporter = new DbSpanExporter(db, { flushThreshold: 1, flushIntervalMs: 999_999 });

    const span = fakeReadableSpan({ spanId: "duplicate00001", name: "first" });
    exporter.export([span as any], () => {});

    // Export same span ID again with different name
    const dup = fakeReadableSpan({ spanId: "duplicate00001", name: "second" });
    exporter.export([dup as any], () => {});

    const rows = db.prepare("SELECT * FROM spans").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]["name"], "first"); // First write wins

    exporter.shutdown();
  });
});

// ─── Schema ─────────────────────────────────────────────────────────────────

describe("spans table schema", () => {
  test("hasSpansTable returns true after openDatabase", () => {
    openMemoryDb();
    assert.equal(hasSpansTable(), true);
  });

  test("spans table has expected indexes", () => {
    const db = openMemoryDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='spans'",
    ).all();
    const indexNames = indexes.map(r => r["name"] as string);

    assert.ok(indexNames.includes("idx_spans_trace"));
    assert.ok(indexNames.includes("idx_spans_name"));
    assert.ok(indexNames.includes("idx_spans_time"));
    assert.ok(indexNames.includes("idx_spans_unit"));
  });

  test("schema version is 15", () => {
    const db = openMemoryDb();
    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get();
    assert.equal(row?.["v"], 15);
  });
});

// ─── Query API ──────────────────────────────────────────────────────────────

describe("query API", () => {
  test("querySpans returns spans matching name", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, { trace_id: "t1", span_id: "s1", name: "gsd.unit.model_selection", start_time: now });
    insertSpan(db, { trace_id: "t1", span_id: "s2", name: "gsd.guards", start_time: now });
    insertSpan(db, { trace_id: "t1", span_id: "s3", name: "gsd.unit.execute", start_time: now });

    const results = querySpans(db, { spanName: "gsd.unit.model_selection" });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "gsd.unit.model_selection");
  });

  test("querySpans supports glob pattern with *", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, { trace_id: "t1", span_id: "s1", name: "gsd.unit.model_selection", start_time: now });
    insertSpan(db, { trace_id: "t1", span_id: "s2", name: "gsd.unit.execute", start_time: now });
    insertSpan(db, { trace_id: "t1", span_id: "s3", name: "gsd.guards", start_time: now });

    const results = querySpans(db, { spanName: "gsd.unit.*" });
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.name.startsWith("gsd.unit.")));
  });

  test("querySpans filters by unit_type and unit_id", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, { trace_id: "t1", span_id: "s1", name: "gsd.unit", unit_type: "execute-task", unit_id: "T001", start_time: now });
    insertSpan(db, { trace_id: "t1", span_id: "s2", name: "gsd.unit", unit_type: "plan-slice", unit_id: "S01", start_time: now });

    const results = querySpans(db, { unitType: "execute-task" });
    assert.equal(results.length, 1);
    assert.equal(results[0].unit_id, "T001");

    const byId = querySpans(db, { unitId: "S01" });
    assert.equal(byId.length, 1);
    assert.equal(byId[0].unit_type, "plan-slice");
  });

  test("querySpans filters by time window", () => {
    const db = openMemoryDb();
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const twoHoursAgo = now - 7_200_000;

    insertSpan(db, { trace_id: "t1", span_id: "s1", name: "recent", start_time: now - 1000 });
    insertSpan(db, { trace_id: "t2", span_id: "s2", name: "old", start_time: twoHoursAgo });

    const results = querySpans(db, { since: oneHourAgo });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "recent");
  });

  test("querySpans filters by status", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, { trace_id: "t1", span_id: "s1", name: "ok-span", status: "ok", start_time: now });
    insertSpan(db, { trace_id: "t1", span_id: "s2", name: "err-span", status: "error", start_time: now });

    const errors = querySpans(db, { status: "error" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, "err-span");
  });

  test("querySpans respects limit", () => {
    const db = openMemoryDb();
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      insertSpan(db, { trace_id: "t1", span_id: `s${i}`, name: "gsd.test", start_time: now - i * 100 });
    }

    const results = querySpans(db, { limit: 3 });
    assert.equal(results.length, 3);
  });

  test("querySpans parses JSON attributes correctly", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, {
      trace_id: "t1", span_id: "s1", name: "gsd.model",
      start_time: now,
      attributes: { [GSD.MODEL_CONFIGURED]: "opus", [GSD.MODEL_DOWNGRADED]: true },
    });

    const results = querySpans(db, {});
    assert.equal(results[0].attributes[GSD.MODEL_CONFIGURED], "opus");
    assert.equal(results[0].attributes[GSD.MODEL_DOWNGRADED], true);
  });

  test("getTrace returns all spans for a trace in time order", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, { trace_id: "trace-abc", span_id: "s3", name: "third", start_time: now + 200 });
    insertSpan(db, { trace_id: "trace-abc", span_id: "s1", name: "first", start_time: now });
    insertSpan(db, { trace_id: "trace-abc", span_id: "s2", name: "second", start_time: now + 100 });
    insertSpan(db, { trace_id: "other-trace", span_id: "s4", name: "other", start_time: now });

    const trace = getTrace(db, "trace-abc");
    assert.equal(trace.length, 3);
    assert.equal(trace[0].name, "first");
    assert.equal(trace[1].name, "second");
    assert.equal(trace[2].name, "third");
  });

  test("getTraceByPrefix resolves exact ID", () => {
    const db = openMemoryDb();
    insertSpan(db, { trace_id: "abcdef1234567890abcdef1234567890", span_id: "s1", name: "root" });

    const spans = getTraceByPrefix(db, "abcdef1234567890abcdef1234567890");
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "root");
  });

  test("getTraceByPrefix resolves prefix match", () => {
    const db = openMemoryDb();
    insertSpan(db, { trace_id: "abcdef1234567890abcdef1234567890", span_id: "s1", name: "root" });

    const spans = getTraceByPrefix(db, "abcdef12");
    assert.equal(spans.length, 1);
    assert.equal(spans[0].trace_id, "abcdef1234567890abcdef1234567890");
  });

  test("getTraceByPrefix returns empty for no match", () => {
    const db = openMemoryDb();
    insertSpan(db, { trace_id: "abcdef1234567890abcdef1234567890", span_id: "s1", name: "root" });

    const spans = getTraceByPrefix(db, "zzzzzzz");
    assert.equal(spans.length, 0);
  });

  test("TRACE_ID_MIN_PREFIX_LENGTH is 8", () => {
    assert.equal(TRACE_ID_MIN_PREFIX_LENGTH, 8);
  });

  test("getRecentTraces returns iteration summaries", () => {
    const db = openMemoryDb();
    const now = Date.now();

    // Insert a root iteration span
    insertSpan(db, {
      trace_id: "trace-1",
      span_id: "root-1",
      name: "gsd.auto.iteration",
      start_time: now,
      duration_ms: 5000,
      unit_type: "execute-task",
      unit_id: "M001-S01-T001",
      attributes: { [GSD.LOOP_ITERATION]: 1 },
    });

    // Insert a model selection child span
    insertSpan(db, {
      trace_id: "trace-1",
      span_id: "model-1",
      parent_span_id: "root-1",
      name: "gsd.unit.model_selection",
      start_time: now + 10,
      attributes: {
        [GSD.MODEL_CONFIGURED]: "claude-opus-4-6",
        [GSD.MODEL_RESOLVED]: "anthropic/claude-haiku-4-5",
        [GSD.MODEL_DOWNGRADED]: true,
      },
    });

    const summaries = getRecentTraces(db, 10);
    assert.equal(summaries.length, 1);

    const s = summaries[0];
    assert.equal(s.traceId, "trace-1");
    assert.equal(s.iteration, 1);
    assert.equal(s.unitType, "execute-task");
    assert.equal(s.modelConfigured, "claude-opus-4-6");
    assert.equal(s.modelResolved, "anthropic/claude-haiku-4-5");
    assert.equal(s.modelDowngraded, true);
    assert.equal(s.spanCount, 2);
  });
});

// ─── Formatting ─────────────────────────────────────────────────────────────

describe("trace formatting", () => {
  test("formatTraceTree renders a tree with parent-child structure", () => {
    const now = Date.now();
    const spans: SpanRow[] = [
      {
        trace_id: "t1", span_id: "root", parent_span_id: null,
        name: "gsd.auto.iteration", start_time: now, end_time: now + 5000,
        duration_ms: 5000, status: "ok", unit_type: "execute-task", unit_id: "T001",
        attributes: { [GSD.LOOP_ITERATION]: 7 },
      },
      {
        trace_id: "t1", span_id: "child1", parent_span_id: "root",
        name: "gsd.pre_dispatch", start_time: now + 10, end_time: now + 20,
        duration_ms: 10, status: "ok", unit_type: null, unit_id: null,
        attributes: { [GSD.STATE_PHASE]: "executing" },
      },
      {
        trace_id: "t1", span_id: "child2", parent_span_id: "root",
        name: "gsd.unit.model_selection", start_time: now + 30, end_time: now + 50,
        duration_ms: 20, status: "ok", unit_type: "execute-task", unit_id: "T001",
        attributes: { [GSD.MODEL_CONFIGURED]: "opus", [GSD.MODEL_RESOLVED]: "haiku" },
      },
    ];

    const output = formatTraceTree(spans);

    assert.ok(output.includes("gsd.auto.iteration"), "Root span present");
    assert.ok(output.includes("gsd.pre_dispatch"), "Child 1 present");
    assert.ok(output.includes("gsd.unit.model_selection"), "Child 2 present");
    assert.ok(output.includes("iteration #7"), "Iteration number in header");
    assert.ok(output.includes("├─") || output.includes("└─"), "Tree connectors present");
    assert.ok(output.includes("model.configured=opus"), "Attributes rendered");
  });

  test("formatTraceTree marks error spans", () => {
    const spans: SpanRow[] = [{
      trace_id: "t1", span_id: "s1", parent_span_id: null,
      name: "gsd.guards", start_time: Date.now(), end_time: Date.now() + 100,
      duration_ms: 100, status: "error", unit_type: null, unit_id: null,
      attributes: {},
    }];

    const output = formatTraceTree(spans);
    assert.ok(output.includes("ERROR"), "Error status marked");
  });

  test("formatTraceTree handles empty spans", () => {
    const output = formatTraceTree([]);
    assert.equal(output, "(no spans)");
  });

  test("formatTraceSummaries renders a summary table", () => {
    const summaries: TraceSummary[] = [
      {
        traceId: "aaaa0000bbbb1111cccc2222dddd3333",
        iteration: 42,
        unitType: "execute-task",
        unitId: "M001-S02-T003",
        modelConfigured: "claude-opus-4-6",
        modelResolved: "anthropic/claude-haiku-4-5",
        modelDowngraded: true,
        startTime: Date.now(),
        durationMs: 45200,
        status: "ok",
        spanCount: 8,
      },
    ];

    const output = formatTraceSummaries(summaries);
    assert.ok(output.includes("Recent traces:"));
    assert.ok(output.includes("execute-task"));
    assert.ok(output.includes("haiku-4-5"));
    assert.ok(output.includes("↓")); // downgrade indicator
  });

  test("formatTraceSummaries handles empty list", () => {
    const output = formatTraceSummaries([]);
    assert.ok(output.includes("No traces found"));
  });
});

// ─── parseTimeWindow ────────────────────────────────────────────────────────

describe("parseTimeWindow", () => {
  test("parses minute windows", () => {
    const before = Date.now();
    const result = parseTimeWindow("30m");
    const expected = before - 30 * 60_000;
    assert.ok(Math.abs(result - expected) < 100, `Expected ~${expected}, got ${result}`);
  });

  test("parses hour windows", () => {
    const before = Date.now();
    const result = parseTimeWindow("2h");
    const expected = before - 2 * 3_600_000;
    assert.ok(Math.abs(result - expected) < 100);
  });

  test("parses day windows", () => {
    const before = Date.now();
    const result = parseTimeWindow("7d");
    const expected = before - 7 * 86_400_000;
    assert.ok(Math.abs(result - expected) < 100);
  });

  test("parses ISO dates", () => {
    const result = parseTimeWindow("2026-01-15T10:00:00Z");
    const expected = new Date("2026-01-15T10:00:00Z").getTime();
    assert.equal(result, expected);
  });

  test("defaults to 1 hour for unparseable input", () => {
    const before = Date.now();
    const result = parseTimeWindow("garbage");
    const expected = before - 3_600_000;
    assert.ok(Math.abs(result - expected) < 100);
  });
});

// ─── Shortcut Queries ───────────────────────────────────────────────────────

describe("shortcutToQuery", () => {
  test("model-decisions queries model_selection spans", () => {
    const q = shortcutToQuery("model-decisions");
    assert.equal(q.spanName, "gsd.unit.model_selection");
    assert.ok(q.since! > 0);
    assert.equal(q.limit, 20);
  });

  test("why-stopped queries iteration spans", () => {
    const q = shortcutToQuery("why-stopped");
    assert.equal(q.spanName, "gsd.auto.iteration");
  });

  test("errors queries error status", () => {
    const q = shortcutToQuery("errors");
    assert.equal(q.status, "error");
  });

  test("guards queries guard spans", () => {
    const q = shortcutToQuery("guards");
    assert.equal(q.spanName, "gsd.guards");
  });

  test("respects custom since parameter", () => {
    const since = Date.now() - 7_200_000;
    const q = shortcutToQuery("recent", since);
    assert.equal(q.since, since);
  });
});

// ─── Doctor Trace Checks ────────────────────────────────────────────────────

describe("doctor trace checks", () => {
  test("detects model downgrades", () => {
    const db = openMemoryDb();
    const now = Date.now();

    // Insert model selection spans with downgrades
    for (let i = 0; i < 3; i++) {
      insertSpan(db, {
        trace_id: `t${i}`, span_id: `s${i}`,
        name: "gsd.unit.model_selection",
        start_time: now - i * 1000,
        unit_type: "execute-task",
        attributes: {
          [GSD.MODEL_CONFIGURED]: "claude-opus-4-6",
          [GSD.MODEL_RESOLVED]: "claude-haiku-4-5",
          [GSD.MODEL_DOWNGRADED]: true,
          [GSD.COMPLEXITY_TIER]: "light",
          [GSD.COMPLEXITY_REASON]: "small task",
        },
      });
    }

    const issues = runTraceChecks(db);
    const downgradeIssue = issues.find(i => i.code === "trace_model_downgrade");
    assert.ok(downgradeIssue, "Should detect model downgrades");
    assert.ok(downgradeIssue.message.includes("3 time(s)"));
    assert.ok(downgradeIssue.message.includes("claude-opus-4-6"));
    assert.ok(downgradeIssue.message.includes("claude-haiku-4-5"));
  });

  test("does not flag when no downgrades", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, {
      trace_id: "t1", span_id: "s1",
      name: "gsd.unit.model_selection",
      start_time: now,
      attributes: {
        [GSD.MODEL_CONFIGURED]: "claude-opus-4-6",
        [GSD.MODEL_RESOLVED]: "claude-opus-4-6",
        [GSD.MODEL_DOWNGRADED]: false,
      },
    });

    const issues = runTraceChecks(db);
    assert.ok(!issues.some(i => i.code === "trace_model_downgrade"));
  });

  test("detects repeated dispatch (stuck loop)", () => {
    const db = openMemoryDb();
    const now = Date.now();

    // Same unit dispatched 5 times
    for (let i = 0; i < 5; i++) {
      insertSpan(db, {
        trace_id: `t${i}`, span_id: `s${i}`,
        name: "gsd.auto.iteration",
        start_time: now - i * 1000,
        unit_type: "execute-task",
        unit_id: "M001-S01-T001",
      });
    }

    const issues = runTraceChecks(db);
    const stuckIssue = issues.find(i => i.code === "trace_repeated_dispatch");
    assert.ok(stuckIssue, "Should detect repeated dispatch");
    assert.ok(stuckIssue.message.includes("5 times"));
    assert.equal(stuckIssue.unitId, "M001-S01-T001");
  });

  test("does not flag normal dispatch counts", () => {
    const db = openMemoryDb();
    const now = Date.now();

    // 3 different units dispatched once each
    insertSpan(db, { trace_id: "t1", span_id: "s1", name: "gsd.auto.iteration", start_time: now, unit_type: "plan-slice", unit_id: "S01" });
    insertSpan(db, { trace_id: "t2", span_id: "s2", name: "gsd.auto.iteration", start_time: now, unit_type: "execute-task", unit_id: "T001" });
    insertSpan(db, { trace_id: "t3", span_id: "s3", name: "gsd.auto.iteration", start_time: now, unit_type: "complete-slice", unit_id: "S01" });

    const issues = runTraceChecks(db);
    assert.ok(!issues.some(i => i.code === "trace_repeated_dispatch"));
  });

  test("detects guard blocking", () => {
    const db = openMemoryDb();
    const now = Date.now();

    // Budget guard blocking 4 times
    for (let i = 0; i < 4; i++) {
      insertSpan(db, {
        trace_id: `t${i}`, span_id: `s${i}`,
        name: "gsd.guards",
        status: "error",
        start_time: now - i * 1000,
        attributes: { [GSD.GUARD_NAME]: "budget" },
      });
    }

    const issues = runTraceChecks(db);
    const guardIssue = issues.find(i => i.code === "trace_guard_blocking");
    assert.ok(guardIssue, "Should detect guard blocking");
    assert.ok(guardIssue.message.includes("4 times"));
  });

  test("detects fallback chain exhaustion", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, {
      trace_id: "t1", span_id: "s1",
      name: "gsd.unit.model_selection",
      start_time: now,
      unit_type: "execute-task",
      attributes: {
        [GSD.MODEL_CONFIGURED]: "claude-opus-4-6",
        [GSD.MODEL_RESOLVED]: "none",
      },
    });

    const issues = runTraceChecks(db);
    const fallbackIssue = issues.find(i => i.code === "trace_fallback_chain_exhausted");
    assert.ok(fallbackIssue, "Should detect fallback exhaustion");
    assert.equal(fallbackIssue.severity, "error");
  });

  test("detects undersized context", () => {
    const db = openMemoryDb();
    const now = Date.now();

    insertSpan(db, {
      trace_id: "t1", span_id: "s1",
      name: "gsd.unit.context_assembly",
      start_time: now,
      attributes: {
        [GSD.CONTEXT_PROMPT_CHARS]: 200,
        [GSD.CONTEXT_KNOWLEDGE]: 0,
        [GSD.CONTEXT_CODEBASE]: 0,
      },
    });

    const issues = runTraceChecks(db);
    const ctxIssue = issues.find(i => i.code === "trace_context_undersized");
    assert.ok(ctxIssue, "Should detect undersized context");
    assert.equal(ctxIssue.severity, "info");
  });

  test("respects custom time window", () => {
    const db = openMemoryDb();
    const now = Date.now();
    const twoHoursAgo = now - 7_200_000;

    // Insert an old downgrade (2 hours ago)
    insertSpan(db, {
      trace_id: "t1", span_id: "s1",
      name: "gsd.unit.model_selection",
      start_time: twoHoursAgo,
      attributes: { [GSD.MODEL_DOWNGRADED]: true },
    });

    // Default window (1h) should miss it
    const issues = runTraceChecks(db);
    assert.ok(!issues.some(i => i.code === "trace_model_downgrade"), "Default 1h window should miss old span");

    // Explicit 3h window should catch it
    const widerIssues = runTraceChecks(db, { traceWindowMs: 3 * 3_600_000 });
    assert.ok(widerIssues.some(i => i.code === "trace_model_downgrade"), "3h window should catch old span");
  });

  test("returns empty array when no spans exist", () => {
    const db = openMemoryDb();
    const issues = runTraceChecks(db);
    assert.deepStrictEqual(issues, []);
  });

  test("detects CWD / worktree path mismatch", () => {
    const db = openMemoryDb();

    // Iteration where cwd doesn't match worktree path — wrong directory
    insertSpan(db, {
      trace_id: "t1", span_id: "s1",
      name: "gsd.auto.iteration",
      attributes: {
        [GSD.LOOP_ITERATION]: 1,
        [GSD.CWD]: "/projects/myrepo",
        [GSD.WORKTREE_PATH]: "/projects/myrepo/.worktrees/milestone-42",
      },
    });

    const issues = runTraceChecks(db);
    const mismatch = issues.find(i => i.code === "trace_cwd_mismatch");
    assert.ok(mismatch, "Should detect cwd mismatch");
    assert.ok(mismatch.message.includes("/projects/myrepo"));
    assert.ok(mismatch.message.includes("milestone-42"));
  });

  test("no cwd mismatch when cwd matches worktree path", () => {
    const db = openMemoryDb();

    insertSpan(db, {
      trace_id: "t1", span_id: "s1",
      name: "gsd.auto.iteration",
      attributes: {
        [GSD.LOOP_ITERATION]: 1,
        [GSD.CWD]: "/projects/myrepo/.worktrees/milestone-42",
        [GSD.WORKTREE_PATH]: "/projects/myrepo/.worktrees/milestone-42",
      },
    });

    const issues = runTraceChecks(db);
    assert.ok(!issues.some(i => i.code === "trace_cwd_mismatch"));
  });

  test("no cwd mismatch when no worktree is active", () => {
    const db = openMemoryDb();

    insertSpan(db, {
      trace_id: "t1", span_id: "s1",
      name: "gsd.auto.iteration",
      attributes: {
        [GSD.LOOP_ITERATION]: 1,
        [GSD.CWD]: "/projects/myrepo",
        [GSD.WORKTREE_PATH]: "",
      },
    });

    const issues = runTraceChecks(db);
    assert.ok(!issues.some(i => i.code === "trace_cwd_mismatch"));
  });
});

// ─── Semantic Attributes ────────────────────────────────────────────────────

describe("GSD semantic attributes", () => {
  test("all attribute keys follow gsd.* naming convention", () => {
    for (const [key, value] of Object.entries(GSD)) {
      assert.ok(
        (value as string).startsWith("gsd."),
        `Attribute ${key} = "${value}" should start with "gsd."`,
      );
    }
  });

  test("no duplicate attribute values", () => {
    const values = Object.values(GSD);
    const unique = new Set(values);
    assert.equal(values.length, unique.size, "Duplicate attribute values found");
  });

  test("GSDAttributeKey type covers all values", () => {
    // This is a compile-time check — if it compiles, the type is correct.
    // We just verify the runtime shape matches.
    const keys: GSDAttributeKey[] = Object.values(GSD);
    assert.ok(keys.length > 0);
  });

  test("key subsystems are represented", () => {
    const values = Object.values(GSD);
    const prefixes = new Set(values.map(v => v.split(".").slice(0, 2).join(".")));

    assert.ok(prefixes.has("gsd.loop"), "Loop lifecycle attributes");
    assert.ok(prefixes.has("gsd.state"), "State derivation attributes");
    assert.ok(prefixes.has("gsd.dispatch"), "Dispatch attributes");
    assert.ok(prefixes.has("gsd.guard") || prefixes.has("gsd.budget"), "Guard attributes");
    assert.ok(prefixes.has("gsd.model"), "Model selection attributes");
    assert.ok(prefixes.has("gsd.context"), "Context assembly attributes");
    assert.ok(prefixes.has("gsd.worktree"), "Worktree attributes");
    assert.ok(prefixes.has("gsd.unit"), "Unit execution attributes");
  });
});

// ─── Retention (pruneOldSpans) ──────────────────────────────────────────────

describe("span retention", () => {
  test("pruneOldSpans removes old spans", async () => {
    // Import inline to avoid circular deps in test setup
    const { pruneOldSpans } = await import("../gsd-db.ts");

    const db = openMemoryDb();
    const now = Date.now();
    const eightDaysAgo = now - 8 * 86_400_000;

    insertSpan(db, { trace_id: "old", span_id: "s1", name: "old.span", start_time: eightDaysAgo });
    insertSpan(db, { trace_id: "new", span_id: "s2", name: "new.span", start_time: now });

    const deleted = pruneOldSpans(7);
    assert.equal(deleted, 1);

    const remaining = db.prepare("SELECT * FROM spans").all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]["name"], "new.span");
  });

  test("pruneOldSpans enforces row cap", async () => {
    const { pruneOldSpans } = await import("../gsd-db.ts");

    const db = openMemoryDb();
    const now = Date.now();

    // Insert 15 recent spans, set cap to 10
    for (let i = 0; i < 15; i++) {
      insertSpan(db, {
        trace_id: `t${i}`, span_id: `s${i}`,
        name: "gsd.test", start_time: now - i * 100,
      });
    }

    const deleted = pruneOldSpans(7, 10);
    // 0 expired by time, but 15 > 10 cap → should prune 20% of 15 = 3
    assert.ok(deleted >= 3, `Expected at least 3 pruned, got ${deleted}`);

    const remaining = db.prepare("SELECT count(*) as cnt FROM spans").get();
    assert.ok((remaining?.["cnt"] as number) <= 12);
  });
});
