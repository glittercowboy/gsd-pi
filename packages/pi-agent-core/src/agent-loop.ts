/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@gsd/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

/**
 * Maximum number of consecutive turns where ALL tool calls in the turn fail
 * schema validation before the loop terminates. This prevents unbounded retry
 * loops when the LLM repeatedly emits tool calls with arguments that cannot
 * pass validation (e.g., schema overload, truncated JSON, missing required
 * fields). See: https://github.com/gsd-build/gsd-2/issues/2783
 */
export const MAX_CONSECUTIVE_VALIDATION_FAILURES = 3;

export const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/**
 * Build an AssistantMessage for an unhandled error caught outside runLoop.
 * Uses the model from config so the message satisfies the full interface.
 */
function createErrorMessage(error: unknown, config: AgentLoopConfig): AssistantMessage {
	const msg = error instanceof Error ? error.message : String(error);
	return {
		role: "assistant",
		content: [{ type: "text", text: msg }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage: msg,
		timestamp: Date.now(),
	};
}

/**
 * Emit a message_start + message_end pair for a single message.
 */
function emitMessagePair(stream: EventStream<AgentEvent, AgentMessage[]>, message: AgentMessage): void {
	stream.push({ type: "message_start", message });
	stream.push({ type: "message_end", message });
}

/**
 * Emit the standard error sequence when the outer agent loop catches an error.
 * Pushes message_start/end, turn_end, agent_end, then closes the stream.
 */
function emitErrorSequence(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	errMsg: AssistantMessage,
	newMessages: AgentMessage[],
): void {
	emitMessagePair(stream, errMsg);
	stream.push({ type: "turn_end", message: errMsg, toolResults: [] });
	stream.push({ type: "agent_end", messages: [...newMessages, errMsg] });
	stream.end([...newMessages, errMsg]);
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			emitMessagePair(stream, prompt);
		}

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (error) {
			emitErrorSequence(stream, createErrorMessage(error, config), newMessages);
		}
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages],
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (error) {
			emitErrorSequence(stream, createErrorMessage(error, config), newMessages);
		}
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Track consecutive turns where ALL tool calls fail validation.
	// When the LLM repeatedly emits tool calls with schema-overloaded or malformed
	// arguments, each turn produces only error tool results. Without a cap, this
	// creates an unbounded retry loop that burns budget. (#2783)
	let consecutiveAllToolErrorTurns = 0;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools: AgentMessage[] | null = null;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					emitMessagePair(stream, message);
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			let message: AssistantMessage;
			try {
				message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			} catch (error) {
				// Critical failure before stream started (e.g. getApiKey threw, credentials in
				// backoff, network unavailable). Convert to a graceful error message so the
				// agent loop can end cleanly instead of crashing with an unhandled rejection.
				const errorText = error instanceof Error ? error.message : String(error);
				message = {
					role: "assistant",
					content: [],
					api: config.model.api,
					provider: config.model.provider,
					model: config.model.id,
					usage: ZERO_USAGE,
					stopReason: signal?.aborted ? "aborted" : "error",
					errorMessage: errorText,
					timestamp: Date.now(),
				};
				stream.push({ type: "message_start", message: { ...message } });
				stream.push({ type: "message_end", message });
				currentContext.messages.push(message);
			}
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "turn_end", message, toolResults: [] });
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			// Check for tool calls or paused server turn
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls =
				toolCalls.length > 0 || message.stopReason === "pauseTurn";

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls && config.externalToolExecution) {
				// External execution mode: tools were handled by the provider
				// (e.g., Claude Code SDK). Emit tool_execution events for each
				// tool call. Prefer any provider-supplied externalResult attached
				// to the tool call so the UI can show the real stdout/stderr
				// instead of a generic placeholder.
				for (const tc of toolCalls as AgentToolCall[]) {
					const externalResult = (tc as AgentToolCall & {
						externalResult?: {
							content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
							details?: Record<string, unknown>;
							isError?: boolean;
						};
					}).externalResult;
					stream.push({
						type: "tool_execution_start",
						toolCallId: tc.id,
						toolName: tc.name,
						args: tc.arguments,
					});
					stream.push({
						type: "tool_execution_end",
						toolCallId: tc.id,
						toolName: tc.name,
						result: externalResult
							? {
									content: externalResult.content ?? [{ type: "text", text: "" }],
									details: externalResult.details ?? {},
								}
							: {
									content: [{ type: "text", text: "(executed by Claude Code)" }],
									details: {},
								},
						isError: externalResult?.isError ?? false,
					});
				}
				// Don't add tool results to context or loop back — the streamSimple
				// call already ran the full multi-turn agentic loop.
				hasMoreToolCalls = false;
			} else if (hasMoreToolCalls) {
				const toolExecution = await executeToolCalls(
					currentContext,
					message,
					config,
					signal,
					stream,
				);
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}

				// Schema overload detection (#2783): count only preparation-phase
				// errors (schema validation, tool-not-found, tool-blocked) toward the
				// consecutive failure cap. Tool execution errors — such as bash
				// commands returning non-zero exit codes (e.g. grep/rg exit 1 for
				// "no matches") — are valid tool usage and must NOT trigger the cap.
				// See: #3618
				const hasPreparationErrors = toolExecution.preparationErrorCount > 0;
				const allToolsFailedPreparation =
					toolResults.length > 0 &&
					toolExecution.preparationErrorCount === toolResults.length;
				if (allToolsFailedPreparation) {
					consecutiveAllToolErrorTurns++;
				} else if (!hasPreparationErrors) {
					// Reset only when there are zero preparation errors this turn.
					// Mixed turns (some prep errors, some successes) don't reset,
					// but they also don't increment — this avoids masking a
					// pattern of alternating schema failures with one working call.
					consecutiveAllToolErrorTurns = 0;
				}

				if (consecutiveAllToolErrorTurns >= MAX_CONSECUTIVE_VALIDATION_FAILURES) {
					// Force-stop: the LLM is stuck retrying broken tool calls.
					// Emit the turn_end and terminate the agent loop cleanly.
					stream.push({ type: "turn_end", message, toolResults });
					const stopMessage: AssistantMessage = {
						role: "assistant",
						content: [
							{
								type: "text",
								text: `Agent stopped: ${consecutiveAllToolErrorTurns} consecutive turns with all tool calls failing. This usually means the model is repeatedly sending arguments that do not match the tool schema.`,
							},
						],
						api: config.model.api,
						provider: config.model.provider,
						model: config.model.id,
						usage: ZERO_USAGE,
						stopReason: "error",
						errorMessage: "Schema overload: consecutive tool validation failures exceeded cap",
						timestamp: Date.now(),
					};
					emitMessagePair(stream, stopMessage);
					newMessages.push(stopMessage);
					stream.push({ type: "turn_end", message: stopMessage, toolResults: [] });
					stream.push({ type: "agent_end", messages: newMessages });
					stream.end(newMessages);
					return;
				}
			}

			stream.push({ type: "turn_end", message, toolResults });

			// Get steering messages after turn completes
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
			case "server_tool_use":
			case "web_search_result":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	return await response.result();
}

/**
 * Result from executing tool calls in a turn. Includes metadata about
 * error provenance so the schema overload detector can distinguish
 * preparation failures (schema validation, tool-not-found, tool-blocked)
 * from execution failures (the tool ran but threw, e.g. bash exit code 1).
 */
interface ToolExecutionResult {
	toolResults: ToolResultMessage[];
	steeringMessages?: AgentMessage[];
	/** Number of tool results that failed during preparation (validation/schema). */
	preparationErrorCount: number;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ToolExecutionResult> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall") as AgentToolCall[];
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, stream);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, stream);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ToolExecutionResult> {
	const results: ToolResultMessage[] = [];
	let steeringMessages: AgentMessage[] | undefined;
	let preparationErrorCount = 0;

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			if (preparation.isError) {
				preparationErrorCount++;
			}
			results.push(emitToolCallOutcome(toolCall, preparation.result, preparation.isError, stream));
		} else {
			const executed = await executePreparedToolCall(preparation, signal, stream);
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					stream,
				),
			);
		}

		if (config.getSteeringMessages) {
			const steering = await config.getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				const remainingCalls = toolCalls.slice(index + 1);
				for (const skipped of remainingCalls) {
					results.push(skipToolCall(skipped, stream));
				}
				break;
			}
		}
	}

	return { toolResults: results, steeringMessages, preparationErrorCount };
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ToolExecutionResult> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];
	let steeringMessages: AgentMessage[] | undefined;
	let preparationErrorCount = 0;

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			if (preparation.isError) {
				preparationErrorCount++;
			}
			results.push(emitToolCallOutcome(toolCall, preparation.result, preparation.isError, stream));
		} else {
			runnableCalls.push(preparation);
		}

		if (config.getSteeringMessages) {
			const steering = await config.getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				for (const runnable of runnableCalls) {
					results.push(skipToolCall(runnable.toolCall, stream, { emitStart: false }));
				}
				const remainingCalls = toolCalls.slice(index + 1);
				for (const skipped of remainingCalls) {
					results.push(skipToolCall(skipped, stream));
				}
				return { toolResults: results, steeringMessages, preparationErrorCount };
			}
		}
	}

	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, stream),
	}));

	for (const running of runningCalls) {
		const executed = await running.execution;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				stream,
			),
		);
	}

	if (!steeringMessages && config.getSteeringMessages) {
		const steering = await config.getSteeringMessages();
		if (steering.length > 0) {
			steeringMessages = steering;
		}
	}

	return { toolResults: results, steeringMessages, preparationErrorCount };
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const validatedArgs = validateToolArguments(tool, toolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ExecutedToolCallOutcome> {
	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				stream.push({
					type: "tool_execution_update",
					toolCallId: prepared.toolCall.id,
					toolName: prepared.toolCall.name,
					args: prepared.toolCall.arguments,
					partialResult,
				});
			},
		);
		return { result, isError: false };
	} catch (error) {
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		if (afterResult) {
			result = {
				content: afterResult.content !== undefined ? afterResult.content : result.content,
				details: afterResult.details !== undefined ? afterResult.details : result.details,
			};
			isError = afterResult.isError !== undefined ? afterResult.isError : isError;
		}
	}

	return emitToolCallOutcome(prepared.toolCall, result, isError, stream);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	emitMessagePair(stream, toolResultMessage);
	return toolResultMessage;
}

function skipToolCall(
	toolCall: AgentToolCall,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	options?: { emitStart?: boolean },
): ToolResultMessage {
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};

	if (options?.emitStart !== false) {
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
	}

	return emitToolCallOutcome(toolCall, result, true, stream);
}
