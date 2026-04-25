import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";

/**
 * Integrates with VS Code's diagnostic system:
 * - Reads diagnostics (errors/warnings) from the Problems panel and sends them to the agent
 * - Provides a DiagnosticCollection for the agent to surface its own findings
 */
export class GsdDiagnosticBridge implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly client: GsdClient) {
		this.collection = vscode.languages.createDiagnosticCollection("gsd");
		this.disposables.push(this.collection);
	}

	/**
	 * Read all diagnostics for the active file and send them to the agent
	 * as a "fix these problems" prompt.
	 */
	async fixProblemsInFile(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage("No active file to fix.");
			return;
		}

		const uri = editor.document.uri;
		const diagnostics = vscode.languages.getDiagnostics(uri);

		if (diagnostics.length === 0) {
			vscode.window.showInformationMessage("No problems found in this file.");
			return;
		}

		const fileName = vscode.workspace.asRelativePath(uri);
		const problemText = formatDiagnostics(fileName, diagnostics);

		const prompt = [
			`Fix the following problems in \`${fileName}\`:`,
			"",
			problemText,
			"",
			"Fix all of these issues. Show me the changes.",
		].join("\n");

		await this.client.sendPrompt(prompt);
	}

	/**
	 * Read all diagnostics across the workspace (errors only) and send
	 * them to the agent as a "fix all errors" prompt.
	 */
	async fixAllProblems(): Promise<void> {
		const allDiagnostics = vscode.languages.getDiagnostics();
		const errorFiles: { fileName: string; diagnostics: vscode.Diagnostic[] }[] = [];

		for (const [uri, diagnostics] of allDiagnostics) {
			// Only include errors and warnings, skip hints/info
			const significant = diagnostics.filter(
				(d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
			);
			if (significant.length > 0) {
				errorFiles.push({
					fileName: vscode.workspace.asRelativePath(uri),
					diagnostics: significant,
				});
			}
		}

		if (errorFiles.length === 0) {
			vscode.window.showInformationMessage("No errors or warnings found in the workspace.");
			return;
		}

		// Cap at 20 files to avoid overwhelming the agent
		const capped = errorFiles.slice(0, 20);
		const totalProblems = capped.reduce((sum, f) => sum + f.diagnostics.length, 0);

		const sections = capped.map((f) => formatDiagnostics(f.fileName, f.diagnostics));

		const prompt = [
			`Fix the following ${totalProblems} problems across ${capped.length} file${capped.length > 1 ? "s" : ""}:`,
			"",
			...sections,
			"",
			"Fix all of these issues.",
		].join("\n");

		await this.client.sendPrompt(prompt);
	}

	/**
	 * Add a GSD diagnostic (agent finding) to a file.
	 * Can be used to surface agent review findings in the Problems panel.
	 */
	addFinding(
		uri: vscode.Uri,
		range: vscode.Range,
		message: string,
		severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Warning,
	): void {
		const existing = this.collection.get(uri) ?? [];
		const diagnostic = new vscode.Diagnostic(range, message, severity);
		diagnostic.source = "GSD Agent";
		this.collection.set(uri, [...existing, diagnostic]);
	}

	/** Clear all GSD diagnostics */
	clearFindings(): void {
		this.collection.clear();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

function formatDiagnostics(fileName: string, diagnostics: vscode.Diagnostic[]): string {
	const lines = [`**${fileName}**`];
	for (const d of diagnostics) {
		const severity = severityLabel(d.severity);
		const line = d.range.start.line + 1;
		const col = d.range.start.character + 1;
		const source = d.source ? ` [${d.source}]` : "";
		lines.push(`  - ${severity} (line ${line}:${col}): ${d.message}${source}`);
	}
	return lines.join("\n");
}

function severityLabel(severity: vscode.DiagnosticSeverity): string {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error: return "Error";
		case vscode.DiagnosticSeverity.Warning: return "Warning";
		case vscode.DiagnosticSeverity.Information: return "Info";
		case vscode.DiagnosticSeverity.Hint: return "Hint";
		default: return "Unknown";
	}
}
