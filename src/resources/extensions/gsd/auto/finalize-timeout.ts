/**
 * auto/finalize-timeout.ts — Timeout guard for post-unit finalization.
 *
 * Prevents the auto-loop from hanging indefinitely when
 * postUnitPostVerification() never resolves (#2344).
 *
 * Leaf module — no imports from auto/ to avoid circular dependencies.
 */

/** Timeout for postUnitPreVerification in runFinalize (ms). */
export const FINALIZE_PRE_TIMEOUT_MS = 60_000;

/** Timeout for postUnitPostVerification in runFinalize (ms). */
export const FINALIZE_POST_TIMEOUT_MS = 60_000;

/**
 * Race a promise against a timeout. Returns an object indicating whether
 * the timeout fired and the resolved value (if any).
 *
 * Unlike Promise.race with a rejection, this returns a discriminated
 * result so callers can handle timeouts as a recoverable condition
 * rather than an exception.
 *
 * The timeout timer is always cleaned up, whether the promise resolves
 * or the timeout fires.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<{ value: T; timedOut: false } | { value: undefined; timedOut: true }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<{ value: undefined; timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ value: undefined, timedOut: true });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      promise.then((value) => ({ value, timedOut: false as const })),
      timeoutPromise,
    ]);
    return result;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
