import * as vscode from "vscode";
import type { AgentEvent, GsdClient } from "./gsd-client.js";

/**
 * Registers the @gsd chat participant that forwards messages to the
 * GSD RPC client and streams tool execution events back to the chat.
 */
export function registerChatParticipant(
	context: vscode.ExtensionContext,
	client: GsdClient,
): vscode.Disposable {
	const participant = vscode.chat.createChatParticipant("gsd.agent", async (
		request: vscode.ChatRequest,
		_chatContext: vscode.ChatContext,
		response: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	) => {
		// Auto-start the agent if not connected
		if (!client.isConnected) {
			response.progress("Starting GSD agent...");
			try {
				await client.start();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				response.markdown(`**Failed to start GSD agent:** ${msg}\n\nMake sure \`gsd\` is installed (\`npm install -g gsd-pi\`) and try again.`);
				return;
			}
		}

		// Build the full message, injecting any #file references
		let message = request.prompt.trim();
		if (!message) {
			response.markdown("Please provide a message.");
			return;
		}

		const fileContext = await buildFileContext(request);
		if (fileContext) {
			message = `${fileContext}\n\n${message}`;
		}

		// Auto-include editor selection if present and not already referenced
		const selectionContext = getSelectionContext();
		if (selectionContext) {
			message = `${selectionContext}\n\n${message}`;
		}

		// Auto-include diagnostics for the active file if the prompt mentions "fix", "error", "problem", "warning"
		const fixKeywords = /\b(fix|error|problem|warning|issue|bug|lint|diagnos)/i;
		if (fixKeywords.test(message)) {
			const diagContext = getActiveDiagnosticsContext();
			if (diagContext) {
				message = `${message}\n\n${diagContext}`;
			}
		}

		// Track streaming state
		let agentDone = false;
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		const filesWritten: string[] = [];
		const filesRead: string[] = [];

		const eventHandler = (event: AgentEvent) => {
			switch (event.type) {
				case "agent_start":
					response.progress("GSD is working...");
					break;

				case "tool_execution_start": {
					const toolName = event.toolName as string;
					const toolInput = event.toolInput as Record<string, unknown> | undefined;
					const detail = describeToolCall(toolName, toolInput);
					response.progress(detail);

					// Track file paths for anchors
					if (toolInput?.file_path) {
						const fp = String(toolInput.file_path);
						if (toolName === "Write" || toolName === "Edit") {
							if (!filesWritten.includes(fp)) filesWritten.push(fp);
						} else if (toolName === "Read") {
							if (!filesRead.includes(fp)) filesRead.push(fp);
						}
					}
					break;
				}

				case "message_update": {
					const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
					if (!assistantEvent) break;

					if (assistantEvent.type === "text_delta") {
						const delta = assistantEvent.delta as string | undefined;
						if (delta) {
							response.markdown(delta);
						}
					} else if (assistantEvent.type === "thinking_delta") {
						// Thinking shown inline — prefix with italic so it's visually distinct
						const delta = assistantEvent.delta as string | undefined;
						if (delta) {
							response.markdown(`*${delta}*`);
						}
					}
					break;
				}

				case "message_end": {
					const usage = event.usage as { inputTokens?: number; outputTokens?: number } | undefined;
					if (usage) {
						if (usage.inputTokens) totalInputTokens += usage.inputTokens;
						if (usage.outputTokens) totalOutputTokens += usage.outputTokens;
					}
					break;
				}

				case "agent_end":
					agentDone = true;
					break;
			}
		};

		const subscription = client.onEvent(eventHandler);

		token.onCancellationRequested(() => {
			client.abort().catch(() => {});
		});

		try {
			await client.sendPrompt(message);

			// Wait for agent_end or cancellation
			await new Promise<void>((resolve) => {
				if (agentDone) {
					resolve();
					return;
				}
				const checkDone = client.onEvent((evt) => {
					if (evt.type === "agent_end") {
						checkDone.dispose();
						resolve();
					}
				});
				token.onCancellationRequested(() => {
					checkDone.dispose();
					resolve();
				});
			});

			// Show clickable file anchors for written files
			if (filesWritten.length > 0) {
				response.markdown("\n\n**Files changed:**");
				for (const fp of filesWritten) {
					const uri = resolveFileUri(fp);
					if (uri) {
						response.anchor(uri, fp);
						response.markdown(" ");
					}
				}
			}

			// Token usage summary
			if (totalInputTokens > 0 || totalOutputTokens > 0) {
				response.markdown(
					`\n\n---\n*${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out tokens*`,
				);
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			response.markdown(`\n**Error:** ${errorMessage}`);
		} finally {
			subscription.dispose();
		}
	});

	participant.iconPath = new vscode.ThemeIcon("hubot");

	// Follow-up suggestions after each response
	participant.followupProvider = {
		provideFollowups: (_result, _context, _token) => {
			return [
				{
					prompt: "/gsd status",
					label: "$(info) Check status",
					title: "Check project status",
				},
				{
					prompt: "/gsd auto",
					label: "$(rocket) Run auto mode",
					title: "Run autonomous mode",
				},
				{
					prompt: "/gsd capture",
					label: "$(note) Capture a thought",
					title: "Capture a thought mid-session",
				},
			];
		},
	};

	return participant;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a file context block from any #file references in the chat request.
 */
async function buildFileContext(request: vscode.ChatRequest): Promise<string | null> {
	if (!request.references || request.references.length === 0) {
		return null;
	}

	const parts: string[] = [];

	for (const ref of request.references) {
		if (ref.value instanceof vscode.Uri) {
			try {
				const bytes = await vscode.workspace.fs.readFile(ref.value);
				const content = Buffer.from(bytes).toString("utf-8");
				const relativePath = vscode.workspace.asRelativePath(ref.value);
				parts.push(`File: ${relativePath}\n\`\`\`\n${content}\n\`\`\``);
			} catch {
				// Skip unreadable files
			}
		} else if (ref.value instanceof vscode.Location) {
			try {
				const doc = await vscode.workspace.openTextDocument(ref.value.uri);
				const text = doc.getText(ref.value.range);
				const relativePath = vscode.workspace.asRelativePath(ref.value.uri);
				const { start, end } = ref.value.range;
				parts.push(`File: ${relativePath} (lines ${start.line + 1}–${end.line + 1})\n\`\`\`\n${text}\n\`\`\``);
			} catch {
				// Skip unreadable ranges
			}
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Produce a human-readable progress label for a tool call.
 */
function describeToolCall(toolName: string, input?: Record<string, unknown>): string {
	if (!input) {
		return `Running: ${toolName}`;
	}
	switch (toolName) {
		case "Read":
			return `Reading: ${shortenPath(String(input.file_path ?? ""))}`;
		case "Write":
			return `Writing: ${shortenPath(String(input.file_path ?? ""))}`;
		case "Edit":
			return `Editing: ${shortenPath(String(input.file_path ?? ""))}`;
		case "Bash": {
			const cmd = String(input.command ?? "");
			return `$ ${cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd}`;
		}
		case "Glob":
			return `Searching: ${input.pattern ?? ""}`;
		case "Grep":
			return `Grep: ${input.pattern ?? ""}`;
		case "WebSearch":
			return `Searching web: ${String(input.query ?? "").slice(0, 60)}`;
		case "WebFetch":
			return `Fetching: ${String(input.url ?? "").slice(0, 60)}`;
		default:
			return `Running: ${toolName}`;
	}
}

/**
 * Shorten an absolute path to just the last 2–3 segments for display.
 */
function shortenPath(fp: string): string {
	const parts = fp.replace(/\\/g, "/").split("/");
	return parts.slice(-3).join("/");
}

/**
 * Attempt to resolve a file path string to a VS Code URI.
 */
function resolveFileUri(fp: string): vscode.Uri | null {
	try {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return null;
		}
		// Absolute path
		if (fp.startsWith("/") || /^[A-Za-z]:[\\/]/.test(fp)) {
			return vscode.Uri.file(fp);
		}
		// Relative path — resolve against first workspace folder
		return vscode.Uri.joinPath(workspaceFolders[0].uri, fp);
	} catch {
		return null;
	}
}

/**
 * Get the current editor selection as context, if any text is selected.
 */
function getSelectionContext(): string | null {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.selection.isEmpty) return null;

	const selection = editor.document.getText(editor.selection);
	if (!selection.trim()) return null;

	const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
	const { start, end } = editor.selection;
	return `Selected code in \`${relativePath}\` (lines ${start.line + 1}-${end.line + 1}):\n\`\`\`\n${selection}\n\`\`\``;
}

/**
 * Get diagnostics (errors/warnings) for the active editor file.
 */
function getActiveDiagnosticsContext(): string | null {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return null;

	const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
	const significant = diagnostics.filter(
		(d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
	);
	if (significant.length === 0) return null;

	const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
	const lines = [`Current diagnostics in \`${relativePath}\`:`];
	for (const d of significant) {
		const sev = d.severity === vscode.DiagnosticSeverity.Error ? "Error" : "Warning";
		const line = d.range.start.line + 1;
		const source = d.source ? ` [${d.source}]` : "";
		lines.push(`- ${sev} (line ${line}): ${d.message}${source}`);
	}
	return lines.join("\n");
}
