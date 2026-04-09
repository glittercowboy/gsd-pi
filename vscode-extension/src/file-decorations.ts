import * as vscode from "vscode";
import type { AgentEvent, GsdClient } from "./gsd-client.js";

/**
 * Badges files in the VS Code explorer that GSD has written or edited
 * during the current session.
 */
export class GsdFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	private modifiedUris = new Set<string>();
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		this.disposables.push(
			this._onDidChangeFileDecorations,
			client.onEvent((evt: AgentEvent) => this.handleEvent(evt)),
			client.onConnectionChange((connected) => {
				if (!connected) {
					this.clear();
				}
			}),
		);
	}

	private handleEvent(evt: AgentEvent): void {
		if (evt.type !== "tool_execution_start") {
			return;
		}
		const toolName = evt.toolName as string | undefined;
		if (toolName !== "Write" && toolName !== "Edit") {
			return;
		}
		const toolInput = evt.toolInput as Record<string, unknown> | undefined;
		const fp = toolInput?.file_path ? String(toolInput.file_path) : undefined;
		if (!fp) {
			return;
		}
		const uri = resolveUri(fp);
		if (uri) {
			this.modifiedUris.add(uri.toString());
			this._onDidChangeFileDecorations.fire(uri);
		}
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (this.modifiedUris.has(uri.toString())) {
			return {
				badge: "G",
				tooltip: "Modified by GSD",
				color: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
			};
		}
		return undefined;
	}

	clear(): void {
		this.modifiedUris.clear();
		this._onDidChangeFileDecorations.fire(undefined);
	}

	dispose(): void {
		this.clear();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

function resolveUri(fp: string): vscode.Uri | null {
	try {
		if (fp.startsWith("/") || /^[A-Za-z]:[\\/]/.test(fp)) {
			return vscode.Uri.file(fp);
		}
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return null;
		}
		return vscode.Uri.joinPath(folders[0].uri, fp);
	} catch {
		return null;
	}
}
