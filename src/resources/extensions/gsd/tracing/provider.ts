/**
 * OTel TracerProvider setup for GSD (#3732).
 *
 * Registers a BasicTracerProvider with a SimpleSpanProcessor that feeds
 * completed spans to the DbSpanExporter (→ gsd.db spans table).
 *
 * Lifecycle:
 *   initTracing(db)   — called once in auto-start after DB open
 *   shutdownTracing() — called on auto-mode stop (flushes remaining spans)
 */

import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { DbSpanExporter } from "./exporter.js";
import type { DbAdapter } from "../gsd-db.js";

let provider: BasicTracerProvider | null = null;

export interface TracingOptions {
  serviceName?: string;
  serviceVersion?: string;
  flushThreshold?: number;
  flushIntervalMs?: number;
}

/**
 * Initialize the OTel tracing pipeline.
 * Idempotent — calling twice is a no-op.
 */
export function initTracing(db: DbAdapter, opts?: TracingOptions): void {
  if (provider) return;

  const resource = resourceFromAttributes({
    "service.name": opts?.serviceName ?? "gsd",
    "service.version": opts?.serviceVersion ?? "unknown",
  });

  const exporter = new DbSpanExporter(db, {
    flushThreshold: opts?.flushThreshold,
    flushIntervalMs: opts?.flushIntervalMs,
  });

  provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  trace.setGlobalTracerProvider(provider);
}

/**
 * Flush remaining spans and deregister the provider.
 * Safe to call even if tracing was never initialized.
 */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  const p = provider;
  provider = null;
  trace.disable();
  await p.shutdown();
}

/** Check if tracing has been initialized. */
export function isTracingInitialized(): boolean {
  return provider !== null;
}
