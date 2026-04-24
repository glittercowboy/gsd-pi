/**
 * Regression tests for #3874 — custom Anthropic-compatible providers that
 * authenticate via an Authorization: Bearer header must be routed through
 * `authToken`, not `x-api-key`.
 *
 * Behaviour tests: invoke the real auth classifier
 * (hasBearerAuthorizationHeader, usesAnthropicBearerAuth) and the pure
 * client-config builder buildAnthropicClientConfig from anthropic.ts.
 * No source-grep.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "../types.js";
import {
	buildAnthropicClientConfig,
	hasBearerAuthorizationHeader,
	usesAnthropicBearerAuth,
} from "./anthropic.js";

function makeModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "custom-model",
		api: "anthropic-messages",
		provider: "custom-anthropic-compat" as Model<"anthropic-messages">["provider"],
		baseUrl: "https://api.example.com",
		reasoning: false,
		input: ["text"],
		name: "Custom",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
		...overrides,
	} as Model<"anthropic-messages">;
}

describe("anthropic bearer auth for custom providers (#3874)", () => {
	it("hasBearerAuthorizationHeader recognises `Authorization: Bearer ...`", () => {
		assert.equal(
			hasBearerAuthorizationHeader(makeModel({ headers: { Authorization: "Bearer sk-abc" } })),
			true,
		);
		assert.equal(
			hasBearerAuthorizationHeader(makeModel({ headers: { authorization: "bearer SK-abc" } })),
			true,
			"lower-case header name and bearer prefix must be accepted",
		);
	});

	it("hasBearerAuthorizationHeader rejects non-bearer Authorization headers", () => {
		assert.equal(
			hasBearerAuthorizationHeader(makeModel({ headers: { Authorization: "Basic Zm9vOmJhcg==" } })),
			false,
		);
		assert.equal(
			hasBearerAuthorizationHeader(makeModel({ headers: {} })),
			false,
		);
		assert.equal(hasBearerAuthorizationHeader(makeModel()), false);
	});

	it("custom provider with Bearer Authorization header is routed via authToken (not x-api-key)", () => {
		// Provider is NOT in the known-list (usesAnthropicBearerAuth returns false)
		// but it has an Authorization: Bearer header — the combined predicate
		// must still pick authToken auth.
		const model = makeModel({
			provider: "some-random-provider" as Model<"anthropic-messages">["provider"],
			headers: { Authorization: "Bearer sk-my-key" },
		});
		assert.equal(usesAnthropicBearerAuth(model.provider), false, "precondition: not in known bearer-auth list");

		const config = buildAnthropicClientConfig(model, "sk-my-key", false);
		assert.equal(config.apiKey, null, "bearer-auth providers must not send x-api-key");
		assert.equal(config.authToken, "sk-my-key", "bearer-auth providers must send apiKey as authToken");
	});

	it("known bearer-auth provider (minimax) uses authToken even without explicit header", () => {
		const model = makeModel({ provider: "minimax" });
		const config = buildAnthropicClientConfig(model, "sk-minimax", false);
		assert.equal(config.apiKey, null);
		assert.equal(config.authToken, "sk-minimax");
	});

	it("non-bearer provider (regular anthropic) uses apiKey / x-api-key", () => {
		const model = makeModel({ provider: "anthropic" });
		const config = buildAnthropicClientConfig(model, "sk-ant", false);
		assert.equal(config.apiKey, "sk-ant");
		assert.equal(config.authToken, undefined);
	});
});
