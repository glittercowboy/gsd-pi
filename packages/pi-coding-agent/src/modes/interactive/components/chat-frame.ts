import { truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme } from "../theme/theme.js";
import { formatTimestamp, type TimestampFormat } from "./timestamp.js";

type FrameTone = "assistant" | "user" | "compaction" | "skill";

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
	const isPurple = opts.tone === "compaction" || opts.tone === "skill";
	const borderColor =
		opts.tone === "user"
			? "border"
			: isPurple
				? "customMessageLabel"
				: "borderAccent";
	const borderMuted = isPurple ? "customMessageLabel" : "borderMuted";
	const border = (s: string) => theme.fg(borderColor, s);
	const leftRaw = `• ${opts.label}`;
	const rightRaw =
		opts.showTimestamp === false || !opts.timestamp
			? ""
			: formatTimestamp(opts.timestamp, opts.timestampFormat);

	const leftBudget = rightRaw
		? Math.max(1, outerWidth - visibleWidth(rightRaw) - 1)
		: outerWidth;
	const left = truncateToWidth(leftRaw, leftBudget, "");
	const labelColor =
		opts.tone === "user"
			? "border"
			: isPurple
				? "customMessageLabel"
				: "borderAccent";
	const dashIdx = left.indexOf(" - ");
	const leftStyled =
		dashIdx >= 0
			? theme.fg(labelColor, theme.bold(left.slice(0, dashIdx))) +
				theme.fg("dim", left.slice(dashIdx))
			: theme.fg(labelColor, theme.bold(left));
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
	const bodyColor =
		opts.tone === "user"
			? "userMessageText"
			: isPurple
				? "customMessageText"
				: "assistantMessageText";
	const bodyLines = (sourceLines.length > 0 ? sourceLines : [""]).map((line) => {
		const clipped = truncateToWidth(line, contentWidth, "");
		return border("│ ") + theme.fg(bodyColor, clipped);
	});

	return [
		theme.fg(borderMuted, "─".repeat(outerWidth)),
		headerRow + " ".repeat(headerPad),
		...bodyLines,
	];
}
