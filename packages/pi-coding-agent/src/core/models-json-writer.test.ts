import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ModelsJsonWriter } from "./models-json-writer.js";

let testDir: string;
let modelsJsonPath: string;

beforeEach(() => {
	testDir = join(tmpdir(), `models-json-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
	modelsJsonPath = join(testDir, "models.json");
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Cleanup best-effort
	}
});

function readModels(): Record<string, unknown> {
	return JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
}

// ─── addModel ────────────────────────────────────────────────────────────────

describe("ModelsJsonWriter — addModel", () => {
	it("creates file and adds model to new provider", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.addModel("openai", { id: "gpt-4o", name: "GPT-4o" }, { baseUrl: "https://api.openai.com", apiKey: "env:OPENAI_API_KEY", api: "openai" });

		const config = readModels() as any;
		assert.ok(config.providers.openai);
		assert.equal(config.providers.openai.models.length, 1);
		assert.equal(config.providers.openai.models[0].id, "gpt-4o");
	});

	it("appends model to existing provider", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.addModel("openai", { id: "gpt-4o" }, { baseUrl: "https://api.openai.com", apiKey: "env:OPENAI_API_KEY", api: "openai" });
		writer.addModel("openai", { id: "gpt-4o-mini" });

		const config = readModels() as any;
		assert.equal(config.providers.openai.models.length, 2);
	});

	it("replaces model with same id", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.addModel("openai", { id: "gpt-4o", name: "Old" }, { baseUrl: "https://api.openai.com", apiKey: "env:OPENAI_API_KEY", api: "openai" });
		writer.addModel("openai", { id: "gpt-4o", name: "New" });

		const config = readModels() as any;
		assert.equal(config.providers.openai.models.length, 1);
		assert.equal(config.providers.openai.models[0].name, "New");
	});
});

// ─── removeModel ─────────────────────────────────────────────────────────────

describe("ModelsJsonWriter — removeModel", () => {
	it("removes a model from provider", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.addModel("openai", { id: "gpt-4o" }, { baseUrl: "https://api.openai.com", apiKey: "env:OPENAI_API_KEY", api: "openai" });
		writer.addModel("openai", { id: "gpt-4o-mini" });

		writer.removeModel("openai", "gpt-4o");

		const config = readModels() as any;
		assert.equal(config.providers.openai.models.length, 1);
		assert.equal(config.providers.openai.models[0].id, "gpt-4o-mini");
	});

	it("removes provider when last model is removed", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.addModel("openai", { id: "gpt-4o" }, { baseUrl: "https://api.openai.com", apiKey: "env:OPENAI_API_KEY", api: "openai" });

		writer.removeModel("openai", "gpt-4o");

		const config = readModels() as any;
		assert.equal(config.providers.openai, undefined);
	});

	it("handles removing from nonexistent provider", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		// Should not throw
		writer.removeModel("nonexistent", "model-id");
	});
});

// ─── setProvider / removeProvider ────────────────────────────────────────────

describe("ModelsJsonWriter — provider operations", () => {
	it("sets a provider configuration", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.setProvider("custom", {
			baseUrl: "http://localhost:8080",
			apiKey: "test-key",
			api: "openai",
			models: [{ id: "local-model" }],
		});

		const config = readModels() as any;
		assert.ok(config.providers.custom);
		assert.equal(config.providers.custom.baseUrl, "http://localhost:8080");
	});

	it("removes a provider", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.setProvider("custom", { baseUrl: "http://localhost:8080" });
		writer.removeProvider("custom");

		const config = readModels() as any;
		assert.equal(config.providers.custom, undefined);
	});

	it("handles removing nonexistent provider", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.removeProvider("nonexistent");
		// Should not throw
	});
});

// ─── listProviders ───────────────────────────────────────────────────────────

describe("ModelsJsonWriter — listProviders", () => {
	it("returns empty config when file does not exist", () => {
		const writer = new ModelsJsonWriter(join(testDir, "nonexistent.json"));
		const config = writer.listProviders();
		assert.deepEqual(config, { providers: {} });
	});

	it("returns current provider config", () => {
		const writer = new ModelsJsonWriter(modelsJsonPath);
		writer.setProvider("openai", { baseUrl: "https://api.openai.com" });
		writer.setProvider("ollama", { baseUrl: "http://localhost:11434" });

		const config = writer.listProviders();
		assert.ok(config.providers.openai);
		assert.ok(config.providers.ollama);
	});
});
