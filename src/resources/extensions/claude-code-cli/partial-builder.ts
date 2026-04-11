/**
 * Content-block mapping helpers and streaming state tracker.
 *
 * Translates the Claude Agent SDK's `BetaRawMessageStreamEvent` sequence
 * into GSD's `AssistantMessageEvent` deltas for incremental TUI rendering.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	ServerToolUseContent,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
	WebSearchResultContent,
} from "@gsd/pi-ai";
import { hasXmlParameterTags, repairToolJson } from "@gsd/pi-ai";
import type { BetaContentBlock, BetaRawMessageStreamEvent, NonNullableUsage } from "./sdk-types.js";

// ---------------------------------------------------------------------------
// Content-block mapping helpers
// ---------------------------------------------------------------------------

/**
 * Convert a single BetaContentBlock to the corresponding GSD content type.
 */
export function mapContentBlock(
	block: BetaContentBlock,
): TextContent | ThinkingContent | ToolCall | ServerToolUseContent | WebSearchResultContent {
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
			return {
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: block.input,
			} satisfies ToolCall;

		case "server_tool_use":
			return {
				type: "serverToolUse",
				id: block.id,
				name: block.name,
				input: block.input,
			} satisfies ServerToolUseContent;

		case "web_search_tool_result":
			return {
				type: "webSearchResult",
				toolUseId: block.tool_use_id,
				content: block.content,
			} satisfies WebSearchResultContent;

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
					this.partial.content.push({
						type: "toolCall",
						id: block.id,
						name: block.name,
						arguments: {},
					});
					return { type: "toolcall_start", contentIndex, partial: this.partial };
				}
				if (block.type === "server_tool_use") {
					this.partial.content.push({
						type: "serverToolUse",
						id: block.id,
						name: block.name,
						input: block.input,
					});
					return { type: "server_tool_use", contentIndex, partial: this.partial };
				}
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
							return { type: "toolcall_end", contentIndex, toolCall: block, partial: this.partial, malformedArguments: true };
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
