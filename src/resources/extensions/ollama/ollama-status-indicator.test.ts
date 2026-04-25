/**
 * Regression test: don't show an Ollama footer status unless Ollama is
 * actually usable (running with at least one discovered model).
 *
 * Behaviour tests:
 *   1. probeAndRegister returns false when /api/tags returns no models
 *      (running-without-models should not be treated as available).
 *   2. The session_start handler calls ctx.ui.setStatus("ollama", "Ollama")
 *      when probeAndRegister reports true, and setStatus("ollama", undefined)
 *      when it reports false — keeping the footer clean on unavailable Ollama.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import ollamaExtension, { probeAndRegister } from "./index.js";

type RegisterCall = [string, Record<string, unknown>];

function makeMockPi() {
	const calls: {
		registerProvider: RegisterCall[];
		unregisterProvider: string[];
		registerTool: unknown[];
		onHandlers: Map<string, Array<(...args: unknown[]) => unknown>>;
	} = {
		registerProvider: [],
		unregisterProvider: [],
		registerTool: [],
		onHandlers: new Map(),
	};
	const pi = {
		registerProvider(id: string, spec: Record<string, unknown>) {
			calls.registerProvider.push([id, spec]);
		},
		unregisterProvider(id: string) {
			calls.unregisterProvider.push(id);
		},
		registerTool(tool: unknown) {
			calls.registerTool.push(tool);
		},
		registerCommand() {
			/* no-op */
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			if (!calls.onHandlers.has(event)) calls.onHandlers.set(event, []);
			calls.onHandlers.get(event)!.push(handler);
		},
	} as unknown as Parameters<typeof probeAndRegister>[0];
	return { pi, calls };
}

// Server mode:
//   "empty"  → /api/tags returns { models: [] }
//   "loaded" → /api/tags returns one model + /api/show with 8k context
let server: Server;
let serverMode: "empty" | "loaded" = "empty";
let savedHost: string | undefined;

before(async () => {
	server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/") {
			res.writeHead(200);
			res.end("Ollama is running");
			return;
		}
		if (req.method === "GET" && req.url === "/api/tags") {
			res.writeHead(200, { "Content-Type": "application/json" });
			if (serverMode === "empty") {
				res.end(JSON.stringify({ models: [] }));
			} else {
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
			}
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

test("probeAndRegister returns false when no Ollama models are discovered", async () => {
	serverMode = "empty";
	const { pi, calls } = makeMockPi();
	const found = await probeAndRegister(pi);
	assert.equal(found, false, "no models should be reported as unavailable");
	assert.equal(
		calls.registerProvider.length,
		0,
		"provider must not be registered when no models are discoverable",
	);
});

test("probeAndRegister returns true when Ollama has at least one model", async () => {
	serverMode = "loaded";
	const { pi, calls } = makeMockPi();
	const found = await probeAndRegister(pi);
	assert.equal(found, true);
	assert.equal(calls.registerProvider.length, 1);
});

test("interactive session sets ollama status based on probeAndRegister result", async () => {
	// Load case: status should be set to "Ollama".
	{
		serverMode = "loaded";
		const { pi, calls } = makeMockPi();
		ollamaExtension(pi);
		const handlers = calls.onHandlers.get("session_start") ?? [];
		assert.equal(handlers.length, 1, "extension registers one session_start handler");

		const statusCalls: Array<[string, string | undefined]> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (slot: string, value: string | undefined) => {
					statusCalls.push([slot, value]);
				},
				notify: () => {},
			},
		};

		// Fire session_start; wait a tick for the internal promise chain to resolve.
		await handlers[0]({}, ctx);
		// Give probeAndRegister + .then(setStatus) time to complete.
		for (let i = 0; i < 50; i++) {
			if (statusCalls.length > 0) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.deepEqual(
			statusCalls,
			[["ollama", "Ollama"]],
			"status should be set to 'Ollama' when probe reports available",
		);
	}

	// Unavailable case: status should be cleared (undefined).
	{
		serverMode = "empty";
		const { pi, calls } = makeMockPi();
		ollamaExtension(pi);
		const handlers = calls.onHandlers.get("session_start") ?? [];

		const statusCalls: Array<[string, string | undefined]> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (slot: string, value: string | undefined) => {
					statusCalls.push([slot, value]);
				},
				notify: () => {},
			},
		};

		await handlers[0]({}, ctx);
		for (let i = 0; i < 50; i++) {
			if (statusCalls.length > 0) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.deepEqual(
			statusCalls,
			[["ollama", undefined]],
			"status must be cleared (undefined) when probe reports unavailable",
		);
	}
});
