/**
 * RetryHandler - Automatic retry logic with exponential backoff and credential/provider fallback.
 *
 * Handles retryable errors (overloaded, rate limit, server errors) by:
 * 1. Trying alternate credentials for the same provider
 * 2. Falling back to other providers via FallbackResolver
 * 3. Exponential backoff with configurable max retries
 *
 * Context overflow errors are NOT handled here (see compaction).
 */

import type { Agent } from "@gsd/pi-agent-core";
import type { AssistantMessage, Model } from "@gsd/pi-ai";
import { isContextOverflow } from "@gsd/pi-ai";
import type { UsageLimitErrorType } from "./auth-storage.js";
import type { FallbackResolver } from "./fallback-resolver.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SettingsManager } from "./settings-manager.js";
import { sleep } from "../utils/sleep.js";
import type { AgentSessionEvent } from "./agent-session.js";

/** Dependencies injected from AgentSession into RetryHandler */
export interface RetryHandlerDeps {
	readonly agent: Agent;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	readonly fallbackResolver: FallbackResolver;
	getModel: () => Model<any> | undefined;
	getSessionId: () => string;
	emit: (event: AgentSessionEvent) => void;
	/** Called when the retry handler switches to a fallback model */
	onModelChange: (model: Model<any>) => void;
	/** Optional: check if the claude-code CLI provider is ready (installed + authed).
	 * Injected from the app layer to preserve package boundary. */
	isClaudeCodeReady?: () => boolean;
}

export class RetryHandler {
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	private _retryGeneration = 0;
	private _continueTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

	constructor(private readonly _deps: RetryHandlerDeps) {}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this._deps.settingsManager.getRetryEnabled();
	}

	/** Toggle auto-retry setting */
	setAutoRetryEnabled(enabled: boolean): void {
		this._deps.settingsManager.setRetryEnabled(enabled);
	}

	/**
	 * Create a retry promise synchronously for agent_end events.
	 * Must be called synchronously from the agent event handler before
	 * any async processing, so that waitForRetry() doesn't miss in-flight retries.
	 */
	createRetryPromiseForAgentEnd(messages: Array<{ role: string } & Record<string, any>>): void {
		if (this._retryPromise) return;

		const settings = this._deps.settingsManager.getRetrySettings();
		if (!settings.enabled) return;

		const lastAssistant = this._findLastAssistantInMessages(messages);
		if (!lastAssistant || !this.isRetryableError(lastAssistant)) return;

		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
	}

	/**
	 * Handle a successful assistant response by resetting retry state.
	 * Call this when an assistant message completes without error.
	 */
	handleSuccessfulResponse(): void {
		if (this._retryAttempt > 0) {
			this._deps.emit({
				type: "auto_retry_end",
				success: true,
				attempt: this._retryAttempt,
			});
			this._retryAttempt = 0;
			this._resolveRetry();
		}
	}

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this._deps.getModel()?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		// "temporarily backed off" is intentionally excluded: it is an internally-
		// generated error from getApiKey() when credentials are in a backoff window.
		// Re-entering the retry handler for that message creates a cascade of empty
		// error entries in the session file, breaking resume (#3429).
		return /overloaded|rate.?limit|too many requests|402|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay|network.?(?:is\s+)?unavailable|credentials.*expired|requires more credits|can only afford|insufficient credits|not enough credits|extra usage is required|(?:out of|no) extra usage|third.party.*draw from extra|third.party.*not.*available/i.test(
			err,
		);
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * When multiple credentials are available, marks the failing credential
	 * as backed off and retries immediately with the next one.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async handleRetryableError(message: AssistantMessage): Promise<boolean> {
		const settings = this._deps.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			this._resolveRetry();
			return false;
		}

		// Retry promise is created synchronously in createRetryPromiseForAgentEnd.
		// Keep a defensive fallback here in case a future refactor bypasses that path.
		if (!this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		// Try credential fallback before counting against retry budget.
		const retryGeneration = this._retryGeneration;
		if (this._deps.getModel() && message.errorMessage) {
			// Third-party subscription block (#3772): Anthropic blocks third-party apps
			// from using Pro/Max subscription quotas. If the claude-code CLI provider is
			// available, switch to it immediately — credential rotation won't help.
			if (this._isThirdPartyBlock(message.errorMessage)) {
				const switched = this._tryClaudeCodeFallback(message, retryGeneration);
				if (switched) return true;
				// CLI not available — fall through to standard error handling
			}

			const errorType = this._classifyErrorType(message.errorMessage);
			const isRateLimit = errorType === "rate_limit";
			const isQuotaError = errorType === "quota_exhausted";

			// Credit-aware retry (OpenRouter-style 402 affordability errors):
			// when provider reports "can only afford N", lower maxTokens and retry
			// on the same model before rotating credentials/providers.
			if (isQuotaError) {
				const adjusted = this._tryAffordableMaxTokensRetry(message, retryGeneration);
				if (adjusted) return true;
			}

			// Credential rotation — only for transient rate limits (#3430).
			// Quota errors ("Extra usage is required") are account-level billing
			// gates; rotating to another credential on the same account won't help
			// and the 30-minute backoff blocks all provider requests needlessly.
			if (isRateLimit) {
				const hasAlternate =
					this._deps.modelRegistry.authStorage.markUsageLimitReached(
						this._deps.getModel()!.provider,
						this._deps.getSessionId(),
						{ errorType },
					);

				if (hasAlternate) {
					this._removeLastAssistantError();

					this._deps.emit({
						type: "auto_retry_start",
						attempt: this._retryAttempt + 1,
						maxAttempts: settings.maxRetries,
						delayMs: 0,
						errorMessage: `${message.errorMessage} (switching credential)`,
					});

					// Retry immediately with the next credential - don't increment _retryAttempt
					this._scheduleContinue(retryGeneration);

					return true;
				}
			}

			// Cross-provider fallback — for rate limits with all creds backed off,
			// or quota errors (which skip credential backoff entirely).
			if (isRateLimit || isQuotaError) {
				const fallbackResult = await this._deps.fallbackResolver.findFallback(
					this._deps.getModel()!,
					errorType,
				);

				if (fallbackResult) {
					const previousProvider = this._deps.getModel()!.provider;
					this._deps.agent.setModel(fallbackResult.model);
					this._deps.onModelChange(fallbackResult.model);
					this._removeLastAssistantError();

					this._deps.emit({
						type: "fallback_provider_switch",
						from: `${previousProvider}/${this._deps.getModel()?.id}`,
						to: `${fallbackResult.model.provider}/${fallbackResult.model.id}`,
						reason: fallbackResult.reason,
					});

					this._deps.emit({
						type: "auto_retry_start",
						attempt: this._retryAttempt + 1,
						maxAttempts: settings.maxRetries,
						delayMs: 0,
						errorMessage: `${message.errorMessage} (${fallbackResult.reason})`,
					});

					// Retry immediately with fallback provider - don't increment _retryAttempt
					this._scheduleContinue(retryGeneration);

					return true;
				}

				// No fallback available either
				if (isQuotaError) {
					// Try long-context model downgrade ([1m] → base) before giving up
					const downgraded = this._tryLongContextDowngrade(message, retryGeneration);
					if (downgraded) return true;

					this._deps.emit({
						type: "fallback_chain_exhausted",
						reason: `All providers exhausted for ${this._deps.getModel()!.provider}/${this._deps.getModel()!.id}`,
					});
					this._deps.emit({
						type: "auto_retry_end",
						success: false,
						attempt: this._retryAttempt,
						finalError: message.errorMessage,
					});
					this._retryAttempt = 0;
					this._resolveRetry();
					return false;
				}
			}
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			this._deps.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
			this._resolveRetry();
			return false;
		}

		// Use server-requested delay when available, capped by maxDelayMs.
		// Fall back to exponential backoff when no server hint is present.
		const exponentialDelayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
		let delayMs: number;
		if (message.retryAfterMs !== undefined) {
			const cap = settings.maxDelayMs > 0 ? settings.maxDelayMs : Infinity;
			if (message.retryAfterMs > cap) {
				this._deps.emit({
					type: "auto_retry_end",
					success: false,
					attempt: this._retryAttempt - 1,
					finalError: `Rate limit reset in ${Math.ceil(message.retryAfterMs / 1000)}s (max: ${Math.ceil(cap / 1000)}s). ${message.errorMessage || ""}`.trim(),
				});
				this._retryAttempt = 0;
				this._resolveRetry();
				return false;
			}
			delayMs = message.retryAfterMs;
		} else {
			delayMs = exponentialDelayMs;
		}

		this._deps.emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		this._removeLastAssistantError();

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep. If the retry generation already advanced, this
			// cancellation was handled externally (e.g. explicit model switch).
			if (retryGeneration !== this._retryGeneration) {
				this._retryAbortController = undefined;
				return false;
			}
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._retryAbortController = undefined;
			this._deps.emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this._resolveRetry();
			return false;
		}
		this._retryAbortController = undefined;

		// Retry via continue() - use setTimeout to break out of event handler chain
		this._scheduleContinue(retryGeneration);

		return true;
	}

	/** Cancel in-progress retry */
	abortRetry(): void {
		const hadRetry =
			this._retryPromise !== undefined
			|| this._retryAbortController !== undefined
			|| this._continueTimeout !== undefined;
		if (!hadRetry) return;

		const attempt = this._retryAttempt > 0 ? this._retryAttempt : 1;
		this._retryGeneration++;
		if (this._continueTimeout) {
			clearTimeout(this._continueTimeout);
			this._continueTimeout = undefined;
		}
		if (this._retryAbortController) {
			this._retryAbortController.abort();
			this._retryAbortController = undefined;
		}
		this._retryAttempt = 0;
		this._deps.emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
		this._resolveRetry();
	}

	/**
	 * Wait for any in-progress retry to complete.
	 * Returns immediately if no retry is in progress.
	 */
	async waitForRetry(): Promise<void> {
		if (this._retryPromise) {
			await this._retryPromise;
		}
	}

	/** Resolve the pending retry promise */
	resolveRetry(): void {
		this._resolveRetry();
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

	private _resolveRetry(): void {
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
		}
	}

	private _scheduleContinue(retryGeneration: number): void {
		if (this._continueTimeout) {
			clearTimeout(this._continueTimeout);
		}
		this._continueTimeout = setTimeout(() => {
			this._continueTimeout = undefined;
			if (retryGeneration !== this._retryGeneration) return;
			this._deps.agent.continue().catch(() => {});
		}, 0);
	}

	private _findLastAssistantInMessages(
		messages: Array<{ role: string } & Record<string, any>>,
	): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * Classify an error message into a usage-limit error type for credential backoff.
	 */
	private _classifyErrorType(errorMessage: string): UsageLimitErrorType {
		const err = errorMessage.toLowerCase();
		// Long-context entitlement errors are billing gates, not transient rate limits.
		// Must be checked before the generic 429/rate_limit regex.
		if (/extra usage is required|long context required/i.test(err)) return "quota_exhausted";
		if (/requires more credits|can only afford|insufficient credits|not enough credits|credit balance/i.test(err))
			return "quota_exhausted";
		if (/quota|billing|exceeded.*limit|usage.*limit/i.test(err)) return "quota_exhausted";
		if (/rate.?limit|too many requests|429/i.test(err)) return "rate_limit";
		if (/500|502|503|504|server.?error|internal.?error|service.?unavailable/i.test(err)) return "server_error";
		return "unknown";
	}

	/**
	 * Attempt a same-model retry by reducing maxTokens when provider reports
	 * an affordability cap (e.g., "can only afford 329").
	 */
	private _tryAffordableMaxTokensRetry(message: AssistantMessage, retryGeneration: number): boolean {
		const currentModel = this._deps.getModel();
		if (!currentModel || !message.errorMessage) return false;

		// Example: "can only afford 329"
		const match = message.errorMessage.match(/can only afford\s+([\d,]+)/i);
		if (!match?.[1]) return false;

		const affordable = Number.parseInt(match[1].replace(/,/g, ""), 10);
		if (!Number.isFinite(affordable) || affordable <= 0) return false;

		// Leave a small buffer so slight input variance doesn't immediately re-fail.
		const safetyBuffer = Math.min(64, Math.max(16, Math.floor(affordable * 0.1)));
		const targetMaxTokens = Math.max(64, affordable - safetyBuffer);
		const downgradedMaxTokens = Math.min(currentModel.maxTokens, targetMaxTokens);
		if (downgradedMaxTokens >= currentModel.maxTokens) return false;

		const downgradedModel = {
			...currentModel,
			maxTokens: downgradedMaxTokens,
		};

		this._deps.agent.setModel(downgradedModel);
		this._deps.onModelChange(downgradedModel);
		this._removeLastAssistantError();

		this._deps.emit({
			type: "fallback_provider_switch",
			from: `${currentModel.provider}/${currentModel.id} (maxTokens=${currentModel.maxTokens})`,
			to: `${downgradedModel.provider}/${downgradedModel.id} (maxTokens=${downgradedModel.maxTokens})`,
			reason: `credit-aware retry: provider affordable cap ${affordable} tokens`,
		});

		this._deps.emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt + 1,
			maxAttempts: this._deps.settingsManager.getRetrySettings().maxRetries,
			delayMs: 0,
			errorMessage: `${message.errorMessage} (reducing max tokens)`,
		});

		this._scheduleContinue(retryGeneration);
		return true;
	}

	/**
	 * Attempt to downgrade a long-context model (e.g. claude-opus-4-6[1m]) to its
	 * base model (claude-opus-4-6) when the account lacks the long-context billing
	 * entitlement. Returns true if the downgrade was initiated.
	 */
	private _tryLongContextDowngrade(message: AssistantMessage, retryGeneration: number): boolean {
		const currentModel = this._deps.getModel();
		if (!currentModel) return false;

		// Only attempt downgrade for [1m] (or similar long-context) model IDs
		const match = currentModel.id.match(/^(.+)\[\d+m\]$/);
		if (!match) return false;

		const baseModelId = match[1];
		const baseModel = this._deps.modelRegistry.find(currentModel.provider, baseModelId);
		if (!baseModel) return false;

		const previousId = currentModel.id;
		this._deps.agent.setModel(baseModel);
		this._deps.onModelChange(baseModel);
		this._removeLastAssistantError();

		this._deps.emit({
			type: "fallback_provider_switch",
			from: `${currentModel.provider}/${previousId}`,
			to: `${baseModel.provider}/${baseModel.id}`,
			reason: `long context downgrade: ${previousId} → ${baseModel.id}`,
		});

		this._deps.emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt + 1,
			maxAttempts: this._deps.settingsManager.getRetrySettings().maxRetries,
			delayMs: 0,
			errorMessage: `${message.errorMessage} (long context downgrade)`,
		});

		this._scheduleContinue(retryGeneration);

		return true;
	}

	/**
	 * Detect Anthropic subscription block errors (#3772).
	 * These are hard policy blocks, not transient rate limits — credential
	 * rotation will not help. Matches both the explicit "third-party" message
	 * and the "out of extra usage" variant that subscription users receive.
	 */
	private _isThirdPartyBlock(errorMessage: string): boolean {
		return /third[- .]party.*(?:draw from extra|not.*available|plan limits|not permitted|cannot be used|not supported)|(?:out of|no) extra usage/i.test(errorMessage);
	}

	/**
	 * Attempt to switch to the claude-code CLI provider when the current
	 * Anthropic provider is blocked by the third-party policy (#3772).
	 * Returns true if the switch was made and retry scheduled.
	 */
	private _tryClaudeCodeFallback(message: AssistantMessage, retryGeneration: number): boolean {
		if (!this._deps.isClaudeCodeReady?.()) return false;

		const currentModel = this._deps.getModel();
		if (!currentModel) return false;

		// Only attempt claude-code fallback when the current provider is anthropic.
		// Transport-specific (ADR-012): intentionally keys on provider, not api —
		// the fallback specifically reroutes the plain `anthropic` transport to
		// the `claude-code` transport. Other Anthropic-fronting transports
		// (anthropic-vertex, amazon-bedrock) must not be rerouted.
		if (currentModel.provider !== "anthropic") return false;

		// Find the same model ID under the claude-code provider
		const ccModel = this._deps.modelRegistry.find("claude-code", currentModel.id);
		if (!ccModel) return false;

		const previousProvider = currentModel.provider;
		this._deps.agent.setModel(ccModel);
		this._deps.onModelChange(ccModel);
		this._removeLastAssistantError();

		this._deps.emit({
			type: "fallback_provider_switch",
			from: `${previousProvider}/${currentModel.id}`,
			to: `claude-code/${ccModel.id}`,
			reason: "Anthropic subscription blocked for third-party apps — routing through Claude Code CLI",
		});

		this._deps.emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt + 1,
			maxAttempts: this._deps.settingsManager.getRetrySettings().maxRetries,
			delayMs: 0,
			errorMessage: `${message.errorMessage} (switching to Claude Code CLI)`,
		});

		this._scheduleContinue(retryGeneration);
		return true;
	}

	/** Remove the last assistant error message from agent state */
	private _removeLastAssistantError(): void {
		const messages = this._deps.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this._deps.agent.replaceMessages(messages.slice(0, -1));
		}
	}
}
