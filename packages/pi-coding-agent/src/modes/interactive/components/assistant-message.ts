import type { AssistantMessage } from "@gsd/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@gsd/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { type TimestampFormat } from "./timestamp.js";
import { renderChatFrame } from "./chat-frame.js";

export interface ContentRange {
	startIndex: number;
	endIndex: number;
}

/**
 * Component that renders a complete assistant message, or a sub-range of its content[].
 * When `range` is provided, only content[startIndex..endIndex] (inclusive) is rendered.
 * Non-text/thinking blocks within the range are silently skipped.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;
	private timestampFormat: TimestampFormat;
	private range?: ContentRange;
	private showMetadata: boolean;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		timestampFormat: TimestampFormat = "date-time-iso",
		range?: ContentRange,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.timestampFormat = timestampFormat;
		this.range = range;
		// No range = legacy full-message rendering; show metadata by default.
		// Ranged (interleaved) instances start with metadata hidden; chat-controller
		// calls setShowMetadata(true) on the last segment at message_end.
		this.showMetadata = !range;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	setRange(range: ContentRange | undefined): void {
		this.range = range;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setShowMetadata(show: boolean): void {
		this.showMetadata = show;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const start = this.range?.startIndex ?? 0;
		const end = this.range?.endIndex ?? message.content.length - 1;
		const slice = message.content.slice(start, end + 1);

		const hasVisibleContent = slice.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);
		const hasTextContent = message.content.some((c) => c.type === "text" && c.text.trim().length > 0);
		const hasToolContent = message.content.some((c) => c.type === "toolCall" || c.type === "serverToolUse");
		// Claude Code often emits long reasoning blocks ahead of user-visible text/tool
		// output in the same lifecycle. Keep chat output visible without requiring a
		// manual thinking toggle every turn.
		const shouldCapThinking = hasTextContent || hasToolContent || message.provider === "claude-code";

		// Render content in order; non-text/thinking blocks are silently skipped
		for (let i = 0; i < slice.length; i++) {
			const content = slice[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = slice
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					this.contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0));
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					const thinkingMarkdown = new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					});
					// Keep visible chat output readable when thinking traces are long.
					// Tool-bearing turns can stream text in a later assistant message.
					if (shouldCapThinking) {
						thinkingMarkdown.maxLines = 8;
					}
					this.contentContainer.addChild(thinkingMarkdown);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Metadata (errors, timestamp): gated on showMetadata so ranged instances stay clean
		// until chat-controller explicitly enables it on the last segment at message_end.
		if (this.showMetadata) {
			// Check if aborted - show after partial content
			// But only if there are no tool calls (tool execution components will show the error)
			const hasToolCalls = message.content.some((c) => c.type === "toolCall");
			if (!hasToolCalls) {
				if (message.stopReason === "aborted") {
					const abortMessage =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Operation aborted";
					if (hasVisibleContent) {
						this.contentContainer.addChild(new Spacer(1));
					}
					this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
				} else if (message.stopReason === "error") {
					const errorMsg = message.errorMessage || "Unknown error";
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
				}
			}

		}
	}

	override render(width: number): string[] {
		const frameWidth = Math.max(20, width);
		const contentWidth = Math.max(1, frameWidth - 4);
		const lines = super.render(contentWidth);
		const headerLabel = this.lastMessage?.model ? `GSD - ${this.lastMessage.model}` : "GSD";
		const framed = renderChatFrame(lines, frameWidth, {
			label: headerLabel,
			tone: "assistant",
			timestamp: this.lastMessage?.timestamp,
			timestampFormat: this.timestampFormat,
			showTimestamp: this.showMetadata,
		});
		if (framed.length === 0) {
			return framed;
		}
		return ["", ...framed];
	}
}
