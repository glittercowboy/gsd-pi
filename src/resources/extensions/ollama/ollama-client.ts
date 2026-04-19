// GSD2 — HTTP client for Ollama REST API

/**
 * Low-level HTTP client for the Ollama REST API.
 * Respects the OLLAMA_HOST environment variable for non-default endpoints.
 *
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import type {
	OllamaChatRequest,
	OllamaChatResponse,
	OllamaPsResponse,
	OllamaPullProgress,
	OllamaShowResponse,
	OllamaTagsResponse,
	OllamaVersionResponse,
} from "./types.js";
import { parseNDJsonStream } from "./ndjson-stream.js";

const DEFAULT_HOST = "http://localhost:11434";
const PROBE_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Get the Ollama host URL from OLLAMA_HOST or default.
 */
export function getOllamaHost(): string {
	const host = process.env.OLLAMA_HOST;
	if (!host) return DEFAULT_HOST;

	// OLLAMA_HOST can be just a host:port without scheme
	if (host.startsWith("http://") || host.startsWith("https://")) return host;
	return `http://${host}`;
}

/**
 * Get auth headers for Ollama API requests.
 * For cloud endpoints (OLLAMA_HOST pointing to ollama.com or remote instances),
 * OLLAMA_API_KEY is used as a Bearer token. Local Ollama ignores the header.
 */
function getAuthHeaders(): Record<string, string> {
	const apiKey = process.env.OLLAMA_API_KEY;
	if (!apiKey) return {};
	return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Merge auth headers into request options.
 */
function withAuth(options: RequestInit = {}): RequestInit {
	const authHeaders = getAuthHeaders();
	if (Object.keys(authHeaders).length === 0) return options;
	return {
		...options,
		headers: { ...authHeaders, ...(options.headers as Record<string, string> || {}) },
	};
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, withAuth({ ...options, signal: controller.signal }));
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Check if Ollama is running and reachable.
 * For cloud endpoints (OLLAMA_HOST pointing to ollama.com), uses /api/tags
 * as the probe since the root endpoint may not be available.
 */
export async function isRunning(): Promise<boolean> {
	try {
		const host = getOllamaHost();
		const isCloud = host.includes("ollama.com") || host.includes("cloud");
		const probeUrl = isCloud ? `${host}/api/tags` : `${host}/`;
		const timeout = isCloud ? REQUEST_TIMEOUT_MS : PROBE_TIMEOUT_MS;
		const response = await fetchWithTimeout(probeUrl, isCloud ? { method: "GET" } : {}, timeout);
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Get Ollama version.
 */
export async function getVersion(): Promise<string | null> {
	try {
		const response = await fetchWithTimeout(`${getOllamaHost()}/api/version`);
		if (!response.ok) return null;
		const data = (await response.json()) as OllamaVersionResponse;
		return data.version;
	} catch {
		return null;
	}
}

/**
 * List all locally available models.
 */
export async function listModels(): Promise<OllamaTagsResponse> {
	const response = await fetchWithTimeout(`${getOllamaHost()}/api/tags`);
	if (!response.ok) {
		throw new Error(`Ollama /api/tags returned ${response.status}: ${response.statusText}`);
	}
	return (await response.json()) as OllamaTagsResponse;
}

/**
 * Get detailed information about a specific model.
 */
export async function showModel(name: string): Promise<OllamaShowResponse> {
	const response = await fetchWithTimeout(`${getOllamaHost()}/api/show`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	});
	if (!response.ok) {
		throw new Error(`Ollama /api/show returned ${response.status}: ${response.statusText}`);
	}
	return (await response.json()) as OllamaShowResponse;
}

/**
 * List currently loaded/running models.
 */
export async function getRunningModels(): Promise<OllamaPsResponse> {
	const response = await fetchWithTimeout(`${getOllamaHost()}/api/ps`);
	if (!response.ok) {
		throw new Error(`Ollama /api/ps returned ${response.status}: ${response.statusText}`);
	}
	return (await response.json()) as OllamaPsResponse;
}

/**
 * Pull a model with streaming progress.
 * Calls onProgress for each progress update.
 * Returns when the pull is complete.
 */
export async function pullModel(
	name: string,
	onProgress?: (progress: OllamaPullProgress) => void,
	signal?: AbortSignal,
): Promise<void> {
	const response = await fetch(`${getOllamaHost()}/api/pull`, withAuth({
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, stream: true }),
		signal,
	}));

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Ollama /api/pull returned ${response.status}: ${text}`);
	}

	if (!response.body) {
		throw new Error("Ollama /api/pull returned no body");
	}

	for await (const progress of parseNDJsonStream<OllamaPullProgress>(response.body, signal)) {
		onProgress?.(progress);
	}
}

/**
 * Stream a chat completion via /api/chat.
 * Returns an async generator yielding each NDJSON response chunk.
 */
export async function* chat(
	request: OllamaChatRequest,
	signal?: AbortSignal,
): AsyncGenerator<OllamaChatResponse> {
	const response = await fetch(`${getOllamaHost()}/api/chat`, withAuth({
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
		signal,
	}));

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Ollama /api/chat returned ${response.status}: ${text}`);
	}

	if (!response.body) {
		throw new Error("Ollama /api/chat returned no body");
	}

	yield* parseNDJsonStream<OllamaChatResponse>(response.body, signal, true);
}

/**
 * Delete a local model.
 */
export async function deleteModel(name: string): Promise<void> {
	const response = await fetchWithTimeout(`${getOllamaHost()}/api/delete`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Ollama /api/delete returned ${response.status}: ${text}`);
	}
}

/**
 * Copy a model to a new name.
 */
export async function copyModel(source: string, destination: string): Promise<void> {
	const response = await fetchWithTimeout(`${getOllamaHost()}/api/copy`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source, destination }),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Ollama /api/copy returned ${response.status}: ${text}`);
	}
}
