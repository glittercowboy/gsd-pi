/**
 * Google Search Extension
 *
 * Provides a `google_search` tool that performs web searches via Gemini's
 * Google Search grounding feature. Uses the user's existing GEMINI_API_KEY
 * and Google Cloud GenAI credits.
 *
 * The tool sends queries to Gemini Flash with `googleSearch: {}` enabled.
 * Gemini internally performs Google searches, synthesizes an answer, and
 * returns it with source URLs from grounding metadata.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchSource {
	title: string;
	uri: string;
	domain: string;
}

interface SearchResult {
	answer: string;
	sources: SearchSource[];
	searchQueries: string[];
	cached: boolean;
}

interface SearchDetails {
	query: string;
	sourceCount: number;
	cached: boolean;
	durationMs: number;
	error?: string;
}

// ── Lazy singleton client ────────────────────────────────────────────────────

type GoogleGenAIClient = {
	models: {
		generateContent: (args: {
			model: string;
			contents: string;
			config?: {
				tools?: Array<{ googleSearch: Record<string, never> }>;
				abortSignal?: AbortSignal;
			};
		}) => Promise<any>;
	};
};

let client: GoogleGenAIClient | null = null;

async function getClient(): Promise<GoogleGenAIClient> {
	if (!client) {
		const { GoogleGenAI } = await import("@google/genai");
		client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	}
	return client;
}

/**
 * Perform a search using OAuth credentials via the Cloud Code Assist API.
 * This is used as a fallback when GEMINI_API_KEY is not set.
 */
async function searchWithOAuth(
	query: string,
	accessToken: string,
	projectId: string,
	signal?: AbortSignal,
): Promise<SearchResult> {
	const model = process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash";
	const url = `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`;

	const GEMINI_CLI_HEADERS = {
	        ideType: "IDE_UNSPECIFIED",
	        platform: "PLATFORM_UNSPECIFIED",
	        pluginType: "GEMINI",
	};

	const executeFetch = async (retries = 3): Promise<Response> => {
	        const response = await fetch(url, {
	                method: "POST",
	                headers: {
	                        Authorization: `Bearer ${accessToken}`,
	                        "Content-Type": "application/json",
	                        "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	                        "X-Goog-Api-Client": "gl-node/22.17.0",
	                        "Client-Metadata": JSON.stringify(GEMINI_CLI_HEADERS),
	                },
	                body: JSON.stringify({
	                        project: projectId,
	                        model,
	                        request: {
	                                contents: [{ parts: [{ text: query }] }],
	                                tools: [{ googleSearch: {} }],
	                        },
	                }),
	                signal,
	        });

	        if (!response.ok && retries > 0 && (response.status === 429 || response.status >= 500)) {
	                await new Promise((resolve) => setTimeout(resolve, 1000 * (4 - retries)));
	                return executeFetch(retries - 1);
	        }

	        return response;
	};

	const response = await executeFetch();

	if (!response.ok) {
	        const errorText = await response.text();
	        throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText}`);
	}

	// Note: streamGenerateContent returns SSE; for now, we consume all chunks.
	// For simplicity and to match the previous structure, we'll read to end.
	const text = await response.text();
	const jsonLines = text.split("\n")
	        .filter(l => l.startsWith("data:"))
	        .map(l => l.slice(5).trim())
	        .filter(l => l.length > 0);

	let data;
	if (jsonLines.length > 0) {
	    // Aggregate chunks if needed, but for now we take the last chunk or assume it's one
	    data = JSON.parse(jsonLines[jsonLines.length - 1]);
	} else {
	    data = JSON.parse(text);
	}	const candidate = data.response?.candidates?.[0];
	const answer = candidate?.content?.parts?.find((p: any) => p.text)?.text ?? "";
	const grounding = candidate?.groundingMetadata;

	const sources: SearchSource[] = [];
	const seenTitles = new Set<string>();
	if (grounding?.groundingChunks) {
		for (const chunk of grounding.groundingChunks) {
			if (chunk.web) {
				const title = chunk.web.title ?? "Untitled";
				if (seenTitles.has(title)) continue;
				seenTitles.add(title);
				const domain = chunk.web.domain ?? title;
				sources.push({
					title,
					uri: chunk.web.uri ?? "",
					domain,
				});
			}
		}
	}

	const searchQueries = grounding?.webSearchQueries ?? [];
	return { answer, sources, searchQueries, cached: false };
}

// ── In-session cache ─────────────────────────────────────────────────────────

const resultCache = new Map<string, SearchResult>();

function cacheKey(query: string): string {
	return query.toLowerCase().trim();
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "google_search",
		label: "Google Search",
		description:
			"Search the web using Google Search via Gemini. " +
			"Returns an AI-synthesized answer grounded in Google Search results, plus source URLs. " +
			"Use this when you need current information from the web: recent events, documentation, " +
			"product details, technical references, news, etc. " +
			"Requires GEMINI_API_KEY or Google login. Alternative to Brave-based search tools.",
		promptSnippet: "Search the web via Google Search to get current information with sources",
		promptGuidelines: [
			"Use google_search when you need up-to-date web information that isn't in your training data.",
			"Be specific with queries for better results, e.g. 'Next.js 15 app router migration guide' not just 'Next.js'.",
			"The tool returns both an answer and source URLs. Cite sources when sharing results with the user.",
			"Results are cached per-session, so repeated identical queries are free.",
			"You can still use fetch_page to read a specific URL if needed after getting results from google_search.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "The search query, e.g. 'latest Node.js LTS version' or 'how to configure Tailwind v4'",
			}),
			maxSources: Type.Optional(
				Type.Number({
					description: "Maximum number of source URLs to include (default 5, max 10).",
					minimum: 1,
					maximum: 10,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const startTime = Date.now();
			const maxSources = Math.min(Math.max(params.maxSources ?? 5, 1), 10);

			// Check for credentials
			let oauthToken: string | undefined;
			let projectId: string | undefined;

			if (!process.env.GEMINI_API_KEY) {
				const oauthRaw = await ctx.modelRegistry.getApiKeyForProvider("google-gemini-cli");
				if (oauthRaw) {
					try {
						const parsed = JSON.parse(oauthRaw);
						oauthToken = parsed.token;
						projectId = parsed.projectId;
					} catch {
						// Fall through to error
					}
				}
			}

			if (!process.env.GEMINI_API_KEY && (!oauthToken || !projectId)) {
				return {
					content: [
						{
							type: "text",
							text: "Error: No authentication found for Google Search. Please set GEMINI_API_KEY or log in via Google.\n\nExample: export GEMINI_API_KEY=your_key or use /login google",
						},
					],
					isError: true,
					details: {
						query: params.query,
						sourceCount: 0,
						cached: false,
						durationMs: Date.now() - startTime,
						error: "auth_error: No credentials set",
					} as SearchDetails,
				};
			}

			// Check cache
			const key = cacheKey(params.query);
			if (resultCache.has(key)) {
				const cached = resultCache.get(key)!;
				const output = formatOutput(cached, maxSources);
				return {
					content: [{ type: "text", text: output }],
					details: {
						query: params.query,
						sourceCount: cached.sources.length,
						cached: true,
						durationMs: Date.now() - startTime,
					} as SearchDetails,
				};
			}

			// Call Gemini with Google Search grounding
			let result: SearchResult;
			try {
				if (process.env.GEMINI_API_KEY) {
					const ai = await getClient();

					// Add a 30-second timeout to prevent hanging (#1100)
					const timeoutController = new AbortController();
					const timeoutId = setTimeout(() => timeoutController.abort(), 30_000);
					const combinedSignal = signal
						? AbortSignal.any([signal, timeoutController.signal])
						: timeoutController.signal;

					let response;
					try {
						response = await ai.models.generateContent({
							model: process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash",
							contents: params.query,
							config: {
								tools: [{ googleSearch: {} }],
								abortSignal: combinedSignal,
							},
						});
					} finally {
						clearTimeout(timeoutId);
					}

					// Extract answer text
					const answer = response.text ?? "";

					// Extract grounding metadata
					const candidate = response.candidates?.[0];
					const grounding = candidate?.groundingMetadata;

					// Parse sources from grounding chunks
					const sources: SearchSource[] = [];
					const seenTitles = new Set<string>();
					if (grounding?.groundingChunks) {
						for (const chunk of grounding.groundingChunks) {
							if (chunk.web) {
								const title = chunk.web.title ?? "Untitled";
								// Dedupe by title since URIs are redirect URLs that differ per call
								if (seenTitles.has(title)) continue;
								seenTitles.add(title);
								// domain field is not available via Gemini API, use title as fallback
								// (title is typically the domain name, e.g. "wikipedia.org")
								const domain = chunk.web.domain ?? title;
								sources.push({
									title,
									uri: chunk.web.uri ?? "",
									domain,
								});
							}
						}
					}

					// Extract search queries Gemini actually performed
					const searchQueries = grounding?.webSearchQueries ?? [];
					result = { answer, sources, searchQueries, cached: false };
				} else {
					result = await searchWithOAuth(params.query, oauthToken!, projectId!, signal);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);

				let errorType = "api_error";
				if (msg.includes("401") || msg.includes("UNAUTHENTICATED")) {
					errorType = "auth_error";
				} else if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
					errorType = "rate_limit";
				}

				return {
					content: [
						{
							type: "text",
							text: `Google Search failed (${errorType}): ${msg}`,
						},
					],
					isError: true,
					details: {
						query: params.query,
						sourceCount: 0,
						cached: false,
						durationMs: Date.now() - startTime,
						error: `${errorType}: ${msg}`,
					} as SearchDetails,
				};
			}

			// Cache the result
			resultCache.set(key, result);

			// Format and truncate output
			const rawOutput = formatOutput(result, maxSources);
			const truncation = truncateHead(rawOutput, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let finalText = truncation.content;
			if (truncation.truncated) {
				finalText +=
					`\n\n[Truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines` +
					` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			return {
				content: [{ type: "text", text: finalText }],
				details: {
					query: params.query,
					sourceCount: result.sources.length,
					cached: false,
					durationMs: Date.now() - startTime,
				} as SearchDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("google_search "));
			text += theme.fg("accent", `"${args.query}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			const d = result.details as SearchDetails | undefined;

			if (isPartial) return new Text(theme.fg("warning", "Searching Google..."), 0, 0);
			if ((result as any).isError || d?.error) {
				return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
			}

			let text = theme.fg("success", `${d?.sourceCount ?? 0} sources`);
			text += theme.fg("dim", ` (${d?.durationMs ?? 0}ms)`);
			if (d?.cached) text += theme.fg("dim", " · cached");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const preview = content.text.split("\n").slice(0, 8).join("\n");
					text += "\n\n" + theme.fg("dim", preview);
					if (content.text.split("\n").length > 8) {
						text += "\n" + theme.fg("muted", "...");
					}
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// ── Session cleanup ─────────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		resultCache.clear();
		client = null;
	});

	// ── Startup notification ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (process.env.GEMINI_API_KEY) return;

		const hasOAuth = await ctx.modelRegistry.authStorage.hasAuth("google-gemini-cli");
		if (!hasOAuth) {
			ctx.ui.notify(
				"Google Search: No authentication set. Log in via Google or set GEMINI_API_KEY to use google_search.",
				"warning",
			);
		}
	});
}

// ── Output formatting ────────────────────────────────────────────────────────

function formatOutput(result: SearchResult, maxSources: number): string {
	const lines: string[] = [];

	// Answer
	if (result.answer) {
		lines.push(result.answer);
	} else {
		lines.push("(No answer text returned from search)");
	}

	// Sources
	if (result.sources.length > 0) {
		lines.push("");
		lines.push("Sources:");
		const sourcesToShow = result.sources.slice(0, maxSources);
		for (let i = 0; i < sourcesToShow.length; i++) {
			const s = sourcesToShow[i];
			lines.push(`[${i + 1}] ${s.title} - ${s.domain}`);
			lines.push(`    ${s.uri}`);
		}
		if (result.sources.length > maxSources) {
			lines.push(`(${result.sources.length - maxSources} more sources omitted)`);
		}
	} else {
		lines.push("");
		lines.push("(No source URLs found in grounding metadata)");
	}

	// Search queries
	if (result.searchQueries.length > 0) {
		lines.push("");
		lines.push(`Searches performed: ${result.searchQueries.map((q) => `"${q}"`).join(", ")}`);
	}

	return lines.join("\n");
}
