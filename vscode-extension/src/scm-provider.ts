import * as vscode from "vscode";
import * as path from "node:path";
import type { GsdChangeTracker } from "./change-tracker.js";

const GSD_ORIGINAL_SCHEME = "gsd-original";

/**
 * Source Control provider that shows files modified by the GSD agent
 * in a dedicated "GSD Agent" section of the Source Control panel.
 * Supports QuickDiff to show before/after diffs, and accept/discard per-file.
 */
export class GsdScmProvider implements vscode.Disposable {
	private readonly scm: vscode.SourceControl;
	private readonly changesGroup: vscode.SourceControlResourceGroup;
	private readonly contentProvider: GsdOriginalContentProvider;
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly tracker: GsdChangeTracker,
		private readonly workspaceRoot: string,
	) {
		// Register content provider for original file contents
		this.contentProvider = new GsdOriginalContentProvider(tracker);
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(
				GSD_ORIGINAL_SCHEME,
				this.contentProvider,
			),
		);

		// Create source control instance
		this.scm = vscode.scm.createSourceControl(
			"gsd",
			"GSD Agent",
			vscode.Uri.file(workspaceRoot),
		);
		this.scm.quickDiffProvider = {
			provideOriginalResource: (uri: vscode.Uri): vscode.Uri | undefined => {
				const filePath = uri.fsPath;
				if (this.tracker.getOriginal(filePath) !== undefined) {
					return uri.with({ scheme: GSD_ORIGINAL_SCHEME });
				}
				return undefined;
			},
		};
		this.scm.inputBox.placeholder = "Describe changes to accept...";
		this.scm.acceptInputCommand = {
			command: "gsd.acceptAllChanges",
			title: "Accept All",
		};
		this.scm.count = 0;
		this.disposables.push(this.scm);

		// Create resource group
		this.changesGroup = this.scm.createResourceGroup("changes", "Agent Changes");
		this.changesGroup.hideWhenEmpty = true;
		this.disposables.push(this.changesGroup);

		// Listen for change tracker updates
		this.disposables.push(
			tracker.onDidChange(() => this.refresh()),
		);

		this.refresh();
	}

	private refresh(): void {
		const files = this.tracker.modifiedFiles;
		this.changesGroup.resourceStates = files.map((filePath) => {
			const uri = vscode.Uri.file(filePath);
			const fileName = path.basename(filePath);
			const relativePath = path.relative(this.workspaceRoot, filePath);

			const state: vscode.SourceControlResourceState = {
				resourceUri: uri,
				decorations: {
					strikeThrough: false,
					tooltip: `Modified by GSD Agent`,
					light: { iconPath: new vscode.ThemeIcon("edit") },
					dark: { iconPath: new vscode.ThemeIcon("edit") },
				},
				command: {
					command: "vscode.diff",
					title: "Show Changes",
					arguments: [
						uri.with({ scheme: GSD_ORIGINAL_SCHEME }),
						uri,
						`${fileName} (GSD Agent Changes)`,
					],
				},
			};
			return state;
		});
		this.scm.count = files.length;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

/**
 * TextDocumentContentProvider that serves the original (pre-agent) content
 * of files via the `gsd-original:` URI scheme.
 */
class GsdOriginalContentProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly tracker: GsdChangeTracker) {
		tracker.onDidChange((paths) => {
			for (const p of paths) {
				this._onDidChange.fire(vscode.Uri.file(p).with({ scheme: GSD_ORIGINAL_SCHEME }));
			}
		});
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const filePath = uri.with({ scheme: "file" }).fsPath;
		return this.tracker.getOriginal(filePath) ?? "";
	}
}
