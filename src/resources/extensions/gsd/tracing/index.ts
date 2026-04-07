/**
 * GSD Tracing — public API (#3732).
 *
 * Usage:
 *   import { initTracing, shutdownTracing, gsdTracer, GSD, withSpan } from "./tracing/index.js";
 *
 *   // At startup (after DB open):
 *   initTracing(db);
 *
 *   // In any module — preferred pattern for context propagation:
 *   return withSpan("gsd.dispatch.resolve", async (span) => {
 *     span.setAttribute(GSD.DISPATCH_RULE, ruleName);
 *     // ... logic — child spans automatically become children ...
 *     return result;
 *   });
 *
 *   // At shutdown:
 *   await shutdownTracing();
 */

import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";

// Re-export lifecycle functions
export { initTracing, shutdownTracing, isTracingInitialized } from "./provider.js";
export type { TracingOptions } from "./provider.js";

// Re-export semantic attributes
export { GSD } from "./attributes.js";
export type { GSDAttributeKey } from "./attributes.js";

// Re-export exporter for testing
export { DbSpanExporter } from "./exporter.js";

// Re-export SpanStatusCode for instrumented modules
export { SpanStatusCode };

/**
 * Get the GSD tracer instance.
 *
 * Returns a no-op tracer if tracing hasn't been initialized — safe to call
 * unconditionally. OTel's global API handles the no-op fallback internally.
 */
export function gsdTracer() {
  return trace.getTracer("gsd");
}

/**
 * Execute `fn` within a new active span. The span is automatically set as the
 * active context, so any child spans created inside `fn` will be linked as
 * children. The span is ended when `fn` completes (or throws).
 *
 * This is the preferred instrumentation pattern — it handles:
 * - Context propagation (parent-child span linking)
 * - Span lifecycle (end on completion or error)
 * - Error recording (sets ERROR status on throw)
 */
export function withSpan<T>(name: string, fn: (span: Span) => T): T {
  const parentCtx = context.active();
  const span = gsdTracer().startSpan(name, undefined, parentCtx);
  const childCtx = trace.setSpan(parentCtx, span);

  return context.with(childCtx, () => {
    try {
      const result = fn(span);
      // Handle async functions
      if (result instanceof Promise) {
        return result.then(
          (v) => { span.end(); return v; },
          (e) => {
            span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
            span.end();
            throw e;
          },
        ) as T;
      }
      span.end();
      return result;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      span.end();
      throw e;
    }
  });
}

/**
 * Create a span that is a child of the current active context, but does NOT
 * automatically end. Use this for cases where you need manual control over
 * the span lifecycle (e.g., loop iterations with break/continue).
 *
 * The span IS set as the active context within the returned scope function.
 * Call `scope(fn)` to execute code within this span's context.
 */
export function startActiveScope(name: string): {
  span: Span;
  scope: <T>(fn: () => T) => T;
} {
  const parentCtx = context.active();
  const span = gsdTracer().startSpan(name, undefined, parentCtx);
  const childCtx = trace.setSpan(parentCtx, span);

  return {
    span,
    scope: <T>(fn: () => T): T => context.with(childCtx, fn),
  };
}
