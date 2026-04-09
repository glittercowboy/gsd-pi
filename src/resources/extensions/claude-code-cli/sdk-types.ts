/**
 * Lightweight type mirrors for the Claude Agent SDK.
 *
 * These stubs allow the extension to compile without a hard dependency on
 * `@anthropic-ai/claude-agent-sdk`. The real SDK is imported dynamically
 * at runtime in stream-adapter.ts.
 */

/** UUID branded string from the SDK. */
export type UUID = string;

/** BetaMessage from the Anthropic SDK, as wrapped by SDKAssistantMessage. */
export interface BetaMessage {
	id: string;
	type: "message";
	role: "assistant";
	content: BetaContentBlock[];
	model: string;
	stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
	usage: { input_tokens: number; output_tokens: number };
}

export type BetaContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature?: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "server_tool_use"; id: string; name: string; input: unknown }
	| { type: "web_search_tool_result"; tool_use_id: string; content: unknown };

/** Streaming event emitted when includePartialMessages is true. */
export interface BetaRawMessageStreamEvent {
	type: string;
	index?: number;
	content_block?: BetaContentBlock;
	delta?: Record<string, unknown>;
}

export interface SDKAssistantMessage {
	type: "assistant";
	uuid: UUID;
	session_id: string;
	message: BetaMessage;
	parent_tool_use_id: string | null;
	error?: { type: string; message: string };
}

export interface SDKUserMessage {
	type: "user";
	uuid?: UUID;
	session_id: string;
	message: unknown;
	parent_tool_use_id: string | null;
	isSynthetic?: boolean;
	tool_use_result?: unknown;
}

export interface SDKSystemMessage {
	type: "system";
	subtype: "init";
	[key: string]: unknown;
}

export interface SDKStatusMessage {
	type: "system";
	subtype: "status";
	status: "compacting" | null;
	uuid: UUID;
	session_id: string;
}

export interface SDKPartialAssistantMessage {
	type: "stream_event";
	event: BetaRawMessageStreamEvent;
	parent_tool_use_id: string | null;
	uuid: UUID;
	session_id: string;
}

export interface SDKToolProgressMessage {
	type: "tool_progress";
	tool_use_id: string;
	tool_name: string;
	parent_tool_use_id: string | null;
	elapsed_time_seconds: number;
	task_id?: string;
	uuid: UUID;
	session_id: string;
}

export interface NonNullableUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

export type SDKResultMessage =
	| {
			type: "result";
			subtype: "success";
			uuid: UUID;
			session_id: string;
			duration_ms: number;
			duration_api_ms: number;
			is_error: boolean;
			num_turns: number;
			result: string;
			stop_reason: string | null;
			total_cost_usd: number;
			usage: NonNullableUsage;
	  }
	| {
			type: "result";
			subtype:
				| "error_max_turns"
				| "error_during_execution"
				| "error_max_budget_usd"
				| "error_max_structured_output_retries";
			uuid: UUID;
			session_id: string;
			duration_ms: number;
			duration_api_ms: number;
			is_error: boolean;
			num_turns: number;
			stop_reason: string | null;
			total_cost_usd: number;
			usage: NonNullableUsage;
			errors: string[];
	  };

/** Catch-all for SDK message types we don't map. */
export interface SDKOtherMessage {
	type: string;
	[key: string]: unknown;
}

/**
 * Union of all SDK message types this extension handles.
 * Mirrors the real `SDKMessage` from `@anthropic-ai/claude-agent-sdk`.
 */
export type SDKMessage =
	| SDKAssistantMessage
	| SDKUserMessage
	| SDKResultMessage
	| SDKSystemMessage
	| SDKStatusMessage
	| SDKPartialAssistantMessage
	| SDKToolProgressMessage
	| SDKOtherMessage;
