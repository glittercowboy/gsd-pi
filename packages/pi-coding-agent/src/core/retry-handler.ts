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
}

export class RetryHandler {
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;

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
		return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay|network.?(?:is\s+)?unavailable|credentials.*expired|temporarily backed off/i.test(
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
		if (this._deps.getModel() && message.errorMessage) {
			const errorType = this._classifyErrorType(message.errorMessage);
			const isCredentialError = errorType === "rate_limit" || errorType === "quota_exhausted";
			const hasAlternate =
				isCredentialError &&
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
				setTimeout(() => {
					this._deps.agent.continue().catch(() => {});
				}, 0);

				return true;
			}

			// All credentials are backed off. Try cross-provider fallback before giving up.
			if (isCredentialError) {
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
					setTimeout(() => {
						this._deps.agent.continue().catch(() => {});
					}, 0);

					return true;
				}

				// No fallback available either
				if (errorType === "quota_exhausted") {
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
			// Aborted during sleep
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
		setTimeout(() => {
			this._deps.agent.continue().catch(() => {});
		}, 0);

		return true;
	}

	/** Cancel in-progress retry */
	abortRetry(): void {
		this._retryAbortController?.abort();
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
		if (/quota|billing|exceeded.*limit|usage.*limit/i.test(err)) return "quota_exhausted";
		if (/rate.?limit|too many requests|429/i.test(err)) return "rate_limit";
		if (/500|502|503|504|server.?error|internal.?error|service.?unavailable/i.test(err)) return "server_error";
		return "unknown";
	}

	/** Remove the last assistant error message from agent state */
	private _removeLastAssistantError(): void {
		const messages = this._deps.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this._deps.agent.replaceMessages(messages.slice(0, -1));
		}
	}
}
