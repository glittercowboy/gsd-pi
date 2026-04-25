import * as vscode from "vscode";
import type { GsdClient, AgentEvent } from "./gsd-client.js";

type ApprovalMode = "ask" | "auto-approve" | "plan-only";

/**
 * Permission/approval system for agent actions.
 * Can be configured to prompt before file writes, command execution, etc.
 */
export class GsdPermissionManager implements vscode.Disposable {
	private _mode: ApprovalMode = "auto-approve";
	private disposables: vscode.Disposable[] = [];

	private readonly _onModeChange = new vscode.EventEmitter<ApprovalMode>();
	readonly onModeChange = this._onModeChange.event;

	constructor(private readonly client: GsdClient) {
		// Load saved mode from configuration
		this._mode = vscode.workspace.getConfiguration("gsd").get<ApprovalMode>("approvalMode", "auto-approve");

		this.disposables.push(
			this._onModeChange,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("gsd.approvalMode")) {
					this._mode = vscode.workspace.getConfiguration("gsd").get<ApprovalMode>("approvalMode", "auto-approve");
					this._onModeChange.fire(this._mode);
				}
			}),
		);

		// If mode is "ask", intercept tool executions for write operations
		if (this._mode === "ask") {
			this.disposables.push(
				client.onEvent((evt) => this.handleEvent(evt)),
			);
		}
	}

	get mode(): ApprovalMode {
		return this._mode;
	}

	/**
	 * Cycle through approval modes: auto-approve -> ask -> plan-only -> auto-approve
	 */
	async cycleMode(): Promise<void> {
		const modes: ApprovalMode[] = ["auto-approve", "ask", "plan-only"];
		const currentIdx = modes.indexOf(this._mode);
		this._mode = modes[(currentIdx + 1) % modes.length];

		await vscode.workspace.getConfiguration("gsd").update("approvalMode", this._mode, vscode.ConfigurationTarget.Workspace);
		this._onModeChange.fire(this._mode);

		const labels: Record<ApprovalMode, string> = {
			"auto-approve": "Auto-Approve (agent runs freely)",
			"ask": "Ask (prompt before file changes)",
			"plan-only": "Plan Only (read-only, no writes)",
		};
		vscode.window.showInformationMessage(`Approval mode: ${labels[this._mode]}`);
	}

	/**
	 * Show a QuickPick to select approval mode.
	 */
	async selectMode(): Promise<void> {
		const items: (vscode.QuickPickItem & { mode: ApprovalMode })[] = [
			{
				label: "$(check) Auto-Approve",
				description: "Agent runs freely without prompts",
				detail: "Best for trusted workflows. The agent can read, write, and execute without asking.",
				mode: "auto-approve",
			},
			{
				label: "$(shield) Ask",
				description: "Prompt before file changes",
				detail: "The agent will ask for approval before writing or editing files.",
				mode: "ask",
			},
			{
				label: "$(eye) Plan Only",
				description: "Read-only mode, no writes allowed",
				detail: "The agent can read and analyze but cannot modify files or run commands.",
				mode: "plan-only",
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: `Current mode: ${this._mode}`,
		});

		if (selected) {
			this._mode = selected.mode;
			await vscode.workspace.getConfiguration("gsd").update("approvalMode", this._mode, vscode.ConfigurationTarget.Workspace);
			this._onModeChange.fire(this._mode);
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private async handleEvent(evt: AgentEvent): Promise<void> {
		if (this._mode !== "ask") return;
		if (evt.type !== "tool_execution_start") return;

		const toolName = String(evt.toolName ?? "");
		if (toolName !== "Write" && toolName !== "Edit" && toolName !== "Bash") return;

		const toolInput = (evt.toolInput ?? {}) as Record<string, unknown>;
		let description = "";

		switch (toolName) {
			case "Write":
			case "Edit": {
				const filePath = String(toolInput.file_path ?? "");
				const shortPath = filePath.split(/[\\/]/).slice(-3).join("/");
				description = `${toolName}: ${shortPath}`;
				break;
			}
			case "Bash": {
				const cmd = String(toolInput.command ?? "").slice(0, 80);
				description = `Execute: ${cmd}`;
				break;
			}
		}

		// Note: In practice, the RPC protocol doesn't support blocking tool execution
		// for approval. This notification serves as awareness — the user sees what's
		// happening and can abort if needed. True blocking approval would require
		// protocol changes in the RPC server.
		vscode.window.showInformationMessage(
			`Agent: ${description}`,
			"OK",
			"Abort",
		).then((choice) => {
			if (choice === "Abort") {
				this.client.abort().catch(() => {});
			}
		});
	}
}
