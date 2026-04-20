import * as vscode from "vscode";
import type { GsdClient, SessionStats, ThinkingLevel } from "./gsd-client.js";

/**
 * Send a message through VS Code's Chat panel so the user sees the response.
 * Opens the Chat panel and pre-fills the @gsd participant with the message.
 */
async function sendViaChat(message: string): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.chat.open", { query: message });
}

/**
 * WebviewViewProvider that renders a compact, card-based sidebar panel.
 * Designed for information density without clutter — collapsible sections,
 * hidden empty data, and consolidated action buttons.
 */
export class GsdSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = "gsd-sidebar";

	private view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private refreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly client: GsdClient,
	) {
		this.disposables.push(
			client.onConnectionChange(() => this.refresh()),
			client.onEvent((evt) => {
				switch (evt.type) {
					case "agent_start":
					case "agent_end":
					case "model_switched":
					case "compaction_start":
					case "compaction_end":
					case "retry_start":
					case "retry_end":
					case "retry_error":
						this.refresh();
						break;
				}
			}),
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

		webviewView.webview.onDidReceiveMessage(async (msg: { command: string; value?: string }) => {
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
				case "cycleModel":
					await vscode.commands.executeCommand("gsd.cycleModel");
					break;
				case "cycleThinking":
					await vscode.commands.executeCommand("gsd.cycleThinking");
					break;
				case "switchModel":
					await vscode.commands.executeCommand("gsd.switchModel");
					break;
				case "setThinking":
					await vscode.commands.executeCommand("gsd.setThinking");
					break;
				case "compact":
					await vscode.commands.executeCommand("gsd.compact");
					break;
				case "abort":
					await vscode.commands.executeCommand("gsd.abort");
					break;
				case "exportHtml":
					await vscode.commands.executeCommand("gsd.exportHtml");
					break;
				case "sessionStats":
					await vscode.commands.executeCommand("gsd.sessionStats");
					break;
				case "listCommands":
					await vscode.commands.executeCommand("gsd.listCommands");
					break;
				case "toggleAutoCompaction":
					if (this.client.isConnected) {
						const state = await this.client.getState().catch(() => null);
						if (state) {
							await this.client.setAutoCompaction(!state.autoCompactionEnabled).catch(() => {});
							this.refresh();
						}
					}
					break;
				case "toggleAutoRetry":
					if (this.client.isConnected) {
						await this.client.setAutoRetry(!this.client.autoRetryEnabled).catch(() => {});
						this.refresh();
					}
					break;
				case "setSessionName":
					await vscode.commands.executeCommand("gsd.setSessionName");
					break;
				case "copyLastResponse":
					await vscode.commands.executeCommand("gsd.copyLastResponse");
					break;
				case "autoMode":
					await sendViaChat("@gsd /gsd auto");
					break;
				case "nextUnit":
					await sendViaChat("@gsd /gsd next");
					break;
				case "quickTask": {
					const quickInput = await vscode.window.showInputBox({
						prompt: "Describe the quick task",
						placeHolder: "e.g. fix the typo in README",
					});
					if (quickInput) {
						await sendViaChat(`@gsd /gsd quick ${quickInput}`);
					}
					break;
				}
				case "capture": {
					const thought = await vscode.window.showInputBox({
						prompt: "Capture a thought",
						placeHolder: "e.g. we should also handle the edge case for...",
					});
					if (thought) {
						await sendViaChat(`@gsd /gsd capture ${thought}`);
					}
					break;
				}
				case "status":
					await sendViaChat("@gsd /gsd status");
					break;
				case "forkSession":
					await vscode.commands.executeCommand("gsd.forkSession");
					break;
				case "toggleSteeringMode":
					await vscode.commands.executeCommand("gsd.toggleSteeringMode");
					break;
				case "toggleFollowUpMode":
					await vscode.commands.executeCommand("gsd.toggleFollowUpMode");
					break;
				case "showHistory":
					await vscode.commands.executeCommand("gsd.showHistory");
					break;
			}
		});

		// Periodic refresh while connected (for token stats)
		this.refreshTimer = setInterval(() => {
			if (this.client.isConnected) {
				this.refresh();
			}
		}, 10_000);

		this.refresh();
	}

	async refresh(): Promise<void> {
		if (!this.view) {
			return;
		}

		let modelName = "N/A";
		let modelShort = "";
		let sessionId = "N/A";
		let sessionName = "";
		let messageCount = 0;
		let pendingMessageCount = 0;
		let thinkingLevel: ThinkingLevel = "off";
		let isStreaming = false;
		let isCompacting = false;
		let autoCompaction = false;
		let autoRetry = false;
		let stats: SessionStats | null = null;
		let contextWindow = 0;
		let steeringMode: "all" | "one-at-a-time" = "all";
		let followUpMode: "all" | "one-at-a-time" = "all";

		if (this.client.isConnected) {
			autoRetry = this.client.autoRetryEnabled;
			try {
				const state = await this.client.getState();
				modelName = state.model
					? `${state.model.provider}/${state.model.id}`
					: "Not set";
				modelShort = state.model?.id ?? "";
				sessionId = state.sessionId;
				sessionName = state.sessionName ?? "";
				messageCount = state.messageCount;
				pendingMessageCount = state.pendingMessageCount;
				thinkingLevel = state.thinkingLevel as ThinkingLevel;
				isStreaming = state.isStreaming;
				isCompacting = state.isCompacting;
				autoCompaction = state.autoCompactionEnabled;
				contextWindow = state.model?.contextWindow ?? 0;
				steeringMode = state.steeringMode;
				followUpMode = state.followUpMode;
			} catch {
				// State fetch failed, show defaults
			}

			try {
				stats = await this.client.getSessionStats();
			} catch {
				// Stats fetch failed
			}
		}

		const connected = this.client.isConnected;

		this.view.webview.html = this.getHtml({
			connected,
			modelName,
			modelShort,
			sessionId,
			sessionName,
			messageCount,
			pendingMessageCount,
			thinkingLevel,
			isStreaming,
			isCompacting,
			autoCompaction,
			autoRetry,
			stats,
			contextWindow,
			steeringMode,
			followUpMode,
		});
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private getHtml(info: {
		connected: boolean;
		modelName: string;
		modelShort: string;
		sessionId: string;
		sessionName: string;
		messageCount: number;
		pendingMessageCount: number;
		thinkingLevel: ThinkingLevel;
		isStreaming: boolean;
		isCompacting: boolean;
		autoCompaction: boolean;
		autoRetry: boolean;
		stats: SessionStats | null;
		contextWindow: number;
		steeringMode: "all" | "one-at-a-time";
		followUpMode: "all" | "one-at-a-time";
	}): string {
		const statusColor = info.connected ? "#4ec9b0" : "#f44747";
		const statusLabel = info.isStreaming ? "Working" : info.isCompacting ? "Compacting" : info.connected ? "Connected" : "Disconnected";

		// Model short name for header
		const modelDisplay = info.modelShort || "N/A";

		// Session display — name or truncated ID
		const sessionDisplay = info.sessionName || (info.sessionId !== "N/A" ? info.sessionId.slice(0, 8) : "N/A");

		// Cost for header
		const costDisplay = info.stats?.totalCost !== undefined && info.stats.totalCost > 0
			? `$${info.stats.totalCost.toFixed(4)}`
			: "";

		// Context window
		const totalTokens = (info.stats?.inputTokens ?? 0) + (info.stats?.outputTokens ?? 0);
		const contextPct = info.contextWindow > 0 ? Math.min(100, Math.round((totalTokens / info.contextWindow) * 100)) : 0;
		const contextColor = contextPct > 80 ? "#f44747" : contextPct > 50 ? "#cca700" : "#4ec9b0";

		// Only show stats that have real data
		const hasStats = info.stats && (
			(info.stats.inputTokens !== undefined && info.stats.inputTokens > 0) ||
			(info.stats.outputTokens !== undefined && info.stats.outputTokens > 0)
		);

		const nonce = getNonce();

		// Build stat rows only for non-zero values
		let statRows = "";
		if (hasStats && info.stats) {
			const pairs: [string, string][] = [];
			if (info.stats.inputTokens) pairs.push(["In", formatNum(info.stats.inputTokens)]);
			if (info.stats.outputTokens) pairs.push(["Out", formatNum(info.stats.outputTokens)]);
			if (info.stats.cacheReadTokens) pairs.push(["Cache R", formatNum(info.stats.cacheReadTokens)]);
			if (info.stats.cacheWriteTokens) pairs.push(["Cache W", formatNum(info.stats.cacheWriteTokens)]);
			if (info.stats.turnCount) pairs.push(["Turns", String(info.stats.turnCount)]);
			if (info.stats.duration) pairs.push(["Time", `${Math.round(info.stats.duration / 1000)}s`]);
			if (info.stats.totalCost !== undefined && info.stats.totalCost > 0) pairs.push(["Cost", `$${info.stats.totalCost.toFixed(4)}`]);

			statRows = pairs.map(([k, v]) =>
				`<span class="stat-label">${k}</span><span class="stat-value">${v}</span>`
			).join("");
		}

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			padding: 8px;
		}

		/* ---- Header card ---- */
		.header {
			padding: 10px 12px;
			border-radius: 6px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			margin-bottom: 8px;
		}
		.header-top {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.status-dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: ${statusColor};
			flex-shrink: 0;
		}
		.status-label {
			font-size: 11px;
			opacity: 0.7;
			flex-shrink: 0;
		}
		.header-model {
			margin-left: auto;
			font-size: 11px;
			font-weight: 600;
			opacity: 0.85;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.header-model:hover { opacity: 1; }
		.header-cost {
			font-size: 11px;
			font-variant-numeric: tabular-nums;
			opacity: 0.6;
			flex-shrink: 0;
		}
		.header-sub {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-top: 6px;
			font-size: 11px;
			opacity: 0.6;
		}
		.header-sub .sep { opacity: 0.3; }
		.session-name {
			cursor: pointer;
			max-width: 120px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.session-name:hover { opacity: 1; text-decoration: underline; }

		/* ---- Streaming banner ---- */
		.streaming {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 10px;
			margin-bottom: 8px;
			background: color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent);
			border: 1px solid var(--vscode-focusBorder);
			border-radius: 6px;
			font-size: 12px;
		}
		.spinner {
			width: 10px; height: 10px;
			border: 2px solid var(--vscode-focusBorder);
			border-top-color: transparent;
			border-radius: 50%;
			animation: spin 0.8s linear infinite;
			flex-shrink: 0;
		}
		@keyframes spin { to { transform: rotate(360deg); } }
		.streaming-abort {
			margin-left: auto;
			font-size: 10px;
			padding: 2px 8px;
			border: 1px solid var(--vscode-foreground);
			background: transparent;
			color: var(--vscode-foreground);
			border-radius: 3px;
			cursor: pointer;
			opacity: 0.6;
		}
		.streaming-abort:hover { opacity: 1; }

		/* ---- Context bar (inline in header) ---- */
		.context-bar {
			margin-top: 8px;
		}
		.context-track {
			width: 100%;
			height: 3px;
			background: var(--vscode-panel-border);
			border-radius: 2px;
			overflow: hidden;
		}
		.context-fill {
			height: 100%;
			border-radius: 2px;
			transition: width 0.3s ease;
		}
		.context-text {
			font-size: 10px;
			opacity: 0.5;
			margin-top: 2px;
		}

		/* ---- Collapsible section ---- */
		.section {
			margin-bottom: 6px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			overflow: hidden;
		}
		.section-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 6px 10px;
			cursor: pointer;
			user-select: none;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			opacity: 0.7;
			background: var(--vscode-editor-background);
		}
		.section-header:hover { opacity: 1; }
		.chevron {
			font-size: 10px;
			transition: transform 0.15s;
		}
		.section.collapsed .section-body { display: none; }
		.section.collapsed .chevron { transform: rotate(-90deg); }
		.section-body {
			padding: 6px 10px 8px;
		}

		/* ---- Stats grid ---- */
		.stats-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 2px 10px;
			font-size: 11px;
		}
		.stat-label { opacity: 0.6; }
		.stat-value {
			text-align: right;
			font-variant-numeric: tabular-nums;
		}

		/* ---- Toggle row ---- */
		.toggle-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 3px 0;
			font-size: 11px;
		}
		.toggle-label { opacity: 0.7; }
		.toggle-pill {
			display: inline-block;
			padding: 1px 8px;
			border-radius: 10px;
			font-size: 10px;
			cursor: pointer;
			transition: all 0.15s;
			border: 1px solid transparent;
		}
		.toggle-pill.on {
			background: color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent);
			border-color: var(--vscode-focusBorder);
			color: var(--vscode-foreground);
		}
		.toggle-pill.off {
			background: transparent;
			border-color: var(--vscode-panel-border);
			opacity: 0.5;
		}
		.toggle-pill:hover { opacity: 1; }

		/* ---- Buttons ---- */
		.actions {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 4px;
		}
		.actions.three-col {
			grid-template-columns: 1fr 1fr 1fr;
		}
		.action-btn {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			padding: 5px 6px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-foreground);
			font-size: 11px;
			cursor: pointer;
			white-space: nowrap;
			width: auto;
		}
		.action-btn:hover {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-focusBorder);
		}
		.action-btn.primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border-color: var(--vscode-button-background);
			font-weight: 600;
		}
		.action-btn.primary:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.action-btn.danger {
			border-color: #f44747;
			color: #f44747;
		}
		.action-btn.danger:hover {
			background: color-mix(in srgb, #f44747 15%, transparent);
		}
		.action-btn.full {
			grid-column: 1 / -1;
		}

		/* ---- Disconnected state ---- */
		.disconnected {
			text-align: center;
			padding: 20px 12px;
		}
		.disconnected p {
			opacity: 0.5;
			font-size: 12px;
			margin-bottom: 12px;
		}
		.start-btn {
			padding: 8px 24px;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-size: var(--vscode-font-size);
			font-weight: 600;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
			width: auto;
			display: inline-block;
		}
		.start-btn:hover {
			background: var(--vscode-button-hoverBackground);
		}
	</style>
</head>
<body>
	${info.connected ? this.getConnectedHtml(info, {
			statusLabel,
			modelDisplay,
			sessionDisplay,
			costDisplay,
			contextPct,
			contextColor,
			hasStats: !!hasStats,
			statRows,
			nonce,
		}) : `
	<div class="header">
		<div class="header-top">
			<div class="status-dot"></div>
			<span class="status-label">Disconnected</span>
		</div>
	</div>
	<div class="disconnected">
		<p>Agent is not running</p>
		<button class="start-btn" data-command="start">Start Agent</button>
	</div>
	`}

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const stored = vscode.getState() || {};

		// Restore collapsed state
		document.querySelectorAll('.section').forEach(s => {
			const id = s.dataset.section;
			if (id && stored[id] === 'collapsed') s.classList.add('collapsed');
		});

		document.addEventListener('click', (e) => {
			// Section toggle
			const header = e.target.closest('.section-header');
			if (header) {
				const section = header.parentElement;
				section.classList.toggle('collapsed');
				const id = section.dataset.section;
				if (id) {
					const state = vscode.getState() || {};
					state[id] = section.classList.contains('collapsed') ? 'collapsed' : 'open';
					vscode.setState(state);
				}
				return;
			}
			// Button/command click
			const btn = e.target.closest('[data-command]');
			if (btn) {
				vscode.postMessage({ command: btn.dataset.command });
			}
		});
	</script>
</body>
</html>`;
	}

	private getConnectedHtml(
		info: {
			connected: boolean;
			modelName: string;
			modelShort: string;
			sessionId: string;
			sessionName: string;
			messageCount: number;
			pendingMessageCount: number;
			thinkingLevel: ThinkingLevel;
			isStreaming: boolean;
			isCompacting: boolean;
			autoCompaction: boolean;
			autoRetry: boolean;
			stats: SessionStats | null;
			contextWindow: number;
			steeringMode: "all" | "one-at-a-time";
			followUpMode: "all" | "one-at-a-time";
		},
		ui: {
			statusLabel: string;
			modelDisplay: string;
			sessionDisplay: string;
			costDisplay: string;
			contextPct: number;
			contextColor: string;
			hasStats: boolean;
			statRows: string;
			nonce: string;
		},
	): string {
		const pendingBadge = info.pendingMessageCount > 0
			? ` <span style="opacity:0.5">+${info.pendingMessageCount}</span>`
			: "";

		return `
	<!-- Header card -->
	<div class="header">
		<div class="header-top">
			<div class="status-dot"></div>
			<span class="status-label">${ui.statusLabel}</span>
			<span class="header-model" data-command="switchModel" title="${escapeHtml(info.modelName)}">${escapeHtml(ui.modelDisplay)}</span>
			${ui.costDisplay ? `<span class="header-cost">${ui.costDisplay}</span>` : ""}
		</div>
		<div class="header-sub">
			<span class="session-name" data-command="setSessionName" title="${escapeHtml(info.sessionId)}">${escapeHtml(ui.sessionDisplay)}</span>
			<span class="sep">/</span>
			<span>${info.messageCount} msg${pendingBadge}</span>
			<span class="sep">/</span>
			<span data-command="cycleThinking" style="cursor:pointer" title="Click to cycle thinking level">${info.thinkingLevel === "off" ? "no think" : info.thinkingLevel}</span>
		</div>
		${info.contextWindow > 0 ? `
		<div class="context-bar">
			<div class="context-track">
				<div class="context-fill" style="width:${ui.contextPct}%;background:${ui.contextColor}"></div>
			</div>
			<div class="context-text">${ui.contextPct}% context (${formatNum((info.stats?.inputTokens ?? 0) + (info.stats?.outputTokens ?? 0))} / ${formatNum(info.contextWindow)})</div>
		</div>
		` : ""}
	</div>

	${info.isStreaming ? `
	<div class="streaming">
		<span class="spinner"></span>
		<span>Agent is working...</span>
		<button class="streaming-abort" data-command="abort">Stop</button>
	</div>
	` : ""}

	<!-- Workflow -->
	<div class="section" data-section="workflow">
		<div class="section-header"><span class="chevron">&#9660;</span> Workflow</div>
		<div class="section-body">
			<div class="actions">
				<button class="action-btn primary" data-command="autoMode">Auto</button>
				<button class="action-btn" data-command="nextUnit">Next</button>
				<button class="action-btn" data-command="quickTask">Quick</button>
				<button class="action-btn" data-command="capture">Capture</button>
			</div>
		</div>
	</div>

	${ui.hasStats ? `
	<!-- Stats -->
	<div class="section" data-section="stats">
		<div class="section-header"><span class="chevron">&#9660;</span> Stats</div>
		<div class="section-body">
			<div class="stats-grid">${ui.statRows}</div>
		</div>
	</div>
	` : ""}

	<!-- Actions -->
	<div class="section" data-section="actions">
		<div class="section-header"><span class="chevron">&#9660;</span> Actions</div>
		<div class="section-body">
			<div class="actions three-col">
				<button class="action-btn" data-command="newSession">New</button>
				<button class="action-btn" data-command="compact">Compact</button>
				<button class="action-btn" data-command="copyLastResponse">Copy</button>
				<button class="action-btn" data-command="status">Status</button>
				<button class="action-btn" data-command="fixProblemsInFile">Fix Errs</button>
				<button class="action-btn" data-command="showHistory">History</button>
			</div>
			<div style="margin-top:6px">
				<button class="action-btn danger full" data-command="stop">Stop Agent</button>
			</div>
		</div>
	</div>

	<!-- Settings (collapsed by default) -->
	<div class="section collapsed" data-section="settings">
		<div class="section-header"><span class="chevron">&#9660;</span> Settings</div>
		<div class="section-body">
			<div class="toggle-row">
				<span class="toggle-label">Auto-compact</span>
				<span class="toggle-pill ${info.autoCompaction ? "on" : "off"}" data-command="toggleAutoCompaction">${info.autoCompaction ? "on" : "off"}</span>
			</div>
			<div class="toggle-row">
				<span class="toggle-label">Auto-retry</span>
				<span class="toggle-pill ${info.autoRetry ? "on" : "off"}" data-command="toggleAutoRetry">${info.autoRetry ? "on" : "off"}</span>
			</div>
			<div class="toggle-row">
				<span class="toggle-label">Steering</span>
				<span class="toggle-pill ${info.steeringMode === "one-at-a-time" ? "on" : "off"}" data-command="toggleSteeringMode">${info.steeringMode === "one-at-a-time" ? "1-at-a-time" : "all"}</span>
			</div>
			<div class="toggle-row">
				<span class="toggle-label">Follow-up</span>
				<span class="toggle-pill ${info.followUpMode === "one-at-a-time" ? "on" : "off"}" data-command="toggleFollowUpMode">${info.followUpMode === "one-at-a-time" ? "1-at-a-time" : "all"}</span>
			</div>
			<div class="toggle-row">
				<span class="toggle-label">Approval</span>
				<span class="toggle-pill on" data-command="selectApprovalMode">change</span>
			</div>
		</div>
	</div>`;
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function getNonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let nonce = "";
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
