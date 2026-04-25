// GSD2 — Tests for Ollama HTTP client
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getOllamaHost } from "../ollama-client.js";

// ─── getOllamaHost ──────────────────────────────────────────────────────────

describe("getOllamaHost", () => {
	const originalHost = process.env.OLLAMA_HOST;

	afterEach(() => {
		if (originalHost === undefined) {
			delete process.env.OLLAMA_HOST;
		} else {
			process.env.OLLAMA_HOST = originalHost;
		}
	});

	it("returns default when OLLAMA_HOST is not set", () => {
		delete process.env.OLLAMA_HOST;
		assert.equal(getOllamaHost(), "http://localhost:11434");
	});

	it("returns OLLAMA_HOST when set with scheme", () => {
		process.env.OLLAMA_HOST = "http://myhost:12345";
		assert.equal(getOllamaHost(), "http://myhost:12345");
	});

	it("adds http:// when OLLAMA_HOST has no scheme", () => {
		process.env.OLLAMA_HOST = "myhost:12345";
		assert.equal(getOllamaHost(), "http://myhost:12345");
	});

	it("preserves https:// scheme", () => {
		process.env.OLLAMA_HOST = "https://secure-ollama.example.com";
		assert.equal(getOllamaHost(), "https://secure-ollama.example.com");
	});
});
