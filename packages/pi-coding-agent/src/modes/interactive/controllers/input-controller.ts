import { dispatchSlashCommand } from "../slash-command-handlers.js";
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";

export function setupEditorSubmitHandler(host: InteractiveModeStateHost & {
	getSlashCommandContext: () => any;
	handleBashCommand: (command: string, excludeFromContext?: boolean) => Promise<void>;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	updateEditorBorderColor: () => void;
	isExtensionCommand: (text: string) => boolean;
	isKnownSlashCommand: (text: string) => boolean;
	queueCompactionMessage: (text: string, mode: "steer" | "followUp") => void;
	updatePendingMessagesDisplay: () => void;
	flushPendingBashComponents: () => void;
	options?: { submitPromptsDirectly?: boolean };
}): void {
	host.defaultEditor.onSubmit = async (text: string) => {
		text = text.trim();
		if (!text) return;

		if (text.startsWith("/") && !looksLikeFilePath(text)) {
			const handled = await dispatchSlashCommand(text, host.getSlashCommandContext());
			if (handled) {
				host.editor.setText("");
				return;
			}
			if (!host.isKnownSlashCommand(text)) {
				const command = text.split(/\s/)[0];
				host.showError(`Unknown command: ${command}. Use slash autocomplete to see available commands.`);
				host.editor.setText("");
				return;
			}
		}

		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (host.session.isBashRunning) {
					host.showWarning("A bash command is already running. Press Esc to cancel it first.");
					host.editor.setText(text);
					return;
				}
				host.editor.addToHistory?.(text);
				await host.handleBashCommand(command, isExcluded);
				host.isBashMode = false;
				host.updateEditorBorderColor();
				return;
			}
		}

		if (host.session.isCompacting) {
			if (host.isExtensionCommand(text)) {
				host.editor.addToHistory?.(text);
				host.editor.setText("");
				try {
					await host.session.prompt(text);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					host.showError(errorMessage);
				}
			} else {
				host.queueCompactionMessage(text, "steer");
			}
			return;
		}

		if (host.session.isStreaming) {
			host.editor.addToHistory?.(text);
			host.editor.setText("");
			await host.session.prompt(text, { streamingBehavior: "steer" });
			host.updatePendingMessagesDisplay();
			host.ui.requestRender();
			return;
		}

		host.flushPendingBashComponents();

		if (host.onInputCallback) {
			host.onInputCallback(text);
			host.editor.addToHistory?.(text);
			return;
		}

		if (host.options?.submitPromptsDirectly) {
			host.editor.addToHistory?.(text);
			try {
				await host.session.prompt(text);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				host.showError(errorMessage);
			}
			return;
		}

		host.editor.addToHistory?.(text);
		// submitPromptsDirectly is false — still dispatch via session.prompt so user input
		// is not silently discarded.
		try {
			await host.session.prompt(text);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			host.showError(errorMessage);
		}
	};
}

/**
 * Distinguish absolute file paths from slash commands (#3478).
 * Drag-and-drop inserts paths like "/Users/name/Desktop/file.png" which
 * should be treated as plain text input, not a /Users command.
 *
 * Heuristic: a slash command is a single token like "/help" or "/gsd auto".
 * File paths have a second "/" within the first token (e.g., "/Users/...").
 */
function looksLikeFilePath(text: string): boolean {
	const firstToken = text.split(/\s/)[0];
	// Slash commands: /help, /gsd, /commit — single "/" at start only.
	// File paths: /Users/name/file, /home/user/file, /tmp/x — contain "/" after position 0.
	return firstToken.indexOf("/", 1) !== -1;
}
