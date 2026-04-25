/**
 * Integration test for the LSP tool port.
 *
 * Spins up typescript-language-server against a temp TypeScript project
 * and exercises: initialize, didOpen, hover, definition, references,
 * documentSymbol, diagnostics, and shutdown.
 *
 * Run: node --experimental-strip-types --test src/core/lsp/lsp-integration.test.ts
 * (from packages/pi-coding-agent/)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers — lightweight JSON-RPC over stdio (no dependency on our LSP code)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params: unknown;
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string };
}

function encodeMessage(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): string {
	const body = JSON.stringify(msg);
	return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

/**
 * Minimal LSP harness: spawns a language server, sends requests, collects responses.
 */
class LspHarness {
	private proc;
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private notifications: Array<{ method: string; params: unknown }> = [];

	constructor(command: string, args: string[], cwd: string) {
		this.proc = spawn(command, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.stdout!.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.drain();
		});

		this.proc.stderr!.on("data", (chunk: Buffer) => {
			// Swallow stderr (server logs)
		});
	}

	private drain(): void {
		while (true) {
			const headerEnd = this.findHeaderEnd();
			if (headerEnd === -1) return;

			const headerText = this.buffer.subarray(0, headerEnd).toString("utf-8");
			const match = headerText.match(/Content-Length:\s*(\d+)/i);
			if (!match) return;

			const contentLength = parseInt(match[1], 10);
			const messageStart = headerEnd + 4; // past \r\n\r\n
			const messageEnd = messageStart + contentLength;
			if (this.buffer.length < messageEnd) return;

			const body = this.buffer.subarray(messageStart, messageEnd).toString("utf-8");
			this.buffer = Buffer.from(this.buffer.subarray(messageEnd));

			const msg = JSON.parse(body) as JsonRpcResponse & { method?: string; params?: unknown };

			if (msg.id !== undefined && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) {
					p.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
				} else {
					p.resolve(msg.result);
				}
			} else if (msg.method) {
				// Server request or notification
				this.notifications.push({ method: msg.method, params: msg.params });
				// Auto-respond to server requests that have an id
				if (msg.id !== undefined) {
					this.respond(msg.id, null);
				}
			}
		}
	}

	private findHeaderEnd(): number {
		for (let i = 0; i < this.buffer.length - 3; i++) {
			if (
				this.buffer[i] === 13 &&
				this.buffer[i + 1] === 10 &&
				this.buffer[i + 2] === 13 &&
				this.buffer[i + 3] === 10
			) {
				return i;
			}
		}
		return -1;
	}

	private respond(id: number, result: unknown): void {
		const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
		this.proc.stdin!.write(encodeMessage(msg));
	}

	async request(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
		const id = this.nextId++;
		const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		this.proc.stdin!.write(encodeMessage(msg));

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
		});
	}

	notify(method: string, params: unknown): void {
		const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		this.proc.stdin!.write(encodeMessage(msg));
	}

	getNotifications(method?: string): Array<{ method: string; params: unknown }> {
		if (!method) return this.notifications;
		return this.notifications.filter((n) => n.method === method);
	}

	async shutdown(): Promise<void> {
		try {
			await this.request("shutdown", null, 5000);
			this.notify("exit", null);
		} catch {
			// Best effort
		}
		this.proc.kill();
	}
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createTempProject(): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));

	// tsconfig.json
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "commonjs",
					strict: true,
					outDir: "./dist",
					rootDir: "./src",
				},
				include: ["src/**/*.ts"],
			},
			null,
			2,
		),
	);

	// package.json
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "lsp-test-project", version: "1.0.0" }, null, 2),
	);

	fs.mkdirSync(path.join(dir, "src"));

	// src/math.ts — module with exported functions
	fs.writeFileSync(
		path.join(dir, "src", "math.ts"),
		`export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export interface Calculator {
  add(a: number, b: number): number;
  subtract(a: number, b: number): number;
}
`,
	);

	// src/main.ts — imports from math, has a type error
	fs.writeFileSync(
		path.join(dir, "src", "main.ts"),
		`import { add, subtract, Calculator } from "./math";

const result: number = add(1, 2);
const diff: number = subtract(5, 3);

// Intentional type error: string assigned to number
const bad: number = "not a number";

export function compute(calc: Calculator): number {
  return calc.add(1, 2) + calc.subtract(5, 3);
}
`,
	);

	return {
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

function fileToUri(filePath: string): string {
	return `file://${path.resolve(filePath)}`;
}

function hasTypescriptLanguageServer(): boolean {
	const probe = spawnSync("typescript-language-server", ["--help"], {
		stdio: "ignore",
	});
	return probe.status === 0 || probe.status === 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("LSP integration: typescript-language-server", async (t) => {
	if (!hasTypescriptLanguageServer()) {
		t.skip("typescript-language-server not installed in this environment");
		return;
	}

	const { dir, cleanup } = createTempProject();
	const mainPath = path.join(dir, "src", "main.ts");
	const mathPath = path.join(dir, "src", "math.ts");
	const mainUri = fileToUri(mainPath);
	const mathUri = fileToUri(mathPath);

	const lsp = new LspHarness("typescript-language-server", ["--stdio"], dir);

	try {
		// ---- Initialize ----
		await t.test("initialize handshake", async () => {
			const result = (await lsp.request("initialize", {
				processId: process.pid,
				rootUri: fileToUri(dir),
				rootPath: dir,
				capabilities: {
					textDocument: {
						hover: { contentFormat: ["markdown", "plaintext"] },
						definition: { linkSupport: true },
						references: {},
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						publishDiagnostics: { relatedInformation: true },
					},
				},
				workspaceFolders: [{ uri: fileToUri(dir), name: "test" }],
			})) as { capabilities?: Record<string, unknown> };

			assert.ok(result, "initialize should return a result");
			assert.ok(result.capabilities, "result should have capabilities");
			assert.ok(result.capabilities.hoverProvider !== undefined, "should support hover");
			assert.ok(result.capabilities.definitionProvider !== undefined, "should support definition");
		});

		lsp.notify("initialized", {});

		// Open both files
		const mainContent = fs.readFileSync(mainPath, "utf-8");
		const mathContent = fs.readFileSync(mathPath, "utf-8");

		lsp.notify("textDocument/didOpen", {
			textDocument: { uri: mainUri, languageId: "typescript", version: 1, text: mainContent },
		});
		lsp.notify("textDocument/didOpen", {
			textDocument: { uri: mathUri, languageId: "typescript", version: 1, text: mathContent },
		});

		// Poll for a published diagnostics notification on main.ts, which
		// is the observable signal that TypeScript has finished indexing
		// the opened file. Previous magic-sleep (3000ms) was too short on
		// slow CI machines and wasteful on fast ones (#4798).
		const INDEX_DEADLINE_MS = 15_000;
		const indexDeadline = Date.now() + INDEX_DEADLINE_MS;
		while (Date.now() < indexDeadline) {
			const diags = lsp
				.getNotifications("textDocument/publishDiagnostics")
				.filter((n) => (n.params as { uri: string }).uri === mainUri);
			if (diags.length > 0) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		// ---- Hover ----
		await t.test("hover on 'add' call", async () => {
			const result = (await lsp.request("textDocument/hover", {
				textDocument: { uri: mainUri },
				position: { line: 2, character: 24 }, // on 'add' in "add(1, 2)"
			})) as { contents?: unknown } | null;

			assert.ok(result, "hover should return a result");
			assert.ok(result.contents, "hover should have contents");
			const text = JSON.stringify(result.contents);
			assert.ok(
				text.includes("add") || text.includes("number"),
				`hover text should mention 'add' or 'number', got: ${text.slice(0, 200)}`,
			);
		});

		// ---- Go to Definition ----
		await t.test("go to definition of 'add'", async () => {
			const result = (await lsp.request("textDocument/definition", {
				textDocument: { uri: mainUri },
				position: { line: 2, character: 24 }, // on 'add'
			})) as unknown;

			assert.ok(result, "definition should return a result");
			const locations = Array.isArray(result) ? result : [result];
			assert.ok(locations.length > 0, "should find at least one definition");
			// Response can be Location (uri) or LocationLink (targetUri)
			const loc = locations[0] as Record<string, unknown>;
			const uri = (loc.uri ?? loc.targetUri) as string;
			assert.ok(uri, `definition should have uri or targetUri, got keys: ${Object.keys(loc).join(", ")}`);
			assert.ok(
				uri.includes("math.ts"),
				`definition should point to math.ts, got: ${uri}`,
			);
		});

		// ---- References ----
		await t.test("find references of 'add'", async () => {
			const result = (await lsp.request("textDocument/references", {
				textDocument: { uri: mathUri },
				position: { line: 0, character: 16 }, // on 'add' definition
				context: { includeDeclaration: true },
			})) as Array<{ uri: string; range: unknown }> | null;

			assert.ok(result, "references should return a result");
			assert.ok(result.length >= 2, `should find at least 2 references (decl + usage), got ${result.length}`);
		});

		// ---- Document Symbols ----
		await t.test("document symbols in math.ts", async () => {
			const result = (await lsp.request("textDocument/documentSymbol", {
				textDocument: { uri: mathUri },
			})) as Array<{ name: string; kind: number }> | null;

			assert.ok(result, "documentSymbol should return a result");
			assert.ok(result.length >= 2, `should find at least 2 symbols, got ${result.length}`);
			const names = result.map((s) => s.name);
			assert.ok(names.includes("add"), `symbols should include 'add', got: ${names.join(", ")}`);
			assert.ok(names.includes("subtract"), `symbols should include 'subtract', got: ${names.join(", ")}`);
		});

		// ---- Diagnostics (published via notification) ----
		await t.test("diagnostics for type error", async () => {
			// Poll for the specific type-error diagnostic on main.ts
			// instead of sleeping a fixed 2s. tsserver pushes diagnostics
			// incrementally — we need to wait until at least one diag
			// contains a type-error signal, not just any diag.
			const DIAG_DEADLINE_MS = 10_000;
			const diagDeadline = Date.now() + DIAG_DEADLINE_MS;
			while (Date.now() < diagDeadline) {
				const candidates = lsp
					.getNotifications("textDocument/publishDiagnostics")
					.filter((n) => (n.params as { uri: string }).uri === mainUri)
					.flatMap(
						(n) => (n.params as { diagnostics: Array<{ message: string }> }).diagnostics,
					);
				if (
					candidates.some(
						(d) => d.message.includes("not assignable") || d.message.includes("Type"),
					)
				) {
					break;
				}
				await new Promise((r) => setTimeout(r, 50));
			}

			const diagNotifications = lsp.getNotifications("textDocument/publishDiagnostics");
			const mainDiags = diagNotifications.filter(
				(n) => (n.params as { uri: string }).uri === mainUri,
			);

			assert.ok(mainDiags.length > 0, "should receive diagnostics for main.ts");

			const lastDiag = mainDiags[mainDiags.length - 1];
			const diagnostics = (lastDiag.params as { diagnostics: Array<{ message: string; range: unknown }> })
				.diagnostics;

			// Should catch the type error: string assigned to number
			const typeError = diagnostics.find(
				(d) => d.message.includes("not assignable") || d.message.includes("Type"),
			);
			assert.ok(
				typeError,
				`should find type error diagnostic, got: ${diagnostics.map((d) => d.message).join("; ")}`,
			);
		});

		// ---- Shutdown ----
		await t.test("clean shutdown", async () => {
			// Should not throw
			await lsp.shutdown();
		});
	} catch (err) {
		await lsp.shutdown().catch(() => {});
		cleanup();
		throw err;
	}

	cleanup();
});
