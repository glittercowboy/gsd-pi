// GSD / pi-coding-agent — Skill invocation message component
import { Container, Markdown, type MarkdownTheme, Text } from "@gsd/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { renderChatFrame } from "./chat-frame.js";
import { editorKey } from "./keybinding-hints.js";

/**
 * Renders a skill invocation in the shared chat-frame style (top rule,
 * `• skill - <name>` header, `│ ` body margin) with purple border/label
 * matching compaction so it visually aligns with user/assistant messages.
 */
export class SkillInvocationMessageComponent extends Container {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.skillBlock = skillBlock;
		this.markdownTheme = markdownTheme;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();

		if (this.expanded) {
			this.addChild(
				new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("dim", `(${editorKey("expandTools")} to expand)`),
					0,
					0,
				),
			);
		}
	}

	override render(width: number): string[] {
		const frameWidth = Math.max(20, width);
		const contentWidth = Math.max(1, frameWidth - 4);
		const lines = super.render(contentWidth);
		const framed = renderChatFrame(lines, frameWidth, {
			label: `skill - ${this.skillBlock.name}`,
			tone: "skill",
			timestampFormat: "date-time-iso",
			showTimestamp: false,
		});
		return framed.length > 0 ? ["", ...framed] : framed;
	}
}
