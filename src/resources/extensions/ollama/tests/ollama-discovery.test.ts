// GSD2 — Tests for Ollama model discovery and enrichment
import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";

const EMPTY_DETAILS = { parent_model: "", format: "", family: "", families: null, parameter_size: "", quantization_level: "" };

function modelStub(name: string, parameterSize = "") {
	return { name, model: name, modified_at: "", size: 0, digest: "", details: { ...EMPTY_DETAILS, parameter_size: parameterSize } };
}

function showStub(modelInfo: Record<string, unknown>) {
	return { modelfile: "", parameters: "", template: "", details: EMPTY_DETAILS, model_info: modelInfo };
}

describe("discoverModels — context window resolution", () => {
	afterEach(() => { mock.restoreAll(); });

	it("uses known table context window without calling /api/show", async () => {
		const clientMod = await import("../ollama-client.js");
		mock.method(clientMod, "listModels", async () => ({ models: [modelStub("llama3.2:latest", "3B")] }));
		const showSpy = mock.method(clientMod, "showModel", async () => { throw new Error("should not be called"); });

		const { discoverModels } = await import("../ollama-discovery.js?t=1");
		const models = await discoverModels();
		assert.equal(models[0].contextWindow, 131072);
		assert.equal(showSpy.mock.calls.length, 0);
	});

	it("uses context_length from /api/show model_info for unknown model", async () => {
		const clientMod = await import("../ollama-client.js");
		mock.method(clientMod, "listModels", async () => ({ models: [modelStub("gemini-3-flash-preview:latest")] }));
		mock.method(clientMod, "showModel", async () => showStub({ "gemini.context_length": 1048576 }));

		const { discoverModels } = await import("../ollama-discovery.js?t=2");
		const models = await discoverModels();
		assert.equal(models[0].contextWindow, 1048576);
	});

	it("falls back to 8192 when /api/show model_info has no context_length key", async () => {
		const clientMod = await import("../ollama-client.js");
		mock.method(clientMod, "listModels", async () => ({ models: [modelStub("unknown-model:latest")] }));
		mock.method(clientMod, "showModel", async () => showStub({}));

		const { discoverModels } = await import("../ollama-discovery.js?t=3");
		const models = await discoverModels();
		assert.equal(models[0].contextWindow, 8192);
	});

	it("falls back to 8192 when /api/show throws", async () => {
		const clientMod = await import("../ollama-client.js");
		mock.method(clientMod, "listModels", async () => ({ models: [modelStub("unknown-model:latest")] }));
		mock.method(clientMod, "showModel", async () => { throw new Error("network error"); });

		const { discoverModels } = await import("../ollama-discovery.js?t=4");
		const models = await discoverModels();
		assert.equal(models[0].contextWindow, 8192);
	});
});
