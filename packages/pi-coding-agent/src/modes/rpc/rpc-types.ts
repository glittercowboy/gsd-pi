/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@gsd/pi-agent-core";
import type { ImageContent, Model } from "@gsd/pi-ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";

// ============================================================================
// RPC Protocol Versioning
// ============================================================================

/** Supported protocol versions. v1 is the implicit default; v2 requires an init handshake. */
export type RpcProtocolVersion = 1 | 2;

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// Bridge-hosted native terminal
	| { id?: string; type: "terminal_input"; data: string }
	| { id?: string; type: "terminal_resize"; cols: number; rows: number }
	| { id?: string; type: "terminal_redraw" }

	// v2 Protocol
	| { id?: string; type: "init"; protocolVersion: 2; clientId?: string }
	| { id?: string; type: "shutdown"; graceful?: boolean }
	| { id?: string; type: "subscribe"; events: string[] };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Where the command was loaded from (undefined for extensions) */
	location?: "user" | "project" | "path";
	/** File path to the command source */
	path?: string;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	retryInProgress: boolean;
	retryAttempt: number;
	messageCount: number;
	pendingMessageCount: number;
	/** Whether extension loading has completed. Commands from `get_commands` may be incomplete until true. */
	extensionsReady: boolean;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; runId?: string }
	| { id?: string; type: "response"; command: "steer"; success: true; runId?: string }
	| { id?: string; type: "response"; command: "follow_up"; success: true; runId?: string }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Bridge-hosted native terminal
	| { id?: string; type: "response"; command: "terminal_input"; success: true }
	| { id?: string; type: "response"; command: "terminal_resize"; success: true }
	| { id?: string; type: "response"; command: "terminal_redraw"; success: true }

	// v2 Protocol
	| { id?: string; type: "response"; command: "init"; success: true; data: RpcInitResult }
	| { id?: string; type: "response"; command: "shutdown"; success: true }
	| { id?: string; type: "response"; command: "subscribe"; success: true }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// v2 Protocol Types
// ============================================================================

/** Result of the init handshake (v2 only) */
export interface RpcInitResult {
	protocolVersion: 2;
	sessionId: string;
	capabilities: {
		events: string[];
		commands: string[];
	};
}

/** v2 execution_complete event — emitted when a prompt/steer/follow_up finishes */
export interface RpcExecutionCompleteEvent {
	type: "execution_complete";
	runId: string;
	status: "completed" | "error" | "cancelled";
	reason?: string;
	stats: SessionStats;
}

/** v2 cost_update event — emitted per-turn with running cost data */
export interface RpcCostUpdateEvent {
	type: "cost_update";
	runId: string;
	turnCost: number;
	cumulativeCost: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

/** Discriminated union of all v2-only event types */
export type RpcV2Event = RpcExecutionCompleteEvent | RpcCostUpdateEvent;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number; allowMultiple?: boolean }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; values: string[] }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
