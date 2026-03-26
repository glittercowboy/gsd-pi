import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";

/**
 * Patterns that identify the start of a named function, class, or method
 * declaration in common languages. Each entry captures the symbol name in
 * capture group 1.
 */
const SYMBOL_PATTERNS: { languages: string[]; regex: RegExp }[] = [
	{
		// TypeScript / JavaScript: function foo(...) | async function foo(...)
		languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
		regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/,
	},
	{
		// TypeScript / JavaScript: class Foo
		languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
		regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
	},
	{
		// TypeScript / JavaScript: method declarations inside a class
		//   foo(...) { | async foo(...) { | private foo(...): T {
		languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
		regex: /^\s*(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*\(/,
	},
	{
		// Python: def foo( | async def foo(
		languages: ["python"],
		regex: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/,
	},
	{
		// Python: class Foo
		languages: ["python"],
		regex: /^\s*class\s+(\w+)/,
	},
	{
		// Go: func foo( | func (r Receiver) foo(
		languages: ["go"],
		regex: /^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/,
	},
	{
		// Rust: fn foo( | pub fn foo( | async fn foo(
		languages: ["rust"],
		regex: /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[(<]/,
	},
];

/**
 * CodeLensProvider that adds an "Ask GSD" lens above named function and class
 * declarations. Clicking the lens sends a brief explanation request to the GSD
 * agent for that specific symbol.
 */
export class GsdCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		this.disposables.push(
			this._onDidChangeCodeLenses,
			client.onConnectionChange(() => this._onDidChangeCodeLenses.fire()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("gsd.codeLens")) {
					this._onDidChangeCodeLenses.fire();
				}
			}),
		);
	}

	provideCodeLenses(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];

		if (!vscode.workspace.getConfiguration("gsd").get<boolean>("codeLens", true)) {
			return lenses;
		}
		const langId = document.languageId;
		const patterns = SYMBOL_PATTERNS.filter((p) => p.languages.includes(langId));

		if (patterns.length === 0) {
			return lenses;
		}

		const fileName = document.fileName.split(/[\\/]/).pop() ?? document.fileName;
		const seen = new Set<number>();

		for (let i = 0; i < document.lineCount; i++) {
			const text = document.lineAt(i).text;

			for (const { regex } of patterns) {
				const match = regex.exec(text);
				if (match && match[1] && !seen.has(i)) {
					seen.add(i);
					const symbolName = match[1];
					const range = new vscode.Range(i, 0, i, text.length);

					lenses.push(
						new vscode.CodeLens(range, {
							title: "$(hubot) Ask GSD",
							tooltip: `Ask GSD to explain ${symbolName}`,
							command: "gsd.askAboutSymbol",
							arguments: [symbolName, fileName, i + 1],
						}),
					);
				}
			}
		}

		return lenses;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
