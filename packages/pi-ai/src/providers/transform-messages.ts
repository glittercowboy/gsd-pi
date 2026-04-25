import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../types.js";

/**
 * Report of context transformations during a cross-provider switch (ADR-005 Phase 3).
 * Tracks what was lost or downgraded when replaying conversation history to a different provider.
 */
export interface ProviderSwitchReport {
	/** API of the messages being transformed from */
	fromApi: string;
	/** API of the target model */
	toApi: string;
	/** Number of thinking blocks completely dropped (redacted/encrypted, cross-model) */
	thinkingBlocksDropped: number;
	/** Number of thinking blocks downgraded from structured to plain text */
	thinkingBlocksDowngraded: number;
	/** Number of tool call IDs that were remapped/normalized */
	toolCallIdsRemapped: number;
	/** Number of synthetic tool results inserted for orphaned tool calls */
	syntheticToolResultsInserted: number;
	/** Number of thought signatures dropped (Google-specific opaque context) */
	thoughtSignaturesDropped: number;
}

/**
 * Create an empty provider switch report.
 */
export function createEmptyReport(fromApi: string, toApi: string): ProviderSwitchReport {
	return {
		fromApi,
		toApi,
		thinkingBlocksDropped: 0,
		thinkingBlocksDowngraded: 0,
		toolCallIdsRemapped: 0,
		syntheticToolResultsInserted: 0,
		thoughtSignaturesDropped: 0,
	};
}

/**
 * Check if a provider switch report has any non-zero transformations.
 */
export function hasTransformations(report: ProviderSwitchReport): boolean {
	return (
		report.thinkingBlocksDropped > 0 ||
		report.thinkingBlocksDowngraded > 0 ||
		report.toolCallIdsRemapped > 0 ||
		report.syntheticToolResultsInserted > 0 ||
		report.thoughtSignaturesDropped > 0
	);
}

/**
 * Create a report, run transformMessages, and log if non-empty.
 * Convenience wrapper for provider adapters (ADR-005).
 */
export function transformMessagesWithReport<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	sourceApi?: string,
): Message[] {
	const report = createEmptyReport(sourceApi ?? "unknown", model.api);
	const result = transformMessages(messages, model, normalizeToolCallId, report);
	if (hasTransformations(report)) {
		logProviderSwitchReport(report);
	}
	return result;
}

/** Log a non-empty ProviderSwitchReport as a debug-level warning. */
function logProviderSwitchReport(report: ProviderSwitchReport): void {
	const parts: string[] = [`Provider switch ${report.fromApi} → ${report.toApi}:`];
	if (report.thinkingBlocksDropped > 0) parts.push(`${report.thinkingBlocksDropped} thinking blocks dropped`);
	if (report.thinkingBlocksDowngraded > 0) parts.push(`${report.thinkingBlocksDowngraded} thinking blocks downgraded`);
	if (report.toolCallIdsRemapped > 0) parts.push(`${report.toolCallIdsRemapped} tool call IDs remapped`);
	if (report.syntheticToolResultsInserted > 0) parts.push(`${report.syntheticToolResultsInserted} synthetic tool results inserted`);
	if (report.thoughtSignaturesDropped > 0) parts.push(`${report.thoughtSignaturesDropped} thought signatures dropped`);
	// Use process.stderr for debug output — this is observable in verbose/debug modes
	// without polluting stdout which may be used for structured output (RPC/MCP).
	if (process.env.GSD_VERBOSE === "1" || process.env.PI_VERBOSE === "1") {
		process.stderr.write(`[provider-switch] ${parts.join(", ")}\n`);
	}
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	report?: ProviderSwitchReport,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();

	// First pass: transform messages (thinking blocks, tool call ID normalization)
	const transformed = messages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						if (!isSameModel && report) report.thinkingBlocksDropped++;
						return isSameModel ? block : [];
					}
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && block.thinkingSignature) return block;
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") {
						if (!isSameModel && report) report.thinkingBlocksDropped++;
						return [];
					}
					if (isSameModel) return block;
					// Downgrade: structured thinking → plain text
					if (report) report.thinkingBlocksDowngraded++;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
						if (report) report.thoughtSignaturesDropped++;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
							if (report) report.toolCallIdsRemapped++;
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			if (pendingToolCalls.length > 0) {
				for (const tc of pendingToolCalls) {
					if (!existingToolResultIds.has(tc.id)) {
						result.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "No result provided" }],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
						if (report) report.syntheticToolResultsInserted++;
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// User message interrupts tool flow - insert synthetic results for orphaned calls
			if (pendingToolCalls.length > 0) {
				for (const tc of pendingToolCalls) {
					if (!existingToolResultIds.has(tc.id)) {
						result.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "No result provided" }],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
						if (report) report.syntheticToolResultsInserted++;
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	return result;
}
