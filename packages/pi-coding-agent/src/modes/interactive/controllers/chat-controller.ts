import { Loader, Spacer, Text } from "@gsd/pi-tui";

import type { InteractiveModeEvent, InteractiveModeStateHost } from "../interactive-mode-state.js";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import { ToolExecutionComponent } from "../components/tool-execution.js";
import { appKey } from "../components/keybinding-hints.js";

export async function handleAgentEvent(host: InteractiveModeStateHost & {
	init: () => Promise<void>;
	getMarkdownThemeWithSettings: () => any;
	addMessageToChat: (message: any, options?: any) => void;
	formatWebSearchResult: (content: unknown) => string;
	getRegisteredToolDefinition: (toolName: string) => any;
	checkShutdownRequested: () => Promise<void>;
	rebuildChatFromMessages: () => void;
	flushCompactionQueue: (options?: { willRetry?: boolean }) => Promise<void>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	updatePendingMessagesDisplay: () => void;
	updateTerminalTitle: () => void;
	updateEditorBorderColor: () => void;
	pendingMessagesContainer: { clear: () => void };
}, event: InteractiveModeEvent): Promise<void> {
	if (!host.isInitialized) {
		await host.init();
	}

	host.footer.invalidate();

	switch (event.type) {
		case "session_state_changed":
			switch (event.reason) {
				case "new_session":
				case "switch_session":
				case "fork":
					host.streamingComponent = undefined;
					host.streamingMessage = undefined;
					host.pendingTools.clear();
					host.pendingMessagesContainer.clear();
					host.compactionQueuedMessages = [];
					host.rebuildChatFromMessages();
					host.updatePendingMessagesDisplay();
					host.updateTerminalTitle();
					host.updateEditorBorderColor();
					host.ui.requestRender();
					return;
				case "set_session_name":
					host.updateTerminalTitle();
					host.ui.requestRender();
					return;
				case "set_model":
				case "set_thinking_level":
					host.updateEditorBorderColor();
					host.ui.requestRender();
					return;
				default:
					host.ui.requestRender();
					return;
			}
		case "agent_start":
			if (host.retryEscapeHandler) {
				host.defaultEditor.onEscape = host.retryEscapeHandler;
				host.retryEscapeHandler = undefined;
			}
			if (host.retryLoader) {
				host.retryLoader.stop();
				host.retryLoader = undefined;
			}
			if (host.loadingAnimation) {
				host.loadingAnimation.stop();
			}
			host.statusContainer.clear();
			host.loadingAnimation = new Loader(
				host.ui,
				(spinner) => theme.fg("accent", spinner),
				(text) => theme.fg("muted", text),
				host.defaultWorkingMessage,
			);
			host.statusContainer.addChild(host.loadingAnimation);
			if (host.pendingWorkingMessage !== undefined) {
				if (host.pendingWorkingMessage) {
					host.loadingAnimation.setMessage(host.pendingWorkingMessage);
				}
				host.pendingWorkingMessage = undefined;
			}
			host.ui.requestRender();
			break;

		case "message_start":
			if (event.message.role === "custom") {
				host.addMessageToChat(event.message);
				host.ui.requestRender();
			} else if (event.message.role === "user") {
				host.addMessageToChat(event.message);
				host.updatePendingMessagesDisplay();
				host.ui.requestRender();
			} else if (event.message.role === "assistant") {
				host.streamingComponent = new AssistantMessageComponent(
					undefined,
					host.hideThinkingBlock,
					host.getMarkdownThemeWithSettings(),
					host.settingsManager.getTimestampFormat(),
				);
				host.streamingMessage = event.message;
				host.chatContainer.addChild(host.streamingComponent);
				host.streamingComponent.updateContent(host.streamingMessage);
				host.ui.requestRender();
			}
			break;

		case "message_update":
			if (host.streamingComponent && event.message.role === "assistant") {
				host.streamingMessage = event.message;
				host.streamingComponent.updateContent(host.streamingMessage);
				for (const content of host.streamingMessage.content) {
					if (content.type === "toolCall") {
						if (!host.pendingTools.has(content.id)) {
							const component = new ToolExecutionComponent(
								content.name,
								content.arguments,
								{ showImages: host.settingsManager.getShowImages() },
								host.getRegisteredToolDefinition(content.name),
								host.ui,
							);
							component.setExpanded(host.toolOutputExpanded);
							host.chatContainer.addChild(component);
							host.pendingTools.set(content.id, component);
						} else {
							host.pendingTools.get(content.id)?.updateArgs(content.arguments);
						}
					} else if (content.type === "serverToolUse") {
						if (!host.pendingTools.has(content.id)) {
							const component = new ToolExecutionComponent(
								content.name,
								content.input ?? {},
								{ showImages: host.settingsManager.getShowImages() },
								undefined,
								host.ui,
							);
							component.setExpanded(host.toolOutputExpanded);
							host.chatContainer.addChild(component);
							host.pendingTools.set(content.id, component);
						}
					} else if (content.type === "webSearchResult") {
						const component = host.pendingTools.get(content.toolUseId);
						if (component) {
							if (process.env.PI_OFFLINE === "1") {
								component.updateResult({
									content: [{ type: "text", text: "Web search disabled (offline mode)" }],
									isError: false,
								});
							} else {
								const searchContent = content.content;
								const isError = searchContent && typeof searchContent === "object" && "type" in (searchContent as any) && (searchContent as any).type === "web_search_tool_result_error";
								component.updateResult({
									content: [{ type: "text", text: host.formatWebSearchResult(searchContent) }],
									isError: !!isError,
								});
							}
						}
					}
				}
				host.ui.requestRender();
			}
			break;

		case "message_end":
			if (event.message.role === "user") break;
			if (host.streamingComponent && event.message.role === "assistant") {
				host.streamingMessage = event.message;
				let errorMessage: string | undefined;
				if (host.streamingMessage.stopReason === "aborted") {
					const retryAttempt = host.session.retryAttempt;
					errorMessage = retryAttempt > 0
						? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
						: "Operation aborted";
					host.streamingMessage.errorMessage = errorMessage;
				}
				host.streamingComponent.updateContent(host.streamingMessage);
				if (host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error") {
					if (!errorMessage) {
						errorMessage = host.streamingMessage.errorMessage || "Error";
					}
					for (const [, component] of host.pendingTools.entries()) {
						component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
					}
					host.pendingTools.clear();
				} else {
					for (const [, component] of host.pendingTools.entries()) {
						component.setArgsComplete();
					}
				}
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
				host.footer.invalidate();
			}
			host.ui.requestRender();
			break;

		case "tool_execution_start":
			if (!host.pendingTools.has(event.toolCallId)) {
				const component = new ToolExecutionComponent(
					event.toolName,
					event.args,
					{ showImages: host.settingsManager.getShowImages() },
					host.getRegisteredToolDefinition(event.toolName),
					host.ui,
				);
				component.setExpanded(host.toolOutputExpanded);
				host.chatContainer.addChild(component);
				host.pendingTools.set(event.toolCallId, component);
				host.ui.requestRender();
			}
			break;

		case "tool_execution_update": {
			const component = host.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.partialResult, isError: false }, true);
				host.ui.requestRender();
			}
			break;
		}

		case "tool_execution_end": {
			const component = host.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError });
				host.pendingTools.delete(event.toolCallId);
				host.ui.requestRender();
			}
			break;
		}

		case "agent_end":
			if (host.loadingAnimation) {
				host.loadingAnimation.stop();
				host.loadingAnimation = undefined;
				host.statusContainer.clear();
			}
			if (host.streamingComponent) {
				host.chatContainer.removeChild(host.streamingComponent);
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
			}
			host.pendingTools.clear();
			await host.checkShutdownRequested();
			host.ui.requestRender();
			break;

		case "auto_compaction_start":
			host.autoCompactionEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => host.session.abortCompaction();
			host.statusContainer.clear();
			host.autoCompactionLoader = new Loader(
				host.ui,
				(spinner) => theme.fg("accent", spinner),
				(text) => theme.fg("muted", text),
				`${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... (${appKey(host.keybindings, "interrupt")} to cancel)`,
			);
			host.statusContainer.addChild(host.autoCompactionLoader);
			host.ui.requestRender();
			break;

		case "auto_compaction_end":
			if (host.autoCompactionEscapeHandler) {
				host.defaultEditor.onEscape = host.autoCompactionEscapeHandler;
				host.autoCompactionEscapeHandler = undefined;
			}
			if (host.autoCompactionLoader) {
				host.autoCompactionLoader.stop();
				host.autoCompactionLoader = undefined;
				host.statusContainer.clear();
			}
			if (event.aborted) {
				host.showStatus("Auto-compaction cancelled");
			} else if (event.result) {
				host.chatContainer.clear();
				host.rebuildChatFromMessages();
				host.addMessageToChat({
					role: "compactionSummary",
					tokensBefore: event.result.tokensBefore,
					summary: event.result.summary,
					timestamp: Date.now(),
				});
				host.footer.invalidate();
			} else if (event.errorMessage) {
				host.chatContainer.addChild(new Spacer(1));
				host.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
			}
			void host.flushCompactionQueue({ willRetry: event.willRetry });
			host.ui.requestRender();
			break;

		case "auto_retry_start":
			host.retryEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => host.session.abortRetry();
			host.statusContainer.clear();
			host.retryLoader = new Loader(
				host.ui,
				(spinner) => theme.fg("warning", spinner),
				(text) => theme.fg("muted", text),
				`Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s... (${appKey(host.keybindings, "interrupt")} to cancel)`,
			);
			host.statusContainer.addChild(host.retryLoader);
			host.ui.requestRender();
			break;

		case "auto_retry_end":
			if (host.retryEscapeHandler) {
				host.defaultEditor.onEscape = host.retryEscapeHandler;
				host.retryEscapeHandler = undefined;
			}
			if (host.retryLoader) {
				host.retryLoader.stop();
				host.retryLoader = undefined;
				host.statusContainer.clear();
			}
			if (!event.success) {
				host.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
			host.ui.requestRender();
			break;

		case "fallback_provider_switch":
			host.showStatus(`Switched from ${event.from} → ${event.to} (${event.reason})`);
			host.ui.requestRender();
			break;

		case "fallback_provider_restored":
			host.showStatus(`Restored to ${event.provider}`);
			host.ui.requestRender();
			break;

		case "fallback_chain_exhausted":
			host.showError(event.reason);
			host.ui.requestRender();
			break;
	}
}
