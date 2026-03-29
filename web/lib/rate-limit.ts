// ---------------------------------------------------------------------------
// In-memory IP rate limiter for the login endpoint
// ---------------------------------------------------------------------------
// Counts all login attempts per IP. Blocks on the 6th attempt within a
// 60-second window. Returns resetAt so clients can show a countdown.
// ---------------------------------------------------------------------------

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const loginAttempts = new Map<string, RateLimitRecord>();

/**
 * Check whether an IP address is allowed to attempt a login.
 * Call on every login attempt (success or failure).
 * Returns { allowed, resetAt } where resetAt is the epoch ms when the window resets.
 */
export function checkRateLimit(ip: string): { allowed: boolean; resetAt: number } {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    // New window
    const resetAt = now + 60_000;
    loginAttempts.set(ip, { count: 1, resetAt });
    return { allowed: true, resetAt };
  }

  if (record.count >= 5) {
    return { allowed: false, resetAt: record.resetAt };
  }

  record.count++;
  return { allowed: true, resetAt: record.resetAt };
}

/**
 * @internal test-only — clears all rate limit state between tests.
 * Do not use in production code.
 */
export function _testResetRateLimits(): void {
  loginAttempts.clear();
}
