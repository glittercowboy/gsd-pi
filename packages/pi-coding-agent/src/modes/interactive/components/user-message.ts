import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@gsd/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { formatTimestamp, type TimestampFormat } from "./timestamp.js";

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
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(text, 1, 1, markdownTheme, {
				bgColor: (text: string) => theme.bg("userMessageBg", text),
				color: (text: string) => theme.fg("userMessageText", text),
			}),
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		// Insert right-aligned timestamp above the message content
		if (this.timestamp) {
			const timeStr = formatTimestamp(this.timestamp, this.timestampFormat);
			const label = theme.fg("dim", timeStr);
			const padding = Math.max(0, width - timeStr.length - 1);
			const timestampLine = " ".repeat(padding) + label;
			lines.splice(0, 0, timestampLine);
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END;
		return lines;
	}
}
