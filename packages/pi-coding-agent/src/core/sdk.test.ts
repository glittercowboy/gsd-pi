// pi-coding-agent / CredentialCooldownError unit tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CredentialCooldownError } from "./sdk.js";

// ─── CredentialCooldownError ──────────────────────────────────────────────────

describe("CredentialCooldownError", () => {
	it("is an instance of Error", () => {
		const err = new CredentialCooldownError("anthropic");
		assert.ok(err instanceof Error);
	});

	it("has name set to CredentialCooldownError", () => {
		const err = new CredentialCooldownError("anthropic");
		assert.equal(err.name, "CredentialCooldownError");
	});

	it("has code set to AUTH_COOLDOWN", () => {
		const err = new CredentialCooldownError("anthropic");
		assert.equal(err.code, "AUTH_COOLDOWN");
	});

	it("message includes the provider name", () => {
		const err = new CredentialCooldownError("openai");
		assert.ok(
			err.message.includes("openai"),
			`Expected message to include provider "openai", got: ${err.message}`,
		);
	});

	it("message mentions cooldown window", () => {
		const err = new CredentialCooldownError("anthropic");
		assert.ok(
			/cooldown window/i.test(err.message),
			`Expected message to mention "cooldown window", got: ${err.message}`,
		);
	});

	it("retryAfterMs is undefined when not provided", () => {
		const err = new CredentialCooldownError("anthropic");
		assert.equal(err.retryAfterMs, undefined);
	});

	it("retryAfterMs holds the provided value when specified", () => {
		const err = new CredentialCooldownError("anthropic", 30_000);
		assert.equal(err.retryAfterMs, 30_000);
	});

	it("retryAfterMs is 0 when explicitly passed as 0", () => {
		const err = new CredentialCooldownError("anthropic", 0);
		assert.equal(err.retryAfterMs, 0);
	});

	it("code property is readonly and always AUTH_COOLDOWN regardless of provider", () => {
		for (const provider of ["anthropic", "openai", "google", "openrouter"]) {
			const err = new CredentialCooldownError(provider);
			assert.equal(err.code, "AUTH_COOLDOWN", `code should be AUTH_COOLDOWN for provider "${provider}"`);
		}
	});

	it("different providers produce different messages", () => {
		const err1 = new CredentialCooldownError("anthropic");
		const err2 = new CredentialCooldownError("openai");
		assert.notEqual(err1.message, err2.message);
	});

	it("can be caught as an Error in a try/catch", () => {
		let caught: unknown;
		try {
			throw new CredentialCooldownError("anthropic", 5_000);
		} catch (e) {
			caught = e;
		}
		assert.ok(caught instanceof Error);
		assert.ok(caught instanceof CredentialCooldownError);
		assert.equal((caught as CredentialCooldownError).retryAfterMs, 5_000);
	});

	it("code property is detectable via plain object check (cross-process pattern)", () => {
		const err = new CredentialCooldownError("anthropic", 15_000);
		// Simulate cross-process serialization: only plain properties survive JSON round-trip
		const plain = { code: err.code, retryAfterMs: err.retryAfterMs, message: err.message };
		assert.equal(plain.code, "AUTH_COOLDOWN");
		assert.equal(plain.retryAfterMs, 15_000);
	});
});
