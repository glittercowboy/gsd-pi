/**
 * auto/infra-errors.ts — Infrastructure error detection.
 *
 * Leaf module with zero transitive dependencies. Used by the auto-loop catch
 * block to distinguish unrecoverable OS/filesystem errors from transient
 * failures that merit retry.
 */

/**
 * Error codes indicating infrastructure failures that cannot be recovered by
 * retrying. Each retry re-dispatches the unit at full LLM cost, so we bail
 * immediately rather than burning budget on guaranteed failures.
 */
export const INFRA_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOSPC",   // disk full
  "ENOMEM",   // out of memory
  "EROFS",    // read-only file system
  "EDQUOT",   // disk quota exceeded
  "EMFILE",   // too many open files (process)
  "ENFILE",   // too many open files (system)
  "EAGAIN",       // resource temporarily unavailable (resource exhaustion)
  "ECONNREFUSED", // connection refused (offline / local server down)
  "ENOTFOUND",    // DNS lookup failed (offline / no network)
  "ENETUNREACH",  // network unreachable (offline / no route)
]);

/**
 * Detect whether an error is an unrecoverable infrastructure failure.
 * Checks the `code` property (Node system errors) and falls back to
 * scanning the message string for known error code tokens.
 *
 * Returns the matched code string, or null if the error is not an
 * infrastructure failure.
 */
export function isInfrastructureError(err: unknown): string | null {
  if (err && typeof err === "object") {
    const code = (err as Record<string, unknown>).code;
    if (typeof code === "string" && INFRA_ERROR_CODES.has(code)) return code;
  }
  const msg = err instanceof Error ? err.message : String(err);
  for (const code of INFRA_ERROR_CODES) {
    if (msg.includes(code)) return code;
  }
  return null;
}
