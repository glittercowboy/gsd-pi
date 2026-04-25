import { Container, Markdown, type MarkdownTheme } from "@gsd/pi-tui";
import { getMarkdownTheme } from "../theme/theme.js";
import { type TimestampFormat } from "./timestamp.js";
import { renderChatFrame } from "./chat-frame.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";

/**
 * Component that renders a user message with a right-aligned timestamp.
 */
export class UserMessageComponent extends Container {
	private timestamp: number | undefined;
	private timestampFormat: TimestampFormat;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), timestamp?: number, timestampFormat: TimestampFormat = "date-time-iso") {
		super();
		this.timestamp = timestamp;
		this.timestampFormat = timestampFormat;
		this.addChild(new Markdown(text, 0, 0, markdownTheme));
	}

	override render(width: number): string[] {
		const frameWidth = Math.max(20, width);
		const contentWidth = Math.max(1, frameWidth - 4);
		const lines = super.render(contentWidth);
		const framed = renderChatFrame(lines, frameWidth, {
			label: "You",
			tone: "user",
			timestamp: this.timestamp,
			timestampFormat: this.timestampFormat,
			showTimestamp: true,
		});
		if (framed.length === 0) {
			return framed;
		}
		const out = ["", ...framed];
		const firstFrameLine = 1;
		const lastFrameLine = out.length - 1;
		out[firstFrameLine] = OSC133_ZONE_START + out[firstFrameLine];
		out[lastFrameLine] = out[lastFrameLine] + OSC133_ZONE_END;
		return out;
	}
}
