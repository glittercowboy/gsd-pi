// GSD2 — Ollama Extension: Native /api/chat stream provider

/**
 * Implements the "ollama-chat" API provider, streaming responses directly
 * from Ollama's native /api/chat endpoint instead of the OpenAI compatibility
 * shim. This exposes Ollama-specific options (num_ctx, keep_alive, num_gpu,
 * sampling parameters) and surfaces inference performance metrics.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type InferenceMetrics,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type Usage,
	EventStream,
} from "@gsd/pi-ai";
import { chat } from "./ollama-client.js";
import type {
	OllamaChatMessage,
	OllamaChatOptions,
	OllamaChatRequest,
	OllamaChatResponse,
	OllamaTool,
	OllamaToolCall,
} from "./types.js";
import { ThinkingTagParser, type ParsedChunk } from "./thinking-parser.js";

/** Create an AssistantMessageEventStream using the base EventStream class. */
function createStream(): AssistantMessageEventStream {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type for final result");
		},
	) as AssistantMessageEventStream;
}

// ─── Stream handler ─────────────────────────────────────────────────────────

export function streamOllamaChat(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createStream();

	(async () => {
		const output = buildInitialOutput(model);

		try {
			const request = buildRequest(model, context, options);
			stream.push({ type: "start", partial: output });

			const useThinkingParser = model.reasoning;
			const thinkParser = useThinkingParser ? new ThinkingTagParser() : null;

			let contentIndex = -1;
			let currentBlockType: "text" | "thinking" | null = null;

			function startBlock(type: "text" | "thinking") {
				contentIndex++;
				currentBlockType = type;
				if (type === "text") {
					output.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex, partial: output });
				} else {
					output.content.push({ type: "thinking", thinking: "" });
					stream.push({ type: "thinking_start", contentIndex, partial: output });
				}
			}

			function endBlock() {
				if (currentBlockType === null) return;
				if (currentBlockType === "text") {
					const block = output.content[contentIndex] as TextContent;
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else {
					const block = output.content[contentIndex] as ThinkingContent;
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				}
				currentBlockType = null;
			}

			function emitDelta(type: "text" | "thinking", text: string) {
				if (!text) return;
				if (currentBlockType !== type) {
					endBlock();
					startBlock(type);
				}
				if (type === "text") {
					(output.content[contentIndex] as TextContent).text += text;
					stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
				} else {
					(output.content[contentIndex] as ThinkingContent).thinking += text;
					stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: output });
				}
			}

			function processChunks(chunks: ParsedChunk[]) {
				for (const chunk of chunks) {
					emitDelta(chunk.type, chunk.text);
				}
			}

			function processToolCalls(toolCalls: OllamaToolCall[]) {
				endBlock();
				for (const tc of toolCalls) {
					contentIndex++;
					const toolCall: ToolCall = {
						type: "toolCall",
						id: `ollama_tc_${contentIndex}`,
						name: tc.function.name,
						arguments: tc.function.arguments,
					};
					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					// Emit a delta with the serialized arguments (convention: start/delta/end)
					stream.push({
						type: "toolcall_delta",
						contentIndex,
						delta: JSON.stringify(tc.function.arguments),
						partial: output,
					});
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall,
						partial: output,
					});
				}
				output.stopReason = "toolUse";
			}

			for await (const chunk of chat(request, options?.signal)) {
				// Handle text content — process independently of tool_calls
				// (a chunk may contain both content and tool_calls)
				const content = chunk.message?.content ?? "";
				if (content) {
					if (thinkParser) {
						processChunks(thinkParser.push(content));
					} else {
						emitDelta("text", content);
					}
				}

				// Handle tool calls (Ollama sends them complete, may be on done:true chunk)
				if (chunk.message?.tool_calls?.length) {
					processToolCalls(chunk.message.tool_calls);
				}

				if (chunk.done) {
					// Final chunk — extract metrics and usage
					if (thinkParser) processChunks(thinkParser.flush());
					endBlock();

					output.usage = buildUsage(chunk);
					output.inferenceMetrics = extractMetrics(chunk);
					// Preserve "toolUse" if tool calls were processed
					if (output.stopReason !== "toolUse") {
						output.stopReason = mapStopReason(chunk.done_reason);
					}
					break;
				}
			}

			assertStreamSuccess(output, options?.signal);
			finalizeStream(stream, output);
		} catch (error) {
			handleStreamError(stream, output, error, options?.signal);
		}
	})();

	return stream;
}

// ─── Request building ───────────────────────────────────────────────────────

function buildRequest(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): OllamaChatRequest {
	const ollamaOpts = (model.providerOptions ?? {}) as OllamaChatOptions;

	const request: OllamaChatRequest = {
		model: model.id,
		messages: convertMessages(context),
		stream: true,
	};

	// Build options block with all Ollama-specific parameters
	const reqOptions: NonNullable<OllamaChatRequest["options"]> = {};

	// Context window — only sent when explicitly configured via providerOptions.
	// Sending inferred/estimated values risks OOM on constrained hosts.
	// Users can set num_ctx per-model in models.json ollamaOptions or the
	// capability table can provide it for known model families.
	if (ollamaOpts.num_ctx !== undefined && ollamaOpts.num_ctx > 0) {
		reqOptions.num_ctx = ollamaOpts.num_ctx;
	}

	// Max output tokens
	const maxTokens = options?.maxTokens ?? model.maxTokens;
	if (maxTokens > 0) {
		reqOptions.num_predict = maxTokens;
	}

	// Temperature
	if (options?.temperature !== undefined) {
		reqOptions.temperature = options.temperature;
	}

	// Per-model sampling options from providerOptions
	if (ollamaOpts.top_p !== undefined) reqOptions.top_p = ollamaOpts.top_p;
	if (ollamaOpts.top_k !== undefined) reqOptions.top_k = ollamaOpts.top_k;
	if (ollamaOpts.repeat_penalty !== undefined) reqOptions.repeat_penalty = ollamaOpts.repeat_penalty;
	if (ollamaOpts.seed !== undefined) reqOptions.seed = ollamaOpts.seed;
	if (ollamaOpts.num_gpu !== undefined) reqOptions.num_gpu = ollamaOpts.num_gpu;

	if (Object.keys(reqOptions).length > 0) {
		request.options = reqOptions;
	}

	// Keep alive
	if (ollamaOpts.keep_alive !== undefined) {
		request.keep_alive = ollamaOpts.keep_alive;
	}

	// Tools
	if (context.tools?.length) {
		request.tools = convertTools(context.tools);
	}

	return request;
}

// ─── Message conversion ─────────────────────────────────────────────────────

function convertMessages(context: Context): OllamaChatMessage[] {
	const messages: OllamaChatMessage[] = [];

	// System prompt
	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		switch (msg.role) {
			case "user":
				messages.push(convertUserMessage(msg));
				break;
			case "assistant":
				messages.push(convertAssistantMessage(msg));
				break;
			case "toolResult":
				messages.push({
					role: "tool",
					content: msg.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n"),
					name: msg.toolName,
				});
				break;
		}
	}

	return messages;
}

function convertUserMessage(msg: Message & { role: "user" }): OllamaChatMessage {
	if (typeof msg.content === "string") {
		return { role: "user", content: msg.content };
	}

	const textParts: string[] = [];
	const images: string[] = [];

	for (const part of msg.content) {
		if (part.type === "text") {
			textParts.push(part.text);
		} else if (part.type === "image") {
			// Strip data URI prefix if present
			let data = (part as ImageContent).data;
			const commaIdx = data.indexOf(",");
			if (commaIdx !== -1 && data.startsWith("data:")) {
				data = data.slice(commaIdx + 1);
			}
			images.push(data);
		}
	}

	const result: OllamaChatMessage = {
		role: "user",
		content: textParts.join("\n"),
	};
	if (images.length > 0) {
		result.images = images;
	}
	return result;
}

function convertAssistantMessage(msg: Message & { role: "assistant" }): OllamaChatMessage {
	let content = "";
	const toolCalls: OllamaChatMessage["tool_calls"] = [];

	for (const block of msg.content) {
		if (block.type === "thinking") {
			// Serialize thinking back inline for round-trip with Ollama
			content += `<think>${(block as ThinkingContent).thinking}</think>`;
		} else if (block.type === "text") {
			content += (block as TextContent).text;
		} else if (block.type === "toolCall") {
			const tc = block as ToolCall;
			toolCalls.push({
				function: {
					name: tc.name,
					arguments: tc.arguments,
				},
			});
		}
	}

	const result: OllamaChatMessage = { role: "assistant", content };
	if (toolCalls.length > 0) {
		result.tool_calls = toolCalls;
	}
	return result;
}

// ─── Tool conversion ────────────────────────────────────────────────────────

function convertTools(tools: Tool[]): OllamaTool[] {
	return tools.map((tool) => {
		const params = tool.parameters as Record<string, unknown>;
		return {
			type: "function" as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: {
					type: "object" as const,
					required: params.required as string[] | undefined,
					properties: (params.properties as Record<string, unknown>) ?? {},
				},
			},
		};
	});
}

// ─── Response mapping ───────────────────────────────────────────────────────

function mapStopReason(doneReason?: string): StopReason {
	switch (doneReason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		default:
			return "stop";
	}
}

function buildUsage(chunk: OllamaChatResponse): Usage {
	const input = chunk.prompt_eval_count ?? 0;
	const outputTokens = chunk.eval_count ?? 0;
	return {
		input,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function extractMetrics(chunk: OllamaChatResponse): InferenceMetrics | undefined {
	if (!chunk.eval_duration && !chunk.total_duration) return undefined;

	const evalCount = chunk.eval_count ?? 0;
	const evalDurationNs = chunk.eval_duration ?? 0;
	const evalDurationMs = evalDurationNs / 1e6;
	const tokensPerSecond = evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : 0;

	return {
		tokensPerSecond,
		totalDurationMs: (chunk.total_duration ?? 0) / 1e6,
		evalDurationMs,
		promptEvalDurationMs: (chunk.prompt_eval_duration ?? 0) / 1e6,
	};
}

// ─── Stream lifecycle helpers ───────────────────────────────────────────────
// Replicated from openai-shared.ts (not exported from @gsd/pi-ai)

function buildInitialOutput(model: Model<Api>): AssistantMessage {
	return {
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
}

function assertStreamSuccess(output: AssistantMessage, signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Request was aborted");
	}
	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error("An unknown error occurred");
	}
}

function finalizeStream(stream: AssistantMessageEventStream, output: AssistantMessage): void {
	stream.push({
		type: "done",
		reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse" | "pauseTurn">,
		message: output,
	});
	stream.end();
}

function handleStreamError(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	error: unknown,
	signal?: AbortSignal,
): void {
	for (const block of output.content) delete (block as { index?: number }).index;
	output.stopReason = signal?.aborted ? "aborted" : "error";
	output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}
