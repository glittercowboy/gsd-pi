/**
 * Shared retry, sleep, and error detection utilities for AI providers.
 *
 * Consolidates duplicated helpers from anthropic.ts, google-gemini-cli.ts,
 * and openai-codex-responses.ts into a single module.
 */

/**
 * Sleep for a given number of milliseconds, respecting abort signal.
 * Rejects immediately if the signal is already aborted, and cleans up
 * the timer if the signal fires while sleeping.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

/**
 * Check if an HTTP error is retryable (rate limit, server error, or known
 * transient error patterns in the response text).
 *
 * Covers patterns from Google Gemini CLI (resource exhausted, other side closed)
 * and OpenAI Codex (upstream connect, connection refused).
 */
export function isRetryableError(status: number, errorText = ""): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed|upstream.?connect|connection.?refused/i.test(
		errorText,
	);
}

/**
 * Detect transient network errors that are likely to succeed on retry.
 * Covers WebSocket disconnects (Tailscale, VPN), TCP resets, and DNS failures.
 */
export function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	const code = (error as NodeJS.ErrnoException).code;
	return (
		code === "ECONNRESET" ||
		code === "EPIPE" ||
		code === "ETIMEDOUT" ||
		code === "ENOTFOUND" ||
		code === "EAI_AGAIN" ||
		msg.includes("connector_closed") ||
		msg.includes("socket hang up") ||
		msg.includes("network") ||
		(msg.includes("connection") && msg.includes("closed")) ||
		msg.includes("fetch failed")
	);
}

/**
 * Extract retry delay from HTTP error response headers and/or body text (in milliseconds).
 *
 * Checks headers (in order):
 * - `retry-after` (seconds or RFC 7231 date)
 * - `x-ratelimit-reset` (Unix timestamp in seconds)
 * - `x-ratelimit-reset-after` (relative seconds)
 * - `x-ratelimit-reset-requests` (Unix timestamp in seconds)
 * - `x-ratelimit-reset-tokens` (Unix timestamp in seconds)
 *
 * Then parses body text patterns:
 * - "Your quota will reset after 18h31m10s"
 * - "Please retry in Xs" or "Please retry in Xms"
 * - "retryDelay": "34.074824224s" (JSON field in error details)
 *
 * Returns `undefined` if no valid delay is found or if the computed delay is not positive.
 * Adds a 1-second buffer to all returned delays.
 */
export function extractRetryDelayMs(
	headers?: Headers | { get(name: string): string | null } | null,
	errorText = "",
): number | undefined {
	const normalizeDelay = (ms: number): number | undefined => (ms > 0 ? Math.ceil(ms + 1000) : undefined);

	if (headers) {
		// retry-after: seconds or RFC 7231 date
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const retryAfterSeconds = Number(retryAfter);
			if (Number.isFinite(retryAfterSeconds)) {
				const delay = normalizeDelay(retryAfterSeconds * 1000);
				if (delay !== undefined) return delay;
			}
			const retryAfterDate = new Date(retryAfter);
			const retryAfterMs = retryAfterDate.getTime();
			if (!Number.isNaN(retryAfterMs)) {
				const delay = normalizeDelay(retryAfterMs - Date.now());
				if (delay !== undefined) return delay;
			}
		}

		// x-ratelimit-reset: Unix timestamp in seconds
		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) {
				const delay = normalizeDelay(resetSeconds * 1000 - Date.now());
				if (delay !== undefined) return delay;
			}
		}

		// x-ratelimit-reset-after: relative seconds
		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const resetAfterSeconds = Number(rateLimitResetAfter);
			if (Number.isFinite(resetAfterSeconds)) {
				const delay = normalizeDelay(resetAfterSeconds * 1000);
				if (delay !== undefined) return delay;
			}
		}

		// x-ratelimit-reset-requests / x-ratelimit-reset-tokens: Unix timestamps (Anthropic)
		for (const header of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
			const value = headers.get(header);
			if (value) {
				const resetSeconds = Number(value);
				if (Number.isFinite(resetSeconds)) {
					const delay = normalizeDelay(resetSeconds * 1000 - Date.now());
					if (delay !== undefined) return delay;
				}
			}
		}
	}

	// Body text patterns (Google Gemini specific, but useful generally)

	// Pattern 1: "Your quota will reset after ..." (formats: "18h31m10s", "10m15s", "6s", "39s")
	const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (durationMatch) {
		const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
		const seconds = parseFloat(durationMatch[3]);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			const delay = normalizeDelay(totalMs);
			if (delay !== undefined) return delay;
		}
	}

	// Pattern 2: "Please retry in X[ms|s]"
	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) return delay;
		}
	}

	// Pattern 3: "retryDelay": "34.074824224s" (JSON field in error details)
	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) return delay;
		}
	}

	return undefined;
}
