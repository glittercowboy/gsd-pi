import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";

/**
 * WebviewViewProvider that renders a simple sidebar panel showing
 * connection status, current model, session info, and start/stop controls.
 */
export class GsdSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = "gsd-sidebar";

	private view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly client: GsdClient,
	) {
		this.disposables.push(
			client.onConnectionChange(() => this.refresh()),
		);
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
		};

		webviewView.webview.onDidReceiveMessage(async (msg: { command: string }) => {
			switch (msg.command) {
				case "start":
					await vscode.commands.executeCommand("gsd.start");
					break;
				case "stop":
					await vscode.commands.executeCommand("gsd.stop");
					break;
				case "newSession":
					await vscode.commands.executeCommand("gsd.newSession");
					break;
			}
		});

		this.refresh();
	}

	async refresh(): Promise<void> {
		if (!this.view) {
			return;
		}

		let modelName = "N/A";
		let sessionId = "N/A";
		let sessionName = "";
		let messageCount = 0;

		if (this.client.isConnected) {
			try {
				const state = await this.client.getState();
				modelName = state.model
					? `${state.model.provider}/${state.model.id}`
					: "Not set";
				sessionId = state.sessionId;
				sessionName = state.sessionName ?? "";
				messageCount = state.messageCount;
			} catch {
				// State fetch failed, show defaults
			}
		}

		const connected = this.client.isConnected;

		this.view.webview.html = this.getHtml({
			connected,
			modelName,
			sessionId,
			sessionName,
			messageCount,
		});
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private getHtml(info: {
		connected: boolean;
		modelName: string;
		sessionId: string;
		sessionName: string;
		messageCount: number;
	}): string {
		const statusColor = info.connected ? "#4ec9b0" : "#f44747";
		const statusText = info.connected ? "Connected" : "Disconnected";

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			padding: 12px;
			margin: 0;
		}
		.status-row {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 16px;
		}
		.status-dot {
			width: 10px;
			height: 10px;
			border-radius: 50%;
			background: ${statusColor};
		}
		.info-table {
			width: 100%;
			margin-bottom: 16px;
		}
		.info-table td {
			padding: 4px 0;
		}
		.info-table td:first-child {
			opacity: 0.7;
			padding-right: 12px;
			white-space: nowrap;
		}
		.info-table td:last-child {
			word-break: break-all;
		}
		.btn-group {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		button {
			display: block;
			width: 100%;
			padding: 6px 14px;
			border: none;
			border-radius: 2px;
			cursor: pointer;
			font-size: var(--vscode-font-size);
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
		}
		button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		button.secondary {
			color: var(--vscode-button-secondaryForeground);
			background: var(--vscode-button-secondaryBackground);
		}
		button.secondary:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
	</style>
</head>
<body>
	<div class="status-row">
		<div class="status-dot"></div>
		<strong>${statusText}</strong>
	</div>

	<table class="info-table">
		<tr><td>Model</td><td>${escapeHtml(info.modelName)}</td></tr>
		<tr><td>Session</td><td>${escapeHtml(info.sessionName || info.sessionId)}</td></tr>
		<tr><td>Messages</td><td>${info.messageCount}</td></tr>
	</table>

	<div class="btn-group">
		${info.connected
			? `<button onclick="send('stop')">Stop Agent</button>
			   <button class="secondary" onclick="send('newSession')">New Session</button>`
			: `<button onclick="send('start')">Start Agent</button>`
		}
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		function send(command) {
			vscode.postMessage({ command });
		}
	</script>
</body>
</html>`;
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
