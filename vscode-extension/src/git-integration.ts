import * as vscode from "vscode";
import { execFile } from "node:child_process";
import type { GsdChangeTracker } from "./change-tracker.js";

/**
 * Provides git integration for agent changes — commit, branch, and diff.
 */
export class GsdGitIntegration implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly tracker: GsdChangeTracker,
		private readonly cwd: string,
	) {}

	/**
	 * Commit all files modified by the agent with a user-provided message.
	 */
	async commitAgentChanges(): Promise<void> {
		const files = this.tracker.modifiedFiles;
		if (files.length === 0) {
			vscode.window.showInformationMessage("No agent changes to commit.");
			return;
		}

		const defaultMsg = `feat: agent changes (${files.length} file${files.length !== 1 ? "s" : ""})`;
		const message = await vscode.window.showInputBox({
			prompt: "Commit message for agent changes",
			value: defaultMsg,
			placeHolder: "feat: describe the changes",
		});
		if (!message) return;

			try {
				// Stage the modified files
				await this.git(["add", ...files]);
				// Commit
				await this.git(["commit", "-m", message]);

			// Accept all changes (clear tracking since they're committed)
			this.tracker.acceptAll();

			vscode.window.showInformationMessage(`Committed ${files.length} file${files.length !== 1 ? "s" : ""}.`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Git commit failed: ${msg}`);
		}
	}

	/**
	 * Create a new branch for agent work and switch to it.
	 */
	async createAgentBranch(): Promise<void> {
		const branchName = await vscode.window.showInputBox({
			prompt: "Branch name for agent work",
			placeHolder: "feat/agent-changes",
			validateInput: (value) => {
				if (!value.trim()) return "Branch name is required";
				if (/\s/.test(value)) return "Branch name cannot contain spaces";
				return null;
			},
		});
		if (!branchName) return;

			try {
				await this.git(["checkout", "-b", branchName]);
			vscode.window.showInformationMessage(`Created and switched to branch: ${branchName}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Failed to create branch: ${msg}`);
		}
	}

	/**
	 * Show a git diff of all agent-modified files.
	 */
	async showAgentDiff(): Promise<void> {
		const files = this.tracker.modifiedFiles;
		if (files.length === 0) {
			vscode.window.showInformationMessage("No agent changes to diff.");
			return;
		}

			try {
				const diff = await this.git(["diff"]);
				if (!diff.trim()) {
					// Files may be untracked — show status instead
					const status = await this.git(["status", "--short"]);
				const channel = vscode.window.createOutputChannel("GSD Git Diff");
				channel.appendLine("# Agent-modified files (unstaged):");
				channel.appendLine(status);
				channel.show();
			} else {
				const channel = vscode.window.createOutputChannel("GSD Git Diff");
				channel.clear();
				channel.appendLine(diff);
				channel.show();
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Git diff failed: ${msg}`);
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private git(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile("git", args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err) {
					reject(new Error(stderr.trim() || err.message));
				} else {
					resolve(stdout);
				}
			});
		});
	}
}
