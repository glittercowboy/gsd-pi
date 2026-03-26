export type ProviderErrorPauseUI = {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
};

/**
 * Classify a provider error as transient (auto-resume) or permanent (manual resume).
 *
 * Transient: rate limits, server errors (500/502/503), overloaded, internal errors.
 * These are expected to self-resolve and should auto-resume after a delay.
 *
 * Permanent: auth errors, invalid API key, billing issues.
 * These require user intervention and should pause indefinitely.
 */
export function classifyProviderError(errorMsg: string): {
  isTransient: boolean;
  isRateLimit: boolean;
  suggestedDelayMs: number;
} {
  const isRateLimit = /rate.?limit|too many requests|429/i.test(errorMsg);
  const isServerError = /internal server error|500|502|503|overloaded|server_error|api_error|service.?unavailable/i.test(errorMsg);

  // Connection/process errors — transient, auto-resume after brief backoff (#2309).
  // These indicate the process was killed, the connection was reset, or a network
  // blip occurred. They are NOT permanent failures.
  const isConnectionError = /terminated|connection.?reset|connection.?refused|other side closed|fetch failed|network.?(?:is\s+)?unavailable|ECONNREFUSED|ECONNRESET|EPIPE/i.test(errorMsg);

  // Permanent errors — never auto-resume
  const isPermanent = /auth|unauthorized|forbidden|invalid.*key|invalid.*api|billing|quota exceeded|account/i.test(errorMsg);

  if (isPermanent && !isRateLimit) {
    return { isTransient: false, isRateLimit: false, suggestedDelayMs: 0 };
  }

  if (isRateLimit) {
    // Try to extract retry-after from the message
    const resetMatch = errorMsg.match(/reset in (\d+)s/i);
    const delayMs = resetMatch ? Number(resetMatch[1]) * 1000 : 60_000; // default 60s for rate limits
    return { isTransient: true, isRateLimit: true, suggestedDelayMs: delayMs };
  }

  if (isServerError) {
    return { isTransient: true, isRateLimit: false, suggestedDelayMs: 30_000 }; // 30s for server errors
  }

  if (isConnectionError) {
    return { isTransient: true, isRateLimit: false, suggestedDelayMs: 15_000 }; // 15s for connection errors
  }

  // Stream-truncation JSON parse errors — transient (#2572).
  // When the API stream is cut mid-chunk, pi tries to reassemble the partial
  // tool-call JSON and gets a SyntaxError. This is the downstream symptom of
  // a connection drop — same root cause as ECONNRESET, one layer up.
  const isMalformedStream = /Unexpected end of JSON|Unexpected token.*JSON|Expected double-quoted property name|SyntaxError.*JSON/i.test(errorMsg);
  if (isMalformedStream) {
    return { isTransient: true, isRateLimit: false, suggestedDelayMs: 15_000 }; // 15s, same as connection errors
  }

  // Unknown error — treat as permanent (user reviews)
  return { isTransient: false, isRateLimit: false, suggestedDelayMs: 0 };
}

/**
 * Pause auto-mode due to a provider error.
 *
 * For transient errors (rate limits, server errors, overloaded), schedules
 * an automatic resume after a delay. For permanent errors (auth, billing),
 * pauses indefinitely — user must manually resume.
 */
export async function pauseAutoForProviderError(
  ui: ProviderErrorPauseUI,
  errorDetail: string,
  pause: () => Promise<void>,
  options?: {
    isRateLimit?: boolean;
    isTransient?: boolean;
    retryAfterMs?: number;
    resume?: () => void;
  },
): Promise<void> {
  const shouldAutoResume = (options?.isRateLimit || options?.isTransient)
    && options.retryAfterMs
    && options.retryAfterMs > 0
    && options.resume;

  if (shouldAutoResume) {
    const delaySec = Math.ceil(options!.retryAfterMs! / 1000);
    const reason = options!.isRateLimit ? "Rate limited" : "Server error (transient)";
    ui.notify(
      `${reason}${errorDetail}. Auto-resuming in ${delaySec}s...`,
      "warning",
    );
    await pause();

    // Schedule auto-resume after the delay
    setTimeout(() => {
      const resumeMsg = options!.isRateLimit
        ? "Rate limit window elapsed. Resuming auto-mode."
        : "Server error recovery delay elapsed. Resuming auto-mode.";
      ui.notify(resumeMsg, "info");
      options!.resume!();
    }, options!.retryAfterMs!);
  } else {
    ui.notify(`Auto-mode paused due to provider error${errorDetail}`, "warning");
    await pause();
  }
}
