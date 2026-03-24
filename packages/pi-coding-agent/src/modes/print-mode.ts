/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@gsd/pi-ai";
import type { AgentSession } from "../core/agent-session.js";
import { createDefaultCommandContextActions } from "./shared/command-context-actions.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			console.log(JSON.stringify(header));
		}
	}
	// Set up extensions for print mode (no UI)
	await session.bindExtensions({
		commandContextActions: createDefaultCommandContextActions(session),
		onError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});

	// Always subscribe to enable session persistence via _handleAgentEvent
	const unsubscribe = session.subscribe((event) => {
		// In JSON mode, output all events
		if (mode === "json") {
			console.log(JSON.stringify(event));
		}
	});

	let exitCode = 0;

	try {
		// Send initial message with attachments
		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		// Send remaining messages
		for (const message of messages) {
			await session.prompt(message);
		}

		// In text mode, output final response
		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;

				// Check for error/aborted
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					// Output text content
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							console.log(content.text);
						}
					}
				}
			}
		}

		// Ensure stdout is fully flushed before returning
		// This prevents race conditions where the process exits before all output is written
		await new Promise<void>((resolve, reject) => {
			process.stdout.write("", (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	} finally {
		unsubscribe();
	}

	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}
