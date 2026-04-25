/**
 * Regression test for #3440: Ollama extension must register with
 * authMode "apiKey" (not "none"), otherwise the core bails out because
 * the provider has no streamSimple.
 *
 * Behaviour test: spin up a fake Ollama endpoint, point OLLAMA_HOST at
 * it, and invoke probeAndRegister with a mock pi. Assert that
 * registerProvider was called with authMode "apiKey".
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { probeAndRegister } from "./index.js";

type RegisterCall = [string, Record<string, unknown>];

function makeMockPi() {
	const calls: { registerProvider: RegisterCall[]; unregisterProvider: string[] } = {
		registerProvider: [],
		unregisterProvider: [],
	};
	const pi = {
		registerProvider(id: string, spec: Record<string, unknown>) {
			calls.registerProvider.push([id, spec]);
		},
		unregisterProvider(id: string) {
			calls.unregisterProvider.push(id);
		},
	} as unknown as Parameters<typeof probeAndRegister>[0];
	return { pi, calls };
}

let server: Server;
let savedHost: string | undefined;

before(async () => {
	// Fake Ollama endpoint that:
	//   GET /          → 200 (isRunning probe)
	//   GET /api/tags  → one model
	//   POST /api/show → minimal capability info
	server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("Ollama is running");
			return;
		}
		if (req.method === "GET" && req.url === "/api/tags") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					models: [
						{
							name: "llama3:latest",
							modified_at: new Date().toISOString(),
							size: 1_000_000,
							digest: "abc",
							details: {
								parent_model: "",
								format: "gguf",
								family: "llama",
								families: ["llama"],
								parameter_size: "8B",
								quantization_level: "Q4_0",
							},
						},
					],
				}),
			);
			return;
		}
		if (req.method === "POST" && req.url === "/api/show") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					modelfile: "",
					parameters: "",
					template: "",
					details: {
						parent_model: "",
						format: "gguf",
						family: "llama",
						families: ["llama"],
						parameter_size: "8B",
						quantization_level: "Q4_0",
					},
					model_info: { "llama.context_length": 8192 },
					capabilities: [],
				}),
			);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	savedHost = process.env.OLLAMA_HOST;
	process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
});

after(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (savedHost === undefined) delete process.env.OLLAMA_HOST;
	else process.env.OLLAMA_HOST = savedHost;
});

beforeEach(() => {
	// Each test starts from a clean providerRegistered state in the module.
	// probeAndRegister is idempotent — calling it is safe regardless.
});

test("Ollama registers with authMode apiKey, not none (#3440)", async () => {
	const { pi, calls } = makeMockPi();

	const found = await probeAndRegister(pi);
	assert.equal(found, true, "probeAndRegister should return true when models are discovered");

	assert.equal(calls.registerProvider.length, 1, "registerProvider should be called exactly once");
	const [providerId, spec] = calls.registerProvider[0];
	assert.equal(providerId, "ollama");
	assert.equal(
		spec.authMode,
		"apiKey",
		"authMode must be apiKey so the core doesn't require streamSimple for every model",
	);
});
