/**
 * Provider discovery adapters for runtime model enumeration.
 * Each adapter implements ProviderDiscoveryAdapter to fetch models from provider APIs.
 */

export interface DiscoveredModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface DiscoveryResult {
	provider: string;
	models: DiscoveredModel[];
	fetchedAt: number;
	error?: string;
}

export interface ProviderDiscoveryAdapter {
	provider: string;
	supportsDiscovery: boolean;
	fetchModels(apiKey: string, baseUrl?: string): Promise<DiscoveredModel[]>;
}

export const OPENAI_COMPAT_DISCOVERY_APIS = new Set([
	"openai",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

/** Per-provider TTLs in milliseconds */
export const DISCOVERY_TTLS: Record<string, number> = {
	ollama: 5 * 60 * 1000, // 5 minutes (local, models change often)
	openai: 60 * 60 * 1000, // 1 hour
	google: 60 * 60 * 1000, // 1 hour
	openrouter: 60 * 60 * 1000, // 1 hour
	default: 24 * 60 * 60 * 1000, // 24 hours
};

export function getDefaultTTL(provider: string): number {
	return DISCOVERY_TTLS[provider] ?? DISCOVERY_TTLS.default;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

// ─── OpenAI Adapter ──────────────────────────────────────────────────────────

const OPENAI_EXCLUDED_PREFIXES = ["embedding", "tts", "dall-e", "whisper", "text-embedding", "davinci", "babbage"];

function asPositiveNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const n = Number.parseFloat(value);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return undefined;
}

function pickFirstPositiveNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = asPositiveNumber(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function discoverInputModalities(rawModel: Record<string, unknown>, id: string): Array<"text" | "image"> {
	const directModalities = rawModel.input_modalities;
	const capabilitiesModalities = (rawModel.capabilities as Record<string, unknown> | undefined)?.input_modalities;
	const source = Array.isArray(directModalities)
		? directModalities
		: Array.isArray(capabilitiesModalities)
			? capabilitiesModalities
			: [];
	const supportsImage = source.some((m) => typeof m === "string" && /image|vision/i.test(m))
		|| /vision|image|omni|multimodal/i.test(id);
	return supportsImage ? ["text", "image"] : ["text"];
}

function parseOpenAICompatibleModel(rawModel: Record<string, unknown>): DiscoveredModel | undefined {
	const id = typeof rawModel.id === "string" ? rawModel.id : "";
	if (!id) return undefined;
	if (OPENAI_EXCLUDED_PREFIXES.some((prefix) => id.startsWith(prefix))) return undefined;

	const contextWindow = pickFirstPositiveNumber(rawModel, [
		"context_window",
		"context_length",
		"max_context_length",
		"max_input_tokens",
		"input_token_limit",
		"max_model_len",
	]);
	const maxTokens = pickFirstPositiveNumber(rawModel, [
		"max_output_tokens",
		"output_token_limit",
		"max_completion_tokens",
		"max_tokens",
	]);
	const reasoning = rawModel.reasoning === true
		|| rawModel.supports_reasoning === true
		|| ((rawModel.capabilities as Record<string, unknown> | undefined)?.reasoning === true);

	return {
		id,
		name: typeof rawModel.name === "string" && rawModel.name.length > 0 ? rawModel.name : id,
		contextWindow,
		maxTokens,
		reasoning,
		input: discoverInputModalities(rawModel, id),
	};
}

class OpenAIDiscoveryAdapter implements ProviderDiscoveryAdapter {
	provider: string;
	supportsDiscovery = true;

	constructor(provider: string) {
		this.provider = provider;
	}

	async fetchModels(apiKey: string, baseUrl?: string): Promise<DiscoveredModel[]> {
		const url = `${baseUrl ?? "https://api.openai.com"}/v1/models`;
		const response = await fetchWithTimeout(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});

		if (!response.ok) {
			throw new Error(`OpenAI models API returned ${response.status}: ${response.statusText}`);
		}

		const data = (await response.json()) as { data?: Array<Record<string, unknown>> };
		return (data.data ?? [])
			.map((m) => parseOpenAICompatibleModel(m))
			.filter((m): m is DiscoveredModel => !!m);
	}
}

// ─── Ollama Adapter ──────────────────────────────────────────────────────────

class OllamaDiscoveryAdapter implements ProviderDiscoveryAdapter {
	provider = "ollama";
	supportsDiscovery = true;

	async fetchModels(_apiKey: string, baseUrl?: string): Promise<DiscoveredModel[]> {
		const url = `${baseUrl ?? "http://localhost:11434"}/api/tags`;
		const response = await fetchWithTimeout(url);

		if (!response.ok) {
			throw new Error(`Ollama tags API returned ${response.status}: ${response.statusText}`);
		}

		const data = (await response.json()) as {
			models: Array<{ name: string; size: number; details?: { parameter_size?: string } }>;
		};

		return (data.models ?? []).map((m) => ({
			id: m.name,
			name: m.name,
			input: ["text" as const],
		}));
	}
}

// ─── OpenRouter Adapter ──────────────────────────────────────────────────────

class OpenRouterDiscoveryAdapter implements ProviderDiscoveryAdapter {
	provider = "openrouter";
	supportsDiscovery = true;

	async fetchModels(apiKey: string, baseUrl?: string): Promise<DiscoveredModel[]> {
		const url = `${baseUrl ?? "https://openrouter.ai"}/api/v1/models`;
		const response = await fetchWithTimeout(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});

		if (!response.ok) {
			throw new Error(`OpenRouter models API returned ${response.status}: ${response.statusText}`);
		}

		const data = (await response.json()) as {
			data: Array<{
				id: string;
				name: string;
				context_length?: number;
				top_provider?: { max_completion_tokens?: number };
				pricing?: { prompt: string; completion: string };
			}>;
		};

		return (data.data ?? []).map((m) => {
			const cost =
				m.pricing?.prompt !== undefined && m.pricing?.completion !== undefined
					? {
							input: parseFloat(m.pricing.prompt) * 1_000_000,
							output: parseFloat(m.pricing.completion) * 1_000_000,
							cacheRead: 0,
							cacheWrite: 0,
						}
					: undefined;

			return {
				id: m.id,
				name: m.name,
				contextWindow: m.context_length,
				maxTokens: m.top_provider?.max_completion_tokens,
				cost,
				input: ["text" as const, "image" as const],
			};
		});
	}
}

// ─── Google/Gemini Adapter ───────────────────────────────────────────────────

class GoogleDiscoveryAdapter implements ProviderDiscoveryAdapter {
	provider = "google";
	supportsDiscovery = true;

	async fetchModels(apiKey: string, baseUrl?: string): Promise<DiscoveredModel[]> {
		const url = `${baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models?key=${apiKey}`;
		const response = await fetchWithTimeout(url);

		if (!response.ok) {
			throw new Error(`Google models API returned ${response.status}: ${response.statusText}`);
		}

		const data = (await response.json()) as {
			models: Array<{
				name: string;
				displayName: string;
				supportedGenerationMethods?: string[];
				inputTokenLimit?: number;
				outputTokenLimit?: number;
			}>;
		};

		return (data.models ?? [])
			.filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
			.map((m) => ({
				id: m.name.replace("models/", ""),
				name: m.displayName,
				contextWindow: m.inputTokenLimit,
				maxTokens: m.outputTokenLimit,
				input: ["text" as const, "image" as const],
			}));
	}
}

// ─── Static Adapter (no discovery) ───────────────────────────────────────────

class StaticDiscoveryAdapter implements ProviderDiscoveryAdapter {
	provider: string;
	supportsDiscovery = false;

	constructor(provider: string) {
		this.provider = provider;
	}

	async fetchModels(): Promise<DiscoveredModel[]> {
		return [];
	}
}

// ─── Registry ────────────────────────────────────────────────────────────────

const adapters: Record<string, ProviderDiscoveryAdapter> = {
	openai: new OpenAIDiscoveryAdapter("openai"),
	ollama: new OllamaDiscoveryAdapter(),
	openrouter: new OpenRouterDiscoveryAdapter(),
	google: new GoogleDiscoveryAdapter(),
	anthropic: new StaticDiscoveryAdapter("anthropic"),
	bedrock: new StaticDiscoveryAdapter("bedrock"),
	"azure-openai": new StaticDiscoveryAdapter("azure-openai"),
	groq: new StaticDiscoveryAdapter("groq"),
	cerebras: new StaticDiscoveryAdapter("cerebras"),
	xai: new StaticDiscoveryAdapter("xai"),
	mistral: new StaticDiscoveryAdapter("mistral"),
};

export function supportsDiscoveryForApi(api: string | undefined): boolean {
	if (!api) return false;
	return OPENAI_COMPAT_DISCOVERY_APIS.has(api);
}

export function getDiscoveryAdapter(provider: string, providerApis?: Iterable<string>): ProviderDiscoveryAdapter {
	const known = adapters[provider];
	if (known) return known;

	if (providerApis) {
		for (const api of providerApis) {
			if (supportsDiscoveryForApi(api)) {
				return new OpenAIDiscoveryAdapter(provider);
			}
		}
	}

	return new StaticDiscoveryAdapter(provider);
}

export function getDiscoverableProviders(): string[] {
	return Object.entries(adapters)
		.filter(([, adapter]) => adapter.supportsDiscovery)
		.map(([name]) => name);
}
