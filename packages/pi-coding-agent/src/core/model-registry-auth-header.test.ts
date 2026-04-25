import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

function createRegistry(): ModelRegistry {
	const authStorage = {
		setFallbackResolver: () => {},
		onCredentialChange: () => {},
		getOAuthProviders: () => [],
		get: () => undefined,
		hasAuth: () => false,
		getApiKey: async () => undefined,
	} as unknown as AuthStorage;

	return new ModelRegistry(authStorage, undefined);
}

describe("ModelRegistry authHeader wiring (#3874)", () => {
	it("adds Authorization bearer header for custom providers with authHeader enabled", () => {
		const registry = createRegistry();
		registry.registerProvider("bigmodel", {
			baseUrl: "https://open.bigmodel.cn/api/anthropic",
			api: "anthropic-messages",
			apiKey: "bigmodel-test-key",
			authHeader: true,
			models: [
				{
					id: "glm-5.1",
					name: "glm-5.1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 128000,
				},
			],
		});

		const model = registry.getAll().find((m) => m.provider === "bigmodel" && m.id === "glm-5.1");
		assert.ok(model, "custom provider model should be registered");
		assert.equal(model.headers?.Authorization, "Bearer bigmodel-test-key");
	});
});
