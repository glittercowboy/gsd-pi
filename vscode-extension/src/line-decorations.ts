import * as vscode from "vscode";
import type { GsdChangeTracker } from "./change-tracker.js";

/**
 * Provides line-level editor decorations for files modified by the GSD agent.
 * Shows subtle background highlights on changed lines and gutter icons.
 */
export class GsdLineDecorationManager implements vscode.Disposable {
	private readonly addedDecoration: vscode.TextEditorDecorationType;
	private readonly modifiedDecoration: vscode.TextEditorDecorationType;
	private readonly gutterDecoration: vscode.TextEditorDecorationType;
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly tracker: GsdChangeTracker) {
		this.addedDecoration = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: "rgba(78, 201, 176, 0.07)",
			overviewRulerColor: "rgba(78, 201, 176, 0.5)",
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});

		this.modifiedDecoration = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: "rgba(204, 167, 0, 0.07)",
			overviewRulerColor: "rgba(204, 167, 0, 0.5)",
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});

		this.gutterDecoration = vscode.window.createTextEditorDecorationType({
			gutterIconPath: new vscode.ThemeIcon("hubot").id, // fallback
			gutterIconSize: "contain",
			// Use a colored left border as a gutter indicator (more reliable than icons)
			borderWidth: "0 0 0 3px",
			borderStyle: "solid",
			borderColor: "rgba(78, 201, 176, 0.4)",
		});

		this.disposables.push(
			this.addedDecoration,
			this.modifiedDecoration,
			this.gutterDecoration,
		);

		// Refresh decorations when tracked files change
		this.disposables.push(
			tracker.onDidChange(() => this.refreshAll()),
			vscode.window.onDidChangeActiveTextEditor(() => this.refreshAll()),
			vscode.workspace.onDidChangeTextDocument((e) => {
				const editor = vscode.window.activeTextEditor;
				if (editor && e.document === editor.document) {
					this.refreshEditor(editor);
				}
			}),
		);
	}

	private refreshAll(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.refreshEditor(editor);
		}
	}

	private refreshEditor(editor: vscode.TextEditor): void {
		const filePath = editor.document.uri.fsPath;
		const original = this.tracker.getOriginal(filePath);

		if (original === undefined) {
			// No tracked changes for this file — clear decorations
			editor.setDecorations(this.addedDecoration, []);
			editor.setDecorations(this.modifiedDecoration, []);
			editor.setDecorations(this.gutterDecoration, []);
			return;
		}

		const currentLines = editor.document.getText().split("\n");
		const originalLines = original.split("\n");
		const { added, modified } = diffLines(originalLines, currentLines);

		const addedRanges = added.map((line) => {
			const range = new vscode.Range(line, 0, line, currentLines[line]?.length ?? 0);
			return { range, hoverMessage: new vscode.MarkdownString("$(hubot) *Added by GSD Agent*") };
		});

		const modifiedRanges = modified.map((line) => {
			const range = new vscode.Range(line, 0, line, currentLines[line]?.length ?? 0);
			return { range, hoverMessage: new vscode.MarkdownString("$(hubot) *Modified by GSD Agent*") };
		});

		const gutterRanges = [...added, ...modified].map((line) => ({
			range: new vscode.Range(line, 0, line, 0),
		}));

		editor.setDecorations(this.addedDecoration, addedRanges);
		editor.setDecorations(this.modifiedDecoration, modifiedRanges);
		editor.setDecorations(this.gutterDecoration, gutterRanges);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

/**
 * Simple line-level diff: compare original vs current line-by-line.
 * Returns arrays of line numbers that were added or modified.
 */
function diffLines(
	originalLines: string[],
	currentLines: string[],
): { added: number[]; modified: number[] } {
	const added: number[] = [];
	const modified: number[] = [];

	const maxShared = Math.min(originalLines.length, currentLines.length);

	for (let i = 0; i < maxShared; i++) {
		if (originalLines[i] !== currentLines[i]) {
			modified.push(i);
		}
	}

	// Lines beyond original length are "added"
	for (let i = originalLines.length; i < currentLines.length; i++) {
		added.push(i);
	}

	return { added, modified };
}
