import { spawn } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import type { Writable } from "node:stream";
import { killProcessTree } from "../../utils/shell.js";
import { ToolAbortError, isEnoent, throwIfAborted, untilAborted } from "./helpers.js";
import { applyWorkspaceEdit } from "./edits.js";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux.js";
import type {
	Diagnostic,
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	ServerConfig,
	WorkspaceEdit,
} from "./types.js";
import { detectLanguageId, fileToUri } from "./utils.js";

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, LspClient>();
const clientLocks = new Map<string, Promise<LspClient>>();
const fileOperationLocks = new Map<string, Promise<void>>();

// Idle timeout configuration (disabled by default)
let idleTimeoutMs: number | null = null;
let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Configure the idle timeout for LSP clients.
 */
export function setIdleTimeout(ms: number | null | undefined): void {
	idleTimeoutMs = ms ?? null;

	if (idleTimeoutMs && idleTimeoutMs > 0) {
		startIdleChecker();
	} else {
		stopIdleChecker();
	}
}

function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = setInterval(() => {
		if (!idleTimeoutMs) return;
		const now = Date.now();
		for (const [key, client] of Array.from(clients.entries())) {
			if (now - client.lastActivity > idleTimeoutMs) {
				shutdownClient(key);
			}
		}
	}, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleChecker(): void {
	if (idleCheckInterval) {
		clearInterval(idleCheckInterval);
		idleCheckInterval = null;
	}
}

// =============================================================================
// Client Capabilities
// =============================================================================

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: {
			didSave: true,
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
		},
		hover: {
			contentFormat: ["markdown", "plaintext"],
			dynamicRegistration: false,
		},
		definition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		typeDefinition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		implementation: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		references: {
			dynamicRegistration: false,
		},
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		rename: {
			dynamicRegistration: false,
			prepareSupport: true,
		},
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
						"source.fixAll",
					],
				},
			},
			resolveSupport: {
				properties: ["edit"],
			},
		},
		callHierarchy: {
			dynamicRegistration: false,
		},
		signatureHelp: {
			dynamicRegistration: false,
			signatureInformation: {
				documentationFormat: ["markdown", "plaintext"],
				parameterInformation: {
					labelOffsetSupport: true,
				},
			},
		},
		formatting: {
			dynamicRegistration: false,
		},
		rangeFormatting: {
			dynamicRegistration: false,
		},
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: false,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "textOnlyTransactional",
		},
		configuration: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
	},
	experimental: {
		snippetTextEdit: true,
	},
};

// =============================================================================
// LSP Message Protocol
// =============================================================================

function parseMessage(
	buffer: Buffer,
): { message: LspJsonRpcResponse | LspJsonRpcNotification | null; remaining: Buffer } | null {
	const headerEndIndex = findHeaderEnd(buffer);
	if (headerEndIndex === -1) return null;

	const headerText = new TextDecoder().decode(buffer.slice(0, headerEndIndex));
	const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
	if (!contentLengthMatch) return null;

	const contentLength = Number.parseInt(contentLengthMatch[1], 10);
	const messageStart = headerEndIndex + 4; // Skip \r\n\r\n
	const messageEnd = messageStart + contentLength;

	if (buffer.length < messageEnd) return null;

	const messageBytes = buffer.subarray(messageStart, messageEnd);
	const messageText = new TextDecoder().decode(messageBytes);
	const remaining = Buffer.from(buffer.subarray(messageEnd));

	let message: LspJsonRpcResponse | LspJsonRpcNotification;
	try {
		message = JSON.parse(messageText);
	} catch {
		// Malformed JSON from LSP server — skip this message and advance past it
		return { message: null, remaining };
	}

	return { message, remaining };
}

function findHeaderEnd(buffer: Uint8Array): number {
	for (let i = 0; i < buffer.length - 3; i++) {
		if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
			return i;
		}
	}
	return -1;
}

async function writeMessage(
	stdin: Writable | null,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	if (!stdin) {
		throw new Error("LSP process stdin is not available");
	}
	const content = JSON.stringify(message);
	const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`;
	return new Promise((resolve, reject) => {
		stdin.write(header + content, (err?: Error | null) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

// =============================================================================
// Message Reader
// =============================================================================

async function startMessageReader(client: LspClient): Promise<void> {
	if (client.isReading) return;
	client.isReading = true;

	const stdout = client.proc.stdout;
	if (!stdout) {
		client.isReading = false;
		return;
	}

	return new Promise<void>((resolve) => {
		stdout.on("data", async (chunk: Buffer) => {
			const currentBuffer: Buffer = Buffer.concat([client.messageBuffer, chunk]);
			client.messageBuffer = currentBuffer;

			let workingBuffer = currentBuffer;
			let parsed = parseMessage(workingBuffer);
			while (parsed) {
				const { message, remaining } = parsed;
				workingBuffer = remaining;

				if (!message) {
					parsed = parseMessage(workingBuffer);
					continue;
				}

				if ("id" in message && message.id !== undefined) {
					const pending = client.pendingRequests.get(message.id);
					if (pending) {
						client.pendingRequests.delete(message.id);
						if ("error" in message && message.error) {
							pending.reject(new Error(`LSP error: ${message.error.message}`));
						} else {
							pending.resolve(message.result);
						}
					} else if ("method" in message) {
						await handleServerRequest(client, message as LspJsonRpcRequest);
					}
				} else if ("method" in message) {
					if (message.method === "textDocument/publishDiagnostics" && message.params) {
						const params = message.params as { uri: string; diagnostics: Diagnostic[] };
						client.diagnostics.set(params.uri, params.diagnostics);
						client.diagnosticsVersion += 1;
					}
				}

				parsed = parseMessage(workingBuffer);
			}

			client.messageBuffer = workingBuffer;
		});

		stdout.on("end", () => {
			client.isReading = false;
			resolve();
		});

		stdout.on("error", () => {
			client.isReading = false;
			resolve();
		});
	});
}

// =============================================================================
// Server Request Handlers
// =============================================================================

async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map(item => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? {};
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { edit?: WorkspaceEdit };
	if (!params?.edit) {
		await sendResponse(
			client,
			message.id,
			{ applied: false, failureReason: "No edit provided" },
			"workspace/applyEdit",
		);
		return;
	}

	try {
		await applyWorkspaceEdit(params.edit, client.cwd);
		await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
	} catch (err: unknown) {
		await sendResponse(client, message.id, { applied: false, failureReason: String(err) }, "workspace/applyEdit");
	}
}

async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await handleConfigurationRequest(client, message);
		return;
	}
	if (message.method === "workspace/applyEdit") {
		await handleApplyEditRequest(client, message);
		return;
	}
	if (typeof message.id !== "number") return;
	await sendResponse(client, message.id, null, message.method, {
		code: -32601,
		message: `Method not found: ${message.method}`,
	});
}

async function sendResponse(
	client: LspClient,
	id: number,
	result: unknown,
	_method: string,
	error?: { code: number; message: string; data?: unknown },
): Promise<void> {
	const response: LspJsonRpcResponse = {
		jsonrpc: "2.0",
		id,
		...(error ? { error } : { result }),
	};

	try {
		await writeMessage(client.proc.stdin, response);
	} catch {
		// Failed to respond to server request
	}
}

// =============================================================================
// Stderr Buffer
// =============================================================================

async function startStderrReader(client: LspClient): Promise<void> {
	const stderr = client.proc.stderr;
	if (!stderr) return;

	return new Promise<void>((resolve) => {
		stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			client.stderrBuffer += text;
			if (client.stderrBuffer.length > 4096) {
				client.stderrBuffer = client.stderrBuffer.slice(-4096);
			}
		});

		stderr.on("end", () => {
			resolve();
		});

		stderr.on("error", () => {
			resolve();
		});
	});
}

// =============================================================================
// Client Management
// =============================================================================

/** Timeout for warmup initialize requests (5 seconds) */
export const WARMUP_TIMEOUT_MS = 5000;

/**
 * Get or create an LSP client for the given server configuration and working directory.
 */
export async function getOrCreateClient(config: ServerConfig, cwd: string, initTimeoutMs?: number): Promise<LspClient> {
	const key = `${config.command}:${cwd}`;

	const existingClient = clients.get(key);
	if (existingClient) {
		existingClient.lastActivity = Date.now();
		return existingClient;
	}

	const existingLock = clientLocks.get(key);
	if (existingLock) {
		return existingLock;
	}

	const clientPromise = (async () => {
		const baseCommand = config.resolvedCommand ?? config.command;
		const baseArgs = config.args ?? [];

		// Wrap with lspmux if available and supported
		const { command, args, env } = isLspmuxSupported(baseCommand)
			? await getLspmuxCommand(baseCommand, baseArgs)
			: { command: baseCommand, args: baseArgs };

		const proc = spawn(command, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: env ? { ...process.env, ...env } : undefined,
		});

		const exitedPromise = new Promise<number>((resolve) => {
			proc.on("exit", (code: number | null) => resolve(code ?? 1));
		});

		const client: LspClient = {
			name: key,
			cwd,
			proc: {
				stdin: proc.stdin,
				stdout: proc.stdout,
				stderr: proc.stderr,
				pid: proc.pid ?? 0,
				exitCode: null,
				exited: exitedPromise,
				kill: (signal?: number) => proc.kill(signal),
			},
			config,
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: Buffer.alloc(0),
			isReading: false,
			lastActivity: Date.now(),
			stderrBuffer: "",
		};
		clients.set(key, client);

		// Register crash recovery
		exitedPromise.then((code: number) => {
			client.proc.exitCode = code;
			clients.delete(key);
			clientLocks.delete(key);

			if (client.pendingRequests.size > 0) {
				const stderr = client.stderrBuffer.trim();
				const err = new Error(
					stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`,
				);
				for (const pending of client.pendingRequests.values()) {
					pending.reject(err);
				}
				client.pendingRequests.clear();
			}
		});

		// Start background readers
		startMessageReader(client);
		startStderrReader(client);

		try {
			const initResult = (await sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd),
					rootPath: cwd,
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split("/").pop() ?? "workspace" }],
				},
				undefined, // signal
				initTimeoutMs,
			)) as { capabilities?: unknown };

			if (!initResult) {
				throw new Error("Failed to initialize LSP: no response");
			}

			client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];

			await sendNotification(client, "initialized", {});

			return client;
		} catch (err) {
			clients.delete(key);
			clientLocks.delete(key);
			try {
				killProcessTree(proc.pid ?? 0);
			} catch {
				proc.kill();
			}
			throw err;
		} finally {
			clientLocks.delete(key);
		}
	})();

	clientLocks.set(key, clientPromise);
	return clientPromise;
}

/**
 * Ensure a file is opened in the LSP client.
 */
export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	if (client.openFiles.has(uri)) {
		return;
	}

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
		return;
	}

	const openPromise = (async () => {
		throwIfAborted(signal);
		if (client.openFiles.has(uri)) {
			return;
		}

		let content: string;
		try {
			content = await fsPromises.readFile(filePath, "utf-8");
			throwIfAborted(signal);
		} catch (err: unknown) {
			if (isEnoent(err)) return;
			throw err;
		}
		const languageId = detectLanguageId(filePath);
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didOpen", {
			textDocument: {
				uri,
				languageId,
				version: 1,
				text: content,
			},
		});

		client.openFiles.set(uri, { version: 1, languageId });
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, openPromise);
	try {
		await openPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Sync in-memory content to the LSP client without reading from disk.
 */
export async function syncContent(
	client: LspClient,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	throwIfAborted(signal);

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const syncPromise = (async () => {
		client.diagnostics.delete(uri);

		const info = client.openFiles.get(uri);

		if (!info) {
			const languageId = detectLanguageId(filePath);
			throwIfAborted(signal);
			await sendNotification(client, "textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version: 1,
					text: content,
				},
			});
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
			return;
		}

		const version = ++info.version;
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, syncPromise);
	try {
		await syncPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Notify LSP that a file was saved.
 */
export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	const info = client.openFiles.get(uri);
	if (!info) return;

	throwIfAborted(signal);
	await sendNotification(client, "textDocument/didSave", {
		textDocument: { uri },
	});
	client.lastActivity = Date.now();
}

/**
 * Refresh a file in the LSP client.
 */
export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const refreshPromise = (async () => {
		throwIfAborted(signal);
		const info = client.openFiles.get(uri);

		if (!info) {
			await ensureFileOpen(client, filePath, signal);
			return;
		}

		let content: string;
		try {
			content = await fsPromises.readFile(filePath, "utf-8");
			throwIfAborted(signal);
		} catch (err: unknown) {
			if (isEnoent(err)) return;
			throw err;
		}
		const version = ++info.version;
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didSave", {
			textDocument: { uri },
			text: content,
		});

		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, refreshPromise);
	try {
		await refreshPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Notify all LSP clients that have the file open that it changed on disk.
 * Synchronous entry point — async refresh runs in background.
 * Swallows errors so editing never fails because of LSP.
 */
export function notifyFileChanged(filePath: string): void {
	const uri = fileToUri(filePath);
	for (const client of clients.values()) {
		if (client.openFiles.has(uri)) {
			refreshFile(client, filePath).catch(() => {});
		}
	}
}

/**
 * Shutdown a specific client by key.
 */
export function shutdownClient(key: string): void {
	const client = clients.get(key);
	if (!client) return;

	for (const pending of Array.from(client.pendingRequests.values())) {
		pending.reject(new Error("LSP client shutdown"));
	}
	client.pendingRequests.clear();

	sendRequest(client, "shutdown", null).catch(() => {});

	try {
		killProcessTree(client.proc.pid);
	} catch {
		client.proc.kill();
	}
	clients.delete(key);
}

// =============================================================================
// LSP Protocol Methods
// =============================================================================

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
	const id = ++client.requestId;
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		return Promise.reject(reason);
	}

	const request: LspJsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	client.lastActivity = Date.now();

	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let timeout: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (signal) {
			signal.removeEventListener("abort", abortHandler);
		}
	};
	const abortHandler = () => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
		}
		void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
		if (timeout) clearTimeout(timeout);
		cleanup();
		const reason = signal?.reason instanceof Error ? signal.reason : new ToolAbortError();
		reject(reason);
	};

	timeout = setTimeout(() => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
			const err = new Error(`LSP request ${method} timed out after ${timeoutMs}ms`);
			cleanup();
			reject(err);
		}
	}, timeoutMs);
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
		if (signal.aborted) {
			abortHandler();
			return promise;
		}
	}

	client.pendingRequests.set(id, {
		resolve: (result: unknown) => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			resolve(result);
		},
		reject: (err: Error) => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			reject(err);
		},
		method,
	});

	writeMessage(client.proc.stdin, request).catch((err: Error) => {
		if (timeout) clearTimeout(timeout);
		client.pendingRequests.delete(id);
		cleanup();
		reject(err);
	});
	return promise;
}

export async function sendNotification(client: LspClient, method: string, params: unknown): Promise<void> {
	const notification: LspJsonRpcNotification = {
		jsonrpc: "2.0",
		method,
		params,
	};

	client.lastActivity = Date.now();
	await writeMessage(client.proc.stdin, notification);
}

/**
 * Shutdown all LSP clients.
 */
export function shutdownAll(): void {
	const clientsToShutdown = Array.from(clients.values());
	clients.clear();

	const err = new Error("LSP client shutdown");
	for (const client of clientsToShutdown) {
		const reqs = Array.from(client.pendingRequests.values());
		client.pendingRequests.clear();
		for (const pending of reqs) {
			pending.reject(err);
		}

		void (async () => {
			const timeout = new Promise<void>(resolve => setTimeout(resolve, 5_000));
			const result = sendRequest(client, "shutdown", null).catch(() => {});
			await Promise.race([result, timeout]);
			try {
				killProcessTree(client.proc.pid);
			} catch {
				client.proc.kill();
			}
		})().catch(() => {});
	}
}

/** Status of an LSP server */
export interface LspServerStatus {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	error?: string;
}

export function getActiveClients(): LspServerStatus[] {
	return Array.from(clients.values()).map(client => ({
		name: client.config.command,
		status: "ready" as const,
		fileTypes: client.config.fileTypes,
	}));
}

// =============================================================================
// Process Cleanup
// =============================================================================

if (typeof process !== "undefined") {
	process.on("beforeExit", shutdownAll);
	process.on("SIGINT", () => {
		shutdownAll();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		shutdownAll();
		process.exit(0);
	});
}
