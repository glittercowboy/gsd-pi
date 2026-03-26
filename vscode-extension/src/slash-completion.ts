import * as vscode from "vscode";
import type { GsdClient, SlashCommand } from "./gsd-client.js";

/**
 * CompletionItemProvider that surfaces GSD slash commands when the user
 * types `/` at the start of a line (or after only whitespace) in Markdown,
 * plaintext, and TypeScript/JavaScript files.
 *
 * Commands are fetched from the running agent via get_commands RPC and
 * cached so the list remains available between keystrokes.
 */
export class GsdSlashCompletionProvider
	implements vscode.CompletionItemProvider, vscode.Disposable
{
	private cachedCommands: SlashCommand[] = [];
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		// Refresh cache whenever the connection (re)establishes.
		this.disposables.push(
			client.onConnectionChange(async (connected) => {
				if (connected) {
					await this.refreshCache();
				} else {
					this.cachedCommands = [];
				}
			}),
		);
	}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.CompletionItem[] | undefined> {
		const lineText = document.lineAt(position).text;
		const linePrefix = lineText.slice(0, position.character);

		// Only activate when the non-whitespace content starts with `/`.
		if (!/^\s*\/\S*$/.test(linePrefix)) {
			return undefined;
		}

		// Lazily populate the cache on first use.
		if (this.cachedCommands.length === 0 && this.client.isConnected) {
			await this.refreshCache();
		}

		if (this.cachedCommands.length === 0) {
			return undefined;
		}

		// The text the user has typed after the `/` — used for pre-filtering.
		const slashIndex = linePrefix.lastIndexOf("/");
		const typedAfterSlash = linePrefix.slice(slashIndex + 1);

		// Range to replace: from the `/` to the current cursor position.
		const replaceRange = new vscode.Range(
			new vscode.Position(position.line, slashIndex),
			position,
		);

		return this.cachedCommands
			.filter(
				(cmd) =>
					typedAfterSlash.length === 0 ||
					cmd.name.toLowerCase().startsWith(typedAfterSlash.toLowerCase()),
			)
			.map((cmd) => this.toCompletionItem(cmd, replaceRange));
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private async refreshCache(): Promise<void> {
		try {
			this.cachedCommands = await this.client.getCommands();
		} catch {
			// Silently ignore — agent may not be ready yet.
		}
	}

	private toCompletionItem(cmd: SlashCommand, replaceRange: vscode.Range): vscode.CompletionItem {
		const item = new vscode.CompletionItem(`/${cmd.name}`, vscode.CompletionItemKind.Event);

		item.insertText = `/${cmd.name}`;
		item.filterText = `/${cmd.name}`;
		item.sortText = cmd.name;
		item.range = replaceRange;
		item.commitCharacters = [" ", "\n"];

		const sourceNote = `Source: \`${cmd.source}\`${cmd.location ? ` (${cmd.location})` : ""}`;
		if (cmd.description) {
			item.detail = cmd.description;
			item.documentation = new vscode.MarkdownString(
				`**/${cmd.name}** — ${cmd.description}\n\n${sourceNote}`,
			);
		} else {
			item.documentation = new vscode.MarkdownString(`**/${cmd.name}**\n\n${sourceNote}`);
		}

		return item;
	}
}
