/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 * This is a standalone SDK client — all types are inlined with zero internal
 * package dependencies.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	BashResult,
	CompactionResult,
	ImageContent,
	ModelInfo,
	RpcCommand,
	RpcInitResult,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	ThinkingLevel,
	SessionStats,
} from "./rpc-types.js";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

/** Agent event — a loosely-typed record from the server. The `type` field is always present. */
export interface SdkAgentEvent {
	type: string;
	[key: string]: unknown;
}

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
}

export type RpcEventListener = (event: SdkAgentEvent) => void;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private _stderrHandler?: (data: Buffer) => void;
	private eventListeners: RpcEventListener[] = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private _stopped = false;

	constructor(private options: RpcClientOptions = {}) {}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		this._stopped = false;

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.process = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Collect stderr for debugging
		this._stderrHandler = (data: Buffer) => {
			this.stderr += data.toString();
		};
		this.process.stderr?.on("data", this._stderrHandler);

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(this.process.stdout!, (line) => {
			this.handleLine(line);
		});

		// Detect unexpected subprocess exit and reject all pending requests
		this.process.on("exit", (code, signal) => {
			if (this.pendingRequests.size > 0) {
				const reason = signal ? `signal ${signal}` : `code ${code}`;
				const error = new Error(`Agent process exited unexpectedly (${reason}). Stderr: ${this.stderr}`);
				for (const [id, pending] of this.pendingRequests) {
					this.pendingRequests.delete(id);
					pending.reject(error);
				}
			}
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this._stopped = true;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		if (this._stderrHandler) {
			this.process.stderr?.removeListener("data", this._stderrHandler);
			this._stderrHandler = undefined;
		}
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events via callback.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Async generator that yields agent events as they arrive.
	 *
	 * Usage:
	 * ```ts
	 * for await (const event of client.events()) {
	 *   console.log(event.type, event);
	 * }
	 * ```
	 *
	 * The generator terminates when:
	 * - `stop()` is called
	 * - The agent process exits
	 * - The consumer breaks out of the loop
	 */
	async *events(): AsyncGenerator<SdkAgentEvent, void, undefined> {
		if (!this.process) {
			throw new Error("Client not started — call start() before events()");
		}

		if (this._stopped) {
			return;
		}

		const buffer: SdkAgentEvent[] = [];
		let resolve: ((value: void) => void) | null = null;
		let done = false;

		// When a new event arrives, either push to buffer or wake up the awaiting generator
		const listener = (event: SdkAgentEvent) => {
			buffer.push(event);
			if (resolve) {
				const r = resolve;
				resolve = null;
				r();
			}
		};

		// When the process exits, signal the generator to stop
		const onExit = () => {
			done = true;
			if (resolve) {
				const r = resolve;
				resolve = null;
				r();
			}
		};

		const unsubscribe = this.onEvent(listener);
		this.process.on("exit", onExit);

		try {
			while (!done && !this._stopped) {
				// Drain buffer first
				while (buffer.length > 0) {
					yield buffer.shift()!;
				}

				// If done after draining, break
				if (done || this._stopped) {
					break;
				}

				// Wait for next event or process exit
				await new Promise<void>((r) => {
					resolve = r;
				});
			}

			// Drain any remaining events that arrived with the exit signal
			while (buffer.length > 0) {
				yield buffer.shift()!;
			}
		} finally {
			unsubscribe();
			this.process?.removeListener("exit", onExit);
		}
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() or events() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 * Messages are returned as opaque objects — the internal structure may vary.
	 */
	async getMessages(): Promise<unknown[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: unknown[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	/**
	 * Send a UI response to a pending extension_ui_request.
	 * Fire-and-forget — no request/response correlation.
	 */
	sendUIResponse(id: string, response: { value?: string; values?: string[]; confirmed?: boolean; cancelled?: boolean }): void {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}
		this.process.stdin.write(serializeJsonLine({
			type: "extension_ui_response",
			id,
			...response,
		}));
	}

	/**
	 * Initialize a v2 protocol session. Must be sent as the first command.
	 * Returns the negotiated protocol version, session ID, and server capabilities.
	 */
	async init(options?: { clientId?: string }): Promise<RpcInitResult> {
		const response = await this.send({ type: "init", protocolVersion: 2, clientId: options?.clientId });
		return this.getData<RpcInitResult>(response);
	}

	/**
	 * Request a graceful shutdown of the agent process.
	 * Waits for the response before the process exits.
	 */
	async shutdown(): Promise<void> {
		await this.send({ type: "shutdown" });
		// Wait for process to exit after shutdown acknowledgment
		if (this.process) {
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					this.process?.kill("SIGKILL");
					resolve();
				}, 5000);
				this.process?.on("exit", () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}
	}

	/**
	 * Subscribe to specific event types (v2 only).
	 * Pass ["*"] to receive all events, or a list of event type strings to filter.
	 */
	async subscribe(events: string[]): Promise<void> {
		await this.send({ type: "subscribe", events });
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<SdkAgentEvent[]> {
		return new Promise((resolve, reject) => {
			const events: SdkAgentEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<SdkAgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Otherwise it's an event — dispatch to listeners
			for (const listener of this.eventListeners) {
				listener(data as SdkAgentEvent);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.process!.stdin!.write(serializeJsonLine(fullCommand));
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
