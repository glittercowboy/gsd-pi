/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSession } from "../../core/agent-session.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { InteractiveMode } from "../interactive/interactive-mode.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { createDefaultCommandContextActions } from "../shared/command-context-actions.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { RemoteTerminal } from "./remote-terminal.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcInitResult,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcInitResult,
	RpcProtocolVersion,
	RpcResponse,
	RpcSessionState,
	RpcV2Event,
} from "./rpc-types.js";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession): Promise<never> {
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		process.stdout.write(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;

	// v2 protocol version detection state
	let protocolVersion: 1 | 2 = 1;
	let protocolLocked = false;

	// v2 runId threading: tracks the current execution run
	let currentRunId: string | null = null;

	// v2 event filtering: null = no filter (all events); Set = only listed event types
	let eventFilter: Set<string> | null = null;

	const embeddedTerminalEnabled = process.env.GSD_WEB_BRIDGE_TUI === "1";
	const remoteTerminal = embeddedTerminalEnabled
		? new RemoteTerminal({
				onWrite: (data) => {
					output({ type: "terminal_output", data });
				},
			})
		: null;
	let embeddedInteractiveMode: InteractiveMode | null = null;
	let embeddedInteractiveInitPromise: Promise<void> | null = null;
	const startupNotifications: Array<{ message: string; type?: "info" | "warning" | "error" | "success" }> = [];
	const statusState = new Map<string, string | undefined>();
	const widgetState = new Map<string, { content: unknown; options?: ExtensionWidgetOptions }>();
	let footerFactory: Parameters<ExtensionUIContext["setFooter"]>[0] | undefined;
	let headerFactory: Parameters<ExtensionUIContext["setHeader"]>[0] | undefined;
	let workingMessageState: string | undefined;
	let titleState: string | undefined;
	let editorTextState: string | undefined;

	const withEmbeddedUiContext = async (apply: (ui: ExtensionUIContext) => void | Promise<void>): Promise<void> => {
		if (!embeddedInteractiveMode) {
			return;
		}
		await apply(embeddedInteractiveMode.getExtensionUIContext());
	};

	const replayEmbeddedUiState = async (interactiveMode: InteractiveMode): Promise<void> => {
		const ui = interactiveMode.getExtensionUIContext();
		ui.setHeader(headerFactory);
		ui.setFooter(footerFactory);
		for (const [key, text] of statusState.entries()) {
			ui.setStatus(key, text);
		}
		for (const [key, widget] of widgetState.entries()) {
			ui.setWidget(key, widget.content as any, widget.options);
		}
		ui.setWorkingMessage(workingMessageState);
		if (titleState) {
			ui.setTitle(titleState);
		}
		if (editorTextState !== undefined) {
			ui.setEditorText(editorTextState);
		}
		for (const { message, type } of startupNotifications) {
			ui.notify(message, type);
		}
	};

	const ensureEmbeddedInteractiveMode = async (): Promise<InteractiveMode> => {
		if (!embeddedTerminalEnabled || !remoteTerminal) {
			throw new Error("Embedded terminal is not enabled for this RPC host");
		}

		if (embeddedInteractiveMode) {
			return embeddedInteractiveMode;
		}

		if (!embeddedInteractiveInitPromise) {
			embeddedInteractiveMode = new InteractiveMode(session, {
				terminal: remoteTerminal,
				bindExtensions: false,
				submitPromptsDirectly: true,
				shutdownBehavior: "ignore",
			});
			embeddedInteractiveInitPromise = embeddedInteractiveMode.init().then(async () => {
				await replayEmbeddedUiState(embeddedInteractiveMode!);
			}).catch((error) => {
				embeddedInteractiveMode = null;
				throw error;
			}).finally(() => {
				embeddedInteractiveInitPromise = null;
			});
		}

		await embeddedInteractiveInitPromise;
		return embeddedInteractiveMode!;
	};

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout, allowMultiple: opts?.allowMultiple }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "values" in r ? r.values : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout, secure: opts?.secure }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error" | "success"): void {
			startupNotifications.push({ message, type });
			if (startupNotifications.length > 20) {
				startupNotifications.splice(0, startupNotifications.length - 20);
			}
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
			void withEmbeddedUiContext((ui) => {
				ui.notify(message, type);
			});
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			statusState.set(key, text);
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
			void withEmbeddedUiContext((ui) => {
				ui.setStatus(key, text);
			});
		},

		setWorkingMessage(message?: string): void {
			workingMessageState = message;
			void withEmbeddedUiContext((ui) => {
				ui.setWorkingMessage(message);
			});
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			widgetState.set(key, { content, options });
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			} else if (typeof content === "function") {
				// Factory-based widgets require TUI access which RPC mode does not have.
				// Emit a minimal placeholder so the RPC client knows a widget was requested.
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			void withEmbeddedUiContext((ui) => {
				ui.setWidget(key, content as any, options);
			});
		},

		setFooter(factory: Parameters<ExtensionUIContext["setFooter"]>[0]): void {
			footerFactory = factory;
			void withEmbeddedUiContext((ui) => {
				ui.setFooter(factory);
			});
		},

		setHeader(factory: Parameters<ExtensionUIContext["setHeader"]>[0]): void {
			headerFactory = factory;
			void withEmbeddedUiContext((ui) => {
				ui.setHeader(factory);
			});
		},

		setTitle(title: string): void {
			titleState = title;
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
			void withEmbeddedUiContext((ui) => {
				ui.setTitle(title);
			});
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			editorTextState = text;
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
			void withEmbeddedUiContext((ui) => {
				ui.setEditorText(text);
			});
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	// Set up extensions with RPC-based UI context.
	// Do not block the initial RPC handshake on extension session_start hooks:
	// browser boot only needs get_state, and several startup-only notifications
	// (MCP availability, web-search status, etc.) can complete in the background.
	// Track readiness so consumers can know when extension commands are available.
	let extensionsReady = false;
	const extensionsReadyPromise = session.bindExtensions({
		uiContext: createExtensionUIContext(),
		commandContextActions: createDefaultCommandContextActions(session),
		shutdownHandler: () => {
			shutdownRequested = true;
		},
		onError: (err) => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
	}).then(() => {
		extensionsReady = true;
		output({ type: "extensions_ready" });
	}).catch((error) => {
		extensionsReady = true; // Mark ready even on failure so consumers don't wait forever
		output({
			type: "extension_error",
			event: "session_start",
			error: error instanceof Error ? error.message : String(error),
		});
	});
	void extensionsReadyPromise;

	// Output all agent events as JSON
	const unsubscribe = session.subscribe((event) => {
		// v2: emit synthesized events before the regular event
		if (protocolVersion === 2) {
			// cost_update on assistant message_end
			if (event.type === "message_end" && event.message.role === "assistant" && currentRunId) {
				const stats = session.getSessionStats();
				const costUpdate = {
					type: "cost_update" as const,
					runId: currentRunId,
					turnCost: session.getLastTurnCost(),
					cumulativeCost: stats.cost,
					tokens: {
						input: stats.tokens.input,
						output: stats.tokens.output,
						cacheRead: stats.tokens.cacheRead,
						cacheWrite: stats.tokens.cacheWrite,
					},
				};
				if (!eventFilter || eventFilter.has("cost_update")) {
					output(costUpdate);
				}
			}

			// execution_complete on agent_end
			if (event.type === "agent_end" && currentRunId) {
				const stats = session.getSessionStats();
				const completionEvent = {
					type: "execution_complete" as const,
					runId: currentRunId,
					status: "completed" as const,
					stats,
				};
				if (!eventFilter || eventFilter.has("execution_complete")) {
					output(completionEvent);
				}
				currentRunId = null;
			}
		}

		// Apply event filter (v2 only, applies to agent session events only)
		if (protocolVersion === 2 && eventFilter && !eventFilter.has(event.type)) {
			return;
		}

		// Emit the regular event, with runId injection in v2 mode
		if (protocolVersion === 2 && currentRunId) {
			output({ ...event, runId: currentRunId });
		} else {
			output(event);
		}
	});

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// v2: generate runId for execution tracking
				const runId = protocolVersion === 2 ? crypto.randomUUID() : undefined;
				if (runId) currentRunId = runId;
				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
					})
					.catch((e) => output(error(id, "prompt", e.message)));
				return { id, type: "response", command: "prompt", success: true, ...(runId && { runId }) } as RpcResponse;
			}

			case "steer": {
				// v2: generate runId for execution tracking
				const runId = protocolVersion === 2 ? crypto.randomUUID() : undefined;
				if (runId) currentRunId = runId;
				await session.steer(command.message, command.images);
				return { id, type: "response", command: "steer", success: true, ...(runId && { runId }) } as RpcResponse;
			}

			case "follow_up": {
				// v2: generate runId for execution tracking
				const runId = protocolVersion === 2 ? crypto.randomUUID() : undefined;
				if (runId) currentRunId = runId;
				await session.followUp(command.message, command.images);
				return { id, type: "response", command: "follow_up", success: true, ...(runId && { runId }) } as RpcResponse;
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const cancelled = !(await session.newSession(options));
				return success(id, "new_session", { cancelled });
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					autoRetryEnabled: session.autoRetryEnabled,
					retryInProgress: session.isRetrying,
					retryAttempt: session.retryAttempt,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
					extensionsReady,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const cancelled = !(await session.switchSession(command.sessionPath));
				return success(id, "switch_session", { cancelled });
			}

			case "fork": {
				const result = await session.fork(command.entryId);
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				// Extension commands
				for (const { command, extensionPath } of session.extensionRunner?.getRegisteredCommandsWithPaths() ?? []) {
					commands.push({
						name: command.name,
						description: command.description,
						source: "extension",
						path: extensionPath,
					});
				}

				// Prompt templates (source is always "user" | "project" | "path" in coding-agent)
				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						location: template.source as RpcSlashCommand["location"],
						path: template.filePath,
					});
				}

				// Skills (source is always "user" | "project" | "path" in coding-agent)
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						location: skill.source as RpcSlashCommand["location"],
						path: skill.filePath,
					});
				}

				return success(id, "get_commands", { commands });
			}

			case "terminal_input": {
				await ensureEmbeddedInteractiveMode();
				remoteTerminal!.pushInput(command.data);
				return success(id, "terminal_input");
			}

			case "terminal_resize": {
				await ensureEmbeddedInteractiveMode();
				remoteTerminal!.resize(command.cols, command.rows);
				return success(id, "terminal_resize");
			}

			case "terminal_redraw": {
				const interactiveMode = await ensureEmbeddedInteractiveMode();
				interactiveMode.requestRender(true);
				return success(id, "terminal_redraw");
			}

			// =================================================================
			// v2 Protocol: subscribe
			// =================================================================

			case "subscribe": {
				if (command.events.includes("*")) {
					eventFilter = null; // wildcard = all events
				} else {
					eventFilter = new Set(command.events);
				}
				return success(id, "subscribe");
			}

			// =================================================================
			// v2 Protocol: shutdown
			// =================================================================

			case "shutdown": {
				shutdownRequested = true;
				return success(id, "shutdown");
			}

			default: {
				const unknownCommand = command as { type: string; id?: string };
				return error(unknownCommand.id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;

		const currentRunner = session.extensionRunner;
		if (currentRunner?.hasHandlers("session_shutdown")) {
			await currentRunner.emit({ type: "session_shutdown" });
		}

		unsubscribe();
		embeddedInteractiveMode?.stop();
		detachInput();
		process.stdin.pause();
		process.exit(0);
	}

	const handleInputLine = async (line: string) => {
		try {
			const parsed = JSON.parse(line);

			// Handle extension UI responses (bypass protocol detection)
			if (parsed.type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pendingExtensionRequests.delete(response.id);
					pending.resolve(response);
				}
				return;
			}

			const command = parsed as RpcCommand;

			// Protocol version detection: first non-UI-response command locks the version
			if (!protocolLocked) {
				protocolLocked = true;
				if (command.type === "init") {
					protocolVersion = 2;
					const initResult: RpcInitResult = {
						protocolVersion: 2,
						sessionId: session.sessionId,
						capabilities: {
							events: ["execution_complete", "cost_update"],
							commands: ["init", "shutdown", "subscribe"],
						},
					};
					output(success(command.id, "init", initResult));
					return;
				}
				// Non-init first message: lock to v1, fall through to normal handling
				protocolVersion = 1;
			} else if (command.type === "init") {
				// Already locked — reject re-init
				output(error(command.id, "init", "Protocol version already locked. init must be the first command."));
				return;
			}

			// Handle regular commands
			const response = await handleCommand(command);
			output(response);

			// Check for deferred shutdown request (idle between commands)
			await checkShutdownRequested();
		} catch (e: any) {
			output(error(undefined, "parse", `Failed to parse command: ${e.message}`));
		}
	};

	detachInput = attachJsonlLineReader(process.stdin, (line) => {
		void handleInputLine(line);
	});

	// Keep process alive forever
	return new Promise(() => {});
}
