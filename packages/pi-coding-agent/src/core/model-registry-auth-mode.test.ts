import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model, SimpleStreamOptions, Context, AssistantMessageEventStream } from "@gsd/pi-ai";
import { getApiProvider } from "@gsd/pi-ai";
import { AuthStorage, type AuthStorageData } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

function createRegistry(hasAuthFn?: (provider: string) => boolean): ModelRegistry {
	const authStorage = {
		setFallbackResolver: () => {},
		onCredentialChange: () => {},
		getOAuthProviders: () => [],
		get: () => undefined,
		hasAuth: hasAuthFn ?? (() => false),
		getApiKey: async () => undefined,
	} as unknown as AuthStorage;

	return new ModelRegistry(authStorage, undefined);
}

function createInMemoryRegistry(data: AuthStorageData = {}): ModelRegistry {
	return new ModelRegistry(AuthStorage.inMemory(data), undefined);
}

function createProviderModel(id: string, api?: string): NonNullable<Parameters<ModelRegistry["registerProvider"]>[1]["models"]>[number] {
	return {
		id,
		name: id,
		api: (api ?? "openai-completions") as Api,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function findModel(registry: ModelRegistry, provider: string, id: string): Model<Api> | undefined {
	return registry.getAvailable().find((m) => m.provider === provider && m.id === id);
}

function makeModel(provider: string, id: string, api: string): Model<Api> {
	return {
		id,
		name: id,
		api: api as Api,
		provider,
		baseUrl: `${provider}:`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "test",
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
}

/** No-op streamSimple for tests that need one to pass validation but don't inspect it. */
const noopStreamSimple = (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
	return {
		[Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true as const }) }; },
		result: () => Promise.resolve({ role: "assistant" as const, content: [], api: "test" as Api, provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() }),
		push: () => {},
		end: () => {},
	} as unknown as AssistantMessageEventStream;
};

/** Create a spy streamSimple that captures the options it receives and returns a stub stream. */
function createStreamSpy(): {
	streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	getCapturedOptions: () => SimpleStreamOptions | undefined;
} {
	let capturedOptions: SimpleStreamOptions | undefined;
	const streamSimple = (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
		capturedOptions = options;
		// Return a minimal stub that satisfies AssistantMessageEventStream
		return {
			[Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true as const }) }; },
			result: () => Promise.resolve({ role: "assistant" as const, content: [], api: "test" as Api, provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() }),
			push: () => {},
			end: () => {},
		} as unknown as AssistantMessageEventStream;
	};
	return { streamSimple, getCapturedOptions: () => capturedOptions };
}

// ─── Registration ─────────────────────────────────────────────────────────────

describe("ModelRegistry authMode — registration", () => {
	it("registers externalCli provider with streamSimple and without apiKey/oauth", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		assert.doesNotThrow(() => {
			registry.registerProvider("cli-provider", {
				authMode: "externalCli",
				baseUrl: "https://cli.local",
				api: "openai-completions",
				streamSimple: spy.streamSimple,
				models: [createProviderModel("cli-model")],
			});
		});
	});

	it("registers none provider with streamSimple and without apiKey/oauth", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		assert.doesNotThrow(() => {
			registry.registerProvider("none-provider", {
				authMode: "none",
				baseUrl: "http://localhost:11434",
				api: "openai-completions",
				streamSimple: spy.streamSimple,
				models: [createProviderModel("local-model")],
			});
		});
	});

	it("rejects apiKey provider without apiKey or oauth — message mentions authMode", () => {
		const registry = createRegistry();
		assert.throws(() => {
			registry.registerProvider("apikey-provider", {
				authMode: "apiKey",
				baseUrl: "https://api.local",
				api: "openai-completions",
				models: [createProviderModel("model")],
			});
		}, (err: Error) => {
			assert.ok(err.message.includes("authMode"), "error message must mention authMode");
			assert.ok(err.message.includes("externalCli"), "error message must suggest externalCli");
			return true;
		});
	});

	it("rejects provider with no authMode and no apiKey/oauth (defaults to apiKey)", () => {
		const registry = createRegistry();
		assert.throws(() => {
			registry.registerProvider("bare-provider", {
				baseUrl: "https://api.local",
				api: "openai-completions",
				models: [createProviderModel("model")],
			});
		}, (err: Error) => {
			assert.ok(err.message.includes("authMode"), "error message must mention authMode");
			return true;
		});
	});

	it("rejects externalCli provider without streamSimple", () => {
		const registry = createRegistry();
		assert.throws(() => {
			registry.registerProvider("cli-no-stream", {
				authMode: "externalCli",
				baseUrl: "https://cli.local",
				api: "openai-completions",
				models: [createProviderModel("model")],
			});
		}, (err: Error) => {
			assert.ok(err.message.includes("streamSimple"), "error message must mention streamSimple");
			assert.ok(err.message.includes("externalCli"), "error message must mention authMode");
			return true;
		});
	});

	it("rejects none provider without streamSimple", () => {
		const registry = createRegistry();
		assert.throws(() => {
			registry.registerProvider("none-no-stream", {
				authMode: "none",
				baseUrl: "http://localhost:11434",
				api: "openai-completions",
				models: [createProviderModel("model")],
			});
		}, (err: Error) => {
			assert.ok(err.message.includes("streamSimple"), "error message must mention streamSimple");
			assert.ok(err.message.includes("none"), "error message must mention authMode");
			return true;
		});
	});

	it("rejects externalCli provider that also sets apiKey", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		assert.throws(() => {
			registry.registerProvider("cli-with-key", {
				authMode: "externalCli",
				baseUrl: "https://cli.local",
				api: "openai-completions",
				apiKey: "SHOULD_NOT_EXIST",
				streamSimple: spy.streamSimple,
				models: [createProviderModel("model")],
			});
		}, (err: Error) => {
			assert.ok(err.message.includes("apiKey"), "error message must mention apiKey");
			assert.ok(err.message.includes("externalCli"), "error message must mention authMode");
			return true;
		});
	});

	it("rejects none provider that also sets apiKey", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		assert.throws(() => {
			registry.registerProvider("none-with-key", {
				authMode: "none",
				baseUrl: "http://localhost:11434",
				api: "openai-completions",
				apiKey: "SHOULD_NOT_EXIST",
				streamSimple: spy.streamSimple,
				models: [createProviderModel("model")],
			});
		}, (err: Error) => {
			assert.ok(err.message.includes("apiKey"), "error message must mention apiKey");
			assert.ok(err.message.includes("none"), "error message must mention authMode");
			return true;
		});
	});
});

// ─── getProviderAuthMode ──────────────────────────────────────────────────────

describe("ModelRegistry authMode — getProviderAuthMode", () => {
	it("returns apiKey for unregistered (built-in) providers", () => {
		const registry = createRegistry();
		assert.equal(registry.getProviderAuthMode("anthropic"), "apiKey");
	});

	it("returns explicit authMode when set", () => {
		const registry = createRegistry();
		registry.registerProvider("cli", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("m")],
		});
		assert.equal(registry.getProviderAuthMode("cli"), "externalCli");
	});

	it("returns none when authMode is none", () => {
		const registry = createRegistry();
		registry.registerProvider("local", {
			authMode: "none",
			baseUrl: "http://localhost:11434",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("m")],
		});
		assert.equal(registry.getProviderAuthMode("local"), "none");
	});
});

// ─── isProviderRequestReady ───────────────────────────────────────────────────

describe("ModelRegistry authMode — isProviderRequestReady", () => {
	it("returns true for externalCli without stored auth", () => {
		const registry = createRegistry(() => false);
		registry.registerProvider("cli", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("m")],
		});
		assert.equal(registry.isProviderRequestReady("cli"), true);
	});

	it("returns true for none without stored auth", () => {
		const registry = createRegistry(() => false);
		registry.registerProvider("local", {
			authMode: "none",
			baseUrl: "http://localhost:11434",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("m")],
		});
		assert.equal(registry.isProviderRequestReady("local"), true);
	});

	it("returns false for apiKey provider without stored auth", () => {
		const registry = createRegistry(() => false);
		assert.equal(registry.isProviderRequestReady("anthropic"), false);
	});

	it("returns true for apiKey provider with stored auth", () => {
		const registry = createRegistry(() => true);
		assert.equal(registry.isProviderRequestReady("anthropic"), true);
	});
});

// ─── isReady callback ─────────────────────────────────────────────────────────

describe("ModelRegistry authMode — isReady callback", () => {
	it("calls isReady and returns its result for externalCli provider", () => {
		const registry = createRegistry(() => false);
		registry.registerProvider("cli-down", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			isReady: () => false,
			models: [createProviderModel("m")],
		});
		assert.equal(registry.isProviderRequestReady("cli-down"), false);
	});

	it("calls isReady for apiKey provider (overrides hasAuth)", () => {
		const registry = createRegistry(() => true);
		registry.registerProvider("strict-provider", {
			apiKey: "MY_KEY",
			baseUrl: "https://api.local",
			api: "openai-completions",
			isReady: () => false,
			models: [createProviderModel("m")],
		});
		assert.equal(registry.isProviderRequestReady("strict-provider"), false);
	});

	it("isReady returning true makes provider available", () => {
		const registry = createRegistry(() => false);
		registry.registerProvider("healthy-cli", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			isReady: () => true,
			models: [createProviderModel("m")],
		});
		assert.equal(registry.isProviderRequestReady("healthy-cli"), true);
	});

	it("falls through to default behavior when isReady not provided", () => {
		const registry = createRegistry(() => false);
		registry.registerProvider("no-callback", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("m")],
		});
		// externalCli without isReady → true (default)
		assert.equal(registry.isProviderRequestReady("no-callback"), true);
	});
});

// ─── getAvailable ─────────────────────────────────────────────────────────────

describe("ModelRegistry authMode — getAvailable", () => {
	it("includes externalCli models without stored auth", () => {
		const registry = createRegistry(() => false);
		registry.registerProvider("cli", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("cli-model")],
		});
		assert.ok(findModel(registry, "cli", "cli-model"));
	});

	it("includes none models without stored auth", () => {
		const registry = createRegistry(() => false);
		registry.registerProvider("local", {
			authMode: "none",
			baseUrl: "http://localhost:11434",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("local-model")],
		});
		assert.ok(findModel(registry, "local", "local-model"));
	});

	it("excludes externalCli models when isReady returns false", () => {
		const registry = createRegistry(() => false);
		registry.registerProvider("cli-down", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			isReady: () => false,
			models: [createProviderModel("m")],
		});
		assert.equal(findModel(registry, "cli-down", "m"), undefined);
	});

	it("excludes apiKey models without stored auth", () => {
		const registry = createRegistry(() => false);
		const available = registry.getAvailable();
		assert.equal(available.length, 0);
	});

	it("prunes Codex models removed from ChatGPT-backed openai-codex OAuth", () => {
		const registry = createInMemoryRegistry({
			"openai-codex": {
				type: "oauth",
				access: "oauth-access",
				refresh: "oauth-refresh",
				expires: Date.now() + 60_000,
				accountId: "acct_123",
			},
		});

		assert.equal(registry.find("openai-codex", "gpt-5.1-codex-max"), undefined);
		assert.equal(registry.find("openai-codex", "gpt-5.1"), undefined);
		assert.equal(findModel(registry, "openai-codex", "gpt-5.2-codex"), undefined);
		assert.ok(registry.find("openai-codex", "gpt-5.4"));
		assert.ok(findModel(registry, "openai-codex", "gpt-5.4"));
		assert.ok(registry.find("openai-codex", "gpt-5.4-mini"));
		assert.ok(findModel(registry, "openai-codex", "gpt-5.4-mini"));
	});

	it("keeps API-backed OpenAI Codex-capable models available", () => {
		const registry = createInMemoryRegistry({
			openai: {
				type: "api_key",
				key: "sk-test",
			},
		});

		assert.ok(registry.find("openai", "gpt-5.2-codex"));
		assert.ok(findModel(registry, "openai", "gpt-5.2-codex"));
	});
});

// ─── getApiKey ────────────────────────────────────────────────────────────────

describe("ModelRegistry authMode — getApiKey", () => {
	it("returns undefined for externalCli provider", async () => {
		const registry = createRegistry();
		registry.registerProvider("cli", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("m")],
		});
		const model = registry.getAll().find((m) => m.provider === "cli")!;
		assert.equal(await registry.getApiKey(model), undefined);
	});

	it("returns undefined for none provider", async () => {
		const registry = createRegistry();
		registry.registerProvider("local", {
			authMode: "none",
			baseUrl: "http://localhost:11434",
			api: "openai-completions",
			streamSimple: noopStreamSimple,
			models: [createProviderModel("m")],
		});
		const model = registry.getAll().find((m) => m.provider === "local")!;
		assert.equal(await registry.getApiKey(model), undefined);
	});

	it("delegates to authStorage for apiKey provider", async () => {
		const registry = createRegistry();
		const key = await registry.getApiKeyForProvider("anthropic");
		assert.equal(key, undefined);
	});
});

// ─── streamSimple apiKey stripping ────────────────────────────────────────────

describe("ModelRegistry authMode — streamSimple apiKey boundary", () => {
	it("strips apiKey from options for externalCli provider", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		const apiType = `ext-cli-strip-${Date.now()}`;

		registry.registerProvider("cli-strip", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: apiType as Api,
			streamSimple: spy.streamSimple,
			models: [createProviderModel("m", apiType)],
		});

		const provider = getApiProvider(apiType as Api);
		assert.ok(provider, "provider must be registered in api registry");

		provider.streamSimple(
			makeModel("cli-strip", "m", apiType),
			makeContext(),
			{ apiKey: "should-be-stripped", maxTokens: 1024 } as SimpleStreamOptions,
		);

		const captured = spy.getCapturedOptions();
		assert.ok(captured, "streamSimple must have been called");
		assert.equal("apiKey" in captured, false, "apiKey must not exist in options for externalCli provider");
		assert.equal(captured.maxTokens, 1024, "other options must pass through");
	});

	it("strips apiKey from options for none provider", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		const apiType = `none-strip-${Date.now()}`;

		registry.registerProvider("none-strip", {
			authMode: "none",
			baseUrl: "http://localhost:11434",
			api: apiType as Api,
			streamSimple: spy.streamSimple,
			models: [createProviderModel("m", apiType)],
		});

		const provider = getApiProvider(apiType as Api);
		assert.ok(provider, "provider must be registered in api registry");

		provider.streamSimple(
			makeModel("none-strip", "m", apiType),
			makeContext(),
			{ apiKey: "should-be-stripped", maxTokens: 2048 } as SimpleStreamOptions,
		);

		const captured = spy.getCapturedOptions();
		assert.ok(captured, "streamSimple must have been called");
		assert.equal("apiKey" in captured, false, "apiKey must not exist in options for none provider");
		assert.equal(captured.maxTokens, 2048, "other options must pass through");
	});

	it("preserves apiKey in options for apiKey provider", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		const apiType = `apikey-preserve-${Date.now()}`;

		registry.registerProvider("apikey-preserve", {
			apiKey: "MY_KEY",
			baseUrl: "https://api.local",
			api: apiType as Api,
			streamSimple: spy.streamSimple,
			models: [createProviderModel("m", apiType)],
		});

		const provider = getApiProvider(apiType as Api);
		assert.ok(provider, "provider must be registered in api registry");

		provider.streamSimple(
			makeModel("apikey-preserve", "m", apiType),
			makeContext(),
			{ apiKey: "sk-real-key", maxTokens: 4096 } as SimpleStreamOptions,
		);

		const captured = spy.getCapturedOptions();
		assert.ok(captured, "streamSimple must have been called");
		assert.equal(captured.apiKey, "sk-real-key", "apiKey must be preserved for apiKey provider");
		assert.equal(captured.maxTokens, 4096, "other options must pass through");
	});

	it("handles undefined options for externalCli provider", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		const apiType = `ext-cli-undef-${Date.now()}`;

		registry.registerProvider("cli-undef", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: apiType as Api,
			streamSimple: spy.streamSimple,
			models: [createProviderModel("m", apiType)],
		});

		const provider = getApiProvider(apiType as Api);
		assert.ok(provider, "provider must be registered in api registry");

		provider.streamSimple(
			makeModel("cli-undef", "m", apiType),
			makeContext(),
			undefined,
		);

		const captured = spy.getCapturedOptions();
		assert.ok(captured !== undefined, "streamSimple must have been called");
		assert.equal("apiKey" in captured, false, "apiKey must not exist even when options is undefined");
	});

	it("strips apiKey but preserves signal and other fields for externalCli", () => {
		const registry = createRegistry();
		const spy = createStreamSpy();
		const apiType = `ext-cli-fields-${Date.now()}`;
		const abortController = new AbortController();

		registry.registerProvider("cli-fields", {
			authMode: "externalCli",
			baseUrl: "https://cli.local",
			api: apiType as Api,
			streamSimple: spy.streamSimple,
			models: [createProviderModel("m", apiType)],
		});

		const provider = getApiProvider(apiType as Api);
		assert.ok(provider, "provider must be registered in api registry");

		provider.streamSimple(
			makeModel("cli-fields", "m", apiType),
			makeContext(),
			{ apiKey: "strip-me", maxTokens: 8192, signal: abortController.signal, reasoning: "high" } as SimpleStreamOptions,
		);

		const captured = spy.getCapturedOptions();
		assert.ok(captured, "streamSimple must have been called");
		assert.equal("apiKey" in captured, false, "apiKey must be stripped");
		assert.equal(captured.maxTokens, 8192, "maxTokens must pass through");
		assert.equal(captured.signal, abortController.signal, "signal must pass through");
		assert.equal((captured as Record<string, unknown>).reasoning, "high", "reasoning must pass through");
	});
});

// ─── Provider-scoped stream routing (#2533) ───────────────────────────────────

describe("ModelRegistry authMode — provider-scoped stream routing", () => {
	it("does not clobber built-in stream handler when custom provider uses same api", () => {
		const registry = createRegistry(() => true);
		const customSpy = createStreamSpy();

		// Register a custom provider with the same API type as a built-in (anthropic-messages).
		// This simulates the claude-code-cli extension registering with api: "anthropic-messages".
		registry.registerProvider("custom-cli", {
			authMode: "externalCli",
			baseUrl: "local://custom",
			api: "anthropic-messages",
			streamSimple: customSpy.streamSimple,
			models: [createProviderModel("custom-model", "anthropic-messages")],
		});

		// The built-in anthropic-messages provider should still be accessible
		// when calling streamSimple with a model from the built-in provider.
		const provider = getApiProvider("anthropic-messages" as Api);
		assert.ok(provider, "anthropic-messages provider must still be registered");

		// Call with a built-in anthropic model — should NOT hit the custom spy.
		// The built-in handler will throw (no API key), which proves the routing
		// correctly delegates to the built-in instead of the custom handler.
		assert.throws(
			() => provider.streamSimple(
				makeModel("anthropic", "claude-sonnet-4-6", "anthropic-messages"),
				makeContext(),
				{ maxTokens: 4096 } as SimpleStreamOptions,
			),
			(err: Error) => err.message.includes("API key"),
			"built-in Anthropic handler must be invoked (throws because no API key in tests)",
		);

		assert.equal(
			customSpy.getCapturedOptions(),
			undefined,
			"custom provider's streamSimple must NOT be called for anthropic provider models",
		);
	});

	it("routes to custom provider when model.provider matches", () => {
		const registry = createRegistry(() => true);
		const customSpy = createStreamSpy();

		registry.registerProvider("custom-cli", {
			authMode: "externalCli",
			baseUrl: "local://custom",
			api: "anthropic-messages",
			streamSimple: customSpy.streamSimple,
			models: [createProviderModel("custom-model", "anthropic-messages")],
		});

		const provider = getApiProvider("anthropic-messages" as Api);
		assert.ok(provider);

		// Call with the custom provider's model — should hit the custom spy
		provider.streamSimple(
			makeModel("custom-cli", "custom-model", "anthropic-messages"),
			makeContext(),
			{ maxTokens: 2048 } as SimpleStreamOptions,
		);

		const captured = customSpy.getCapturedOptions();
		assert.ok(captured, "custom provider's streamSimple must be called for its own models");
		assert.equal(captured.maxTokens, 2048);
	});
});
