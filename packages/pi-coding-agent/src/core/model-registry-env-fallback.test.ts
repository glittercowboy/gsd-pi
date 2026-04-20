import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

function createRegistryWithCapturedResolver() {
	let capturedResolver: ((provider: string) => string | undefined) | undefined;
	const authStorage = {
		setFallbackResolver: (resolver: (provider: string) => string | undefined) => {
			capturedResolver = resolver;
		},
		onCredentialChange: () => {},
		getOAuthProviders: () => [],
		get: () => undefined,
		hasAuth: () => false,
		getApiKey: async () => undefined,
	} as unknown as AuthStorage;

	new ModelRegistry(authStorage, undefined);
	assert.ok(capturedResolver, "ModelRegistry should register a fallback resolver");
	return capturedResolver!;
}

describe("ModelRegistry env fallback resolver (#3782)", () => {
	it("falls back to built-in provider env vars when models.json has no custom key", () => {
		const prev = process.env.MINIMAX_API_KEY;
		process.env.MINIMAX_API_KEY = "minimax-env-test-key";

		try {
			const resolver = createRegistryWithCapturedResolver();
			assert.equal(
				resolver("minimax"),
				"minimax-env-test-key",
				"fallback resolver should return built-in provider env keys",
			);
		} finally {
			if (prev === undefined) {
				delete process.env.MINIMAX_API_KEY;
			} else {
				process.env.MINIMAX_API_KEY = prev;
			}
		}
	});

	it("still returns undefined when no custom or built-in env key exists", () => {
		const prev = process.env.MINIMAX_API_KEY;
		delete process.env.MINIMAX_API_KEY;

		try {
			const resolver = createRegistryWithCapturedResolver();
			assert.equal(resolver("minimax"), undefined);
			assert.equal(resolver("totally-unknown-provider"), undefined);
		} finally {
			if (prev !== undefined) {
				process.env.MINIMAX_API_KEY = prev;
			}
		}
	});
});
