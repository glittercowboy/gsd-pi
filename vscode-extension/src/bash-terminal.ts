import * as vscode from "vscode";
import type { AgentEvent, GsdClient } from "./gsd-client.js";

/**
 * Routes the GSD agent's Bash tool output to a dedicated VS Code terminal panel.
 * Shows streaming output from tool_execution_update events in real time.
 */
export class GsdBashTerminal implements vscode.Disposable {
	private terminal: vscode.Terminal | undefined;
	private writeEmitter: vscode.EventEmitter<string> | undefined;
	private disposables: vscode.Disposable[] = [];

	constructor(client: GsdClient) {
		this.disposables.push(
			client.onEvent((evt: AgentEvent) => this.handleEvent(evt)),
			client.onConnectionChange((connected) => {
				if (!connected) {
					this.close();
				}
			}),
		);
	}

	private getOrCreateTerminal(): { terminal: vscode.Terminal; writeEmitter: vscode.EventEmitter<string> } {
		if (!this.terminal || this.terminal.exitStatus !== undefined) {
			this.writeEmitter?.dispose();
			this.writeEmitter = new vscode.EventEmitter<string>();
			const emitter = this.writeEmitter;
			const pty: vscode.Pseudoterminal = {
				onDidWrite: emitter.event,
				open: () => {},
				close: () => { this.terminal = undefined; },
			};
			this.terminal = vscode.window.createTerminal({ name: "GSD Agent", pty });
		}
		return { terminal: this.terminal, writeEmitter: this.writeEmitter! };
	}

	private handleEvent(evt: AgentEvent): void {
		switch (evt.type) {
			case "tool_execution_start": {
				if (evt.toolName !== "Bash") {
					break;
				}
				const cmd = (evt.toolInput as Record<string, unknown> | undefined)?.command as string | undefined;
				const { terminal, writeEmitter } = this.getOrCreateTerminal();
				terminal.show(true); // preserve editor focus
				writeEmitter.fire(`\x1b[90m$ ${cmd ?? ""}\x1b[0m\r\n`);
				break;
			}
			case "tool_execution_update": {
				if (evt.toolName !== "Bash" || !this.writeEmitter) {
					break;
				}
				const partial = evt.partialResult as string | undefined;
				if (partial) {
					this.writeEmitter.fire(partial.replace(/\n/g, "\r\n"));
				}
				break;
			}
			case "tool_execution_end": {
				if (evt.toolName !== "Bash" || !this.writeEmitter) {
					break;
				}
				this.writeEmitter.fire("\r\n");
				break;
			}
		}
	}

	close(): void {
		this.terminal?.dispose();
		this.terminal = undefined;
		this.writeEmitter?.dispose();
		this.writeEmitter = undefined;
	}

	dispose(): void {
		this.close();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
