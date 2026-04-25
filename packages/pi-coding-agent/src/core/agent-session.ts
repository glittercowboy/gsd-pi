/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@gsd/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "@gsd/pi-ai";
import { modelsAreEqual, resetApiProviders, supportsXhigh } from "@gsd/pi-ai";
import { Type } from "@sinclair/typebox";
import { getDocsPath } from "../config.js";
import { getErrorMessage } from "../utils/error.js";
import { theme } from "../modes/interactive/theme/theme.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { type BashResult, executeBash as executeBashCommand, executeBashWithOperations } from "./bash-executor.js";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	estimateContextTokens,
	generateBranchSummary,
} from "./compaction/index.js";
import { CompactionOrchestrator } from "./compaction-orchestrator.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.js";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.js";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type SessionBeforeForkResult,
	type SessionBeforeSwitchResult,
	type SessionBeforeTreeResult,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { FallbackResolver } from "./fallback-resolver.js";
import type { ModelRegistry } from "./model-registry.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import { RetryHandler } from "./retry-handler.js";
import { isImageDimensionError, downsizeConversationImages } from "./image-overflow-recovery.js";
import type { BranchSummaryEntry, SessionManager } from "./session-manager.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo, type SlashCommandLocation } from "./slash-commands.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { BashOperations } from "./tools/bash.js";
import { createAllTools } from "./tools/index.js";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type SessionStateChangeReason =
	| "set_model"
	| "set_thinking_level"
	| "set_steering_mode"
	| "set_follow_up_mode"
	| "set_auto_compaction"
	| "set_auto_retry"
	| "abort_retry"
	| "new_session"
	| "switch_session"
	| "set_session_name"
	| "fork";

export type AgentSessionEvent =
	| AgentEvent
	| { type: "session_state_changed"; reason: SessionStateChangeReason }
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
	| {
			type: "auto_compaction_end";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "fallback_provider_switch"; from: string; to: string; reason: string }
	| { type: "fallback_provider_restored"; provider: string; reason: string }
	| { type: "fallback_chain_exhausted"; reason: string }
	| { type: "image_overflow_recovery"; strippedCount: number; imageCount: number };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Override base tools (useful for custom runtimes). */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Optional: check if the claude-code CLI provider is ready (installed + authed).
	 * Passed through to RetryHandler for third-party block recovery (#3772). */
	isClaudeCodeReady?: () => boolean;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** Thinking levels including xhigh (for supported models) */
const THINKING_LEVELS_WITH_XHIGH: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _agentEventQueue: Promise<void> = Promise.resolve();

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Delegated subsystems
	private _retryHandler: RetryHandler;
	private _compactionOrchestrator: CompactionOrchestrator;

	// Cumulative session stats — survives compaction (#1423)
	private _cumulativeCost = 0;
	private _cumulativeInputTokens = 0;
	private _cumulativeOutputTokens = 0;
	private _cumulativeToolCalls = 0;

	/** Cost of the most recent assistant response (for per-prompt display). */
	private _lastTurnCost = 0;


	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner: ExtensionRunner | undefined = undefined;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolRegistry: Map<string, AgentTool> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Provider fallback resolver
	private _fallbackResolver: FallbackResolver;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._fallbackResolver = new FallbackResolver(
			this.settingsManager,
			this._modelRegistry.authStorage,
			this._modelRegistry,
		);
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._baseToolsOverride = config.baseToolsOverride;

		// Initialize delegated subsystems
		this._retryHandler = new RetryHandler({
			agent: this.agent,
			settingsManager: this.settingsManager,
			modelRegistry: this._modelRegistry,
			fallbackResolver: this._fallbackResolver,
			getModel: () => this.model,
			getSessionId: () => this.sessionId,
			emit: (event) => this._emit(event),
			onModelChange: (model) => this.sessionManager.appendModelChange(model.provider, model.id),
			isClaudeCodeReady: config.isClaudeCodeReady,
		});

		this._compactionOrchestrator = new CompactionOrchestrator({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			modelRegistry: this._modelRegistry,
			getModel: () => this.model,
			getSessionId: () => this.sessionId,
			getExtensionRunner: () => this._extensionRunner,
			emit: (event) => this._emit(event),
			disconnectFromAgent: () => this._disconnectFromAgent(),
			reconnectToAgent: () => this._reconnectToAgent(),
			abort: () => this.abort(),
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);

		// Install tool hooks that await the event queue before emitting extension events.
		// This ensures extensions always see settled state (e.g., assistant message appended)
		// even when tools execute in parallel.
		this._installAgentToolHooks();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	/** Fallback resolver for cross-provider fallback */
	get fallbackResolver(): FallbackResolver {
		return this._fallbackResolver;
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitSessionStateChanged(reason: SessionStateChangeReason): void {
		this._emit({ type: "session_state_changed", reason });
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = (event: AgentEvent): void => {
		// Create retry promise synchronously before queueing async processing.
		// Agent.emit() calls this handler synchronously, and prompt() calls waitForRetry()
		// as soon as agent.prompt() resolves. If the retry promise is created only inside
		// _processAgentEvent, slow earlier queued events can delay agent_end processing
		// and waitForRetry() can miss the in-flight retry.
		this._createRetryPromiseForAgentEnd(event);

		this._agentEventQueue = this._agentEventQueue.then(
			() => this._processAgentEvent(event),
			() => this._processAgentEvent(event),
		);

		// Keep queue alive if an event handler fails
		this._agentEventQueue.catch(() => {});
	};

	private _createRetryPromiseForAgentEnd(event: AgentEvent): void {
		if (event.type !== "agent_end") return;
		this._retryHandler.createRetryPromiseForAgentEnd(event.messages);
	}

	private async _processAgentEvent(event: AgentEvent): Promise<void> {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._compactionOrchestrator.resetOverflowRecovery();
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				// Accumulate session stats that survive compaction (#1423)
				const assistantMsg = event.message as AssistantMessage;
				this._lastTurnCost = assistantMsg.usage?.cost?.total ?? 0;
				this._cumulativeCost += assistantMsg.usage?.cost?.total ?? 0;
				this._cumulativeInputTokens += assistantMsg.usage?.input ?? 0;
				this._cumulativeOutputTokens += assistantMsg.usage?.output ?? 0;
				this._cumulativeToolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;

				if (assistantMsg.stopReason !== "error") {
					this._compactionOrchestrator.clearOverflowRecovery();
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error") {
					this._retryHandler.handleSuccessfulResponse();
				}
			}
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end" && this._lastAssistantMessage) {
			const msg = this._lastAssistantMessage;
			this._lastAssistantMessage = undefined;

			// Check for retryable errors first (overloaded, rate limit, server errors)
			if (this._retryHandler.isRetryableError(msg)) {
				const didRetry = await this._retryHandler.handleRetryableError(msg);
				if (didRetry) return; // Retry was initiated, don't proceed to compaction
			}

			// Check for image dimension overflow (many-image 400 error).
			// When a session accumulates many images, the API rejects requests
			// whose images exceed the many-image dimension limit. Strip older
			// images from the conversation and auto-retry. (#2874)
			if (
				msg.stopReason === "error" &&
				isImageDimensionError(msg.errorMessage)
			) {
				const messages = this.agent.state.messages;
				const result = downsizeConversationImages(messages as Message[]);
				if (result.processed) {
					// Remove the trailing error assistant message, then replace
					if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
						this.agent.replaceMessages(messages.slice(0, -1));
					}

					this._emit({
						type: "image_overflow_recovery",
						strippedCount: result.strippedCount,
						imageCount: result.imageCount,
					});

					// Auto-retry after downsizing
					setTimeout(() => {
						this.agent.continue().catch(() => {});
					}, 0);
					return;
				}
			}

			await this._compactionOrchestrator.checkCompaction(msg);
		}
	}

	/**
	 * Install beforeToolCall/afterToolCall hooks on the Agent.
	 *
	 * These hooks await `_agentEventQueue` before emitting extension events,
	 * ensuring that all prior events (including `message_end` which appends
	 * the assistant message) have fully settled. This prevents a race condition
	 * in parallel tool execution where extension `tool_call` handlers could
	 * see stale agent state.
	 */
	private _installAgentToolHooks(): void {
		this.agent.setBeforeToolCall(async ({ toolCall, args }) => {
			// Wait for all queued agent events to settle before emitting to extensions
			await this._agentEventQueue;

			if (!this._extensionRunner?.hasHandlers("tool_call")) return undefined;

			try {
				const callResult = await this._extensionRunner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});

				if (callResult?.block) {
					return {
						block: true,
						reason: callResult.reason || "Tool execution was blocked by an extension",
					};
				}
			} catch (err) {
				return { block: true, reason: err instanceof Error ? err.message : `Extension failed, blocking execution: ${String(err)}` };
			}

			return undefined;
		});

		this.agent.setAfterToolCall(async ({ toolCall, args, result, isError }) => {
			// Wait for all queued agent events to settle
			await this._agentEventQueue;

			if (!this._extensionRunner?.hasHandlers("tool_result")) return undefined;

			const resultResult = await this._extensionRunner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (resultResult) {
				return {
					content: resultResult.content ?? undefined,
					details: resultResult.details ?? undefined,
				};
			}

			return undefined;
		});
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (!this._extensionRunner) return;

		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
			// `stop` fires on true quiescence: the agent cleanly completed and is now
			// waiting for the user. Use the last assistant message's stopReason to
			// distinguish clean completion from error/cancellation.
			const last = event.messages[event.messages.length - 1];
			const stopReason: "completed" | "cancelled" | "error" | "blocked" =
				last?.role === "assistant"
					? last.stopReason === "aborted"
						? "cancelled"
						: last.stopReason === "error"
							? "error"
							: "completed"
					: "completed";
			await this._extensionRunner.emitStop({ reason: stopReason, lastMessage: last });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = undefined;
		this._disconnectFromAgent();
		this._eventListeners = [];
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryHandler.retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, and parameter schema.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolRegistry.values()).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const requestedToolNames = [...new Set([...toolNames, ...this._getBuiltinToolNames()])];
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of requestedToolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.setTools(tools);


		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.setSystemPrompt(this._baseSystemPrompt);
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compactionOrchestrator.isCompacting;
	}

	/**
	 * Switch edit mode between standard (text-match) and hashline (LINE#ID anchors).
	 * Swaps the active read/edit tools and rebuilds the system prompt.
	 */
	setEditMode(mode: "standard" | "hashline"): void {
		this.settingsManager.setEditMode(mode);

		// Get current active tool registry keys
		const currentKeys = new Set<string>();
		for (const [key, tool] of this._toolRegistry.entries()) {
			if (this.agent.state.tools.includes(tool)) {
				currentKeys.add(key);
			}
		}

		// Swap read tools
		if (mode === "hashline") {
			currentKeys.delete("read");
			currentKeys.add("hashline_read");
			currentKeys.delete("edit");
			currentKeys.add("hashline_edit");
		} else {
			currentKeys.delete("hashline_read");
			currentKeys.add("read");
			currentKeys.delete("hashline_edit");
			currentKeys.add("edit");
		}

		this.setActiveToolsByName([...currentKeys]);
	}

	/** Current edit mode */
	get editMode(): "standard" | "hashline" {
		return this.settingsManager.getEditMode();
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _findSkillByName(skillName: string) {
		return this.resourceLoader.getSkills().skills.find((skill) => skill.name === skillName);
	}

	private _formatMissingSkillMessage(skillName: string): string {
		const availableSkills = this.resourceLoader.getSkills().skills.map((skill) => skill.name).join(", ") || "(none)";
		return `Skill "${skillName}" not found. Available skills: ${availableSkills}`;
	}

	private _emitSkillExpansionError(skillFilePath: string, err: unknown): void {
		this._extensionRunner?.emitError({
			extensionPath: skillFilePath,
			event: "skill_expansion",
			error: getErrorMessage(err),
		});
	}

	private _renderSkillInvocation(skill: { name: string; filePath: string; baseDir: string }, args?: string): string {
		const content = readFileSync(skill.filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return args && args.trim() ? `${skillBlock}\n\n${args.trim()}` : skillBlock;
	}

	private _expandSkillByName(skillName: string, args?: string): string {
		const skill = this._findSkillByName(skillName);
		if (!skill) {
			throw new Error(this._formatMissingSkillMessage(skillName));
		}

		try {
			return this._renderSkillInvocation(skill, args);
		} catch (err) {
			this._emitSkillExpansionError(skill.filePath, err);
			throw err;
		}
	}

	private _formatSkillInvocation(skillName: string, args?: string): string {
		return this._expandSkillByName(skillName, args);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		return buildSystemPrompt({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		});
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		// Extension commands manage their own LLM interaction via pi.sendMessage()
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this._tryExecuteExtensionCommand(text);
			if (handled) {
				// Extension command executed, no prompt to send
				return;
			}
		}

		// Emit input event for extension interception (before skill/template expansion)
		let currentText = text;
		let currentImages = options?.images;
		if (this._extensionRunner?.hasHandlers("input")) {
			const inputResult = await this._extensionRunner.emitInput(
				currentText,
				currentImages,
				options?.source ?? "interactive",
			);
			if (inputResult.action === "handled") {
				return;
			}
			if (inputResult.action === "transform") {
				currentText = inputResult.text;
				currentImages = inputResult.images ?? currentImages;
			}
		}

		// Expand skill commands (/skill:name args) and prompt templates (/template args)
		let expandedText = currentText;
		if (expandPromptTemplates) {
			expandedText = this._expandSkillCommand(expandedText);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			if (options.streamingBehavior === "followUp") {
				await this._queueFollowUp(expandedText, currentImages);
			} else {
				await this._queueSteer(expandedText, currentImages);
			}
			return;
		}

		// Flush any pending bash messages before the new prompt
		this._flushPendingBashMessages();

		// Validate model
		if (!this.model) {
			throw new Error(
				"No model selected.\n\n" +
					`Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}\n\n` +
					"Then use /model to select a model.",
			);
		}

		// Check if a higher-priority provider in the fallback chain has recovered
		const restoration = await this._fallbackResolver.checkForRestoration(this.model);
		if (restoration) {
			const previousProvider = `${this.model.provider}/${this.model.id}`;
			this.agent.setModel(restoration.model);
			this.sessionManager.appendModelChange(restoration.model.provider, restoration.model.id);
			this._emit({
				type: "fallback_provider_restored",
				provider: `${restoration.model.provider}/${restoration.model.id}`,
				reason: `Restored from ${previousProvider}`,
			});
		}

		// Validate provider readiness
		if (!this._modelRegistry.isProviderRequestReady(this.model.provider)) {
			const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
			if (isOAuth) {
				throw new Error(
					`Authentication failed for "${this.model.provider}". ` +
						`Credentials may have expired or network is unavailable. ` +
						`Run '/login ${this.model.provider}' to re-authenticate.`,
				);
			}
			throw new Error(
				`No API key found for ${this.model.provider}.\n\n` +
					`Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}`,
			);
		}

		// Check if we need to compact before sending (catches aborted responses)
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) {
			await this._compactionOrchestrator.checkCompaction(lastAssistant, false);
		}

		// Build messages array (custom message if any, then user message)
		const messages: AgentMessage[] = [];

		// Add user message
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (currentImages) {
			userContent.push(...currentImages);
		}
		messages.push({
			role: "user",
			content: userContent,
			timestamp: Date.now(),
		});

		// Inject any pending "nextTurn" messages as context alongside the user message
		for (const msg of this._pendingNextTurnMessages) {
			messages.push(msg);
		}
		this._pendingNextTurnMessages = [];

		// Emit before_agent_start extension event
		if (this._extensionRunner) {
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt) {
				this.agent.setSystemPrompt(result.systemPrompt);
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this.agent.setSystemPrompt(this._baseSystemPrompt);
			}
		}

		await this.agent.prompt(messages);
		await this._retryHandler.waitForRetry();
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this._extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: getErrorMessage(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		if (!this._findSkillByName(skillName)) return text;

		try {
			return this._formatSkillInvocation(skillName, args);
		} catch {
			return text;
		}
	}

	private _createBuiltInSkillTool(): AgentTool {
		const skillSchema = Type.Object({
			skill: Type.String({ description: "The skill name. E.g., 'commit', 'review-pr', or 'pdf'" }),
			args: Type.Optional(Type.String({ description: "Optional arguments for the skill" })),
		});

		return {
			name: "Skill",
			label: "Skill",
			description:
				"Execute a skill within the main conversation. Use this tool when users ask for a slash command or reference a skill by name. Returns the expanded skill block and appends args after it.",
			parameters: skillSchema,
			execute: async (_toolCallId, params: unknown) => {
				const input = params as { skill: string; args?: string };
				try {
					return {
						content: [
							{
								type: "text",
								text: this._expandSkillByName(input.skill, input.args),
							},
						],
						details: undefined,
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: getErrorMessage(err) }],
						details: undefined,
					};
				}
			},
		};
	}

	private _getBuiltinToolNames(): string[] {
		return this._getBuiltinTools().map((tool) => tool.name);
	}

	private _getBuiltinTools(): AgentTool[] {
		return [this._createBuiltInSkillTool()];
	}

	private _getRegisteredToolDefinitions(): ToolDefinition[] {
		const registeredTools = this._extensionRunner?.getAllRegisteredTools() ?? [];
		return registeredTools.map((tool) => tool.definition);
	}

	private _getBuiltinToolDefinitions(): ToolDefinition[] {
		return this._getBuiltinTools().map((tool) => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			execute: async () => ({ content: [], details: undefined }),
		}));
	}

	getRenderableToolDefinition(toolName: string): ToolDefinition | undefined {
		const normalizedToolName = toolName.toLowerCase();
		return [...this._getBuiltinToolDefinitions(), ...this._getRegisteredToolDefinitions()].find(
			(tool) => tool.name.toLowerCase() === normalizedToolName,
		);
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 * Delivered after current tool execution, skips remaining tools.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer(
			{
				role: "user",
				content,
				timestamp: Date.now(),
			},
			"user",
		);
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp(
			{
				role: "user",
				content,
				timestamp: Date.now(),
			},
			"user",
		);
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		if (!this._extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this.agent.prompt(appMessage);
		} else {
			this.agent.appendMessage(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		// Drain user-origin messages from agent queues before clearing.
		// This preserves messages the user explicitly typed during streaming,
		// while system-generated messages (extension notifications, etc.) are discarded.
		const userMessages = this.agent.drainUserMessages();

		// Extract text content from preserved user messages
		const extractText = (m: AgentMessage): string => {
			if (!("content" in m) || !Array.isArray(m.content)) return "";
			const textPart = m.content.find((c: { type: string }) => c.type === "text");
			return textPart && "text" in textPart ? (textPart as { text: string }).text : "";
		};
		const preservedSteering = userMessages.steering.map(extractText).filter((t) => t.length > 0);
		const preservedFollowUp = userMessages.followUp.map(extractText).filter((t) => t.length > 0);

		// Session-level string arrays track what was queued for display purposes.
		// Return the full set (session-tracked + any agent-only user messages).
		const steering = [...this._steeringMessages, ...preservedSteering];
		const followUp = [...this._followUpMessages, ...preservedFollowUp];
		this._steeringMessages = [];
		this._followUpMessages = [];

		// Clear remaining system messages from agent queues
		this.agent.clearAllQueues();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this._retryHandler.abortRetry();
		this.agent.abort();
		await this.agent.waitForIdle();
		// Ensure agent_end is emitted even when abort interrupts a tool call (#1414).
		// The agent may go idle without emitting agent_end if the abort happens
		// between tool execution and response processing. Also fire Stop so
		// Layer 0 hooks see a consistent view of session quiescence.
		if (!this.isStreaming && this._extensionRunner) {
			const messages = this.agent.state.messages;
			await this._extensionRunner.emit({
				type: "agent_end",
				messages,
			});
			const last = messages[messages.length - 1];
			const stopReason: "completed" | "cancelled" | "error" | "blocked" =
				last?.role === "assistant"
					? last.stopReason === "aborted"
						? "cancelled"
						: last.stopReason === "error"
							? "error"
							: "completed"
					: "cancelled";
			await this._extensionRunner.emitStop({ reason: stopReason, lastMessage: last });
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options.parentSession - Optional parent session path for tracking
	 * @param options.setup - Optional callback to initialize session (e.g., append messages)
	 * @returns true if completed, false if cancelled by extension
	 */
	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		/** See ExtensionCommandContext.newSession for docs (#3731). */
		abortSignal?: AbortSignal;
	}): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this._extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

	// #4243: Must call abort() BEFORE _disconnectFromAgent() so that
	// message_end/agent_end events fire and the #4216 finalization code
	// can run before we unsubscribe from the event bus.
	await this.abort();

		// #3731: If the caller aborted (e.g. runUnit() timed out and restored cwd to
		// project root), discard this session before capturing process.cwd() and
		// rebuilding the tool runtime. Without this check, the late newSession()
		// would rebuild tools with root cwd, breaking worktree isolation.
		if (options?.abortSignal?.aborted) {
			return false;
		}

	this._disconnectFromAgent();
	this.agent.reset();
		// Update cwd to current process directory — auto-mode may have chdir'd
		// into a worktree since the original session was created.
		const previousCwd = this._cwd;
		this._cwd = process.cwd();
		this.sessionManager.newSession({ parentSession: options?.parentSession });
		this.agent.sessionId = this.sessionManager.getSessionId();
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._pendingNextTurnMessages = [];

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);

		// Rebuild tools when cwd changed (e.g., auto-mode entered a worktree).
		// Tools capture cwd at creation time for path resolution — without
		// rebuilding, write/read/edit/bash resolve relative paths against
		// the original project root instead of the worktree (#633).
		if (this._cwd !== previousCwd) {
			this._buildRuntime({
				activeToolNames: this.getActiveToolNames(),
				includeAllExtensionTools: true,
			});
		} else {
			// Even when cwd hasn't changed, restore the full tool set (#3616).
			// Extensions (e.g., discuss flows) may narrow the active tool list
			// via setActiveTools() during a session. Without this refresh, the
			// narrowed set persists into the next session — causing tools like
			// gsd_plan_slice to be missing from auto-mode subagent sessions.
			this._refreshToolRegistry({
				activeToolNames: this.getActiveToolNames(),
				includeAllExtensionTools: true,
			});
		}

		// Run setup callback if provided (e.g., to append initial messages)
		if (options?.setup) {
			await options.setup(this.sessionManager);
			// Sync agent state with session manager after setup
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.replaceMessages(sessionContext.messages);
		}

		this._reconnectToAgent();

		// Emit session_switch event with reason "new" to extensions
		if (this._extensionRunner) {
			await this._extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		// Emit session event to custom tools
		this._emitSessionStateChanged("new_session");
		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (!this._extensionRunner) return;
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Apply a model change: set the model on the agent, persist to session/settings,
	 * re-clamp thinking level, and emit the model_select event.
	 */
	private async _applyModelChange(
		model: Model<any>,
		thinkingLevel: ThinkingLevel,
		source: "set" | "cycle" | "restore",
		options?: { persist?: boolean },
	): Promise<void> {
		const previousModel = this.model;
		// Explicit model switches must cancel any in-flight retry loop from the
		// previous provider/model. Otherwise stale provider backoff errors can
		// continue to land after the user or runtime has already switched models.
		this._retryHandler.abortRetry();
		this.agent.setModel(model);
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options?.persist !== false) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}
		this.setThinkingLevel(thinkingLevel);
		await this._emitModelSelect(model, previousModel, source);
		this._emitSessionStateChanged("set_model");
	}

	/**
	 * Set model directly.
	 * Validates provider readiness, saves to session and settings.
	 * @throws Error if provider is not ready (missing credentials for apiKey/oauth providers)
	 */
	async setModel(model: Model<any>, options?: { persist?: boolean }): Promise<void> {
		if (!this._modelRegistry.isProviderRequestReady(model.provider)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		await this._applyModelChange(model, thinkingLevel, "set", options);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward", options?: { persist?: boolean }): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private _getReadyScopedModels(): Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels.filter((scoped) =>
			this._modelRegistry.isProviderRequestReady(scoped.model.provider),
		);
	}

	private async _cycleScopedModel(direction: "forward" | "backward", options?: { persist?: boolean }): Promise<ModelCycleResult | undefined> {
		const scopedModels = this._getReadyScopedModels();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Explicit scoped model thinking level overrides current session level;
		// undefined scoped model thinking level inherits the current session preference.
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);
		await this._applyModelChange(next.model, thinkingLevel, "cycle", options);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward", options?: { persist?: boolean }): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		await this._applyModelChange(nextModel, thinkingLevel, "cycle", options);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const isChanging = effectiveLevel !== this.agent.state.thinkingLevel;

		this.agent.setThinkingLevel(effectiveLevel);

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emitSessionStateChanged("set_thinking_level");
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.supportsThinking()) return ["off"];
		return this.supportsXhighThinking() ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
	}

	/**
	 * Check if current model supports xhigh thinking level.
	 */
	supportsXhighThinking(): boolean {
		return this.model ? supportsXhigh(this.model) : false;
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel {
		const ordered = THINKING_LEVELS_WITH_XHIGH;
		const available = new Set(availableLevels);
		const requestedIndex = ordered.indexOf(level);
		if (requestedIndex === -1) {
			return availableLevels[0] ?? "off";
		}
		for (let i = requestedIndex; i < ordered.length; i++) {
			const candidate = ordered[i];
			if (available.has(candidate)) return candidate;
		}
		for (let i = requestedIndex - 1; i >= 0; i--) {
			const candidate = ordered[i];
			if (available.has(candidate)) return candidate;
		}
		return availableLevels[0] ?? "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settingsManager.setSteeringMode(mode);
		this._emitSessionStateChanged("set_steering_mode");
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settingsManager.setFollowUpMode(mode);
		this._emitSessionStateChanged("set_follow_up_mode");
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this._compactionOrchestrator.compact(customInstructions);
	}

	/** Cancel in-progress compaction (manual or auto) */
	abortCompaction(): void {
		this._compactionOrchestrator.abortCompaction();
	}

	/** Cancel in-progress branch summarization */
	abortBranchSummary(): void {
		this._compactionOrchestrator.abortBranchSummary();
	}

	/** Toggle auto-compaction setting */
	setAutoCompactionEnabled(enabled: boolean): void {
		this._compactionOrchestrator.setAutoCompactionEnabled(enabled);
		this._emitSessionStateChanged("set_auto_compaction");
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this._compactionOrchestrator.autoCompactionEnabled;
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		if (this._extensionRunner) {
			this._applyExtensionBindings(this._extensionRunner);
			await this._extensionRunner.emit({ type: "session_start" });
			await this.extendResourcesFromExtensions("startup");
		}
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner?.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.setSystemPrompt(this._baseSystemPrompt);
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.bindCommandContext(this._extensionCommandContextActions);

		try {
			this._extensionErrorUnsubscriber?.();
		} catch {
			// Ignore errors from previous unsubscriber
		}
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const normalizeLocation = (source: string): SlashCommandLocation | undefined => {
			if (source === "user" || source === "project" || source === "path") {
				return source;
			}
			return undefined;
		};

		const reservedBuiltins = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner
				.getRegisteredCommandsWithPaths()
				.filter(({ command }) => !reservedBuiltins.has(command.name))
				.map(({ command, extensionPath }) => ({
					name: command.name,
					description: command.description,
					source: "extension",
					path: extensionPath,
				}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				location: normalizeLocation(template.source),
				path: template.filePath,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				location: normalizeLocation(skill.source),
				path: skill.filePath,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: getErrorMessage(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: getErrorMessage(err),
						});
					});
				},
				retryLastTurn: () => {
					const messages = this.agent.state.messages;
					const last = messages[messages.length - 1];
					if (last?.role === "assistant" && (last as AssistantMessage).stopReason === "error") {
						// If the error was an image dimension overflow, downsize images
						// before retrying so the retry doesn't hit the same error (#2874)
						if (isImageDimensionError((last as AssistantMessage).errorMessage)) {
							downsizeConversationImages(messages as Message[]);
						}
						this.agent.replaceMessages(messages.slice(0, -1));
						this.agent.continue().catch((err) => {
							runner.emitError({
								extensionPath: "<runtime>",
								event: "retry_last_turn",
								error: getErrorMessage(err),
							});
						});
					}
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.sessionManager.appendSessionInfo(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model, options) => {
					if (!this.modelRegistry.isProviderRequestReady(model.provider)) return false;
					await this.setModel(model, options);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isStreaming,
				abort: () => this.abort(),
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();

		const registeredTools = this._extensionRunner?.getAllRegisteredTools() ?? [];
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((def) => ({ definition: def, extensionPath: "<sdk>" })),
		];
		this._toolPromptSnippets = new Map(
			allCustomTools
				.map((registeredTool) => {
					const snippet = this._normalizePromptSnippet(
						registeredTool.definition.promptSnippet ?? registeredTool.definition.description,
					);
					return snippet ? ([registeredTool.definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			allCustomTools
				.map((registeredTool) => {
					const guidelines = this._normalizePromptGuidelines(registeredTool.definition.promptGuidelines);
					return guidelines.length > 0 ? ([registeredTool.definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const wrappedExtensionTools = this._extensionRunner
			? wrapRegisteredTools(allCustomTools, this._extensionRunner)
			: [];
		const builtinTools = this._getBuiltinTools();

		const toolRegistry = new Map(this._baseToolRegistry);
		for (const tool of builtinTools) {
			toolRegistry.set(tool.name, tool);
		}
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}

		// Tool interception (tool_call/tool_result extension events) is handled by
		// beforeToolCall/afterToolCall hooks installed in _installAgentToolHooks(),
		// which await _agentEventQueue for safe parallel execution.
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = options?.activeToolNames
			? [...options.activeToolNames]
			: [...previousActiveToolNames];

		if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const baseTools = this._baseToolsOverride
			? this._baseToolsOverride
			: createAllTools(this._cwd, {
					read: { autoResizeImages },
					bash: {
						commandPrefix: shellCommandPrefix,
						interceptor: {
							enabled: this.settingsManager.getBashInterceptorEnabled(),
							rules: this.settingsManager.getBashInterceptorRules(),
						},
						availableToolNames: () => this.getActiveToolNames(),
					},
				});

		this._baseToolRegistry = new Map(Object.entries(baseTools).map(([name, tool]) => [name, tool as AgentTool]));

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		const hasExtensions = extensionsResult.extensions.length > 0;
		const hasCustomTools = this._customTools.length > 0;
		this._extensionRunner =
			hasExtensions || hasCustomTools
				? new ExtensionRunner(
						extensionsResult.extensions,
						extensionsResult.runtime,
						this._cwd,
						this.sessionManager,
						this._modelRegistry,
					)
				: undefined;
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		if (this._extensionRunner) {
			this._bindExtensionCore(this._extensionRunner);
			this._applyExtensionBindings(this._extensionRunner);
		}

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write", "lsp"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(): Promise<void> {
		const previousFlagValues = this._extensionRunner?.getFlagValues();
		await this._extensionRunner?.emit({ type: "session_shutdown" });
		this.settingsManager.reload();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (this._extensionRunner && hasBindings) {
			await this._extensionRunner.emit({ type: "session_start" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry (delegated to RetryHandler)
	// =========================================================================

	/** Cancel in-progress retry */
	abortRetry(): void {
		const hadRetry = this._retryHandler.isRetrying;
		this._retryHandler.abortRetry();
		if (hadRetry) {
			this._emitSessionStateChanged("abort_retry");
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryHandler.isRetrying;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this._retryHandler.autoRetryEnabled;
	}

	/** Toggle auto-retry setting */
	setAutoRetryEnabled(enabled: boolean): void {
		this._retryHandler.setAutoRetryEnabled(enabled);
		this._emitSessionStateChanged("set_auto_retry");
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations; loginShell?: boolean },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = options?.operations
				? await executeBashWithOperations(resolvedCommand, process.cwd(), options.operations, {
						onChunk,
						signal: this._bashAbortController.signal,
					})
				: await executeBashCommand(resolvedCommand, {
						onChunk,
						signal: this._bashAbortController.signal,
						loginShell: options?.loginShell,
					});

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by extension
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();

		// Emit session_before_switch event (can be cancelled)
		if (this._extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

	// #4243: Must call abort() BEFORE _disconnectFromAgent() so that
	// message_end/agent_end events fire and the #4216 finalization code
	// can run before we unsubscribe from the event bus.
	await this.abort();
	this._disconnectFromAgent();
	this._steeringMessages = [];
		this._followUpMessages = [];
		this._pendingNextTurnMessages = [];

		// Set new session
		this.sessionManager.setSessionFile(sessionPath);
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Reload messages
		const sessionContext = this.sessionManager.buildSessionContext();

		// Emit session_switch event to extensions
		if (this._extensionRunner) {
			await this._extensionRunner.emit({
				type: "session_switch",
				reason: "resume",
				previousSessionFile,
			});
		}

		// Emit session event to custom tools

		this.agent.replaceMessages(sessionContext.messages);

		// Restore model if saved
		if (sessionContext.model) {
			const previousModel = this.model;
			const availableModels = await this._modelRegistry.getAvailable();
			const match = availableModels.find(
				(m) => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId,
			);
			if (match) {
				this.agent.setModel(match);
				await this._emitModelSelect(match, previousModel, "restore");
			}
		}

		const hasThinkingEntry = this.sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
		const defaultThinkingLevel = this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;

		if (hasThinkingEntry) {
			// Restore thinking level if saved (setThinkingLevel clamps to model capabilities)
			this.setThinkingLevel(sessionContext.thinkingLevel as ThinkingLevel);
		} else {
			const availableLevels = this.getAvailableThinkingLevels();
			const effectiveLevel = availableLevels.includes(defaultThinkingLevel)
				? defaultThinkingLevel
				: this._clampThinkingLevel(defaultThinkingLevel, availableLevels);
			this.agent.setThinkingLevel(effectiveLevel);
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
		}

		this._reconnectToAgent();
		this._emitSessionStateChanged("switch_session");
		return true;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this._emitSessionStateChanged("set_session_name");
	}

	/**
	 * Create a fork from a specific entry.
	 * Emits before_fork/fork session events to extensions.
	 *
	 * @param entryId ID of the entry to fork from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if an extension cancelled the fork
	 */
	async fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for forking");
		}

		const selectedText = this._extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// Emit session_before_fork event (can be cancelled)
		if (this._extensionRunner?.hasHandlers("session_before_fork")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_fork",
				entryId,
			})) as SessionBeforeForkResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		// Clear pending messages (bound to old session state)
		this._pendingNextTurnMessages = [];

		if (!selectedEntry.parentId) {
			this.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.sessionManager.buildSessionContext();

		// Emit session_fork event to extensions (after fork completes)
		if (this._extensionRunner) {
			await this._extensionRunner.emit({
				type: "session_fork",
				previousSessionFile,
			});
		}

		// Emit session event to custom tools (with reason "fork")

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
		}

		this._emitSessionStateChanged("fork");
		return { selectedText, cancelled: false };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._compactionOrchestrator.branchSummaryAbortController = new AbortController();
		let extensionSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this._extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this._compactionOrchestrator.branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				extensionSummary = result.summary;
				fromExtension = true;
			}

			// Allow extensions to override instructions and label
			if (result?.customInstructions !== undefined) {
				customInstructions = result.customInstructions;
			}
			if (result?.replaceInstructions !== undefined) {
				replaceInstructions = result.replaceInstructions;
			}
			if (result?.label !== undefined) {
				label = result.label;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
			const model = this.model!;
			if (!this._modelRegistry.isProviderRequestReady(model.provider)) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const apiKey = await this._modelRegistry.getApiKey(model, this.sessionId);
			const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey,
				signal: this._compactionOrchestrator.branchSummaryAbortController.signal,
				customInstructions,
				replaceInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
			});
			this._compactionOrchestrator.branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (extensionSummary) {
			summaryText = extensionSummary.summary;
			summaryDetails = extensionSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this._extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

			// Attach label to the summary entry
			if (label) {
				this.sessionManager.appendLabelChange(summaryId, label);
			}
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			this.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			this.sessionManager.branch(newLeafId);
		}

		// Attach label to target entry when not summarizing (no summary entry to label)
		if (label && !summaryText) {
			this.sessionManager.appendLabelChange(targetId, label);
		}

		// Update agent state
		const sessionContext = this.sessionManager.buildSessionContext();
		this.agent.replaceMessages(sessionContext.messages);

		// Emit session_tree event
		if (this._extensionRunner) {
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
		}

		// Emit to custom tools

		this._compactionOrchestrator.branchSummaryAbortController = undefined;
		return { editorText, cancelled: false, summaryEntry };
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls: Math.max(toolCalls, this._cumulativeToolCalls),
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: Math.max(totalInput, this._cumulativeInputTokens),
				output: Math.max(totalOutput, this._cumulativeOutputTokens),
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: Math.max(totalInput + totalOutput, this._cumulativeInputTokens + this._cumulativeOutputTokens) + totalCacheRead + totalCacheWrite,
			},
			cost: Math.max(totalCost, this._cumulativeCost),
		};
	}

	/**
	 * Get the cost of the most recent assistant response.
	 * Returns 0 if no assistant message has been received yet.
	 */
	getLastTurnCost(): number {
		return this._lastTurnCost;
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		// Create tool renderer for extension and built-in tool HTML rendering
		const toolRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getRenderableToolDefinition(name),
			theme,
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this._extensionRunner;
	}
}
