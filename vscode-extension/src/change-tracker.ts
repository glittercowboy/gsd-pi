import * as vscode from "vscode";
import * as fs from "node:fs";
import type { GsdClient, AgentEvent } from "./gsd-client.js";

export interface FileSnapshot {
	uri: vscode.Uri;
	originalContent: string;
	timestamp: number;
}

export interface Checkpoint {
	id: number;
	label: string;
	timestamp: number;
	/** Map of file path → original content at checkpoint creation time */
	snapshots: Map<string, string>;
}

/**
 * Tracks file changes made by the GSD agent. Stores original file content
 * before the agent modifies it, enabling diff views, SCM integration,
 * and checkpoint/rollback functionality.
 */
export class GsdChangeTracker implements vscode.Disposable {
	/** file path → original content (before first agent modification this session) */
	private originals = new Map<string, string>();
	/** Set of file paths modified in the current agent turn */
	private currentTurnFiles = new Set<string>();
	/** Ordered list of checkpoints */
	private _checkpoints: Checkpoint[] = [];
	private nextCheckpointId = 1;
	/** toolUseId → file path for in-flight tool executions */
	private pendingTools = new Map<string, string>();

	private readonly _onDidChange = new vscode.EventEmitter<string[]>();
	/** Fires when the set of tracked files changes. Payload is array of changed file paths. */
	readonly onDidChange = this._onDidChange.event;

	private readonly _onCheckpointChange = new vscode.EventEmitter<void>();
	readonly onCheckpointChange = this._onCheckpointChange.event;

	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		this.disposables.push(this._onDidChange, this._onCheckpointChange);

		this.disposables.push(
			client.onEvent((evt) => this.handleEvent(evt)),
			client.onConnectionChange((connected) => {
				if (!connected) {
					this.reset();
				}
			}),
		);
	}

	/** All file paths that have been modified by the agent */
	get modifiedFiles(): string[] {
		return [...this.originals.keys()];
	}

	/** Get the original content of a file (before agent first modified it) */
	getOriginal(filePath: string): string | undefined {
		return this.originals.get(filePath);
	}

	/** Whether the tracker has any modifications */
	get hasChanges(): boolean {
		return this.originals.size > 0;
	}

	/** Current checkpoints (newest first) */
	get checkpoints(): readonly Checkpoint[] {
		return this._checkpoints;
	}

	/**
	 * Discard agent changes to a single file — restore original content.
	 * Returns true if the file was restored.
	 */
	async discardFile(filePath: string): Promise<boolean> {
		const original = this.originals.get(filePath);
		if (original === undefined) return false;

		try {
			await fs.promises.writeFile(filePath, original, "utf8");
			this.originals.delete(filePath);
			this._onDidChange.fire([filePath]);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Discard all agent changes — restore all files to their original state.
	 */
	async discardAll(): Promise<number> {
		let count = 0;
		const paths = [...this.originals.keys()];
		for (const filePath of paths) {
			if (await this.discardFile(filePath)) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Accept changes to a file — remove from tracking (keep the current content).
	 */
	acceptFile(filePath: string): void {
		if (this.originals.delete(filePath)) {
			this._onDidChange.fire([filePath]);
		}
	}

	/**
	 * Accept all changes — clear all tracking.
	 */
	acceptAll(): void {
		const paths = [...this.originals.keys()];
		this.originals.clear();
		if (paths.length > 0) {
			this._onDidChange.fire(paths);
		}
	}

	/**
	 * Restore all files to a checkpoint state.
	 */
	async restoreCheckpoint(checkpointId: number): Promise<number> {
		const idx = this._checkpoints.findIndex((c) => c.id === checkpointId);
		if (idx === -1) return 0;

		const checkpoint = this._checkpoints[idx];
		let count = 0;

		for (const [filePath, content] of checkpoint.snapshots) {
			try {
				await fs.promises.writeFile(filePath, content, "utf8");
				count++;
			} catch {
				// skip files that can't be restored
			}
		}

		// Reset originals to the checkpoint state
		this.originals = new Map(checkpoint.snapshots);

		// Remove all checkpoints after this one
		this._checkpoints = this._checkpoints.slice(0, idx);

		this._onDidChange.fire([...checkpoint.snapshots.keys()]);
		this._onCheckpointChange.fire();
		return count;
	}

	/** Clear all tracking state */
	reset(): void {
		const paths = [...this.originals.keys()];
		this.originals.clear();
		this.currentTurnFiles.clear();
		this.pendingTools.clear();
		this._checkpoints = [];
		this.nextCheckpointId = 1;
		if (paths.length > 0) {
			this._onDidChange.fire(paths);
		}
		this._onCheckpointChange.fire();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private handleEvent(evt: AgentEvent): void {
		switch (evt.type) {
			case "agent_start":
				this.createCheckpoint();
				this.currentTurnFiles.clear();
				break;

			case "tool_execution_start": {
				const toolName = String(evt.toolName ?? "");
				if (toolName !== "Write" && toolName !== "Edit") break;

				const toolInput = (evt.toolInput ?? {}) as Record<string, unknown>;
				const filePath = String(toolInput.file_path ?? toolInput.path ?? "");
				const toolUseId = String(evt.toolUseId ?? "");

				if (!filePath) break;

				// Store the original content before the agent modifies it
				// Only capture on FIRST modification (don't overwrite)
				if (!this.originals.has(filePath)) {
					try {
						if (fs.existsSync(filePath)) {
							const content = fs.readFileSync(filePath, "utf8");
							this.originals.set(filePath, content);
						} else {
							// File doesn't exist yet — original is "empty" (new file)
							this.originals.set(filePath, "");
						}
					} catch {
						// Can't read file, skip tracking
					}
				}

				if (toolUseId) {
					this.pendingTools.set(toolUseId, filePath);
				}
				break;
			}

			case "tool_execution_end": {
				const toolUseId = String(evt.toolUseId ?? "");
				const filePath = this.pendingTools.get(toolUseId);
				if (filePath) {
					this.pendingTools.delete(toolUseId);
					this.currentTurnFiles.add(filePath);
					this._onDidChange.fire([filePath]);
				}
				break;
			}
		}
	}

	private createCheckpoint(): void {
		// Only create a checkpoint if there are tracked changes
		if (this.originals.size === 0 && this._checkpoints.length === 0) {
			// First agent turn — create initial checkpoint with empty snapshots
			// (nothing to restore to yet)
		}

		const checkpoint: Checkpoint = {
			id: this.nextCheckpointId++,
			label: `Turn ${this._checkpoints.length + 1}`,
			timestamp: Date.now(),
			snapshots: new Map(this.originals),
		};
		this._checkpoints.push(checkpoint);
		this._onCheckpointChange.fire();
	}
}
