/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * When the native Rust truncation module (@gsd/native/truncate) is available,
 * byte-level truncation is delegated to it for performance. Line-limit
 * enforcement and the partial-line edge case are handled in JS on top of the
 * native result. Falls back to a pure-JS implementation when native is
 * unavailable.
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

// ── Native module loader ────────────────────────────────────────────────

interface NativeTruncateResult {
	text: string;
	truncated: boolean;
	originalLines: number;
	keptLines: number;
}

interface NativeTruncateModule {
	truncateTail: (text: string, maxBytes: number) => NativeTruncateResult;
	truncateHead: (text: string, maxBytes: number) => NativeTruncateResult;
}

let nativeModule: NativeTruncateModule | null | undefined; // undefined = not yet attempted

async function getNativeModule(): Promise<NativeTruncateModule | null> {
	if (nativeModule !== undefined) {
		return nativeModule;
	}
	try {
		// @ts-expect-error - module provided by @gsd/native when native truncate is built
		const mod = (await import("@gsd/native/truncate")) as NativeTruncateModule;
		// Verify the functions exist
		if (typeof mod.truncateTail === "function" && typeof mod.truncateHead === "function") {
			nativeModule = mod;
			return mod;
		}
		nativeModule = null;
		return null;
	} catch {
		nativeModule = null;
		return null;
	}
}

// Eagerly kick off the native load (fire-and-forget)
void getNativeModule();

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");

	// Fast path: no truncation needed (check bytes first to avoid splitting)
	if (totalBytes <= maxBytes) {
		const totalLines = countLines(content);
		if (totalLines <= maxLines) {
			return {
				content,
				truncated: false,
				truncatedBy: null,
				totalLines,
				totalBytes,
				outputLines: totalLines,
				outputBytes: totalBytes,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines,
				maxBytes,
			};
		}
	}

	// Try native byte-level truncation
	const native = nativeModule;
	if (native) {
		return truncateHeadNative(native, content, maxLines, maxBytes, totalBytes);
	}

	// JS fallback
	return truncateHeadJS(content, maxLines, maxBytes, totalBytes);
}

/**
 * Native path for truncateHead (keep beginning).
 * Native `truncateTail` keeps the first N bytes of complete lines.
 */
function truncateHeadNative(
	native: NativeTruncateModule,
	content: string,
	maxLines: number,
	maxBytes: number,
	totalBytes: number,
): TruncationResult {
	// Step 1: byte-level truncation via native
	const nResult = native.truncateTail(content, maxBytes);
	const totalLines = nResult.originalLines;

	// Handle firstLineExceedsLimit: native returns empty text with keptLines=0
	if (nResult.truncated && nResult.keptLines === 0) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	let outputContent = nResult.text;
	let outputLineCount = nResult.keptLines;
	let truncatedBy: "lines" | "bytes" | null = nResult.truncated ? "bytes" : null;

	// Step 2: apply line limit on top of the byte-truncated result
	if (outputLineCount > maxLines) {
		const lines = outputContent.split("\n");
		outputContent = lines.slice(0, maxLines).join("\n");
		outputLineCount = maxLines;
		truncatedBy = "lines";
	}

	const outputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: truncatedBy !== null,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLineCount,
		outputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Pure-JS fallback for truncateHead.
 */
function truncateHeadJS(
	content: string,
	maxLines: number,
	maxBytes: number,
	totalBytes: number,
): TruncationResult {
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Check if first line alone exceeds byte limit
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");

	// Fast path: no truncation needed
	if (totalBytes <= maxBytes) {
		const totalLines = countLines(content);
		if (totalLines <= maxLines) {
			return {
				content,
				truncated: false,
				truncatedBy: null,
				totalLines,
				totalBytes,
				outputLines: totalLines,
				outputBytes: totalBytes,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines,
				maxBytes,
			};
		}
	}

	// Try native byte-level truncation
	const native = nativeModule;
	if (native) {
		return truncateTailNative(native, content, maxLines, maxBytes, totalBytes);
	}

	// JS fallback
	return truncateTailJS(content, maxLines, maxBytes, totalBytes);
}

/**
 * Native path for truncateTail (keep end).
 * Native `truncateHead` keeps the last N bytes of complete lines.
 */
function truncateTailNative(
	native: NativeTruncateModule,
	content: string,
	maxLines: number,
	maxBytes: number,
	totalBytes: number,
): TruncationResult {
	// Step 1: byte-level truncation via native
	const nResult = native.truncateHead(content, maxBytes);
	const totalLines = nResult.originalLines;

	// Handle edge case: last line exceeds byte limit.
	// Native returns empty text — but JS truncateTail takes the partial end of the line.
	// Fall back to JS for this edge case to preserve behavior.
	if (nResult.truncated && nResult.keptLines === 0) {
		return truncateTailJS(content, maxLines, maxBytes, totalBytes);
	}

	let outputContent = nResult.text;
	let outputLineCount = nResult.keptLines;
	let truncatedBy: "lines" | "bytes" | null = nResult.truncated ? "bytes" : null;

	// Step 2: apply line limit — keep only the last maxLines lines
	if (outputLineCount > maxLines) {
		const lines = outputContent.split("\n");
		outputContent = lines.slice(lines.length - maxLines).join("\n");
		outputLineCount = maxLines;
		truncatedBy = "lines";
	}

	const outputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: truncatedBy !== null,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLineCount,
		outputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Pure-JS fallback for truncateTail.
 */
function truncateTailJS(
	content: string,
	maxLines: number,
	maxBytes: number,
	totalBytes: number,
): TruncationResult {
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Work backwards from the end
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// Start from the end, skip maxBytes back
	let start = buf.length - maxBytes;

	// Find a valid UTF-8 boundary (start of a character)
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/**
 * Count lines in a string. Matches the convention used by the native module:
 * a trailing newline does not add an extra line, empty string returns 0.
 * For compatibility with the existing JS split("\n").length behavior,
 * this returns the split count.
 */
function countLines(content: string): number {
	if (content.length === 0) return 0;
	let count = 1;
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) count++;
	}
	// split("\n") on "a\n" returns ["a", ""] which is length 2.
	// This matches that behavior.
	return count;
}

/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
