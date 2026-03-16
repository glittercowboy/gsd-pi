import * as vscode from "vscode";
import { GsdClient } from "./gsd-client.js";
import { registerChatParticipant } from "./chat-participant.js";
import { GsdSidebarProvider } from "./sidebar.js";

let client: GsdClient | undefined;
let sidebarProvider: GsdSidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const config = vscode.workspace.getConfiguration("gsd");
	const binaryPath = config.get<string>("binaryPath", "gsd");
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

	client = new GsdClient(binaryPath, cwd);
	context.subscriptions.push(client);

	// Log stderr to an output channel
	const outputChannel = vscode.window.createOutputChannel("GSD Agent");
	context.subscriptions.push(outputChannel);

	client.onError((msg) => {
		outputChannel.appendLine(`[stderr] ${msg}`);
	});

	client.onConnectionChange((connected) => {
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

	// -- Chat participant ---------------------------------------------------

	context.subscriptions.push(registerChatParticipant(context, client));

	// -- Commands -----------------------------------------------------------

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.start", async () => {
			try {
				await client!.start();
				sidebarProvider?.refresh();
				vscode.window.showInformationMessage("GSD agent started.");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to start GSD: ${msg}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.stop", async () => {
			await client!.stop();
			sidebarProvider?.refresh();
			vscode.window.showInformationMessage("GSD agent stopped.");
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.newSession", async () => {
			if (!client!.isConnected) {
				vscode.window.showWarningMessage("GSD agent is not running.");
				return;
			}
			try {
				await client!.newSession();
				sidebarProvider?.refresh();
				vscode.window.showInformationMessage("New GSD session started.");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to start new session: ${msg}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gsd.sendMessage", async () => {
			if (!client!.isConnected) {
				vscode.window.showWarningMessage("GSD agent is not running.");
				return;
			}
			const message = await vscode.window.showInputBox({
				prompt: "Enter message for GSD",
				placeHolder: "What should I do?",
			});
			if (!message) {
				return;
			}
			try {
				await client!.sendPrompt(message);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to send message: ${msg}`);
			}
		}),
	);
}

export function deactivate(): void {
	client?.dispose();
	sidebarProvider?.dispose();
	client = undefined;
	sidebarProvider = undefined;
}
