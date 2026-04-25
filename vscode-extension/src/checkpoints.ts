import * as vscode from "vscode";
import type { GsdChangeTracker, Checkpoint } from "./change-tracker.js";

/**
 * TreeDataProvider that shows agent checkpoints (one per agent turn).
 * Each checkpoint can be restored to revert all file changes since that point.
 */
export class GsdCheckpointProvider implements vscode.TreeDataProvider<Checkpoint>, vscode.Disposable {
	public static readonly viewId = "gsd-checkpoints";

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private disposables: vscode.Disposable[] = [];

	constructor(private readonly tracker: GsdChangeTracker) {
		this.disposables.push(
			this._onDidChangeTreeData,
			tracker.onCheckpointChange(() => this._onDidChangeTreeData.fire()),
		);
	}

	getTreeItem(checkpoint: Checkpoint): vscode.TreeItem {
		const fileCount = checkpoint.snapshots.size;
		const time = new Date(checkpoint.timestamp);
		const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

		const item = new vscode.TreeItem(
			checkpoint.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.description = `${timeStr} (${fileCount} file${fileCount !== 1 ? "s" : ""})`;
		item.iconPath = new vscode.ThemeIcon("history");
		item.tooltip = `Checkpoint: ${checkpoint.label}\nTime: ${time.toLocaleString()}\nFiles tracked: ${fileCount}\n\nClick to restore to this point`;
		item.contextValue = "checkpoint";
		item.command = {
			command: "gsd.restoreCheckpoint",
			title: "Restore Checkpoint",
			arguments: [checkpoint.id],
		};

		return item;
	}

	getChildren(): Checkpoint[] {
		// Show newest first
		return [...this.tracker.checkpoints].reverse();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
