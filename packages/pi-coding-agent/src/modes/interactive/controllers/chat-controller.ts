import { Loader, Markdown, Spacer, Text } from "@gsd/pi-tui";

import type { InteractiveModeEvent, InteractiveModeStateHost } from "../interactive-mode-state.js";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import { ToolExecutionComponent } from "../components/tool-execution.js";
import { DynamicBorder } from "../components/dynamic-border.js";
import { appKey } from "../components/keybinding-hints.js";

// Tracks the last processed content index to avoid re-scanning all blocks on every message_update
let lastProcessedContentIndex = 0;

// Tracks the previous content[] length so we can detect when an adapter resets
// the assistant content array for a new provider sub-turn within one lifecycle.
let lastContentLength = 0;

// --- Segment walker state (per streaming assistant turn) ---
type RenderedSegment =
	| {
		kind: "text-run";
		startIndex: number;
		endIndex: number;
		contentType: "text" | "thinking";
		component: AssistantMessageComponent;
	}
	| { kind: "tool"; contentIndex: number; component: ToolExecutionComponent };

let renderedSegments: RenderedSegment[] = [];
// When providers reuse one assistant lifecycle across internal sub-turns,
// a content[] shrink resets renderedSegments. Keep the displaced segments so
// claude-code MCP pruning can remove stale provisional text later.
let orphanedSegments: RenderedSegment[] = [];

function hasVisibleAssistantContent(message: { content: Array<any> }): boolean {
	return message.content.some(
		(c) =>
			(c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0)
			|| (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim().length > 0),
	);
}

function hasAssistantToolBlocks(message: { content: Array<any> }): boolean {
	return message.content.some((c) => c.type === "toolCall" || c.type === "serverToolUse");
}

// Pinnable text candidates: non-empty text blocks that appear strictly before
// the most recent tool call, returned newest-first. Text blocks after the last
// tool call are still streaming live into the chat container.
export function findLatestPinnableCandidates(
	contentBlocks: Array<any>,
): Array<{ text: string; contentIndex: number }> {
	let lastToolIdx = -1;
	for (let i = contentBlocks.length - 1; i >= 0; i--) {
		const c = contentBlocks[i];
		if (c?.type === "toolCall" || c?.type === "serverToolUse") {
			lastToolIdx = i;
			break;
		}
	}
	const out: Array<{ text: string; contentIndex: number }> = [];
	for (let i = lastToolIdx - 1; i >= 0; i--) {
		const c = contentBlocks[i];
		if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
			out.push({ text: c.text.trim(), contentIndex: i });
		}
	}
	return out;
}

export function findLatestPinnableText(contentBlocks: Array<any>): string {
	return findLatestPinnableCandidates(contentBlocks)[0]?.text ?? "";
}

// Sum rendered line counts of segments that appear strictly after the given
// content-block index. Used to decide whether a pinnable text block has
// scrolled out of the viewport and therefore warrants mirroring.
function rowsRenderedAfterContentIndex(contentIndex: number, width: number): number {
	let rows = 0;
	for (const seg of renderedSegments) {
		try {
			if (seg.kind === "text-run" && seg.startIndex > contentIndex) {
				rows += seg.component.render(width).length;
			} else if (seg.kind === "tool" && seg.contentIndex > contentIndex) {
				rows += seg.component.render(width).length;
			}
		} catch {
			// Defensive: a component that throws during measurement shouldn't
			// destabilize pinned-zone logic. Skip it.
		}
	}
	return rows;
}

// Tracks the latest assistant text for the pinned message zone
let lastPinnedText = "";
// Whether any tool execution has been added in this assistant turn (triggers pinned display)
let hasToolsInTurn = false;
// Reference to the pinned border so we can toggle its label between working/idle
let pinnedBorder: DynamicBorder | undefined;
// Reference to the pinned markdown component below the border
let pinnedTextComponent: Markdown | undefined;

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
	const timestampFormat = host.settingsManager.getTimestampFormat();

	// Reset content index tracker and pinned state when a new assistant message starts
	if (event.type === "message_start" && event.message.role === "assistant") {
		lastProcessedContentIndex = 0;
		lastContentLength = 0;
		lastPinnedText = "";
		hasToolsInTurn = false;
		renderedSegments = [];
		orphanedSegments = [];
		if (pinnedBorder) pinnedBorder.stopSpinner();
		pinnedBorder = undefined;
		pinnedTextComponent = undefined;
		host.pinnedMessageContainer.clear();
	}

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
					host.pinnedMessageContainer.clear();
					lastPinnedText = "";
					hasToolsInTurn = false;
					renderedSegments = [];
					orphanedSegments = [];
					lastContentLength = 0;
					if (pinnedBorder) pinnedBorder.stopSpinner();
					pinnedBorder = undefined;
					pinnedTextComponent = undefined;
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
				host.streamingMessage = event.message;
				// External-tool providers can stream multiple assistant turns through
				// one response. Delay component creation until visible assistant text
				// arrives so tool outputs keep chronological ordering.
				host.ui.requestRender();
			}
			break;

		case "message_update":
			if (event.message.role === "assistant") {
				host.streamingMessage = event.message;
				const innerEvent = event.assistantMessageEvent;

				let externalToolResult:
					| { toolCallId: string; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: Record<string, unknown>; isError: boolean }
					| undefined;
				if (innerEvent.type === "toolcall_end" && innerEvent.toolCall) {
					const tc = innerEvent.toolCall as any;
					const ext = tc.externalResult;
					if (ext) {
						externalToolResult = {
							toolCallId: tc.id,
							content: ext.content ?? [{ type: "text", text: "" }],
							details: ext.details ?? {},
							isError: ext.isError ?? false,
						};
					}
				} else if (innerEvent.type === "server_tool_use") {
					const idx = typeof innerEvent.contentIndex === "number" ? innerEvent.contentIndex : -1;
					const block = idx >= 0 ? (host.streamingMessage.content[idx] as any) : undefined;
					const ext = block?.externalResult;
					if (block?.id && ext) {
						externalToolResult = {
							toolCallId: block.id,
							content: ext.content ?? [{ type: "text", text: "" }],
							details: ext.details ?? {},
							isError: ext.isError ?? false,
						};
					}
				}

				const contentBlocks = host.streamingMessage.content;
				// Some adapters (notably claude-code) reuse a single assistant
				// lifecycle while internally spanning multiple provider sub-turns.
				// When a new sub-turn starts, content[] length shrinks back to 0/1.
				// The scan loop needs its index reset, AND the segment walker's
				// renderedSegments map must be cleared so existing text-run
				// components don't get overwritten in place with new sub-turn
				// content (#4144 regression). Prior sub-turn children stay in
				// chatContainer as frozen history; new segments append after them.
				if (contentBlocks.length < lastContentLength) {
					// Accumulate across successive shrinks — overwriting would drop
					// segments displaced by an earlier shrink, leaving them stranded
					// in chatContainer once the prune pass finally runs.
					orphanedSegments = [...orphanedSegments, ...renderedSegments];
					renderedSegments = [];
					lastPinnedText = "";
					lastProcessedContentIndex = 0;
				} else if (lastProcessedContentIndex >= contentBlocks.length) {
					lastProcessedContentIndex = 0;
				}
				lastContentLength = contentBlocks.length;
				for (let i = lastProcessedContentIndex; i < contentBlocks.length; i++) {
					const content = contentBlocks[i];
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

				// When the stream adapter signals a completed tool call with an
				// external result (from Claude Code SDK), update the pending
				// ToolExecutionComponent immediately so output is visible in
				// real-time instead of waiting for the session to end.
				if (externalToolResult) {
					const component = host.pendingTools.get(externalToolResult.toolCallId);
					if (component) {
						component.updateResult({
							content: externalToolResult.content,
							details: externalToolResult.details,
							isError: externalToolResult.isError,
						});
					}
				}

				// Segment walker: render content blocks in stream order, append-only.
				// Build desired segment plan from content[].
				{
					const blocks = host.streamingMessage.content;
					const isClaudeCodeProvider = host.streamingMessage.provider === "claude-code";
					const hasMcpToolBlock = blocks.some((b: any) => {
						if (b?.type === "toolCall") {
							return typeof b?.mcpServer === "string" || String(b?.name ?? "").startsWith("mcp__");
						}
						if (b?.type === "serverToolUse") {
							return typeof b?.mcpServer === "string" || String(b?.name ?? "").startsWith("mcp__");
						}
						return false;
					});
					const firstToolIdx = blocks.findIndex((b: any) => b.type === "toolCall" || b.type === "serverToolUse");
					const hasPostToolText = firstToolIdx >= 0
						&& blocks.some(
							(b: any, idx: number) => (
								idx > firstToolIdx
								&& b?.type === "text"
								&& typeof b?.text === "string"
								&& b.text.trim().length > 0
							),
						);
					// Only prune provisional pre-tool prose after post-tool prose exists,
					// so MCP tool-only windows do not blank the assistant content.
					const shouldDropPreToolProse = isClaudeCodeProvider && hasMcpToolBlock && hasPostToolText;
					type DesiredSegment =
						| { kind: "text-run"; startIndex: number; endIndex: number; contentType: "text" | "thinking" }
						| { kind: "tool"; contentIndex: number; toolId: string };
				const desired: DesiredSegment[] = [];
				let runStart = -1;
				let runEnd = -1;
				let runType: "text" | "thinking" | undefined;
				const closeRun = () => {
					if (runStart !== -1 && runType) {
						desired.push({ kind: "text-run", startIndex: runStart, endIndex: runEnd, contentType: runType });
						runStart = -1;
						runEnd = -1;
						runType = undefined;
						}
					};
				for (let i = 0; i < blocks.length; i++) {
					const b = blocks[i];
					const blockType = b.type === "text" || b.type === "thinking" ? b.type : undefined;
					const isTextLike = blockType === "text" || blockType === "thinking";
					const isTool = b.type === "toolCall" || b.type === "serverToolUse";
					// For Claude Code MCP turns, prune only pre-tool prose, never thinking.
					const textValue = blockType === "text" && typeof b?.text === "string" ? b.text : "";
					const isLikelyQuestion = blockType === "text" && typeof textValue === "string" && /\?\s*$/.test(textValue.trim());
					const shouldSkipProse = shouldDropPreToolProse
						&& firstToolIdx >= 0
						&& i < firstToolIdx
						&& blockType === "text"
						&& !isLikelyQuestion;
					if (shouldSkipProse) {
						closeRun();
						continue;
					}
						if (isTextLike) {
							if (runStart === -1) {
								runStart = i;
								runEnd = i;
								runType = blockType;
							} else if (runType !== blockType) {
								closeRun();
								runStart = i;
								runEnd = i;
								runType = blockType;
							} else {
								runEnd = i;
							}
						} else {
							closeRun();
							if (isTool) {
								desired.push({ kind: "tool", contentIndex: i, toolId: b.id });
							}
						}
					}
					closeRun();

					// Claude Code MCP can emit provisional pre-tool prose that gets
					// superseded by post-tool output. Prune stale text-run segments so
					// the final assistant output remains below tool output.
					if (shouldDropPreToolProse && firstToolIdx >= 0) {
						if (orphanedSegments.length > 0) {
							const remainingOrphans: RenderedSegment[] = [];
							for (const orphan of orphanedSegments) {
								if (orphan.kind === "text-run" && orphan.contentType === "text") {
									host.chatContainer.removeChild(orphan.component);
									if (host.streamingComponent === orphan.component) {
										host.streamingComponent = undefined;
									}
									continue;
								}
								remainingOrphans.push(orphan);
							}
							orphanedSegments = remainingOrphans;
						}
						const desiredTextKeys = new Set(
							desired
								.filter((seg): seg is Extract<DesiredSegment, { kind: "text-run" }> => seg.kind === "text-run")
								.map((seg) => `${seg.contentType}:${seg.startIndex}`),
						);
						const desiredToolIndices = new Set(
							desired
								.filter((seg): seg is Extract<DesiredSegment, { kind: "tool" }> => seg.kind === "tool")
								.map((seg) => seg.contentIndex),
						);
						const nextRendered: RenderedSegment[] = [];
						for (const seg of renderedSegments) {
							if (
								seg.kind === "text-run"
								&& seg.contentType === "text"
								&& !desiredTextKeys.has(`${seg.contentType}:${seg.startIndex}`)
							) {
								host.chatContainer.removeChild(seg.component);
								if (host.streamingComponent === seg.component) {
									host.streamingComponent = undefined;
								}
								continue;
							}
							if (seg.kind === "tool" && !desiredToolIndices.has(seg.contentIndex)) {
								continue;
							}
							nextRendered.push(seg);
						}
						renderedSegments = nextRendered;
					}

					// Append any newly needed segments (never reorder existing ones).
					for (const seg of desired) {
						if (seg.kind === "tool") {
							// Tool segments are already handled above via pendingTools; just
							// register them in renderedSegments if not yet tracked.
							const existing = renderedSegments.find(
								(s) => s.kind === "tool" && s.contentIndex === seg.contentIndex,
							);
							if (!existing) {
								const comp = host.pendingTools.get(seg.toolId);
								if (comp) {
									renderedSegments.push({ kind: "tool", contentIndex: seg.contentIndex, component: comp });
								}
							}
						} else {
							// text-run segment
							const existing = renderedSegments.find(
								(s) => s.kind === "text-run" && s.startIndex === seg.startIndex && s.contentType === seg.contentType,
							);
							if (!existing) {
								const comp = new AssistantMessageComponent(
									undefined,
									host.hideThinkingBlock,
									host.getMarkdownThemeWithSettings(),
									timestampFormat,
									{ startIndex: seg.startIndex, endIndex: seg.endIndex },
								);
								host.chatContainer.addChild(comp);
								renderedSegments.push({
									kind: "text-run",
									startIndex: seg.startIndex,
									endIndex: seg.endIndex,
									contentType: seg.contentType,
									component: comp,
								});
								host.streamingComponent = comp;
							}
						}
					}

					// Update all trailing text-run segments with the latest message so
					// streaming text grows in place.
					for (const seg of renderedSegments) {
						if (seg.kind === "text-run") {
							// Find corresponding desired segment to get current endIndex
							const d = desired.find(
								(ds) => ds.kind === "text-run" && ds.startIndex === seg.startIndex && ds.contentType === seg.contentType,
							);
							if (d && d.kind === "text-run" && d.endIndex !== seg.endIndex) {
								seg.endIndex = d.endIndex;
								seg.component.setRange({ startIndex: seg.startIndex, endIndex: seg.endIndex });
							}
							seg.component.updateContent(host.streamingMessage);
						}
					}

					// Keep streamingComponent pointing at the last text-run for message_end compatibility.
					const lastTextSeg = [...renderedSegments].reverse().find((s) => s.kind === "text-run");
					if (lastTextSeg && lastTextSeg.kind === "text-run") {
						host.streamingComponent = lastTextSeg.component;
					}
				}

				// Update index: fully processed blocks won't need re-scanning.
				// Keep the last block's index (it may still be accumulating data),
				// so we re-check it next time but skip all earlier ones.
				if (contentBlocks.length > 0) {
					lastProcessedContentIndex = Math.max(0, contentBlocks.length - 1);
				}

				// Pinned message: mirror the latest assistant text above the editor
				// when tool executions push it out of the viewport.
				const hasTools = contentBlocks.some(
					(c: any) => c.type === "toolCall" || c.type === "serverToolUse",
				);
				if (hasTools) hasToolsInTurn = true;

				if (hasToolsInTurn) {
					const candidates = findLatestPinnableCandidates(contentBlocks);
					const termRows = host.ui.terminal.rows;
					const termCols = host.ui.terminal.columns;
					const pinnedMax = Math.max(3, Math.floor(termRows * 0.4));
					// Reserve rows for pinned zone + its border + editor + footer chrome.
					// Anything below this row budget is still in the viewport.
					const offscreenThreshold = Math.max(1, termRows - pinnedMax - 8);

					// Walk candidates newest→oldest; pick the first whose following
					// segments have pushed enough rows to scroll it off-screen.
					let picked: { text: string; contentIndex: number } | undefined;
					for (const c of candidates) {
						if (rowsRenderedAfterContentIndex(c.contentIndex, termCols) >= offscreenThreshold) {
							picked = c;
							break;
						}
					}

					if (picked) {
						if (picked.text !== lastPinnedText) {
							lastPinnedText = picked.text;

							if (!pinnedBorder) {
								// First time: create border + text component
								host.pinnedMessageContainer.clear();
								pinnedBorder = new DynamicBorder(
									(str: string) => theme.fg("dim", str),
									"Working · Latest Output",
								);
								pinnedBorder.startSpinner(host.ui, (str: string) => theme.fg("accent", str));
								host.pinnedMessageContainer.addChild(pinnedBorder);
								pinnedTextComponent = new Markdown(picked.text, 1, 0, host.getMarkdownThemeWithSettings());
								// Cap pinned content to ~40% of terminal height so tall output
								// doesn't exceed the viewport and cause render flashing.
								pinnedTextComponent.maxLines = pinnedMax;
								host.pinnedMessageContainer.addChild(pinnedTextComponent);
								// Hide the separate status loader — the pinned zone replaces it
								if (host.loadingAnimation) {
									host.loadingAnimation.stop();
									host.loadingAnimation = undefined;
								}
								host.statusContainer.clear();
							} else {
								// Update existing markdown component in-place
								pinnedTextComponent?.setText(picked.text);
								// Refresh maxLines in case terminal was resized
								if (pinnedTextComponent) {
									pinnedTextComponent.maxLines = pinnedMax;
								}
							}
						}
					} else if (pinnedBorder) {
						// Every candidate is still visible in the chat scrollback —
						// tear down the pinned zone so we don't duplicate on-screen text.
						pinnedBorder.stopSpinner();
						pinnedBorder = undefined;
						pinnedTextComponent = undefined;
						host.pinnedMessageContainer.clear();
						lastPinnedText = "";
					}
				}

				host.ui.requestRender();
			}
			break;

			case "message_end":
				if (event.message.role === "user") break;
				if (event.message.role === "assistant") {
					host.streamingMessage = event.message;
					let errorMessage: string | undefined;
				if (host.streamingMessage.stopReason === "aborted") {
					const retryAttempt = host.session.retryAttempt;
					errorMessage = retryAttempt > 0
						? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
						: "Operation aborted";
					host.streamingMessage.errorMessage = errorMessage;
				}

					const shouldRenderAssistant = hasVisibleAssistantContent(host.streamingMessage)
						|| (
							(host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error")
							&& !hasAssistantToolBlocks(host.streamingMessage)
						);

					// The final message_end payload can contain additional text/thinking
					// blocks that never arrived via message_update (e.g. SDK result
					// aggregation). Rebuild this in-flight turn from final content so
					// ranges/components don't keep stale partial indices.
					if (renderedSegments.length > 0) {
						const finalBlocks = host.streamingMessage.content;
						type DesiredSegment =
							| { kind: "text-run"; startIndex: number; endIndex: number; contentType: "text" | "thinking" }
							| { kind: "tool"; contentIndex: number; toolId: string };
						const desired: DesiredSegment[] = [];
						let runStart = -1;
						let runEnd = -1;
						let runType: "text" | "thinking" | undefined;
						const closeRun = () => {
							if (runStart !== -1 && runType) {
								desired.push({ kind: "text-run", startIndex: runStart, endIndex: runEnd, contentType: runType });
								runStart = -1;
								runEnd = -1;
								runType = undefined;
							}
						};

						for (let i = 0; i < finalBlocks.length; i++) {
							const block = finalBlocks[i] as any;
							const blockType = block?.type === "text" || block?.type === "thinking" ? block.type : undefined;
							const isTextLike = blockType === "text" || blockType === "thinking";
							const isTool = block?.type === "toolCall" || block?.type === "serverToolUse";

							if (isTextLike) {
								if (runStart === -1) {
									runStart = i;
									runEnd = i;
									runType = blockType;
								} else if (runType !== blockType) {
									closeRun();
									runStart = i;
									runEnd = i;
									runType = blockType;
								} else {
									runEnd = i;
								}
							} else {
								closeRun();
								if (isTool) {
									desired.push({ kind: "tool", contentIndex: i, toolId: block.id });
								}
							}
						}
						closeRun();

						const toolComponentsById = new Map<string, ToolExecutionComponent>();
						for (const [toolId, component] of host.pendingTools.entries()) {
							toolComponentsById.set(toolId, component);
						}

						for (const seg of renderedSegments) {
							host.chatContainer.removeChild(seg.component);
							if (seg.kind === "tool") {
								const priorBlocks = host.streamingMessage.content;
								const priorBlock = priorBlocks[seg.contentIndex] as any;
								if (priorBlock?.id && !toolComponentsById.has(priorBlock.id)) {
									toolComponentsById.set(priorBlock.id, seg.component);
								}
							}
						}
						renderedSegments = [];
						host.streamingComponent = undefined;

						for (const seg of desired) {
							if (seg.kind === "tool") {
								const finalBlock = finalBlocks[seg.contentIndex] as any;
								let component = toolComponentsById.get(seg.toolId);
								if (!component && finalBlock?.id) {
									component = host.pendingTools.get(finalBlock.id);
								}
								if (!component && finalBlock?.type === "toolCall") {
									component = new ToolExecutionComponent(
										finalBlock.name,
										finalBlock.arguments,
										{ showImages: host.settingsManager.getShowImages() },
										host.getRegisteredToolDefinition(finalBlock.name),
										host.ui,
									);
									component.setExpanded(host.toolOutputExpanded);
									host.pendingTools.set(finalBlock.id, component);
									toolComponentsById.set(finalBlock.id, component);
								} else if (!component && finalBlock?.type === "serverToolUse") {
									component = new ToolExecutionComponent(
										finalBlock.name,
										finalBlock.input ?? {},
										{ showImages: host.settingsManager.getShowImages() },
										undefined,
										host.ui,
									);
									component.setExpanded(host.toolOutputExpanded);
									host.pendingTools.set(finalBlock.id, component);
									toolComponentsById.set(finalBlock.id, component);
								}
								if (component) {
									host.chatContainer.addChild(component);
									renderedSegments.push({ kind: "tool", contentIndex: seg.contentIndex, component });
								}
								continue;
							}

							const comp = new AssistantMessageComponent(
								undefined,
								host.hideThinkingBlock,
								host.getMarkdownThemeWithSettings(),
								timestampFormat,
								{ startIndex: seg.startIndex, endIndex: seg.endIndex },
							);
							comp.updateContent(host.streamingMessage);
							host.chatContainer.addChild(comp);
							renderedSegments.push({
								kind: "text-run",
								startIndex: seg.startIndex,
								endIndex: seg.endIndex,
								contentType: seg.contentType,
								component: comp,
							});
							host.streamingComponent = comp;
						}
					}

					if (!host.streamingComponent && shouldRenderAssistant) {
						host.streamingComponent = new AssistantMessageComponent(
							undefined,
							host.hideThinkingBlock,
							host.getMarkdownThemeWithSettings(),
							timestampFormat,
						);
					host.chatContainer.addChild(host.streamingComponent);
				}
				if (host.streamingComponent) {
					host.streamingComponent.setShowMetadata(true);
					host.streamingComponent.updateContent(host.streamingMessage);
				}

				if (host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error") {
					if (!errorMessage) {
						errorMessage = host.streamingMessage.errorMessage || "Error";
					}
					const pendingComponents = Array.from(host.pendingTools.values());
					if (pendingComponents.length > 0) {
						const [first, ...rest] = pendingComponents;
						first.completeWithError(errorMessage);
						for (const component of rest) {
							component.completeWithError();
						}
					}
					host.pendingTools.clear();
				} else {
					for (const [, component] of host.pendingTools.entries()) {
						component.setArgsComplete();
					}
				}
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
				renderedSegments = [];
				orphanedSegments = [];
				lastContentLength = 0;
				// Clear pinned output once the message is finalized in the chat
				// container — prevents duplicate display when the agent continues
				// (e.g. form elicitation) after the assistant message ends.
				if (pinnedBorder) pinnedBorder.stopSpinner();
				host.pinnedMessageContainer.clear();
				lastPinnedText = "";
				hasToolsInTurn = false;
				pinnedBorder = undefined;
				pinnedTextComponent = undefined;
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
			if (host.streamingComponent && host.streamingMessage) {
				host.streamingComponent.setShowMetadata(true);
				host.streamingComponent.updateContent(host.streamingMessage);
			}
			host.streamingComponent = undefined;
			host.streamingMessage = undefined;
			renderedSegments = [];
			orphanedSegments = [];
			lastContentLength = 0;
			host.pendingTools.clear();
			// Pinned output is only useful while work is actively streaming.
			// Keep chat history as the single source after completion.
			if (pinnedBorder) {
				pinnedBorder.stopSpinner();
			}
			host.pinnedMessageContainer.clear();
			lastPinnedText = "";
			hasToolsInTurn = false;
			pinnedBorder = undefined;
			pinnedTextComponent = undefined;
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

		case "image_overflow_recovery":
			host.showStatus(
				`Removed ${event.strippedCount} older image(s) to comply with API limits. Retrying...`,
			);
			host.ui.requestRender();
			break;
	}
}
