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

		const eventHandler = (event: AgentEvent) => {
			switch (event.type) {
				case "agent_start":
					response.progress("GSD is working...");
					break;

				case "tool_execution_start":
					response.progress(`Running tool: ${event.toolName}`);
					break;

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
					const msg = event.message as Record<string, unknown>;
					if (msg && msg.role === "assistant") {
						// Assistant message starting, will be followed by updates
					}
					break;
				}

				case "message_update": {
					const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
					if (assistantEvent?.type === "text_delta") {
						const delta = assistantEvent.delta as string | undefined;
						if (delta) {
							response.markdown(delta);
						}
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
