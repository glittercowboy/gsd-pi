import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GsdClient } from "./gsd-client.js";

export interface SessionItem {
	label: string;
	sessionFile: string;
	timestamp: Date;
	sessionId: string;
	isCurrent: boolean;
}

/**
 * Tree view provider that lists GSD session files from the same directory
 * as the currently active session.
 */
export class GsdSessionTreeProvider implements vscode.TreeDataProvider<SessionItem>, vscode.Disposable {
	public static readonly viewId = "gsd-sessions";

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private sessions: SessionItem[] = [];
	private currentSessionFile: string | undefined;
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		this.disposables.push(
			this._onDidChangeTreeData,
			client.onConnectionChange(() => this.refresh()),
		);
	}

	async refresh(): Promise<void> {
		this.sessions = await this.loadSessions();
		this._onDidChangeTreeData.fire();
	}

	private async loadSessions(): Promise<SessionItem[]> {
		if (!this.client.isConnected) {
			return [];
		}
		try {
			const state = await this.client.getState();
			this.currentSessionFile = state.sessionFile;
			if (!state.sessionFile) {
				return [];
			}

			const sessionDir = path.dirname(state.sessionFile);
			const files = fs.readdirSync(sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.sort()
				.reverse(); // newest first

			const items: SessionItem[] = [];
			for (const file of files) {
				const sessionFile = path.join(sessionDir, file);

				// Try two filename formats:
				// 1. ISO timestamp: 2026-03-23T17-49-05-784Z_<sessionId>.jsonl
				// 2. Unix timestamp: <unixTimestampMs>_<sessionId>.jsonl
				const isoMatch = file.match(/^(\d{4}-\d{2}-\d{2}T[\d-]+Z)_(.+)\.jsonl$/);
				const unixMatch = file.match(/^(\d{10,})_(.+)\.jsonl$/);

				let timestamp: Date;
				let sessionId: string;

				if (isoMatch) {
					// Convert ISO-like format (dashes instead of colons) back to parseable ISO
					const isoStr = isoMatch[1].replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d+)Z/, "$1:$2:$3.$4Z");
					timestamp = new Date(isoStr);
					sessionId = isoMatch[2];
				} else if (unixMatch) {
					timestamp = new Date(parseInt(unixMatch[1], 10));
					sessionId = unixMatch[2];
				} else {
					continue;
				}

				if (isNaN(timestamp.getTime())) continue;

				items.push({
					label: formatDate(timestamp),
					sessionFile,
					timestamp,
					sessionId,
					isCurrent: sessionFile === state.sessionFile,
				});
			}
			return items;
		} catch {
			return [];
		}
	}

	getTreeItem(element: SessionItem): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.description = element.sessionId.slice(0, 8);
		item.tooltip = new vscode.MarkdownString(
			`**${element.label}**\n\nID: \`${element.sessionId}\`\n\nFile: \`${element.sessionFile}\``,
		);
		item.iconPath = new vscode.ThemeIcon(
			element.isCurrent ? "comment-discussion" : "history",
			element.isCurrent ? new vscode.ThemeColor("terminal.ansiGreen") : undefined,
		);
		if (!element.isCurrent) {
			item.command = {
				command: "gsd.switchSession",
				title: "Switch to Session",
				arguments: [element.sessionFile],
			};
		}
		item.contextValue = element.isCurrent ? "currentSession" : "session";
		return item;
	}

	getChildren(): SessionItem[] {
		return this.sessions;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

function formatDate(d: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - d.getTime();
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (diffDays === 0) {
		return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	} else if (diffDays === 1) {
		return `Yesterday ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	} else if (diffDays < 7) {
		return d.toLocaleDateString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
	}
	return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
