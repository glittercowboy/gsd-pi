/**
 * DbSpanExporter — writes OTel spans to the gsd.db `spans` table (#3732).
 *
 * Buffers completed spans and flushes on threshold or timer.
 * Silently drops spans if DB is unavailable — tracing must never crash GSD.
 */

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import type { DbAdapter } from "../gsd-db.js";

/** Convert OTel HrTime [seconds, nanoseconds] to epoch milliseconds. */
function hrTimeToMs(hrTime: readonly [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

/**
 * Convert a flat OTel attribute map (dotted keys) to a nested object.
 * e.g. {"gsd.model.configured": "opus"} → {gsd: {model: {configured: "opus"}}}
 *
 * SQLite's json_extract uses dots as path separators, so nested structure
 * is required for queries like json_extract(attributes, '$.gsd.model.configured').
 */
export function flatToNested(attrs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const parts = key.split(".");
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current) || typeof current[parts[i]] !== "object" || current[parts[i]] === null) {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

export class DbSpanExporter implements SpanExporter {
  private buffer: ReadableSpan[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushThreshold: number;
  private readonly db: DbAdapter;

  constructor(
    db: DbAdapter,
    opts?: { flushThreshold?: number; flushIntervalMs?: number },
  ) {
    this.db = db;
    this.flushThreshold = opts?.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    const intervalMs = opts?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.timer = setInterval(() => this.flush(), intervalMs);
    // Don't keep the process alive just for span flushing
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.buffer.push(...spans);
    if (this.buffer.length >= this.flushThreshold) {
      this.flush();
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    this.flush();
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    return Promise.resolve();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);

    try {
      this.db.exec("BEGIN");
      try {
        const stmt = this.db.prepare(`
          INSERT OR IGNORE INTO spans
            (trace_id, span_id, parent_span_id, name, start_time, end_time,
             duration_ms, status, unit_type, unit_id, attributes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const span of batch) {
          const spanCtx = span.spanContext();
          const attrs = span.attributes;
          const startMs = Math.round(hrTimeToMs(span.startTime));
          const endMs = span.ended ? Math.round(hrTimeToMs(span.endTime)) : null;
          const durationMs = endMs !== null ? endMs - startMs : null;

          // Status code: 0=UNSET, 1=OK, 2=ERROR (OTel SpanStatusCode)
          const status = span.status.code === 2 ? "error" : "ok";

          // Denormalized unit columns — pull from well-known attribute keys
          const unitType = (attrs["gsd.unit.type"] ?? attrs["gsd.dispatch.unit_type"] ?? null) as string | null;
          const unitId = (attrs["gsd.unit.id"] ?? attrs["gsd.dispatch.unit_id"] ?? null) as string | null;

          stmt.run(
            spanCtx.traceId,
            spanCtx.spanId,
            span.parentSpanContext?.spanId ?? null,
            span.name,
            startMs,
            endMs,
            durationMs,
            status,
            unitType,
            unitId,
            JSON.stringify(flatToNested(attrs as Record<string, unknown>)),
          );
        }
        this.db.exec("COMMIT");
      } catch {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore rollback failure */ }
      }
    } catch {
      // Silently drop — tracing must never crash GSD
    }
  }
}
