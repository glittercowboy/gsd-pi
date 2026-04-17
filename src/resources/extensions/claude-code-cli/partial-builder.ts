/**
 * Content-block mapping helpers and streaming state tracker.
 *
 * Translates the Claude Agent SDK's `BetaRawMessageStreamEvent` sequence
 * into GSD's `AssistantMessageEvent` deltas for incremental TUI rendering.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@gsd/pi-ai";
import type { BetaContentBlock, BetaRawMessageStreamEvent, NonNullableUsage } from "./sdk-types.js";

// ---------------------------------------------------------------------------
// XML parameter tag utilities (inline replacements for removed pi-ai symbols)
// ---------------------------------------------------------------------------

/**
 * Detects XML parameter tags (inline <parameter name="...">...</parameter> form)
 * or XML wrapper (<parameters>...</parameters>) in streaming tool call JSON.
 * Replaces removed pi-ai utility (removed in pi 0.67.2).
 * T-10-05: regex only detects tag presence; does not evaluate content.
 */
function hasXmlParameterTags(s: string): boolean {
	return /<parameter[s\s>]/i.test(s);
}

/**
 * Repairs malformed LLM-generated tool JSON using three strategies:
 *
 * 1. XML parameter extraction: When inline <parameter name="key">value</parameter>
 *    tags appear inside a JSON string value, extract each as a top-level key and
 *    clean the containing string value by truncating at the closing tag boundary.
 *
 * 2. YAML bullet repair: When bare "- item" patterns appear as JSON values (not
 *    quoted), convert each bullet sequence into a JSON array.
 *
 * 3. XML wrapper extraction: Extract content from <parameters>...</parameters> wrapper.
 *
 * Replaces removed pi-ai utility (removed in pi 0.67.2).
 * T-10-05: extracts text content only, no evaluation.
 */
function repairToolJson(s: string): string {
	// Strategy 1: XML parameter tags inside JSON string values (#3751)
	// The raw JSON string may have escaped quotes: <parameter name=\"key\">val</parameter>
	// or unescaped: <parameter name="key">val</parameter>
	// We match both forms.
	if (/<parameter\s+name=/i.test(s)) {
		try {
			// Match <parameter name="key"> or <parameter name=\"key\"> in raw JSON text
			const paramPattern = /<parameter\s+name=(?:\\"|")([^"\\]+)(?:\\"|")>([\s\S]*?)<\/parameter>/gi;
			const extracted: Record<string, unknown> = {};
			let match: RegExpExecArray | null;
			while ((match = paramPattern.exec(s)) !== null) {
				const key = match[1];
				// rawVal may contain JSON-escaped characters; unescape for parsing
				const rawVal = match[2].trim().replace(/\\"/g, '"').replace(/\\n/g, "\n");
				// Attempt to parse value as JSON; fall back to string
				try {
					extracted[key] = JSON.parse(rawVal);
				} catch {
					extracted[key] = rawVal;
				}
			}

			if (Object.keys(extracted).length > 0) {
				// Remove the XML parameter block and preceding closing tag from the raw string.
				// The block looks like: </tagName>\n<parameter ...>...</parameter>...\n (with escaped chars)
				// We remove from the first </...> closing tag through the last </parameter> tag.
				const cleaned = s
					.replace(/<\/[^>]+>(?:\\n|\n)*(?:<parameter[\s\S]*?<\/parameter>(?:\\n|\n)*)+/gi, "")
					.trim();

				// Parse cleaned base JSON and merge extracted params
				const base = JSON.parse(cleaned) as Record<string, unknown>;
				return JSON.stringify({ ...base, ...extracted });
			}
		} catch {
			// Fall through to next strategy
		}
	}

	// Strategy 2: YAML bullet lists as unquoted JSON values (#2660)
	// Pattern: "key": - item1, "key2": - item2
	if (/:\s*-\s+/.test(s)) {
		try {
			// Replace bare YAML bullet sequences with JSON arrays.
			// Match: "key": - val1, - val2, "nextKey" or end
			// We need to handle: "key": - item, "nextKey" where - item is the unquoted value
			const repaired = s.replace(
				// Match a quoted key followed by colon, then one or more "- item" bullets
				// terminated by either a comma+quote (next key) or closing brace
				/"([^"]+)":\s*((?:-\s+[^,\n\-"{}[\]]+(?:,\s*(?![-"\s*{]))?)+)/g,
				(fullMatch: string, key: string, bulletBlock: string) => {
					// Extract individual bullet items
					const items = bulletBlock
						.split(/,?\s*-\s+/)
						.map((item: string) => item.trim().replace(/,\s*$/, "").trim())
						.filter((item: string) => item.length > 0);
					if (items.length === 0) return fullMatch;
					return `"${key}": ${JSON.stringify(items)}`;
				},
			);
			const parsed = JSON.parse(repaired);
			return JSON.stringify(parsed);
		} catch {
			// Fall through to next strategy
		}
	}

	// Strategy 3: XML wrapper extraction (<parameters>...</parameters>)
	const m = /<parameters[^>]*>([\s\S]*?)<\/parameters>/i.exec(s);
	return m ? m[1].trim() : s;
}

// ---------------------------------------------------------------------------
// MCP tool name parsing
// ---------------------------------------------------------------------------

/**
 * Split a Claude Code MCP tool name (`mcp__<server>__<tool>`) into its parts.
 * Returns null for non-prefixed names so callers can fall through unchanged.
 *
 * Server names may contain hyphens (`gsd-workflow`); the SDK uses the literal
 * `__` delimiter between the server name and the tool name.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice("mcp__".length);
	const delim = rest.indexOf("__");
	if (delim <= 0 || delim === rest.length - 2) return null;
	return { server: rest.slice(0, delim), tool: rest.slice(delim + 2) };
}

/**
 * Build a GSD ToolCall block from a Claude Code SDK tool_use block, stripping
 * the `mcp__<server>__` prefix from the name so registered extension renderers
 * (which use the unprefixed canonical names) can match. The original server
 * name is preserved on the block for diagnostics and rendering.
 */
function toolCallFromBlock(
	id: string,
	rawName: string,
	input: Record<string, unknown>,
): ToolCall {
	const parsed = parseMcpToolName(rawName);
	const toolCall: ToolCall = {
		type: "toolCall",
		id,
		name: parsed ? parsed.tool : rawName,
		arguments: input,
	};
	if (parsed) {
		(toolCall as ToolCall & { mcpServer?: string }).mcpServer = parsed.server;
	}
	return toolCall;
}

// ---------------------------------------------------------------------------
// Content-block mapping helpers
// ---------------------------------------------------------------------------

/**
 * Convert a single BetaContentBlock to the corresponding GSD content type.
 */
export function mapContentBlock(
	block: BetaContentBlock,
): TextContent | ThinkingContent | ToolCall {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text } satisfies TextContent;

		case "thinking":
			return {
				type: "thinking",
				thinking: block.thinking,
				...(block.signature ? { thinkingSignature: block.signature } : {}),
			} satisfies ThinkingContent;

		case "tool_use":
			return toolCallFromBlock(block.id, block.name, block.input);

		case "server_tool_use":
			// ServerToolUseContent removed from pi-ai in pi 0.67.2 — represent as text
			return {
				type: "text",
				text: `[server tool use: ${(block as Record<string, unknown>).name ?? "unknown"}]`,
			} satisfies TextContent;

		case "web_search_tool_result":
			// WebSearchResultContent removed from pi-ai in pi 0.67.2 — represent as text
			return {
				type: "text",
				text: `[web search result]`,
			} satisfies TextContent;

		default: {
			const unknown = block as Record<string, unknown>;
			return { type: "text", text: `[unknown content block: ${JSON.stringify(unknown)}]` };
		}
	}
}

export function mapStopReason(reason: string | null): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "stop";
	}
}

/**
 * Convert SDK usage + total_cost_usd into GSD's Usage shape.
 *
 * The SDK does not break cost down per-bucket, so all cost is
 * attributed to `cost.total`.
 */
export function mapUsage(sdkUsage: NonNullableUsage, totalCostUsd: number): Usage {
	return {
		input: sdkUsage.input_tokens,
		output: sdkUsage.output_tokens,
		cacheRead: sdkUsage.cache_read_input_tokens,
		cacheWrite: sdkUsage.cache_creation_input_tokens,
		totalTokens:
			sdkUsage.input_tokens +
			sdkUsage.output_tokens +
			sdkUsage.cache_read_input_tokens +
			sdkUsage.cache_creation_input_tokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: totalCostUsd,
		},
	};
}

// ---------------------------------------------------------------------------
// Zero-cost usage constant
// ---------------------------------------------------------------------------

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// ---------------------------------------------------------------------------
// Streaming partial-message state tracker
// ---------------------------------------------------------------------------

/**
 * Mutable accumulator that tracks the partial AssistantMessage being built
 * from a sequence of stream_event messages. Produces AssistantMessageEvent
 * deltas that the TUI can render incrementally.
 */
export class PartialMessageBuilder {
	private partial: AssistantMessage;
	/** Map from stream-event `index` to our content array index. */
	private indexMap = new Map<number, number>();
	/** Accumulated JSON input string per tool_use block (keyed by stream index). */
	private toolJsonAccum = new Map<number, string>();

	constructor(model: string) {
		this.partial = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "claude-code",
			model,
			usage: { ...ZERO_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	get message(): AssistantMessage {
		return this.partial;
	}

	/**
	 * Feed a BetaRawMessageStreamEvent and return the corresponding
	 * AssistantMessageEvent (or null if the event is not mapped).
	 */
	handleEvent(event: BetaRawMessageStreamEvent): AssistantMessageEvent | null {
		const streamIndex = event.index ?? 0;

		switch (event.type) {
			// ---- Block start ----
			case "content_block_start": {
				const block = event.content_block;
				if (!block) return null;

				const contentIndex = this.partial.content.length;
				this.indexMap.set(streamIndex, contentIndex);

				if (block.type === "text") {
					this.partial.content.push({ type: "text", text: "" });
					return { type: "text_start", contentIndex, partial: this.partial };
				}
				if (block.type === "thinking") {
					this.partial.content.push({ type: "thinking", thinking: "" });
					return { type: "thinking_start", contentIndex, partial: this.partial };
				}
				if (block.type === "tool_use") {
					this.toolJsonAccum.set(streamIndex, "");
					this.partial.content.push(toolCallFromBlock(block.id, block.name, {}));
					return { type: "toolcall_start", contentIndex, partial: this.partial };
				}
				// server_tool_use removed from pi-ai content types in pi 0.67.2 — skip
				return null;
			}

			// ---- Block delta ----
			case "content_block_delta": {
				const contentIndex = this.indexMap.get(streamIndex);
				if (contentIndex === undefined) return null;
				const delta = event.delta;
				if (!delta) return null;

				if (delta.type === "text_delta" && typeof delta.text === "string") {
					const existing = this.partial.content[contentIndex] as TextContent;
					existing.text += delta.text;
					return { type: "text_delta", contentIndex, delta: delta.text, partial: this.partial };
				}
				if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
					const existing = this.partial.content[contentIndex] as ThinkingContent;
					existing.thinking += delta.thinking;
					return { type: "thinking_delta", contentIndex, delta: delta.thinking, partial: this.partial };
				}
				if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
					const accum = (this.toolJsonAccum.get(streamIndex) ?? "") + delta.partial_json;
					this.toolJsonAccum.set(streamIndex, accum);
					return { type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: this.partial };
				}
				return null;
			}

			// ---- Block stop ----
			case "content_block_stop": {
				const contentIndex = this.indexMap.get(streamIndex);
				if (contentIndex === undefined) return null;
				const block = this.partial.content[contentIndex];

				if (block.type === "text") {
					return { type: "text_end", contentIndex, content: block.text, partial: this.partial };
				}
				if (block.type === "thinking") {
					return { type: "thinking_end", contentIndex, content: block.thinking, partial: this.partial };
				}
				if (block.type === "toolCall") {
					const jsonStr = this.toolJsonAccum.get(streamIndex) ?? "{}";
					const jsonForParse = hasXmlParameterTags(jsonStr) ? repairToolJson(jsonStr) : jsonStr;
					try {
						block.arguments = JSON.parse(jsonForParse);
					} catch {
						// JSON.parse failed — attempt repair for YAML-style bullet
						// lists that LLMs copy from template formatting (#2660).
						try {
							block.arguments = JSON.parse(repairToolJson(jsonForParse));
						} catch {
							// Repair also failed — stream was truncated or garbage.
							// Preserve the raw string for diagnostics but signal the
							// malformation explicitly so downstream consumers can
							// distinguish this from a healthy tool completion (#2574).
							block.arguments = { _raw: jsonStr };
							// malformedArguments removed from the toolcall_end type in pi 0.67.2;
							// cast to any to preserve the runtime signal for downstream consumers (#2574)
							return { type: "toolcall_end", contentIndex, toolCall: block, partial: this.partial, malformedArguments: true } as any;
						}
					}
					return { type: "toolcall_end", contentIndex, toolCall: block, partial: this.partial };
				}
				return null;
			}

			default:
				return null;
		}
	}
}
