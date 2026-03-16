import { ChildProcess, spawn } from "node:child_process";
import * as vscode from "vscode";

/**
 * Mirrors the RPC command/response protocol from the GSD agent.
 * These types are intentionally kept minimal and self-contained so the
 * extension has no dependency on the agent packages at runtime.
 */

export interface RpcSessionState {
	model?: { provider: string; id: string; contextWindow?: number };
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow?: number;
	reasoning?: boolean;
}

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface AgentEvent {
	type: string;
	[key: string]: unknown;
}

type PendingRequest = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/**
 * Client that spawns `gsd --mode rpc` and communicates via JSON lines
 * over stdin/stdout. Emits VS Code events for streaming responses.
 */
export class GsdClient implements vscode.Disposable {
	private process: ChildProcess | null = null;
	private pendingRequests = new Map<string, PendingRequest>();
	private requestId = 0;
	private buffer = "";
	private restartCount = 0;

	private readonly _onEvent = new vscode.EventEmitter<AgentEvent>();
	readonly onEvent = this._onEvent.event;

	private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
	readonly onConnectionChange = this._onConnectionChange.event;

	private readonly _onError = new vscode.EventEmitter<string>();
	readonly onError = this._onError.event;

	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly binaryPath: string,
		private readonly cwd: string,
	) {
		this.disposables.push(this._onEvent, this._onConnectionChange, this._onError);
	}

	get isConnected(): boolean {
		return this.process !== null && this.process.exitCode === null;
	}

	/**
	 * Spawn the GSD agent in RPC mode.
	 */
	async start(): Promise<void> {
		if (this.process) {
			return;
		}

		this.process = spawn(this.binaryPath, ["--mode", "rpc", "--no-session"], {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		this.buffer = "";

		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			this.drainBuffer();
		});

		this.process.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trim();
			if (text) {
				this._onError.fire(text);
			}
		});

		this.process.on("exit", (code, signal) => {
			this.process = null;
			this.rejectAllPending(`GSD process exited (code=${code}, signal=${signal})`);
			this._onConnectionChange.fire(false);

			if (this.restartCount < 3 && code !== 0 && signal !== "SIGTERM") {
				this.restartCount++;
				setTimeout(() => this.start(), 1000 * this.restartCount);
			}
		});

		this._onConnectionChange.fire(true);
		this.restartCount = 0;
	}

	/**
	 * Stop the GSD agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) {
			return;
		}

		const proc = this.process;
		this.process = null;
		proc.kill("SIGTERM");

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 2000);
			proc.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.rejectAllPending("Client stopped");
		this._onConnectionChange.fire(false);
	}

	/**
	 * Send a prompt message to the agent.
	 * Returns once the command is acknowledged; streaming events follow via onEvent.
	 */
	async sendPrompt(message: string): Promise<void> {
		const response = await this.send({ type: "prompt", message });
		this.assertSuccess(response);
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		const response = await this.send({ type: "abort" });
		this.assertSuccess(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		this.assertSuccess(response);
		return response.data as RpcSessionState;
	}

	/**
	 * Set the active model.
	 */
	async setModel(provider: string, modelId: string): Promise<void> {
		const response = await this.send({ type: "set_model", provider, modelId });
		this.assertSuccess(response);
	}

	/**
	 * Get available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		this.assertSuccess(response);
		return (response.data as { models: ModelInfo[] }).models;
	}

	/**
	 * Start a new session.
	 */
	async newSession(): Promise<void> {
		const response = await this.send({ type: "new_session" });
		this.assertSuccess(response);
	}

	dispose(): void {
		this.stop();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	// -- Private helpers ------------------------------------------------------

	private drainBuffer(): void {
		while (true) {
			const newlineIdx = this.buffer.indexOf("\n");
			if (newlineIdx === -1) {
				break;
			}
			let line = this.buffer.slice(0, newlineIdx);
			this.buffer = this.buffer.slice(newlineIdx + 1);

			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			if (!line) {
				continue;
			}
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(line);
		} catch {
			return; // ignore non-JSON lines
		}

		// Response to a pending request
		if (data.type === "response" && typeof data.id === "string" && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			clearTimeout(pending.timer);
			pending.resolve(data as unknown as RpcResponse);
			return;
		}

		// Streaming event
		this._onEvent.fire(data as AgentEvent);
	}

	private send(command: Record<string, unknown>): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			return Promise.reject(new Error("GSD client not started"));
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id };

		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, 30_000);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.process!.stdin!.write(JSON.stringify(fullCommand) + "\n");
		});
	}

	private assertSuccess(response: RpcResponse): void {
		if (!response.success) {
			throw new Error(response.error ?? "Unknown RPC error");
		}
	}

	private rejectAllPending(reason: string): void {
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pendingRequests.clear();
	}
}
