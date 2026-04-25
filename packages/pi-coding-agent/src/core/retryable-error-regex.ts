/**
 * Regex matching retryable provider errors — overloaded, rate limits, transient
 * server/connection failures, credential-backoff, quota/credit issues.
 *
 * Kept in its own zero-import module so tests can consume the live pattern
 * without pulling in the full RetryHandler dependency graph (Agent /
 * FallbackResolver / ModelRegistry / @gsd/pi-ai …). The test in
 * `src/resources/extensions/gsd/tests/provider-errors.test.ts` previously
 * redefined this regex inline, which meant runtime and test could drift
 * silently on every edit (see #4837).
 *
 * "temporarily backed off" is intentionally excluded: it is an internally-
 * generated error from getApiKey() when credentials are in a backoff window.
 * Re-entering the retry handler for that message creates a cascade of empty
 * error entries in the session file, breaking resume (#3429).
 */
export const RETRYABLE_ERROR_RE =
	/overloaded|rate.?limit|too many requests|402|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay|network.?(?:is\s+)?unavailable|credentials.*expired|requires more credits|can only afford|insufficient credits|not enough credits|extra usage is required|(?:out of|no) extra usage|third.party.*draw from extra|third.party.*not.*available/i;
