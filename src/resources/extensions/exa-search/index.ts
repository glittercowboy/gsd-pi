/**
 * Exa Search Extension — 原生 pi 扩展
 *
 * 提供两个搜索工具：
 *   codesearch  — 代码上下文搜索（API、库、SDK 文档与示例）
 *   websearch   — 通用网页搜索
 *
 * 通过 Exa MCP 兼容端点实现，无需 API Key。
 * 参照 Context7 扩展模式实现，使用共享 exa.ts 模块。
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import {
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { callExaCodeSearch, callExaWebSearch } from "../search-the-web/exa.js";

// ─── 会话缓存 ────────────────────────────────────────────────────────────────

const codeSearchCache = new Map<string, { text: string; timestamp: number }>();
const webSearchCache = new Map<string, { text: string; timestamp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── 缓存辅助 ────────────────────────────────────────────────────────────────

function getCached(
	cache: Map<string, { text: string; timestamp: number }>,
	key: string,
): string | null {
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
		cache.delete(key);
		return null;
	}
	return entry.text;
}

function setCached(
	cache: Map<string, { text: string; timestamp: number }>,
	key: string,
	text: string,
): void {
	cache.set(key, { text, timestamp: Date.now() });
}

function truncateOutput(text: string): { content: string; truncated: boolean } {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let content = truncation.content;
	if (truncation.truncated) {
		content += `\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	}
	return { content, truncated: truncation.truncated };
}

// ─── 扩展 ────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── codesearch 工具 ────────────────────────────────────────────────────

	pi.registerTool({
		name: "codesearch",
		label: "Code Search",
		description:
			"Search for code context, API documentation, and SDK examples using Exa. " +
			"Use this to find relevant code snippets, library documentation, and programming examples. " +
			"Works for any programming language, framework, or library.",
		promptSnippet: "Search for code examples and API documentation",
		promptGuidelines: [
			"Use codesearch when you need current documentation, code examples, or API references for a library or framework.",
			"Be specific in your query — 'React useState hook cleanup pattern' returns better results than just 'React hooks'.",
			"Start with tokensNum=5000. Increase to 10000-20000 only if you need more comprehensive documentation.",
			"codesearch returns content from across the web — it's not limited to the current project.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query for code context, e.g. 'React useState hook examples', " +
					"'Python pandas dataframe filtering', 'Express.js middleware setup'",
			}),
			tokensNum: Type.Optional(
				Type.Number({
					description:
						"Number of tokens to return (1000-50000, default 5000). " +
						"Use lower values for focused queries, higher for comprehensive docs.",
					minimum: 1000,
					maximum: 50000,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const query = params.query.trim();
			const tokensNum = params.tokensNum ?? 5000;
			const cacheKey = `code:${query}::${tokensNum}`;

			// Check cache
            const cached = getCached(codeSearchCache, cacheKey);
            if (cached) {
                return {
                    content: [{ type: "text", text: cached }],
                    details: { query, tokensNum, cached: true as const, truncated: false as const, charCount: cached.length },
                };
            }

			// Call Exa API
			const result = await callExaCodeSearch(query, tokensNum, signal);

			const output =
				result ||
				"No code snippets or documentation found. " +
					"Try a different query or be more specific about the library or framework.";

			const { content: finalText, truncated } = truncateOutput(output);
			setCached(codeSearchCache, cacheKey, finalText);

			return {
				content: [{ type: "text", text: finalText }],
				details: {
					query,
					tokensNum,
					cached: false,
					truncated,
					charCount: finalText.length,
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("codesearch "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.tokensNum && args.tokensNum !== 5000) {
				text += theme.fg("dim", ` (${args.tokensNum} tokens)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			const d = result.details as {
				query: string;
				tokensNum: number;
				cached: boolean;
				truncated: boolean;
				charCount: number;
			} | undefined;

			if (isPartial) return new Text(theme.fg("warning", "Searching Exa..."), 0, 0);

			let text = theme.fg("success", `${(d?.charCount ?? 0).toLocaleString()} chars`);
			if (d?.cached) text += theme.fg("dim", " (cached)");
			if (d?.truncated) text += theme.fg("warning", " truncated");
			text += theme.fg("dim", ` · "${d?.query}"`);

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const preview = content.text.split("\n").slice(0, 12).join("\n");
					text += "\n\n" + theme.fg("dim", preview);
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// ── websearch 工具 ────────────────────────────────────────────────────

	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description:
			"Search the web using Exa. Returns relevant web pages with content. " +
			"Supports different search depths and live crawling for up-to-date results. " +
			"No API key required.",
		promptSnippet: "Search the web for information",
		promptGuidelines: [
			"Use websearch for general information queries, current events, or when codesearch doesn't cover the topic.",
			"Use type='deep' for comprehensive research queries, 'fast' for quick lookups, or 'auto' for balanced results.",
			"Set livecrawl='preferred' when you need the most current information from web pages.",
			"Limit numResults to 3-5 for focused queries, 8-10 for broader research.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Web search query",
			}),
			numResults: Type.Optional(
				Type.Number({
					description: "Number of search results to return (default: 8)",
					minimum: 1,
					maximum: 20,
				}),
			),
			type: Type.Optional(
				Type.Union(
					[Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")],
					{
						description:
							"Search type: 'auto' (balanced, default), 'fast' (quick), 'deep' (comprehensive)",
					},
				),
			),
			livecrawl: Type.Optional(
				Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
					description:
						"Live crawl mode: 'fallback' (default) or 'preferred' (prioritize fresh content)",
				}),
			),
			contextMaxCharacters: Type.Optional(
				Type.Number({
					description: "Maximum characters for context (default: 10000)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const query = params.query.trim();
			const cacheKey = `web:${query}::${params.type ?? "auto"}::${params.numResults ?? 8}`;

            const cached = getCached(webSearchCache, cacheKey);
            if (cached) {
                return {
                    content: [{ type: "text", text: cached }],
                    details: { query, cached: true as const, truncated: false as const, charCount: cached.length },
                };
            }

			const result = await callExaWebSearch(query, {
				numResults: params.numResults,
				type: params.type,
				livecrawl: params.livecrawl,
				contextMaxCharacters: params.contextMaxCharacters,
			}, signal);

			const output = result || "No search results found. Try a different query.";

			const { content: finalText, truncated } = truncateOutput(output);
			setCached(webSearchCache, cacheKey, finalText);

			return {
				content: [{ type: "text", text: finalText }],
				details: {
					query,
					cached: false,
					truncated,
					charCount: finalText.length,
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("websearch "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.type && args.type !== "auto") {
				text += theme.fg("dim", ` (${args.type})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			const d = result.details as {
				query: string;
				cached: boolean;
				truncated: boolean;
				charCount: number;
			} | undefined;

			if (isPartial) return new Text(theme.fg("warning", "Searching web..."), 0, 0);

			let text = theme.fg("success", `${(d?.charCount ?? 0).toLocaleString()} chars`);
			if (d?.cached) text += theme.fg("dim", " (cached)");
			if (d?.truncated) text += theme.fg("warning", " truncated");
			text += theme.fg("dim", ` · "${d?.query}"`);

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const preview = content.text.split("\n").slice(0, 12).join("\n");
					text += "\n\n" + theme.fg("dim", preview);
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// ── 生命周期 ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("Exa search ready — no API key required", "info");
	});

	pi.on("session_shutdown", async () => {
		codeSearchCache.clear();
		webSearchCache.clear();
	});
}
