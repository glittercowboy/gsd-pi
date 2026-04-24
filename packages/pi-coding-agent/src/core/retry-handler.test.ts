/**
 * RetryHandler tests — long-context entitlement 429 error handling (#2803)
 *
 * Verifies that "Extra usage is required for long context requests" errors
 * are classified as quota_exhausted (not rate_limit) and trigger a model
 * downgrade from [1m] to base when no cross-provider fallback exists.
 */

import { describe, it, beforeEach, mock, type Mock } from "node:test";
import assert from "node:assert/strict";
import { RetryHandler, type RetryHandlerDeps } from "./retry-handler.js";
import type { Api, AssistantMessage, Model } from "@gsd/pi-ai";
import type { FallbackResolver } from "./fallback-resolver.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SettingsManager } from "./settings-manager.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic" as Api,
		provider,
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 16384,
	} as Model<Api>;
}

function errorMessage(msg: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6[1m]",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: msg,
		timestamp: Date.now(),
	} as AssistantMessage;
}

interface MockDeps {
	deps: RetryHandlerDeps;
	emittedEvents: Array<Record<string, any>>;
	continueFn: Mock<() => Promise<void>>;
	onModelChangeFn: Mock<(model: Model<any>) => void>;
	markUsageLimitReached: Mock<(...args: any[]) => boolean>;
	findFallback: Mock<(...args: any[]) => Promise<any>>;
	findModel: Mock<(provider: string, modelId: string) => Model<Api> | undefined>;
}

function createMockDeps(overrides?: {
	model?: Model<Api>;
	retryEnabled?: boolean;
	markUsageLimitReachedResult?: boolean;
	fallbackResult?: any;
	findModelResult?: (provider: string, modelId: string) => Model<Api> | undefined;
	retrySettings?: {
		maxRetries?: number;
		baseDelayMs?: number;
		maxDelayMs?: number;
	};
}): MockDeps {
	const model = overrides?.model ?? createMockModel("anthropic", "claude-opus-4-6[1m]");
	const emittedEvents: Array<Record<string, any>> = [];
	const continueFn = mock.fn(async () => {});
	const onModelChangeFn = mock.fn((_model: Model<any>) => {});
	const markUsageLimitReached = mock.fn(
		() => overrides?.markUsageLimitReachedResult ?? false,
	);
	const findFallback = mock.fn(async () => overrides?.fallbackResult ?? null);
	const findModel = mock.fn(
		overrides?.findModelResult ?? ((_provider: string, _modelId: string) => undefined),
	);

	const messages: Array<{ role: string } & Record<string, any>> = [];

	const deps: RetryHandlerDeps = {
		agent: {
			continue: continueFn,
			state: { messages },
			setModel: mock.fn(),
			replaceMessages: mock.fn((newMessages: any[]) => {
				messages.length = 0;
				messages.push(...newMessages);
			}),
		} as any,
		settingsManager: {
			getRetryEnabled: () => overrides?.retryEnabled ?? true,
			getRetrySettings: () => ({
				enabled: overrides?.retryEnabled ?? true,
				maxRetries: overrides?.retrySettings?.maxRetries ?? 5,
				baseDelayMs: overrides?.retrySettings?.baseDelayMs ?? 1000,
				maxDelayMs: overrides?.retrySettings?.maxDelayMs ?? 30000,
			}),
		} as unknown as SettingsManager,
		modelRegistry: {
			authStorage: {
				markUsageLimitReached,
			},
			find: findModel,
		} as unknown as ModelRegistry,
		fallbackResolver: {
			findFallback,
		} as unknown as FallbackResolver,
		getModel: () => model,
		getSessionId: () => "test-session",
		emit: (event: any) => emittedEvents.push(event),
		onModelChange: onModelChangeFn,
	};

	return { deps, emittedEvents, continueFn, onModelChangeFn, markUsageLimitReached, findFallback, findModel };
}

// ─── _classifyErrorType (tested via handleRetryableError behavior) ──────────

describe("RetryHandler — long-context entitlement 429 (#2803)", () => {

	describe("error classification", () => {
		it("classifies 'Extra usage is required for long context requests' as quota_exhausted, not rate_limit", async () => {
			// When the error is classified as quota_exhausted AND no alternate credentials
			// AND no fallback, the handler should emit fallback_chain_exhausted and stop.
			// If misclassified as rate_limit, it would enter the backoff loop instead.
			const { deps, emittedEvents, findModel } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
				markUsageLimitReachedResult: false, // no alternate credentials
				fallbackResult: null, // no cross-provider fallback
				findModelResult: () => undefined, // no base model either
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."}}'
			);

			const result = await handler.handleRetryableError(msg);

			// Should NOT retry (would be true if misclassified as rate_limit entering backoff)
			assert.equal(result, false);

			// Should emit fallback_chain_exhausted (quota_exhausted path), NOT auto_retry_start (backoff path)
			const chainExhausted = emittedEvents.find((e) => e.type === "fallback_chain_exhausted");
			assert.ok(chainExhausted, "Expected fallback_chain_exhausted event for entitlement error");

			const retryStart = emittedEvents.find((e) => e.type === "auto_retry_start");
			assert.equal(retryStart, undefined, "Should NOT emit auto_retry_start for entitlement error");
		});

		it("still classifies regular 429 rate limits as rate_limit", async () => {
			// A normal "rate limit" 429 should still be classified as rate_limit
			const { deps, emittedEvents } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("429 Too Many Requests");

			const result = await handler.handleRetryableError(msg);

			// Should enter the backoff loop (rate_limit path, not quota_exhausted)
			assert.equal(result, true);

			const retryStart = emittedEvents.find((e) => e.type === "auto_retry_start");
			assert.ok(retryStart, "Regular 429 should enter backoff retry");
		});

		it("classifies OpenRouter credit affordability errors as quota_exhausted", async () => {
			const { deps, emittedEvents } = createMockDeps({
				model: createMockModel("openrouter", "openai/gpt-5-pro"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				"402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329.",
			);

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, true, "affordability error should trigger credit-aware retry");
			const retryStart = emittedEvents.find((e) => e.type === "auto_retry_start");
			assert.ok(retryStart, "Expected immediate retry after reducing max tokens");
		});
	});

	describe("long-context model downgrade", () => {
		it("downgrades from [1m] to base model when entitlement error and no fallback", async () => {
			const baseModel = createMockModel("anthropic", "claude-opus-4-6");
			const { deps, emittedEvents, onModelChangeFn, continueFn } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
				findModelResult: (provider: string, modelId: string) => {
					if (provider === "anthropic" && modelId === "claude-opus-4-6") return baseModel;
					return undefined;
				},
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("Extra usage is required for long context requests.");

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, true, "Should retry after downgrade");

			// Should have called setModel with the base model
			const setModelCalls = (deps.agent.setModel as any).mock.calls;
			assert.equal(setModelCalls.length, 1);
			assert.equal(setModelCalls[0].arguments[0].id, "claude-opus-4-6");

			// Should have notified about model change
			assert.equal(onModelChangeFn.mock.calls.length, 1);

			// Should emit a fallback_provider_switch event indicating downgrade
			const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
			assert.ok(switchEvent, "Expected fallback_provider_switch event for downgrade");
			assert.ok(switchEvent!.reason.includes("long context downgrade"), `reason should mention downgrade: ${switchEvent!.reason}`);
		});

		it("emits fallback_chain_exhausted when base model is also unavailable", async () => {
			const { deps, emittedEvents } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
				findModelResult: () => undefined, // base model not found
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("Extra usage is required for long context requests.");

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, false);
			const chainExhausted = emittedEvents.find((e) => e.type === "fallback_chain_exhausted");
			assert.ok(chainExhausted, "Expected fallback_chain_exhausted when base model unavailable");
		});

		it("does not attempt downgrade for non-[1m] models", async () => {
			// When a regular model (no [1m] suffix) gets a quota_exhausted error
			// with no fallback, it should just stop — no downgrade attempt.
			const { deps, emittedEvents } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("Extra usage is required for long context requests.");

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, false);
			const chainExhausted = emittedEvents.find((e) => e.type === "fallback_chain_exhausted");
			assert.ok(chainExhausted);

			// No downgrade switch should occur
			const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
			assert.equal(switchEvent, undefined, "Should not switch for non-[1m] models");
		});
	});

	describe("retry cancellation", () => {
		it("cancels queued immediate continue callbacks when retry is aborted", async () => {
			const { deps, emittedEvents, continueFn } = createMockDeps({
				markUsageLimitReachedResult: true,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("429 Too Many Requests");

			const result = await handler.handleRetryableError(msg);
			assert.equal(result, true, "retry should be initiated");

			handler.abortRetry();
			// Yield the microtask queue so any synchronous continuation
			// scheduled by abortRetry() settles before we assert. This is
			// deterministic — no magic-sleep dependency (#4798 / #4784).
			await Promise.resolve();
			await Promise.resolve();

			assert.equal(continueFn.mock.calls.length, 0, "cancelled retry must not continue after explicit abort");
			const endEvents = emittedEvents.filter((e) => e.type === "auto_retry_end");
			assert.equal(endEvents.length, 1, "retry cancellation should emit a single auto_retry_end event");
			assert.equal(endEvents[0]?.finalError, "Retry cancelled");
		});
	});

	describe("credit-aware maxTokens retry", () => {
		it("reduces maxTokens on same model when provider reports affordable cap", async () => {
			const expensiveModel = createMockModel("openrouter", "openai/gpt-5-pro");
			expensiveModel.maxTokens = 128000;

			const { deps, emittedEvents, onModelChangeFn } = createMockDeps({
				model: expensiveModel,
				markUsageLimitReachedResult: false,
				fallbackResult: null,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				"402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329.",
			);

			const result = await handler.handleRetryableError(msg);
			assert.equal(result, true, "should retry after reducing maxTokens");

			const setModelCalls = (deps.agent.setModel as any).mock.calls;
			assert.equal(setModelCalls.length, 1, "should apply one model downgrade");
			const downgraded = setModelCalls[0].arguments[0] as Model<Api>;
			assert.equal(downgraded.provider, "openrouter");
			assert.equal(downgraded.id, "openai/gpt-5-pro");
			assert.equal(downgraded.maxTokens, 297, "expected affordability cap with safety buffer");

			assert.equal(onModelChangeFn.mock.calls.length, 1, "should notify about model update");
			const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
			assert.ok(switchEvent, "should emit model-adjustment event");
			assert.ok(
				String(switchEvent?.reason || "").includes("credit-aware retry"),
				"switch reason should mention credit-aware retry",
			);
		});

		it("does not mark credentials in cooldown for affordability quota errors", async () => {
			const expensiveModel = createMockModel("openrouter", "openai/gpt-5-pro");
			expensiveModel.maxTokens = 128000;

			const { deps, markUsageLimitReached } = createMockDeps({
				model: expensiveModel,
				markUsageLimitReachedResult: false,
				fallbackResult: null,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				"402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329.",
			);

			await handler.handleRetryableError(msg);
			assert.equal(markUsageLimitReached.mock.calls.length, 0, "quota error should skip credential cooldown");
		});
	});

	describe("isRetryableError", () => {
		it("considers long-context entitlement error as retryable", () => {
			const { deps } = createMockDeps();
			const handler = new RetryHandler(deps);
			const msg = errorMessage("Extra usage is required for long context requests.");
			assert.equal(handler.isRetryableError(msg), true);
		});

		it("does NOT consider credential cooldown error as retryable (#3429)", () => {
			// The credential cooldown message from getApiKey() must not re-enter
			// the retry handler. Re-entry creates cascading empty error entries
			// in the session file that break resume.
			const { deps } = createMockDeps();
			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				'All credentials for "anthropic" are in a cooldown window. ' +
				'Please wait a moment and try again, or switch to a different provider.',
			);
			assert.equal(handler.isRetryableError(msg), false);
		});

		it("considers OpenRouter affordability credit errors as retryable", () => {
			const { deps } = createMockDeps();
			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				"402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329.",
			);
			assert.equal(handler.isRetryableError(msg), true);
		});
	});

	describe("third-party block claude-code fallback (#3772)", () => {
		it("switches to claude-code provider when current provider is anthropic", async () => {
			const ccModel = createMockModel("claude-code", "claude-opus-4-6");
			const { deps, emittedEvents, onModelChangeFn } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6"),
				findModelResult: (provider: string, modelId: string) => {
					if (provider === "claude-code" && modelId === "claude-opus-4-6") return ccModel;
					return undefined;
				},
			});
			deps.isClaudeCodeReady = () => true;

			const handler = new RetryHandler(deps);
			const msg = errorMessage("third-party apps cannot draw from extra usage");

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, true, "should retry via claude-code fallback");
			const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
			assert.ok(switchEvent, "Expected fallback_provider_switch event");
			assert.ok(switchEvent!.to.startsWith("claude-code/"), "Should switch to claude-code provider");
		});

		it("switches to claude-code on 'out of extra usage' error (#3772)", async () => {
			const ccModel = createMockModel("claude-code", "claude-opus-4-6");
			const { deps, emittedEvents } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6"),
				findModelResult: (provider: string, modelId: string) => {
					if (provider === "claude-code" && modelId === "claude-opus-4-6") return ccModel;
					return undefined;
				},
			});
			deps.isClaudeCodeReady = () => true;

			const handler = new RetryHandler(deps);
			const msg = errorMessage("You're out of extra usage. Add more at claude.ai/settings/usage and keep going.");

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, true, "should retry via claude-code fallback");
			const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
			assert.ok(switchEvent, "Expected fallback_provider_switch event");
			assert.ok(switchEvent!.to.startsWith("claude-code/"), "Should switch to claude-code provider");
		});

		it("does NOT switch to claude-code when current provider is not anthropic", async () => {
			const ccModel = createMockModel("claude-code", "gpt-4o");
			const { deps, emittedEvents } = createMockDeps({
				model: createMockModel("openai", "gpt-4o"),
				findModelResult: (provider: string, modelId: string) => {
					if (provider === "claude-code" && modelId === "gpt-4o") return ccModel;
					return undefined;
				},
			});
			deps.isClaudeCodeReady = () => true;

			const handler = new RetryHandler(deps);
			const msg = errorMessage("third-party apps are not supported for this plan");

			const result = await handler.handleRetryableError(msg);

			// Should NOT have triggered the claude-code fallback
			const switchEvent = emittedEvents.find(
				(e) => e.type === "fallback_provider_switch" && e.to?.startsWith("claude-code/"),
			);
			assert.equal(switchEvent, undefined, "Should NOT switch non-anthropic provider to claude-code");
		});
	});

	describe("quota_exhausted credential backoff (#3430)", () => {
		it("does NOT call markUsageLimitReached for quota_exhausted errors", async () => {
			// "Extra usage is required" is an account-level billing gate.
			// Backing off the credential for 30 minutes blocks all provider
			// requests and has no effect on the billing condition.
			const { deps, markUsageLimitReached } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
				findModelResult: () => undefined,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."}}',
			);

			await handler.handleRetryableError(msg);

			assert.equal(
				markUsageLimitReached.mock.calls.length,
				0,
				"markUsageLimitReached must NOT be called for quota_exhausted errors",
			);
		});

		it("still calls markUsageLimitReached for regular rate_limit errors", async () => {
			const { deps, markUsageLimitReached } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6"),
				markUsageLimitReachedResult: false,
				fallbackResult: null,
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("429 Too Many Requests");

			await handler.handleRetryableError(msg);

			assert.equal(
				markUsageLimitReached.mock.calls.length,
				1,
				"markUsageLimitReached should be called for rate_limit errors",
			);
		});

		it("still tries cross-provider fallback for quota_exhausted without credential backoff", async () => {
			const fallbackModel = createMockModel("openai", "gpt-4o");
			const { deps, markUsageLimitReached, continueFn } = createMockDeps({
				model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
				markUsageLimitReachedResult: false,
				fallbackResult: { model: fallbackModel, reason: "cross-provider fallback" },
			});

			const handler = new RetryHandler(deps);
			const msg = errorMessage("Extra usage is required for long context requests.");

			const result = await handler.handleRetryableError(msg);

			assert.equal(result, true, "should retry with fallback provider");
			assert.equal(
				markUsageLimitReached.mock.calls.length,
				0,
				"should NOT back off credentials before trying fallback",
			);
		});
	});
});
