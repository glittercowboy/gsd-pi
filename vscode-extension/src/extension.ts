import * as vscode from "vscode";
import { pickTrustedConfigurationValue } from "./trusted-config.js";
import { GsdClient, ThinkingLevel } from "./gsd-client.js";
import { registerChatParticipant } from "./chat-participant.js";
import { GsdSidebarProvider } from "./sidebar.js";
import { GsdFileDecorationProvider } from "./file-decorations.js";
import { GsdBashTerminal } from "./bash-terminal.js";
import { GsdSessionTreeProvider } from "./session-tree.js";
import { GsdConversationHistoryPanel } from "./conversation-history.js";
import { GsdSlashCompletionProvider } from "./slash-completion.js";
import { GsdCodeLensProvider } from "./code-lens.js";
import { GsdActivityFeedProvider } from "./activity-feed.js";
import { GsdChangeTracker } from "./change-tracker.js";
import { GsdScmProvider } from "./scm-provider.js";
import { GsdDiagnosticBridge } from "./diagnostics.js";
import { GsdLineDecorationManager } from "./line-decorations.js";
import { GsdGitIntegration } from "./git-integration.js";
import { GsdPermissionManager } from "./permissions.js";

let client: GsdClient | undefined;
let sidebarProvider: GsdSidebarProvider | undefined;
let fileDecorations: GsdFileDecorationProvider | undefined;
let sessionTreeProvider: GsdSessionTreeProvider | undefined;
let activityFeedProvider: GsdActivityFeedProvider | undefined;
let changeTracker: GsdChangeTracker | undefined;
let scmProvider: GsdScmProvider | undefined;
let diagnosticBridge: GsdDiagnosticBridge | undefined;
let lineDecorations: GsdLineDecorationManager | undefined;
let gitIntegration: GsdGitIntegration | undefined;
let permissionManager: GsdPermissionManager | undefined;

function getTrustedConfigurationValue<T>(section: string, key: string, fallback: T): T {
	const config = vscode.workspace.getConfiguration(section);
	return pickTrustedConfigurationValue(config.inspect<T>(key), fallback);
}

export function resolveTrustedGsdStartupConfig(): { binaryPath: string; autoStart: boolean } {
	return {
		binaryPath: getTrustedConfigurationValue("gsd", "binaryPath", "gsd"),
		autoStart: getTrustedConfigurationValue("gsd", "autoStart", false),
	};
}

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
	const startupConfig = resolveTrustedGsdStartupConfig();
	const config = vscode.workspace.getConfiguration("gsd");
	const binaryPath = startupConfig.binaryPath;
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

	// -- Activity feed -----------------------------------------------------

	activityFeedProvider = new GsdActivityFeedProvider(client);
	context.subscriptions.push(
		activityFeedProvider,
		vscode.window.registerTreeDataProvider(GsdActivityFeedProvider.viewId, activityFeedProvider),
	);

	// -- Change tracker & SCM provider -------------------------------------

	changeTracker = new GsdChangeTracker(client);
	context.subscriptions.push(changeTracker);

	scmProvider = new GsdScmProvider(changeTracker, cwd);
	context.subscriptions.push(scmProvider);

	// -- Diagnostics -------------------------------------------------------

	diagnosticBridge = new GsdDiagnosticBridge(client);
	context.subscriptions.push(diagnosticBridge);

	// -- Line-level decorations --------------------------------------------

	lineDecorations = new GsdLineDecorationManager(changeTracker!);
	context.subscriptions.push(lineDecorations);

	// -- Git integration ---------------------------------------------------

	gitIntegration = new GsdGitIntegration(changeTracker!, cwd);
	context.subscriptions.push(gitIntegration);

	// -- Permissions -------------------------------------------------------

	permissionManager = new GsdPermissionManager(client);
	context.subscriptions.push(permissionManager);

	// -- Progress notifications --------------------------------------------

	let currentProgress: { resolve: () => void } | undefined;

	client.onEvent((evt) => {
		const showProgress = vscode.workspace.getConfiguration("gsd").get<boolean>("showProgressNotifications", true);
		if (!showProgress) return;

		if (evt.type === "agent_start" && !currentProgress) {
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "GSD Agent",
					cancellable: true,
				},
				(progress, token) => {
					token.onCancellationRequested(() => {
						client?.abort().catch(() => {});
					});

					// Listen for tool events to update progress message
					const toolListener = client!.onEvent((toolEvt) => {
						if (toolEvt.type === "tool_execution_start") {
							const toolName = String(toolEvt.toolName ?? "");
							progress.report({ message: `Running ${toolName}...` });
						}
					});

					return new Promise<void>((resolve) => {
						currentProgress = { resolve };
						// Also clean up if disposed
						token.onCancellationRequested(() => {
							toolListener.dispose();
							currentProgress = undefined;
							resolve();
						});
					}).finally(() => {
						toolListener.dispose();
					});
				},
			);
		} else if (evt.type === "agent_end" && currentProgress) {
			currentProgress.resolve();
			currentProgress = undefined;
		}
	});

	// -- Context window warning --------------------------------------------

	let lastContextWarning = 0;
	client.onEvent(async (evt) => {
		if (evt.type !== "message_end") return;
		const showWarning = vscode.workspace.getConfiguration("gsd").get<boolean>("showContextWarning", true);
		if (!showWarning) return;

		// Throttle: at most once per 60 seconds
		if (Date.now() - lastContextWarning < 60_000) return;

		try {
			const [state, stats] = await Promise.all([
				client!.getState().catch(() => null),
				client!.getSessionStats().catch(() => null),
			]);
			const contextWindow = state?.model?.contextWindow ?? 0;
			const totalTokens = (stats?.inputTokens ?? 0) + (stats?.outputTokens ?? 0);
			if (contextWindow <= 0) return;

			const threshold = vscode.workspace.getConfiguration("gsd").get<number>("contextWarningThreshold", 80);
			const pct = Math.round((totalTokens / contextWindow) * 100);
			if (pct >= threshold) {
				lastContextWarning = Date.now();
				const action = await vscode.window.showWarningMessage(
					`Context window ${pct}% full (${Math.round(totalTokens / 1000)}k / ${Math.round(contextWindow / 1000)}k). Consider compacting.`,
					"Compact Now",
				);
				if (action === "Compact Now") {
					await vscode.commands.executeCommand("gsd.compact");
				}
			}
		} catch {
			// ignore
		}
	});

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

	// Clear Activity Feed
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.clearActivity", () => {
			activityFeedProvider?.clear();
		}),
	);

	// Fork Session
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.forkSession", async () => {
			if (!requireConnected()) return;
			try {
				const messages = await client!.getForkMessages();
				if (messages.length === 0) {
					vscode.window.showInformationMessage("No fork points available.");
					return;
				}
				const items = messages.map((m) => ({
					label: m.text.slice(0, 80) + (m.text.length > 80 ? "..." : ""),
					description: m.entryId,
					entryId: m.entryId,
				}));
				const selected = await vscode.window.showQuickPick(items, {
					placeHolder: "Select a message to fork from",
				});
				if (!selected) return;
				const result = await client!.forkSession(selected.entryId);
				if (!result.cancelled) {
					vscode.window.showInformationMessage("Session forked successfully.");
					sidebarProvider?.refresh();
					sessionTreeProvider?.refresh();
				}
			} catch (err) {
				handleError(err, "Failed to fork session");
			}
		}),
	);

	// Toggle Steering Mode
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.toggleSteeringMode", async () => {
			if (!requireConnected()) return;
			try {
				const state = await client!.getState();
				const next = state.steeringMode === "all" ? "one-at-a-time" : "all";
				await client!.setSteeringMode(next);
				vscode.window.showInformationMessage(`Steering mode: ${next}`);
				sidebarProvider?.refresh();
			} catch (err) {
				handleError(err, "Failed to toggle steering mode");
			}
		}),
	);

	// Toggle Follow-Up Mode
	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.toggleFollowUpMode", async () => {
			if (!requireConnected()) return;
			try {
				const state = await client!.getState();
				const next = state.followUpMode === "all" ? "one-at-a-time" : "all";
				await client!.setFollowUpMode(next);
				vscode.window.showInformationMessage(`Follow-up mode: ${next}`);
				sidebarProvider?.refresh();
			} catch (err) {
				handleError(err, "Failed to toggle follow-up mode");
			}
		}),
	);

	// Refactor Symbol (code lens)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"gsd.refactorSymbol",
			async (symbolName: string, fileName: string, lineNumber: number) => {
				if (!requireConnected()) return;
				try {
					await client!.sendPrompt(`Refactor the \`${symbolName}\` function/class in ${fileName} (line ${lineNumber}). Improve clarity, performance, or structure while preserving behavior.`);
				} catch (err) {
					handleError(err, "Failed to send refactor request");
				}
			},
		),
	);

	// Find Bugs in Symbol (code lens)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"gsd.findBugsSymbol",
			async (symbolName: string, fileName: string, lineNumber: number) => {
				if (!requireConnected()) return;
				try {
					await client!.sendPrompt(`Review the \`${symbolName}\` function/class in ${fileName} (line ${lineNumber}) for potential bugs, edge cases, and issues.`);
				} catch (err) {
					handleError(err, "Failed to send bug review request");
				}
			},
		),
	);

	// Generate Tests for Symbol (code lens)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"gsd.generateTestsSymbol",
			async (symbolName: string, fileName: string, lineNumber: number) => {
				if (!requireConnected()) return;
				try {
					await client!.sendPrompt(`Generate comprehensive tests for the \`${symbolName}\` function/class in ${fileName} (line ${lineNumber}). Cover success paths, edge cases, and error scenarios.`);
				} catch (err) {
					handleError(err, "Failed to send test generation request");
				}
			},
		),
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

	// -- SCM commands -------------------------------------------------------

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.acceptAllChanges", () => {
			changeTracker?.acceptAll();
			vscode.window.showInformationMessage("All agent changes accepted.");
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.discardAllChanges", async () => {
			if (!changeTracker?.hasChanges) {
				vscode.window.showInformationMessage("No agent changes to discard.");
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Discard all agent changes (${changeTracker.modifiedFiles.length} files)?`,
				{ modal: true },
				"Discard",
			);
			if (confirm === "Discard") {
				const count = await changeTracker.discardAll();
				vscode.window.showInformationMessage(`Reverted ${count} file${count !== 1 ? "s" : ""}.`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.discardFileChanges", async (resourceState: vscode.SourceControlResourceState) => {
			if (!changeTracker || !resourceState?.resourceUri) return;
			const filePath = resourceState.resourceUri.fsPath;
			const success = await changeTracker.discardFile(filePath);
			if (success) {
				vscode.window.showInformationMessage(`Reverted ${vscode.workspace.asRelativePath(filePath)}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.acceptFileChanges", (resourceState: vscode.SourceControlResourceState) => {
			if (!changeTracker || !resourceState?.resourceUri) return;
			changeTracker.acceptFile(resourceState.resourceUri.fsPath);
		}),
	);

	// -- Checkpoint commands ------------------------------------------------

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.restoreCheckpoint", async (checkpointId: number) => {
			if (!changeTracker) return;
			const checkpoint = changeTracker.checkpoints.find((c) => c.id === checkpointId);
			if (!checkpoint) return;

			const confirm = await vscode.window.showWarningMessage(
				`Restore to "${checkpoint.label}"? This will revert files to their state at ${new Date(checkpoint.timestamp).toLocaleTimeString()}.`,
				{ modal: true },
				"Restore",
			);
			if (confirm === "Restore") {
				const count = await changeTracker.restoreCheckpoint(checkpointId);
				vscode.window.showInformationMessage(`Restored ${count} file${count !== 1 ? "s" : ""} to checkpoint.`);
			}
		}),
	);

	// -- Diagnostic commands ------------------------------------------------

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.fixProblemsInFile", async () => {
			if (!requireConnected()) return;
			try {
				await diagnosticBridge!.fixProblemsInFile();
			} catch (err) {
				handleError(err, "Failed to fix problems");
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.fixAllProblems", async () => {
			if (!requireConnected()) return;
			try {
				await diagnosticBridge!.fixAllProblems();
			} catch (err) {
				handleError(err, "Failed to fix problems");
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.clearDiagnostics", () => {
			diagnosticBridge?.clearFindings();
		}),
	);

	// -- Permission commands ------------------------------------------------

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.cycleApprovalMode", () => {
			permissionManager?.cycleMode();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.selectApprovalMode", () => {
			permissionManager?.selectMode();
		}),
	);

	// -- Git commands -------------------------------------------------------

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.commitAgentChanges", () => {
			gitIntegration?.commitAgentChanges();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.createAgentBranch", () => {
			gitIntegration?.createAgentBranch();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.showAgentDiff", () => {
			gitIntegration?.showAgentDiff();
		}),
	);

	// -- Auto-start ---------------------------------------------------------

	if (startupConfig.autoStart) {
		vscode.commands.executeCommand("gsd.start");
	}
}

export function deactivate(): void {
	client?.dispose();
	sidebarProvider?.dispose();
	fileDecorations?.dispose();
	sessionTreeProvider?.dispose();
	activityFeedProvider?.dispose();
	changeTracker?.dispose();
	scmProvider?.dispose();
	diagnosticBridge?.dispose();
	lineDecorations?.dispose();
	gitIntegration?.dispose();
	permissionManager?.dispose();
	client = undefined;
	sidebarProvider = undefined;
	fileDecorations = undefined;
	sessionTreeProvider = undefined;
	activityFeedProvider = undefined;
	changeTracker = undefined;
	scmProvider = undefined;
	diagnosticBridge = undefined;
	lineDecorations = undefined;
	gitIntegration = undefined;
	permissionManager = undefined;
}
