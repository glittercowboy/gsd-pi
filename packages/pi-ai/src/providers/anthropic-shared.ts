/**
 * Shared utilities for Anthropic providers (direct API and Vertex AI).
 * Includes message conversion, tool normalisation, cache-control helpers,
 * adaptive-thinking detection, and the core `processAnthropicStream` pump.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	ServerToolUseContent,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	WebSearchResultContent,
} from "../types.js";

/** API types that use the Anthropic Messages protocol */
export type AnthropicApi = "anthropic-messages" | "anthropic-vertex";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { hasXmlParameterTags, repairToolJson } from "../utils/repair-tool-json.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessagesWithReport } from "./transform-messages.js";

/** Effort levels accepted by the Anthropic `output_config.effort` field. */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Extended stream options for Anthropic-protocol providers (direct API and Vertex AI). */
export interface AnthropicOptions extends StreamOptions {
	thinkingEnabled?: boolean;
	thinkingBudgetTokens?: number;
	effort?: AnthropicEffort;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

/** Canonical list of Claude Code built-in tool names used for case-normalisation. */
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

/** Lowercase-keyed lookup map built from `claudeCodeTools` for O(1) case-insensitive name resolution. */
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

/** Normalise a tool name to its canonical Claude Code casing. */
export const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
/** Reverse-map a Claude Code tool name back to the provider's own casing, using the tools list if available. */
export const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

/** Resolve cache retention and return the matching Anthropic `cache_control` block. */
export function getCacheControl(
	baseUrl: string,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: { type: "ephemeral"; ttl?: "1h" } } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

/** Convert GSD content blocks to the Anthropic SDK's user-message content format. */
export function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

/** Returns true for models that support the adaptive thinking API (Opus 4.6/4.7, Sonnet 4.6/4.7, Haiku 4.5). */
export function supportsAdaptiveThinking(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6") ||
		modelId.includes("sonnet-4-7") ||
		modelId.includes("sonnet-4.7") ||
		modelId.includes("haiku-4-5") ||
		modelId.includes("haiku-4.5")
	);
}

/** Map a GSD thinking level to the corresponding Anthropic effort value; model-specific for xhigh. */
export function mapThinkingLevelToEffort(level: string | undefined, modelId: string): AnthropicEffort {
	switch (level) {
		case "minimal":
			return "low";
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			if (modelId.includes("opus-4-7") || modelId.includes("opus-4.7")) return "xhigh";
			if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) return "max";
			return "high";
		default:
			return "high";
	}
}

/** Returns true for low-level network errors that are safe to retry (reset, pipe, timeout, DNS). */
export function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	const code = (error as NodeJS.ErrnoException).code;
	return (
		code === 'ECONNRESET' ||
		code === 'EPIPE' ||
		code === 'ETIMEDOUT' ||
		code === 'ENOTFOUND' ||
		code === 'EAI_AGAIN' ||
		msg.includes('connector_closed') ||
		msg.includes('socket hang up') ||
		msg.includes('network') ||
		msg.includes('connection') && msg.includes('closed') ||
		msg.includes('fetch failed')
	);
}

/** Parse `Retry-After` / rate-limit reset headers and return a suggested delay in milliseconds. */
export function extractRetryAfterMs(headers: Headers | { get(name: string): string | null }, errorText = ""): number | undefined {
	const normalizeDelay = (ms: number): number | undefined => (ms > 0 ? Math.ceil(ms + 1000) : undefined);

	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) {
			const delay = normalizeDelay(seconds * 1000);
			if (delay !== undefined) return delay;
		}
		const asDate = new Date(retryAfter).getTime();
		if (!Number.isNaN(asDate)) {
			const delay = normalizeDelay(asDate - Date.now());
			if (delay !== undefined) return delay;
		}
	}

	for (const header of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
		const value = headers.get(header);
		if (value) {
			const resetSeconds = Number(value);
			if (Number.isFinite(resetSeconds)) {
				const delay = normalizeDelay(resetSeconds * 1000 - Date.now());
				if (delay !== undefined) return delay;
			}
		}
	}

	return undefined;
}

/** Sanitise a tool-call ID to only alphanumeric, underscore, and hyphen characters (max 64 chars). */
export function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** Convert GSD messages to Anthropic SDK `MessageParam` format, applying cache control to the last user turn. */
export function convertMessages(
	messages: Message[],
	model: Model<AnthropicApi>,
	isOAuthToken: boolean,
	cacheControl?: { type: "ephemeral"; ttl?: "1h" },
): MessageParam[] {
	const params: MessageParam[] = [];

	const transformedMessages = transformMessagesWithReport(messages, model, normalizeToolCallId, "anthropic-messages");

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				let filteredBlocks = !model?.input.includes("image") ? blocks.filter((b) => b.type !== "image") : blocks;
				filteredBlocks = filteredBlocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push({
							type: "text",
							text: sanitizeSurrogates(block.thinking),
						});
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				} else if (block.type === "serverToolUse") {
					blocks.push({
						type: "server_tool_use",
						id: block.id,
						name: block.name,
						input: block.input ?? {},
					} as any);
				} else if (block.type === "webSearchResult") {
					blocks.push({
						type: "web_search_tool_result",
						tool_use_id: block.toolUseId,
						content: block.content,
					} as any);
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			const toolResults: ContentBlockParam[] = [];

			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			i = j - 1;

			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

/** Convert GSD tools to Anthropic SDK tool definitions, applying cache control to the last entry. */
export function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	cacheControl?: { type: "ephemeral"; ttl?: "1h" },
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	const result = tools.map((tool) => {
		const jsonSchema = tool.parameters as any;

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			input_schema: {
				type: "object" as const,
				properties: jsonSchema.properties || {},
				required: jsonSchema.required || [],
			},
		};
	});

	// Add cache breakpoint to last tool — covers entire tool block
	if (cacheControl && result.length > 0) {
		(result[result.length - 1] as any).cache_control = cacheControl;
	}

	return result;
}

/** Build the `MessageCreateParamsStreaming` payload for an Anthropic API call. */
export function buildParams(
	model: Model<AnthropicApi>,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model.baseUrl, options?.cacheRetention);
	const apiModelId = model.id.replace(/\[.*\]$/, "");
	const params: MessageCreateParamsStreaming = {
		model: apiModelId,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	if (options?.temperature !== undefined && !options?.thinkingEnabled) {
		params.temperature = options.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools, isOAuthToken, cacheControl);
	}

	if (options?.thinkingEnabled && model.reasoning) {
		if (supportsAdaptiveThinking(model.id)) {
			params.thinking = { type: "adaptive" };
			if (options.effort) {
				params.output_config = { effort: options.effort };
			}
		} else {
			params.thinking = {
				type: "enabled",
				budget_tokens: options.thinkingBudgetTokens || 1024,
			};
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

/** Map an Anthropic API stop reason string to GSD's internal `StopReason`. */
export function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn":
			return "pauseTurn";
		case "stop_sequence":
			return "stop";
		case "sensitive":
			return "error";
		default:
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}

/** Arguments for `processAnthropicStream`. */
export interface StreamAnthropicArgs {
	client: Anthropic;
	model: Model<AnthropicApi>;
	context: Context;
	isOAuthToken: boolean;
	options?: AnthropicOptions;
	AnthropicSdkClass?: typeof Anthropic;
}

/** Drive an Anthropic streaming response, pushing `AssistantMessageEvent`s into `stream` until done or error. */
export function processAnthropicStream(
	stream: AssistantMessageEventStream,
	args: StreamAnthropicArgs,
): void {
	const { client, model, context, isOAuthToken, options, AnthropicSdkClass } = args;

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			let params = buildParams(model, context, isOAuthToken, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | ServerToolUseContent | WebSearchResultContent) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuthToken
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					} else if ((event.content_block as any).type === "server_tool_use") {
						const serverBlock = event.content_block as any;
						const block: Block = {
							type: "serverToolUse",
							id: serverBlock.id,
							name: serverBlock.name,
							input: serverBlock.input,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "server_tool_use", contentIndex: output.content.length - 1, partial: output });
					} else if ((event.content_block as any).type === "web_search_tool_result") {
						const resultBlock = event.content_block as any;
						const block: Block = {
							type: "webSearchResult",
							toolUseId: resultBlock.tool_use_id,
							content: resultBlock.content,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "web_search_result", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							// Try strict parse first; if it fails, attempt YAML bullet
							// repair (#2660) before falling back to the lenient streaming
							// parser which silently swallows errors.
							const raw = block.partialJson ?? "";
							const rawForParse = hasXmlParameterTags(raw) ? repairToolJson(raw) : raw;
							let parsed: Record<string, any> | undefined;
							try {
								parsed = JSON.parse(rawForParse);
							} catch {
								try {
									parsed = JSON.parse(repairToolJson(rawForParse));
								} catch {
									// Fall through to streaming parser
								}
							}
							block.arguments = parsed ?? parseStreamingJson(block.partialJson);
							delete (block as any).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_reason) {
						output.stopReason = mapStopReason(event.delta.stop_reason);
					}
					if (event.usage.input_tokens != null) {
						output.usage.input = event.usage.input_tokens;
					}
					if (event.usage.output_tokens != null) {
						output.usage.output = event.usage.output_tokens;
					}
					if (event.usage.cache_read_input_tokens != null) {
						output.usage.cacheRead = event.usage.cache_read_input_tokens;
					}
					if (event.usage.cache_creation_input_tokens != null) {
						output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
					}
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			if (model.provider === "alibaba-coding-plan") {
				output.errorMessage = `[alibaba-coding-plan] ${output.errorMessage}`;
			}
			if (AnthropicSdkClass && error instanceof AnthropicSdkClass.APIError && error.headers) {
				const retryAfterMs = extractRetryAfterMs(error.headers, error.message);
				if (retryAfterMs !== undefined) {
					output.retryAfterMs = retryAfterMs;
				}
			}
			if (isTransientNetworkError(error)) {
				output.retryAfterMs = output.retryAfterMs ?? 5000;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
}
