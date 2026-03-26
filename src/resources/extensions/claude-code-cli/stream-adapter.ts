/**
 * Stream adapter: bridges the Claude Agent SDK into GSD's streamSimple contract.
 *
 * The SDK runs the full agentic loop (multi-turn, tool execution, compaction)
 * in one call. This adapter translates the SDK's streaming output into
 * AssistantMessageEvents for TUI rendering, then strips tool-call blocks from
 * the final AssistantMessage so GSD's agent loop doesn't try to dispatch them.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@gsd/pi-ai";
import { EventStream } from "@gsd/pi-ai";
import { execSync } from "node:child_process";
import { PartialMessageBuilder, ZERO_USAGE, mapUsage } from "./partial-builder.js";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
	SDKSystemMessage,
	SDKStatusMessage,
	SDKUserMessage,
} from "./sdk-types.js";

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

/**
 * Construct an AssistantMessageEventStream using EventStream directly.
 * (The class itself is only re-exported as a type from the @gsd/pi-ai barrel.)
 */
function createAssistantStream(): AssistantMessageEventStream {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type for final result");
		},
	) as AssistantMessageEventStream;
}

// ---------------------------------------------------------------------------
// Claude binary resolution
// ---------------------------------------------------------------------------

let cachedClaudePath: string | null = null;

/**
 * Resolve the path to the system-installed `claude` binary.
 * The SDK defaults to a bundled cli.js which doesn't exist when
 * installed as a library — we need to point it at the real CLI.
 */
function getClaudePath(): string {
	if (cachedClaudePath) return cachedClaudePath;
	try {
		cachedClaudePath = execSync("which claude", { timeout: 5_000, stdio: "pipe" })
			.toString()
			.trim();
	} catch {
		cachedClaudePath = "claude"; // fall back to PATH resolution
	}
	return cachedClaudePath;
}

// ---------------------------------------------------------------------------
// Prompt extraction
// ---------------------------------------------------------------------------

/**
 * Extract the last user prompt text from GSD's context messages.
 * The SDK manages its own conversation history — we only send
 * the latest user message as the prompt.
 */
function extractLastUserPrompt(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") return msg.content;
			if (Array.isArray(msg.content)) {
				const textParts = msg.content
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text);
				if (textParts.length > 0) return textParts.join("\n");
			}
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function makeErrorMessage(model: string, errorMsg: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `Claude Code error: ${errorMsg}` }],
		api: "anthropic-messages",
		provider: "claude-code",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "error",
		errorMessage: errorMsg,
		timestamp: Date.now(),
	};
}

/**
 * Generator exhaustion without a terminal result means the SDK stream was
 * interrupted mid-turn. Surface it as an error so downstream recovery logic
 * can classify and retry it instead of treating it as a clean completion.
 */
export function makeStreamExhaustedErrorMessage(model: string, lastTextContent: string): AssistantMessage {
	const errorMsg = "stream_exhausted_without_result";
	const message = makeErrorMessage(model, errorMsg);
	if (lastTextContent) {
		message.content = [{ type: "text", text: lastTextContent }];
	}
	return message;
}

// ---------------------------------------------------------------------------
// streamSimple implementation
// ---------------------------------------------------------------------------

/**
 * GSD streamSimple function that delegates to the Claude Agent SDK.
 *
 * Emits AssistantMessageEvent deltas for real-time TUI rendering
 * (thinking, text, tool calls). The final AssistantMessage has tool-call
 * blocks stripped so the agent loop ends the turn without local dispatch.
 */
export function streamViaClaudeCode(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantStream();

	void pumpSdkMessages(model, context, options, stream);

	return stream;
}

async function pumpSdkMessages(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const modelId = model.id;
	let builder: PartialMessageBuilder | null = null;
	/** Track the last text content seen across all assistant turns for the final message. */
	let lastTextContent = "";
	let lastThinkingContent = "";
	/** Collect tool calls from intermediate SDK turns for tool_execution events. */
	const intermediateToolCalls: AssistantMessage["content"] = [];

	try {
		// Dynamic import — the SDK is an optional dependency.
		const sdkModule = "@anthropic-ai/claude-agent-sdk";
		const sdk = (await import(/* webpackIgnore: true */ sdkModule)) as {
			query: (args: {
				prompt: string | AsyncIterable<unknown>;
				options?: Record<string, unknown>;
			}) => AsyncIterable<SDKMessage>;
		};

		// Bridge GSD's AbortSignal to SDK's AbortController
		const controller = new AbortController();
		if (options?.signal) {
			options.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const prompt = extractLastUserPrompt(context);

		const queryResult = sdk.query({
			prompt,
			options: {
				pathToClaudeCodeExecutable: getClaudePath(),
				model: modelId,
				includePartialMessages: true,
				persistSession: false,
				abortController: controller,
				cwd: process.cwd(),
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
				systemPrompt: { type: "preset", preset: "claude_code" },
				betas: modelId.includes("sonnet") ? ["context-1m-2025-08-07"] : [],
			},
		});

		// Emit start with an empty partial
		const initialPartial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "claude-code",
			model: modelId,
			usage: { ...ZERO_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: initialPartial });

		for await (const msg of queryResult as AsyncIterable<SDKMessage>) {
			if (options?.signal?.aborted) break;

			switch (msg.type) {
				// -- Init --
				case "system": {
					// Nothing to emit — the stream is already started.
					break;
				}

				// -- Streaming partial messages --
				case "stream_event": {
					const partial = msg as SDKPartialAssistantMessage;
					if (partial.parent_tool_use_id !== null) break; // skip subagent

					const event = partial.event;

					// New assistant turn starts with message_start
					if (event.type === "message_start") {
						builder = new PartialMessageBuilder(
							(event as any).message?.model ?? modelId,
						);
						break;
					}

					if (!builder) break;

					const assistantEvent = builder.handleEvent(event);
					if (assistantEvent) {
						// Skip toolcall events — the agent loop's externalToolExecution
						// path emits tool_execution_start/end events after streamSimple
						// returns. Streaming toolcall events would render tool calls
						// out of order in the TUI's accumulated message content.
						const t = assistantEvent.type;
						if (t !== "toolcall_start" && t !== "toolcall_delta" && t !== "toolcall_end") {
							stream.push(assistantEvent);
						}
					}
					break;
				}

				// -- Complete assistant message (non-streaming fallback) --
				case "assistant": {
					const sdkAssistant = msg as SDKAssistantMessage;
					if (sdkAssistant.parent_tool_use_id !== null) break;

					// Capture text content from complete messages
					for (const block of sdkAssistant.message.content) {
						if (block.type === "text") {
							lastTextContent = block.text;
						} else if (block.type === "thinking") {
							lastThinkingContent = block.thinking;
						}
					}
					break;
				}

				// -- User message (synthetic tool result — signals turn boundary) --
				case "user": {
					const userMsg = msg as SDKUserMessage;
					if (userMsg.parent_tool_use_id !== null) break;

					// Capture content from the completed turn before resetting
					if (builder) {
						for (const block of builder.message.content) {
							if (block.type === "text" && block.text) {
								lastTextContent = block.text;
							} else if (block.type === "thinking" && block.thinking) {
								lastThinkingContent = block.thinking;
							} else if (block.type === "toolCall") {
								// Collect tool calls for externalToolExecution rendering
								intermediateToolCalls.push(block);
							}
						}
					}
					builder = null;
					break;
				}

				// -- Result (terminal) --
				case "result": {
					const result = msg as SDKResultMessage;

					// Build final message. Include intermediate tool calls so the
					// agent loop's externalToolExecution path emits tool_execution
					// events for proper TUI rendering, followed by the text response.
					const finalContent: AssistantMessage["content"] = [];

					// Add tool calls from intermediate turns first (renders above text)
					finalContent.push(...intermediateToolCalls);

					// Add text/thinking from the last turn
					if (builder && builder.message.content.length > 0) {
						for (const block of builder.message.content) {
							if (block.type === "text" || block.type === "thinking") {
								finalContent.push(block);
							}
						}
					} else {
						if (lastThinkingContent) {
							finalContent.push({ type: "thinking", thinking: lastThinkingContent });
						}
						if (lastTextContent) {
							finalContent.push({ type: "text", text: lastTextContent });
						}
					}

					// Fallback: use the SDK's result text if we have no content
					if (finalContent.length === 0 && result.subtype === "success" && result.result) {
						finalContent.push({ type: "text", text: result.result });
					}

					const finalMessage: AssistantMessage = {
						role: "assistant",
						content: finalContent,
						api: "anthropic-messages",
						provider: "claude-code",
						model: modelId,
						usage: mapUsage(result.usage, result.total_cost_usd),
						stopReason: result.is_error ? "error" : "stop",
						timestamp: Date.now(),
					};

					if (result.is_error) {
						const errText =
							"errors" in result
								? (result as any).errors?.join("; ")
								: result.subtype;
						finalMessage.errorMessage = errText;
						stream.push({ type: "error", reason: "error", error: finalMessage });
					} else {
						stream.push({ type: "done", reason: "stop", message: finalMessage });
					}
					return;
				}

				default:
					break;
			}
		}

		// Generator exhaustion without a terminal result is a stream interruption,
		// not a successful completion. Emitting an error lets GSD classify it as a
		// transient provider failure instead of advancing auto-mode state.
		const fallback = makeStreamExhaustedErrorMessage(modelId, lastTextContent);
		stream.push({ type: "error", reason: "error", error: fallback });
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		stream.push({
			type: "error",
			reason: "error",
			error: makeErrorMessage(modelId, errorMsg),
		});
	}
}
