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
		if (!client.isConnected) {
			response.markdown("GSD agent is not running. Use the **GSD: Start Agent** command first.");
			return;
		}

		const message = request.prompt;
		if (!message.trim()) {
			response.markdown("Please provide a message.");
			return;
		}

		// Track streaming events while the prompt executes
		let agentDone = false;
		let totalInputTokens = 0;
		let totalOutputTokens = 0;

		const eventHandler = (event: AgentEvent) => {
			switch (event.type) {
				case "agent_start":
					response.progress("GSD is working...");
					break;

				case "tool_execution_start": {
					const toolName = event.toolName as string;
					const toolInput = event.toolInput as Record<string, unknown> | undefined;

					let detail = `Running tool: ${toolName}`;

					// Show relevant parameters for common tools
					if (toolInput) {
						if (toolName === "Read" && toolInput.file_path) {
							detail = `Reading: ${toolInput.file_path}`;
						} else if (toolName === "Write" && toolInput.file_path) {
							detail = `Writing: ${toolInput.file_path}`;
						} else if (toolName === "Edit" && toolInput.file_path) {
							detail = `Editing: ${toolInput.file_path}`;
						} else if (toolName === "Bash" && toolInput.command) {
							const cmd = String(toolInput.command);
							detail = `Running: $ ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}`;
						} else if (toolName === "Glob" && toolInput.pattern) {
							detail = `Searching: ${toolInput.pattern}`;
						} else if (toolName === "Grep" && toolInput.pattern) {
							detail = `Grep: ${toolInput.pattern}`;
						}
					}

					response.progress(detail);
					break;
				}

				case "tool_execution_end": {
					const toolName = event.toolName as string;
					const isError = event.isError as boolean;
					if (isError) {
						response.markdown(`\n**Tool \`${toolName}\` failed**\n`);
					} else {
						response.markdown(`\n*Tool \`${toolName}\` completed*\n`);
					}
					break;
				}

				case "message_start": {
					// Assistant message starting
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
						// Show thinking content in a collapsed section
						const delta = assistantEvent.delta as string | undefined;
						if (delta) {
							response.markdown(delta);
						}
					}
					break;
				}

				case "message_end": {
					// Capture token usage from message end events
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

		// Handle cancellation
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

			// Show token usage summary at the end
			if (totalInputTokens > 0 || totalOutputTokens > 0) {
				response.markdown(
					`\n\n---\n*Tokens: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out*\n`,
				);
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			response.markdown(`\n**Error:** ${errorMessage}\n`);
		} finally {
			subscription.dispose();
		}
	});

	participant.iconPath = new vscode.ThemeIcon("hubot");

	return participant;
}
