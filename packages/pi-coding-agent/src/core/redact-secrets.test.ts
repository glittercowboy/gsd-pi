// pi-coding-agent — unit tests for session-log secret redaction

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactSecrets } from "./redact-secrets.js";

describe("redactSecrets", () => {
	it("is a no-op on plain text with no secret markers", () => {
		const input = "Hello world — this is just some prose with numbers 12345 and dashes - - -.";
		assert.equal(redactSecrets(input), input);
	});

	it("redacts Anthropic keys before generic openai sk- pattern", () => {
		const out = redactSecrets("key=sk-ant-api03-abcDEF1234567890abcDEF1234567890");
		assert.equal(out, "key=[REDACTED:anthropic]");
	});

	it("redacts legacy OpenAI sk- keys", () => {
		const out = redactSecrets("OPENAI_API_KEY=sk-abcDEF1234567890abcDEF12");
		assert.equal(out, "OPENAI_API_KEY=[REDACTED:openai]");
	});

	it("redacts OpenAI project sk-proj- keys with hyphens/underscores in body", () => {
		const out = redactSecrets("OPENAI_API_KEY=sk-proj-AbCd_1234-EfGh_5678-IjKl_9012");
		assert.equal(out, "OPENAI_API_KEY=[REDACTED:openai]");
	});

	it("redacts OpenAI admin sk-admin- keys", () => {
		const out = redactSecrets("OPENAI_ADMIN_KEY=sk-admin-AbCd1234EfGh5678IjKl9012");
		assert.equal(out, "OPENAI_ADMIN_KEY=[REDACTED:openai]");
	});

	it("redacts LlamaCloud llx- keys", () => {
		const out = redactSecrets("LLAMA_CLOUD_API_KEY=llx-abcDEF1234567890abcDEF1234567890");
		assert.equal(out, "LLAMA_CLOUD_API_KEY=[REDACTED:llamacloud]");
	});

	it("redacts AWS access key ids", () => {
		const out = redactSecrets("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
		assert.equal(out, "aws_access_key_id = [REDACTED:aws-access-key]");
	});

	it("redacts GitHub personal/oauth/app/server/refresh tokens", () => {
		const out = redactSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
		assert.equal(out, "token=[REDACTED:github-token]");
	});

	it("redacts Slack tokens", () => {
		const out = redactSecrets("slack=xoxb-1234567890-abcdefghij");
		assert.equal(out, "slack=[REDACTED:slack-token]");
	});

	it("redacts Google API keys", () => {
		// Google API keys are exactly AIza + 35 chars (39 total).
		const out = redactSecrets("key=AIzaSyA-1234567890abcdefghijklmnopqrstu");
		assert.equal(out, "key=[REDACTED:google-api-key]");
	});

	it("redacts PEM private key blocks across newlines", () => {
		const pem = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEowIBAAKCAQEAabcDEF...",
			"morekeymaterial==",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");
		const out = redactSecrets(`before\n${pem}\nafter`);
		assert.equal(out, "before\n[REDACTED:pem-private-key]\nafter");
	});

	it("redacts multiple secrets in the same string", () => {
		const out = redactSecrets(
			"AZURE_CLIENT_SECRET: also llx-abcDEF1234567890abcDEF1234567890 and AKIAIOSFODNN7EXAMPLE",
		);
		assert.equal(
			out,
			"AZURE_CLIENT_SECRET: also [REDACTED:llamacloud] and [REDACTED:aws-access-key]",
		);
	});

	it("does not redact short strings that merely contain sk- prose", () => {
		// "sk-foo" is too short to match the openai pattern — must be 20+ chars.
		const input = "the sk- prefix isn't always a secret";
		assert.equal(redactSecrets(input), input);
	});
});
