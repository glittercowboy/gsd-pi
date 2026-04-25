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
  // SQLite WAL corruption is not transient — retrying burns LLM budget
  // for guaranteed failures (#2823).
  if (msg.includes("database disk image is malformed")) return "SQLITE_CORRUPT";
  return null;
}

/**
 * Default wait duration when a cooldown error is detected but no specific
 * expiry is available from AuthStorage (e.g., error propagated across
 * process boundary without structured backoff data).
 */
export const COOLDOWN_FALLBACK_WAIT_MS = 35_000; // 35s — slightly longer than the 30s rate-limit backoff

/** Maximum consecutive cooldown retries before the auto-loop gives up. */
export const MAX_COOLDOWN_RETRIES = 5;

/**
 * Detect whether an error is a transient credential cooldown that should
 * be waited out rather than counted as a consecutive failure.
 *
 * Prefers the structured `CredentialCooldownError` (code: AUTH_COOLDOWN)
 * thrown by sdk.ts. Falls back to message matching for errors that
 * propagated across process boundaries without the typed class.
 */
export function isTransientCooldownError(err: unknown): boolean {
  if (err && typeof err === "object" && (err as Record<string, unknown>).code === "AUTH_COOLDOWN") {
    return true;
  }
  // Fallback: message match for cross-process error propagation
  const msg = err instanceof Error ? err.message : String(err);
  return /in a cooldown window/i.test(msg);
}

/**
 * Extract retryAfterMs from a CredentialCooldownError, if available.
 * Returns undefined for unstructured errors or when no retry hint exists.
 */
export function getCooldownRetryAfterMs(err: unknown): number | undefined {
  if (err && typeof err === "object" && (err as Record<string, unknown>).code === "AUTH_COOLDOWN") {
    return (err as Record<string, unknown>).retryAfterMs as number | undefined;
  }
  return undefined;
}
