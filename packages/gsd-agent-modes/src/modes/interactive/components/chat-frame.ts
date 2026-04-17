import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme } from "../../../theme.js";
import { formatTimestamp, type TimestampFormat } from "./timestamp.js";

type FrameTone = "assistant" | "user";

function trimOuterBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim().length === 0) start++;
	while (end > start && lines[end - 1].trim().length === 0) end--;
	return lines.slice(start, end);
}

export function renderChatFrame(
	contentLines: string[],
	width: number,
	opts: {
		label: string;
		tone: FrameTone;
		timestamp?: number;
		timestampFormat: TimestampFormat;
		showTimestamp?: boolean;
	},
): string[] {
	const outerWidth = Math.max(20, width);
	const contentWidth = Math.max(1, outerWidth - 2); // "│ " + content
	const borderColor = opts.tone === "user" ? "borderAccent" : "border";
	const borderMuted = opts.tone === "user" ? "borderMuted" : "borderMuted";
	const border = (s: string): string => theme.fg(borderColor, s);
	const leftRaw = `• ${opts.label}`;
	const rightRaw =
		opts.showTimestamp === false || !opts.timestamp
			? ""
			: formatTimestamp(opts.timestamp, opts.timestampFormat);

	const leftBudget = rightRaw
		? Math.max(1, outerWidth - visibleWidth(rightRaw) - 1)
		: outerWidth;
	const left = truncateToWidth(leftRaw, leftBudget, "");
	const leftStyled =
		opts.tone === "user"
			? theme.fg("accent", theme.bold(left))
			: theme.fg("muted", theme.bold(left));
	const rightStyled = rightRaw ? theme.fg("dim", rightRaw) : "";
	const gap =
		rightRaw.length > 0
			? Math.max(
					1,
					outerWidth - visibleWidth(leftStyled) - visibleWidth(rightStyled),
				)
			: Math.max(0, outerWidth - visibleWidth(leftStyled));
	const headerRow = `${leftStyled}${" ".repeat(gap)}${rightStyled}`;
	const headerPad = Math.max(0, outerWidth - visibleWidth(headerRow));

	const sourceLines = trimOuterBlankLines(contentLines);
	const bodyLines = (sourceLines.length > 0 ? sourceLines : [""]).map((line) => {
		const clipped = truncateToWidth(line, contentWidth, "");
		return border("│ ") + clipped;
	});

	return [
		theme.fg(borderMuted, "─".repeat(outerWidth)),
		headerRow + " ".repeat(headerPad),
		...bodyLines,
	];
}
