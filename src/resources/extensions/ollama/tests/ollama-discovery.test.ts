// GSD2 — Tests for Ollama model discovery and enrichment
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverModels } from "../ollama-discovery.js";
import type { OllamaTagsResponse, OllamaShowResponse } from "../types.js";

const EMPTY_DETAILS = { parent_model: "", format: "", family: "", families: null, parameter_size: "", quantization_level: "" };

function modelStub(name: string, parameterSize = "") {
	return { name, model: name, modified_at: "", size: 0, digest: "", details: { ...EMPTY_DETAILS, parameter_size: parameterSize } };
}

function tagsStub(name: string, parameterSize = ""): OllamaTagsResponse {
	return { models: [modelStub(name, parameterSize)] };
}

function showStub(modelInfo: Record<string, unknown>): OllamaShowResponse {
	return { modelfile: "", parameters: "", template: "", details: EMPTY_DETAILS, model_info: modelInfo };
}

describe("discoverModels — context window resolution", () => {
	it("uses known table context window without calling /api/show", async () => {
		let showCalled = false;
		const models = await discoverModels({
			listModels: async () => tagsStub("llama3.2:latest", "3B"),
			showModel: async () => { showCalled = true; throw new Error("should not be called"); },
		});
		assert.equal(models[0].contextWindow, 131072);
		assert.equal(showCalled, false);
	});

	it("uses context_length from /api/show model_info for unknown model", async () => {
		const models = await discoverModels({
			listModels: async () => tagsStub("gemini-3-flash-preview:latest"),
			showModel: async () => showStub({ "gemini.context_length": 1048576 }),
		});
		assert.equal(models[0].contextWindow, 1048576);
	});

	it("falls back to 8192 when /api/show model_info has no context_length key", async () => {
		const models = await discoverModels({
			listModels: async () => tagsStub("unknown-model:latest"),
			showModel: async () => showStub({}),
		});
		assert.equal(models[0].contextWindow, 8192);
	});

	it("falls back to 8192 when /api/show throws", async () => {
		const models = await discoverModels({
			listModels: async () => tagsStub("unknown-model:latest"),
			showModel: async () => { throw new Error("network error"); },
		});
		assert.equal(models[0].contextWindow, 8192);
	});
});