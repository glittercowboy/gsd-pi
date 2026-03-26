import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";

interface ContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface ConversationMessage {
	role: "user" | "assistant" | "system";
	content: string | ContentBlock[];
}

/**
 * Webview panel that displays the full conversation history for the
 * current GSD session using the get_messages RPC call.
 */
export class GsdConversationHistoryPanel implements vscode.Disposable {
	private static currentPanel: GsdConversationHistoryPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly client: GsdClient;
	private disposables: vscode.Disposable[] = [];

	static createOrShow(
		extensionUri: vscode.Uri,
		client: GsdClient,
	): GsdConversationHistoryPanel {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (GsdConversationHistoryPanel.currentPanel) {
			GsdConversationHistoryPanel.currentPanel.panel.reveal(column);
			void GsdConversationHistoryPanel.currentPanel.refresh();
			return GsdConversationHistoryPanel.currentPanel;
		}

		const panel = vscode.window.createWebviewPanel(
			"gsd-history",
			"GSD Conversation History",
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		GsdConversationHistoryPanel.currentPanel = new GsdConversationHistoryPanel(
			panel,
			extensionUri,
			client,
		);
		void GsdConversationHistoryPanel.currentPanel.refresh();
		return GsdConversationHistoryPanel.currentPanel;
	}

	private constructor(
		panel: vscode.WebviewPanel,
		_extensionUri: vscode.Uri,
		client: GsdClient,
	) {
		this.panel = panel;
		this.client = client;

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			async (msg: { command: string }) => {
				if (msg.command === "refresh") {
					await this.refresh();
				}
			},
			null,
			this.disposables,
		);
	}

	async refresh(): Promise<void> {
		if (!this.client.isConnected) {
			this.panel.webview.html = this.getHtml([], "Not connected to GSD agent.");
			return;
		}

		try {
			const raw = await this.client.getMessages();
			this.panel.webview.html = this.getHtml(raw as ConversationMessage[]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.panel.webview.html = this.getHtml([], `Error loading messages: ${msg}`);
		}
	}

	dispose(): void {
		GsdConversationHistoryPanel.currentPanel = undefined;
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private getHtml(messages: ConversationMessage[], errorMessage?: string): string {
		const nonce = getNonce();

		const renderedMessages = messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((msg) => {
				const text = extractText(msg.content);
				if (!text.trim()) return "";
				const isUser = msg.role === "user";
				return `<div class="message ${isUser ? "user" : "assistant"}">
				<div class="role">${isUser ? "You" : "GSD"}</div>
				<div class="content">${escapeHtml(text)}</div>
			</div>`;
			})
			.filter(Boolean)
			.join("\n");

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			padding: 16px;
			margin: 0;
		}
		h2 {
			margin: 0 0 12px;
			font-size: 15px;
			font-weight: 600;
		}
		.toolbar {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 16px;
		}
		.btn {
			padding: 5px 12px;
			border: none;
			border-radius: 2px;
			cursor: pointer;
			font-size: var(--vscode-font-size);
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
		}
		.btn:hover { background: var(--vscode-button-hoverBackground); }
		.count {
			font-size: 12px;
			opacity: 0.6;
		}
		.error {
			color: var(--vscode-errorForeground);
			padding: 10px 12px;
			background: var(--vscode-inputValidation-errorBackground);
			border-radius: 4px;
			margin-bottom: 12px;
		}
		.empty {
			opacity: 0.55;
			font-style: italic;
		}
		.message {
			margin-bottom: 14px;
			border-radius: 5px;
			overflow: hidden;
			border: 1px solid var(--vscode-panel-border);
		}
		.role {
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.6px;
			padding: 3px 10px;
			background: var(--vscode-panel-border);
			opacity: 0.85;
		}
		.message.assistant .role {
			background: var(--vscode-focusBorder);
			color: var(--vscode-button-foreground);
			opacity: 1;
		}
		.content {
			padding: 10px 12px;
			white-space: pre-wrap;
			word-break: break-word;
			line-height: 1.55;
		}
	</style>
</head>
<body>
	<h2>Conversation History</h2>
	<div class="toolbar">
		<button class="btn" id="refresh">Refresh</button>
		${messages.length > 0 ? `<span class="count">${messages.length} message${messages.length === 1 ? "" : "s"}</span>` : ""}
	</div>
	${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ""}
	${!errorMessage && renderedMessages === "" ? '<div class="empty">No messages in this session.</div>' : renderedMessages}
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('refresh').addEventListener('click', () => {
			vscode.postMessage({ command: 'refresh' });
		});
	</script>
</body>
</html>`;
	}
}

function extractText(content: string | ContentBlock[]): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				if (block?.type === "text" && typeof block.text === "string") return block.text;
				return "";
			})
			.join("");
	}
	return "";
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function getNonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let nonce = "";
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
