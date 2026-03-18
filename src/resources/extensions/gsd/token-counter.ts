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
		encoder = tiktoken.encoding_for_model("gpt-4o") as TokenEncoder;
		return encoder;
	} catch {
		encoderFailed = true;
		return null;
	}
}

export async function countTokens(text: string): Promise<number> {
	const enc = await getEncoder();
	if (enc) {
		const tokens = enc.encode(text);
		return tokens.length;
	}
	return Math.ceil(text.length / 4);
}

export function countTokensSync(text: string): number {
	if (encoder) {
		return encoder.encode(text).length;
	}
	return Math.ceil(text.length / 4);
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
