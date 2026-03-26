import * as vscode from "vscode";
import { GsdClient, ThinkingLevel } from "./gsd-client.js";
import { registerChatParticipant } from "./chat-participant.js";
import { GsdSidebarProvider } from "./sidebar.js";
import { GsdFileDecorationProvider } from "./file-decorations.js";
import { GsdBashTerminal } from "./bash-terminal.js";
import { GsdSessionTreeProvider } from "./session-tree.js";
import { GsdConversationHistoryPanel } from "./conversation-history.js";
import { GsdSlashCompletionProvider } from "./slash-completion.js";
import { GsdCodeLensProvider } from "./code-lens.js";

let client: GsdClient | undefined;
let sidebarProvider: GsdSidebarProvider | undefined;
let fileDecorations: GsdFileDecorationProvider | undefined;
let sessionTreeProvider: GsdSessionTreeProvider | undefined;

function requireConnected(): boolean {
	if (!client?.isConnected) {
		vscode.window.showWarningMessage("GSD agent is not running.");
		return false;
	}
	return true;
}

function handleError(err: unknown, context: string): void {
	const msg = err instanceof Error ? err.message : String(err);
	vscode.window.showErrorMessage(`${context}: ${msg}`);
}

export function activate(context: vscode.ExtensionContext): void {
	const config = vscode.workspace.getConfiguration("gsd");
	const binaryPath = config.get<string>("binaryPath", "gsd");
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

	client = new GsdClient(binaryPath, cwd);
	context.subscriptions.push(client);

	// Log stderr to an output channel
	const outputChannel = vscode.window.createOutputChannel("GSD-2 Agent");
	context.subscriptions.push(outputChannel);

	client.onError((msg) => {
		outputChannel.appendLine(`[stderr] ${msg}`);
	});

	// -- Persistent status bar item ----------------------------------------

	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	statusBarItem.command = "workbench.view.extension.gsd";
	statusBarItem.text = "$(hubot) GSD";
	statusBarItem.tooltip = "GSD Agent — click to open";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	async function refreshStatusBar(): Promise<void> {
		if (!client?.isConnected) {
			statusBarItem.text = "$(hubot) GSD";
			statusBarItem.tooltip = "GSD: Disconnected";
			return;
		}
		try {
			const [state, stats] = await Promise.all([
				client.getState().catch(() => null),
				client.getSessionStats().catch(() => null),
			]);
			const modelId = state?.model?.id ?? "";
			const costPart = stats?.totalCost !== undefined ? ` | $${stats.totalCost.toFixed(4)}` : "";
			const streamPart = state?.isStreaming ? " $(sync~spin)" : "";
			statusBarItem.text = `$(hubot) GSD${modelId ? ` | ${modelId}` : ""}${costPart}${streamPart}`;
			statusBarItem.tooltip = state?.model
				? `GSD: Connected — ${state.model.provider}/${state.model.id}`
				: "GSD: Connected";
		} catch {
			// ignore fetch errors
		}
	}

	const statusBarTimer = setInterval(() => refreshStatusBar(), 10_000);
	context.subscriptions.push({ dispose: () => clearInterval(statusBarTimer) });

	client.onConnectionChange(async (connected) => {
		await refreshStatusBar();
		if (connected) {
			vscode.window.setStatusBarMessage("$(hubot) GSD connected", 3000);
		} else {
			vscode.window.setStatusBarMessage("$(hubot) GSD disconnected", 3000);
		}
	});

	// -- Sidebar -----------------------------------------------------------

	sidebarProvider = new GsdSidebarProvider(context.extensionUri, client);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			GsdSidebarProvider.viewId,
			sidebarProvider,
		),
	);

	// -- File decorations --------------------------------------------------

	fileDecorations = new GsdFileDecorationProvider(client);
	context.subscriptions.push(
		fileDecorations,
		vscode.window.registerFileDecorationProvider(fileDecorations),
	);

	// -- Bash terminal -----------------------------------------------------

	const bashTerminal = new GsdBashTerminal(client);
	context.subscriptions.push(bashTerminal);

	// -- Session tree view -------------------------------------------------

	sessionTreeProvider = new GsdSessionTreeProvider(client);
	context.subscriptions.push(
		sessionTreeProvider,
		vscode.window.registerTreeDataProvider(GsdSessionTreeProvider.viewId, sessionTreeProvider),
	);

	// -- Chat participant ---------------------------------------------------

	context.subscriptions.push(registerChatParticipant(context, client));

	// -- Conversation history panel ----------------------------------------

	// (panel is created on demand via gsd.showHistory command)

	// -- Slash command completion ------------------------------------------

	const slashCompletion = new GsdSlashCompletionProvider(client);
	context.subscriptions.push(
		slashCompletion,
		vscode.languages.registerCompletionItemProvider(
			[
				{ language: "markdown" },
				{ language: "plaintext" },
				{ language: "typescript" },
				{ language: "typescriptreact" },
				{ language: "javascript" },
				{ language: "javascriptreact" },
			],
			slashCompletion,
			"/",
		),
	);

	// -- Code lens "Ask GSD" -----------------------------------------------

	const codeLensProvider = new GsdCodeLensProvider(client);
	context.subscriptions.push(
		codeLensProvider,
		vscode.languages.registerCodeLensProvider(
			[
				{ language: "typescript" },
				{ language: "typescriptreact" },
				{ language: "javascript" },
				{ language: "javascriptreact" },
				{ language: "python" },
				{ language: "go" },
				{ language: "rust" },
			],
			codeLensProvider,
		),
	);

	// -- Commands -----------------------------------------------------------

	// Start
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.start", async () => {
			try {
				await client!.start();
				// Apply auto-compaction setting
				const autoCompaction = vscode.workspace.getConfiguration("gsd").get<boolean>("autoCompaction", true);
				await client!.setAutoCompaction(autoCompaction).catch(() => {});
				sidebarProvider?.refresh();
				refreshStatusBar();
				vscode.window.showInformationMessage("GSD agent started.");
			} catch (err) {
				handleError(err, "Failed to start GSD");
			}
		}),
	);

	// Stop
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.stop", async () => {
			await client!.stop();
			sidebarProvider?.refresh();
			vscode.window.showInformationMessage("GSD agent stopped.");
		}),
	);

	// New Session
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.newSession", async () => {
			if (!requireConnected()) return;
			try {
				await client!.newSession();
				sidebarProvider?.refresh();
				sessionTreeProvider?.refresh();
				fileDecorations?.clear();
				vscode.window.showInformationMessage("New GSD session started.");
			} catch (err) {
				handleError(err, "Failed to start new session");
			}
		}),
	);

	// Send Message
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.sendMessage", async () => {
			if (!requireConnected()) return;
			const message = await vscode.window.showInputBox({
				prompt: "Enter message for GSD",
				placeHolder: "What should I do?",
			});
			if (!message) return;
			try {
				await client!.sendPrompt(message);
			} catch (err) {
				handleError(err, "Failed to send message");
			}
		}),
	);

	// Abort
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.abort", async () => {
			if (!requireConnected()) return;
			try {
				await client!.abort();
				vscode.window.showInformationMessage("Operation aborted.");
			} catch (err) {
				handleError(err, "Failed to abort");
			}
		}),
	);

	// Cycle Model
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.cycleModel", async () => {
			if (!requireConnected()) return;
			try {
				const result = await client!.cycleModel();
				if (result) {
					vscode.window.showInformationMessage(
						`Model: ${result.model.provider}/${result.model.id} (thinking: ${result.thinkingLevel})`,
					);
				} else {
					vscode.window.showInformationMessage("No other models available.");
				}
				sidebarProvider?.refresh();
			} catch (err) {
				handleError(err, "Failed to cycle model");
			}
		}),
	);

	// Switch Model (QuickPick)
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.switchModel", async () => {
			if (!requireConnected()) return;
			try {
				const models = await client!.getAvailableModels();
				if (models.length === 0) {
					vscode.window.showInformationMessage("No models available.");
					return;
				}
				const items = models.map((m) => ({
					label: `${m.provider}/${m.id}`,
					description: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined,
					provider: m.provider,
					modelId: m.id,
				}));
				const selected = await vscode.window.showQuickPick(items, {
					placeHolder: "Select a model",
				});
				if (!selected) return;
				await client!.setModel(selected.provider, selected.modelId);
				vscode.window.showInformationMessage(`Model set to ${selected.label}`);
				sidebarProvider?.refresh();
			} catch (err) {
				handleError(err, "Failed to switch model");
			}
		}),
	);

	// Cycle Thinking Level
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.cycleThinking", async () => {
			if (!requireConnected()) return;
			try {
				const result = await client!.cycleThinkingLevel();
				if (result) {
					vscode.window.showInformationMessage(`Thinking level: ${result.level}`);
				} else {
					vscode.window.showInformationMessage("Cannot change thinking level for this model.");
				}
				sidebarProvider?.refresh();
			} catch (err) {
				handleError(err, "Failed to cycle thinking level");
			}
		}),
	);

	// Set Thinking Level (QuickPick)
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.setThinking", async () => {
			if (!requireConnected()) return;
			const levels: ThinkingLevel[] = ["off", "low", "medium", "high"];
			const selected = await vscode.window.showQuickPick(levels, {
				placeHolder: "Select thinking level",
			});
			if (!selected) return;
			try {
				await client!.setThinkingLevel(selected as ThinkingLevel);
				vscode.window.showInformationMessage(`Thinking level set to ${selected}`);
				sidebarProvider?.refresh();
			} catch (err) {
				handleError(err, "Failed to set thinking level");
			}
		}),
	);

	// Compact Context
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.compact", async () => {
			if (!requireConnected()) return;
			try {
				await client!.compact();
				vscode.window.showInformationMessage("Context compacted.");
				sidebarProvider?.refresh();
			} catch (err) {
				handleError(err, "Failed to compact context");
			}
		}),
	);

	// Export HTML
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.exportHtml", async () => {
			if (!requireConnected()) return;
			try {
				const saveUri = await vscode.window.showSaveDialog({
					defaultUri: vscode.Uri.file("gsd-conversation.html"),
					filters: { "HTML Files": ["html"] },
				});
				const outputPath = saveUri?.fsPath;
				const result = await client!.exportHtml(outputPath);
				vscode.window.showInformationMessage(`Conversation exported to ${result.path}`);
			} catch (err) {
				handleError(err, "Failed to export HTML");
			}
		}),
	);

	// Session Stats
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.sessionStats", async () => {
			if (!requireConnected()) return;
			try {
				const stats = await client!.getSessionStats();
				const lines: string[] = [];
				if (stats.inputTokens !== undefined) lines.push(`Input tokens: ${stats.inputTokens.toLocaleString()}`);
				if (stats.outputTokens !== undefined) lines.push(`Output tokens: ${stats.outputTokens.toLocaleString()}`);
				if (stats.cacheReadTokens !== undefined) lines.push(`Cache read: ${stats.cacheReadTokens.toLocaleString()}`);
				if (stats.cacheWriteTokens !== undefined) lines.push(`Cache write: ${stats.cacheWriteTokens.toLocaleString()}`);
				if (stats.totalCost !== undefined) lines.push(`Cost: $${stats.totalCost.toFixed(4)}`);
				if (stats.turnCount !== undefined) lines.push(`Turns: ${stats.turnCount}`);
				if (stats.messageCount !== undefined) lines.push(`Messages: ${stats.messageCount}`);
				if (stats.duration !== undefined) lines.push(`Duration: ${Math.round(stats.duration / 1000)}s`);

				vscode.window.showInformationMessage(
					lines.length > 0 ? lines.join(" | ") : "No stats available.",
				);
			} catch (err) {
				handleError(err, "Failed to get session stats");
			}
		}),
	);

	// Run Bash Command
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.runBash", async () => {
			if (!requireConnected()) return;
			const command = await vscode.window.showInputBox({
				prompt: "Enter bash command to execute",
				placeHolder: "ls -la",
			});
			if (!command) return;
			try {
				const result = await client!.runBash(command);
				outputChannel.appendLine(`[bash] $ ${command}`);
				if (result.stdout) outputChannel.appendLine(result.stdout);
				if (result.stderr) outputChannel.appendLine(`[stderr] ${result.stderr}`);
				outputChannel.appendLine(`[exit code: ${result.exitCode}]`);
				outputChannel.show(true);

				if (result.exitCode === 0) {
					vscode.window.showInformationMessage("Bash command completed successfully.");
				} else {
					vscode.window.showWarningMessage(`Bash command exited with code ${result.exitCode}`);
				}
			} catch (err) {
				handleError(err, "Failed to run bash command");
			}
		}),
	);

	// Steer Agent
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.steer", async () => {
			if (!requireConnected()) return;
			const message = await vscode.window.showInputBox({
				prompt: "Enter steering message (interrupts current operation)",
				placeHolder: "Focus on the error handling instead",
			});
			if (!message) return;
			try {
				await client!.steer(message);
			} catch (err) {
				handleError(err, "Failed to steer agent");
			}
		}),
	);

	// List Available Commands
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.listCommands", async () => {
			if (!requireConnected()) return;
			try {
				const commands = await client!.getCommands();
				if (commands.length === 0) {
					vscode.window.showInformationMessage("No slash commands available.");
					return;
				}
				const items = commands.map((cmd) => ({
					label: `/${cmd.name}`,
					description: cmd.description ?? "",
					detail: `Source: ${cmd.source}${cmd.location ? ` (${cmd.location})` : ""}`,
				}));
				const selected = await vscode.window.showQuickPick(items, {
					placeHolder: "Available slash commands",
				});
				if (selected) {
					// Send the selected command as a prompt
					await client!.sendPrompt(selected.label);
				}
			} catch (err) {
				handleError(err, "Failed to list commands");
			}
		}),
	);

	// Switch Session
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.switchSession", async (sessionFile?: string) => {
			if (!requireConnected()) return;
			const file = sessionFile ?? await (async () => {
				const input = await vscode.window.showInputBox({
					prompt: "Enter session file path",
					placeHolder: "/path/to/session.jsonl",
				});
				return input;
			})();
			if (!file) return;
			try {
				await client!.switchSession(file);
				sidebarProvider?.refresh();
				sessionTreeProvider?.refresh();
				vscode.window.showInformationMessage("Switched session.");
			} catch (err) {
				handleError(err, "Failed to switch session");
			}
		}),
	);

	// Refresh Sessions
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.refreshSessions", () => {
			sessionTreeProvider?.refresh();
		}),
	);

	// Show Conversation History
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.showHistory", () => {
			if (!requireConnected()) return;
			GsdConversationHistoryPanel.createOrShow(context.extensionUri, client!);
		}),
	);

	// Ask About Symbol (triggered by code lens)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"gsd.askAboutSymbol",
			async (symbolName: string, fileName: string, lineNumber: number) => {
				if (!requireConnected()) return;
				try {
					const prompt = `Explain the \`${symbolName}\` function/class in ${fileName} (line ${lineNumber}). Be concise.`;
					await client!.sendPrompt(prompt);
				} catch (err) {
					handleError(err, "Failed to send Ask GSD request");
				}
			},
		),
	);

	// Clear File Decorations
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.clearFileDecorations", () => {
			fileDecorations?.clear();
		}),
	);

	// Toggle Auto-Retry
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.toggleAutoRetry", async () => {
			if (!requireConnected()) return;
			try {
				const next = !client!.autoRetryEnabled;
				await client!.setAutoRetry(next);
				vscode.window.showInformationMessage(`Auto-retry ${next ? "enabled" : "disabled"}.`);
				sidebarProvider?.refresh();
			} catch (err) {
				handleError(err, "Failed to toggle auto-retry");
			}
		}),
	);

	// Abort Retry
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.abortRetry", async () => {
			if (!requireConnected()) return;
			try {
				await client!.abortRetry();
				vscode.window.showInformationMessage("Retry aborted.");
			} catch (err) {
				handleError(err, "Failed to abort retry");
			}
		}),
	);

	// Set Session Name
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.setSessionName", async () => {
			if (!requireConnected()) return;
			const name = await vscode.window.showInputBox({
				prompt: "Enter a name for this session",
				placeHolder: "e.g. auth-refactor",
			});
			if (!name) return;
			try {
				await client!.setSessionName(name);
				sidebarProvider?.refresh();
				vscode.window.showInformationMessage(`Session named "${name}".`);
			} catch (err) {
				handleError(err, "Failed to set session name");
			}
		}),
	);

	// Copy Last Response
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.copyLastResponse", async () => {
			if (!requireConnected()) return;
			try {
				const text = await client!.getLastAssistantText();
				if (!text) {
					vscode.window.showInformationMessage("No response to copy.");
					return;
				}
				await vscode.env.clipboard.writeText(text);
				vscode.window.showInformationMessage("Last response copied to clipboard.");
			} catch (err) {
				handleError(err, "Failed to copy last response");
			}
		}),
	);

	// -- Auto-start ---------------------------------------------------------

	if (config.get<boolean>("autoStart", false)) {
		vscode.commands.executeCommand("gsd.start");
	}
}

export function deactivate(): void {
	client?.dispose();
	sidebarProvider?.dispose();
	fileDecorations?.dispose();
	sessionTreeProvider?.dispose();
	client = undefined;
	sidebarProvider = undefined;
	fileDecorations = undefined;
	sessionTreeProvider = undefined;
}
