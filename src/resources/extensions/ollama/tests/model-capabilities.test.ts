// GSD2 — Tests for Ollama model capability detection
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	getModelCapabilities,
	estimateContextFromParams,
	humanizeModelName,
	formatModelSize,
} from "../model-capabilities.js";

// ─── getModelCapabilities ────────────────────────────────────────────────────

describe("getModelCapabilities", () => {
	it("returns reasoning for deepseek-r1 models", () => {
		const caps = getModelCapabilities("deepseek-r1:8b");
		assert.equal(caps.reasoning, true);
		assert.equal(caps.contextWindow, 131072);
	});

	it("returns reasoning for qwq models", () => {
		const caps = getModelCapabilities("qwq:32b");
		assert.equal(caps.reasoning, true);
	});

	it("returns vision for llava models", () => {
		const caps = getModelCapabilities("llava:7b");
		assert.deepEqual(caps.input, ["text", "image"]);
	});

	it("returns vision for llama3.2-vision models", () => {
		const caps = getModelCapabilities("llama3.2-vision:11b");
		assert.deepEqual(caps.input, ["text", "image"]);
	});

	it("returns correct context for llama3.1", () => {
		const caps = getModelCapabilities("llama3.1:8b");
		assert.equal(caps.contextWindow, 131072);
	});

	it("returns correct context for llama3 (no .1)", () => {
		const caps = getModelCapabilities("llama3:8b");
		assert.equal(caps.contextWindow, 8192);
	});

	it("returns correct context for llama2", () => {
		const caps = getModelCapabilities("llama2:7b");
		assert.equal(caps.contextWindow, 4096);
	});

	it("returns correct context for qwen2.5-coder", () => {
		const caps = getModelCapabilities("qwen2.5-coder:7b");
		assert.equal(caps.contextWindow, 131072);
		assert.equal(caps.maxTokens, 32768);
	});

	it("returns correct context for codestral", () => {
		const caps = getModelCapabilities("codestral:22b");
		assert.equal(caps.contextWindow, 262144);
	});

	it("returns correct context for mistral-nemo", () => {
		const caps = getModelCapabilities("mistral-nemo:12b");
		assert.equal(caps.contextWindow, 131072);
	});

	it("returns correct context for gemma3", () => {
		const caps = getModelCapabilities("gemma3:9b");
		assert.equal(caps.contextWindow, 131072);
	});

	it("returns empty object for unknown models", () => {
		const caps = getModelCapabilities("totally-unknown-model:3b");
		assert.deepEqual(caps, {});
	});

	it("strips tag before matching", () => {
		const caps = getModelCapabilities("llama3.1:70b-instruct-q4_0");
		assert.equal(caps.contextWindow, 131072);
	});

	it("matches case-insensitively", () => {
		const caps = getModelCapabilities("Llama3.1:8B");
		assert.equal(caps.contextWindow, 131072);
	});
});

// ─── estimateContextFromParams ───────────────────────────────────────────────

describe("estimateContextFromParams", () => {
	it("estimates 8192 for small models", () => {
		assert.equal(estimateContextFromParams("1.5B"), 8192);
	});

	it("estimates 16384 for 7B models", () => {
		assert.equal(estimateContextFromParams("7B"), 16384);
	});

	it("estimates 32768 for 13B models", () => {
		assert.equal(estimateContextFromParams("13B"), 32768);
	});

	it("estimates 65536 for 34B models", () => {
		assert.equal(estimateContextFromParams("34B"), 65536);
	});

	it("estimates 131072 for 70B+ models", () => {
		assert.equal(estimateContextFromParams("70B"), 131072);
	});

	it("handles decimal sizes", () => {
		assert.equal(estimateContextFromParams("7.5B"), 16384);
	});

	it("handles M (millions)", () => {
		assert.equal(estimateContextFromParams("500M"), 8192);
	});

	it("returns 8192 for unparseable input", () => {
		assert.equal(estimateContextFromParams("unknown"), 8192);
	});

	it("returns 8192 for empty string", () => {
		assert.equal(estimateContextFromParams(""), 8192);
	});
});

// ─── humanizeModelName ───────────────────────────────────────────────────────

describe("humanizeModelName", () => {
	it("capitalizes and adds tag", () => {
		assert.equal(humanizeModelName("llama3.1:8b"), "Llama 3.1 8B");
	});

	it("handles latest tag", () => {
		assert.equal(humanizeModelName("llama3.1:latest"), "Llama 3.1");
	});

	it("handles no tag", () => {
		assert.equal(humanizeModelName("llama3.1"), "Llama 3.1");
	});

	it("handles hyphenated names", () => {
		const result = humanizeModelName("deepseek-r1:8b");
		assert.ok(result.includes("8B"));
	});
});

// ─── formatModelSize ─────────────────────────────────────────────────────────

describe("formatModelSize", () => {
	it("formats GB", () => {
		assert.equal(formatModelSize(4_700_000_000), "4.7 GB");
	});

	it("formats MB", () => {
		assert.equal(formatModelSize(500_000_000), "500.0 MB");
	});

	it("formats KB", () => {
		assert.equal(formatModelSize(500_000), "500 KB");
	});
});
