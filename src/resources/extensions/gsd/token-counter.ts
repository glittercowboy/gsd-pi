export type TokenProvider = "anthropic" | "openai" | "google" | "mistral" | "bedrock" | "unknown";

const CHARS_PER_TOKEN_BY_PROVIDER: Record<TokenProvider, number> = {
	anthropic: 3.5,
	openai: 4.0,
	google: 4.0,
	mistral: 3.8,
	bedrock: 3.5,
	unknown: 4.0,
};

interface TokenEncoder {
	encode(text: string): Uint32Array | number[];
}

let encoder: TokenEncoder | null = null;
let encoderFailed = false;

async function getEncoder(): Promise<TokenEncoder | null> {
	if (encoder) return encoder;
	if (encoderFailed) return null;
	try {
		// @ts-ignore — tiktoken may not have type declarations in extensions tsconfig
		const tiktoken = await import("tiktoken");
		// Use cl100k_base — the most conservative and broadly compatible BPE encoding.
		// It is shared by GPT-3.5/GPT-4 and gives a safer (larger) estimate than
		// gpt-4o's o200k_base encoding, which produces fewer tokens for the same text
		// and would cause context windows for non-OpenAI providers to be under-counted.
		encoder = tiktoken.get_encoding("cl100k_base") as TokenEncoder;
		return encoder;
	} catch {
		encoderFailed = true;
		return null;
	}
}

/**
 * Count tokens in `text` using tiktoken (cl100k_base) when available.
 *
 * When tiktoken is not loaded, falls back to a provider-aware character-ratio
 * estimate via `estimateTokensForProvider`. Passing `provider` is recommended
 * so the heuristic fallback is as accurate as possible.
 */
export async function countTokens(text: string, provider?: TokenProvider): Promise<number> {
	const enc = await getEncoder();
	if (enc) {
		const tokens = enc.encode(text);
		return tokens.length;
	}
	return estimateTokensForProvider(text, provider ?? "unknown");
}

/**
 * Synchronous token count — only accurate after `initTokenCounter()` resolves.
 *
 * Before init, or when tiktoken is unavailable, falls back to a provider-aware
 * character-ratio estimate. Passing `provider` is recommended.
 */
export function countTokensSync(text: string, provider?: TokenProvider): number {
	if (encoder) {
		return encoder.encode(text).length;
	}
	return estimateTokensForProvider(text, provider ?? "unknown");
}

export async function initTokenCounter(): Promise<boolean> {
	const enc = await getEncoder();
	return enc !== null;
}

export function isAccurateCountingAvailable(): boolean {
	return encoder !== null;
}

export function getCharsPerToken(provider: TokenProvider): number {
	return CHARS_PER_TOKEN_BY_PROVIDER[provider] ?? CHARS_PER_TOKEN_BY_PROVIDER.unknown;
}

export function estimateTokensForProvider(text: string, provider: TokenProvider): number {
	const ratio = getCharsPerToken(provider);
	return Math.ceil(text.length / ratio);
}
