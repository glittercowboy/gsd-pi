import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: Record<string, unknown>;
	content?: string | ContentBlock[];
	[key: string]: unknown;
}

interface ConversationMessage {
	role: "user" | "assistant" | "system";
	content: string | ContentBlock[];
}

/**
 * Webview panel that displays the full conversation history for the
 * current GSD session using the get_messages RPC call. Shows tool calls,
 * thinking blocks, search/filter, and fork-from-here actions.
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
			async (msg: { command: string; entryId?: string }) => {
				if (msg.command === "refresh") {
					await this.refresh();
				} else if (msg.command === "fork" && msg.entryId) {
					try {
						const result = await this.client.forkSession(msg.entryId);
						if (!result.cancelled) {
							vscode.window.showInformationMessage("Session forked successfully.");
						}
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						vscode.window.showErrorMessage(`Fork failed: ${errMsg}`);
					}
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
		const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");

		const renderedMessages = visibleMessages
			.map((msg, idx) => {
				const isUser = msg.role === "user";
				const blocks = renderContentBlocks(msg.content);
				if (!blocks.trim()) return "";

				const entryId = `msg-${idx}`;
				const forkBtn = `<button class="fork-btn" data-entry-id="${entryId}" title="Fork from this message">Fork</button>`;

				return `<div class="message ${isUser ? "user" : "assistant"}" id="${entryId}">
				<div class="role-row">
					<span class="role">${isUser ? "You" : "GSD"}</span>
					${forkBtn}
				</div>
				<div class="content">${blocks}</div>
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
		.search-input {
			flex: 1;
			padding: 5px 10px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 2px;
			font-size: var(--vscode-font-size);
		}
		.btn {
			padding: 5px 12px;
			border: none;
			border-radius: 2px;
			cursor: pointer;
			font-size: var(--vscode-font-size);
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
			white-space: nowrap;
		}
		.btn:hover { background: var(--vscode-button-hoverBackground); }
		.count {
			font-size: 12px;
			opacity: 0.6;
			white-space: nowrap;
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
		.message.hidden {
			display: none;
		}
		.role-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 3px 10px;
			background: var(--vscode-panel-border);
		}
		.message.assistant .role-row {
			background: var(--vscode-focusBorder);
		}
		.role {
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.6px;
			opacity: 0.85;
		}
		.message.assistant .role {
			color: var(--vscode-button-foreground);
			opacity: 1;
		}
		.fork-btn {
			padding: 1px 6px;
			font-size: 10px;
			border: 1px solid var(--vscode-foreground);
			background: transparent;
			color: var(--vscode-foreground);
			border-radius: 3px;
			cursor: pointer;
			opacity: 0;
			transition: opacity 0.15s;
		}
		.message:hover .fork-btn {
			opacity: 0.6;
		}
		.fork-btn:hover {
			opacity: 1 !important;
			background: var(--vscode-button-secondaryBackground);
		}
		.content {
			padding: 10px 12px;
			white-space: pre-wrap;
			word-break: break-word;
			line-height: 1.55;
		}
		.tool-block {
			margin: 8px 0;
			padding: 6px 10px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			font-size: 12px;
		}
		.tool-header {
			display: flex;
			align-items: center;
			gap: 6px;
			cursor: pointer;
			user-select: none;
			font-weight: 600;
			opacity: 0.8;
		}
		.tool-header:hover {
			opacity: 1;
		}
		.tool-body {
			display: none;
			margin-top: 6px;
			padding-top: 6px;
			border-top: 1px solid var(--vscode-panel-border);
			white-space: pre-wrap;
			word-break: break-all;
			max-height: 200px;
			overflow-y: auto;
			opacity: 0.75;
		}
		.tool-block.expanded .tool-body {
			display: block;
		}
		.thinking-block {
			margin: 8px 0;
			padding: 6px 10px;
			background: var(--vscode-editor-background);
			border-left: 3px solid var(--vscode-focusBorder);
			border-radius: 2px;
			font-size: 12px;
			opacity: 0.65;
			font-style: italic;
		}
		.thinking-header {
			cursor: pointer;
			user-select: none;
			font-weight: 600;
		}
		.thinking-body {
			display: none;
			margin-top: 4px;
			white-space: pre-wrap;
			max-height: 300px;
			overflow-y: auto;
		}
		.thinking-block.expanded .thinking-body {
			display: block;
		}
		code {
			background: var(--vscode-editor-background);
			padding: 1px 4px;
			border-radius: 3px;
			font-family: var(--vscode-editor-font-family);
			font-size: 0.92em;
		}
	</style>
</head>
<body>
	<h2>Conversation History</h2>
	<div class="toolbar">
		<input type="text" class="search-input" id="search" placeholder="Search messages..." />
		<button class="btn" id="refresh">Refresh</button>
		${visibleMessages.length > 0 ? `<span class="count">${visibleMessages.length} message${visibleMessages.length === 1 ? "" : "s"}</span>` : ""}
	</div>
	${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ""}
	<div id="messages">
		${!errorMessage && renderedMessages === "" ? '<div class="empty">No messages in this session.</div>' : renderedMessages}
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		document.getElementById('refresh').addEventListener('click', () => {
			vscode.postMessage({ command: 'refresh' });
		});

		// Search filter
		document.getElementById('search').addEventListener('input', (e) => {
			const query = e.target.value.toLowerCase();
			document.querySelectorAll('.message').forEach((el) => {
				const text = el.textContent.toLowerCase();
				el.classList.toggle('hidden', query && !text.includes(query));
			});
		});

		// Toggle tool/thinking blocks
		document.addEventListener('click', (e) => {
			const header = e.target.closest('.tool-header, .thinking-header');
			if (header) {
				header.parentElement.classList.toggle('expanded');
				return;
			}
			const forkBtn = e.target.closest('.fork-btn');
			if (forkBtn) {
				vscode.postMessage({ command: 'fork', entryId: forkBtn.dataset.entryId });
			}
		});
	</script>
</body>
</html>`;
	}
}

function renderContentBlocks(content: string | ContentBlock[]): string {
	if (typeof content === "string") return escapeHtml(content);
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (typeof block === "string") return escapeHtml(block);

			switch (block.type) {
				case "text":
					return escapeHtml(block.text ?? "");

				case "thinking":
					if (!block.text) return "";
					return `<div class="thinking-block">
						<div class="thinking-header">Thinking...</div>
						<div class="thinking-body">${escapeHtml(block.text)}</div>
					</div>`;

				case "tool_use":
					return `<div class="tool-block">
						<div class="tool-header">Tool: ${escapeHtml(block.name ?? "unknown")}</div>
						<div class="tool-body">${escapeHtml(JSON.stringify(block.input ?? {}, null, 2))}</div>
					</div>`;

				case "tool_result": {
					const resultText = typeof block.content === "string"
						? block.content
						: Array.isArray(block.content)
							? block.content.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("")
							: "";
					if (!resultText) return "";
					const truncated = resultText.length > 500 ? resultText.slice(0, 500) + "..." : resultText;
					return `<div class="tool-block">
						<div class="tool-header">Tool Result</div>
						<div class="tool-body">${escapeHtml(truncated)}</div>
					</div>`;
				}

				default:
					return "";
			}
		})
		.join("");
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
