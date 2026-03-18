/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 *
 * These helpers intentionally stay in JavaScript. Issue #453 showed that
 * post-tool preview paths must not depend on the native addon because a native
 * hang there can wedge the entire interactive session after a successful tool run.
 */

import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd, UNICODE_SPACES } from "./path-utils.js";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching.
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/[‐‑‒–—−]/g, "-")
		.replace(UNICODE_SPACES, " ")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n");
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 *
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const normalizedContent = normalizeForFuzzyMatch(content);
	const normalizedOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = normalizedContent.indexOf(normalizedOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: normalizedOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: normalizedContent,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * Generate a unified diff string with line numbers and context.
 *
 * Returns both the diff string and the first changed line number (in the new file).
 * Only lines within `contextLines` of a change are included (like unified diff).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const ops = buildLineDiff(oldContent, newContent);
	let firstChangedLine: number | undefined;

	// First pass: assign line numbers and find changed indices
	const annotated: { op: LineDiffOp; oldLine: number; newLine: number }[] = [];
	let oldLine = 1;
	let newLine = 1;
	const changedIndices: number[] = [];

	for (let idx = 0; idx < ops.length; idx++) {
		const op = ops[idx];
		annotated.push({ op, oldLine, newLine });

		if (op.type !== "context") {
			changedIndices.push(idx);
			if (firstChangedLine === undefined) {
				firstChangedLine = newLine;
			}
		}

		if (op.type === "remove") {
			oldLine += 1;
		} else if (op.type === "add") {
			newLine += 1;
		} else {
			oldLine += 1;
			newLine += 1;
		}
	}

	// Build set of indices to include (changes + surrounding context)
	const includeSet = new Set<number>();
	for (const ci of changedIndices) {
		for (let k = Math.max(0, ci - contextLines); k <= Math.min(ops.length - 1, ci + contextLines); k++) {
			includeSet.add(k);
		}
	}

	const maxLine = Math.max(oldLine - 1, newLine - 1, 1);
	const lineNumberWidth = String(maxLine).length;
	const rendered: string[] = [];
	let lastIncluded = -1;

	for (let idx = 0; idx < annotated.length; idx++) {
		if (!includeSet.has(idx)) continue;

		// Insert separator when there's a gap between included regions
		if (lastIncluded !== -1 && idx > lastIncluded + 1) {
			rendered.push("...");
		}
		lastIncluded = idx;

		const { op, oldLine: ol, newLine: nl } = annotated[idx];
		if (op.type === "context") {
			rendered.push(` ${String(nl).padStart(lineNumberWidth, " ")} ${op.line}`);
		} else if (op.type === "remove") {
			rendered.push(`-${String(ol).padStart(lineNumberWidth, " ")} ${op.line}`);
		} else {
			rendered.push(`+${String(nl).padStart(lineNumberWidth, " ")} ${op.line}`);
		}
	}

	return {
		diff: rendered.join("\n"),
		firstChangedLine,
	};
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

type LineDiffOp =
	| { type: "context"; line: string }
	| { type: "remove"; line: string }
	| { type: "add"; line: string };

function splitLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
}

/**
 * Maximum number of cells (oldLines * newLines) before we switch from the
 * full LCS DP algorithm to a simpler linear-scan diff. This prevents OOM
 * on large files (e.g. 10k lines would need a 100M-cell matrix).
 */
const MAX_DP_CELLS = 4_000_000; // ~32 MB for 64-bit numbers

function buildLineDiff(oldContent: string, newContent: string): LineDiffOp[] {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);

	const cells = (oldLines.length + 1) * (newLines.length + 1);
	if (cells > MAX_DP_CELLS) {
		return buildLineDiffLinear(oldLines, newLines);
	}

	return buildLineDiffLCS(oldLines, newLines);
}

/**
 * Full LCS-based diff using O(n*m) DP table. Produces optimal diffs but
 * is only safe for files where n*m <= MAX_DP_CELLS.
 */
function buildLineDiffLCS(oldLines: string[], newLines: string[]): LineDiffOp[] {
	const dp: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
		Array<number>(newLines.length + 1).fill(0),
	);

	for (let i = oldLines.length - 1; i >= 0; i--) {
		for (let j = newLines.length - 1; j >= 0; j--) {
			if (oldLines[i] === newLines[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	const ops: LineDiffOp[] = [];
	let i = 0;
	let j = 0;

	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			ops.push({ type: "context", line: oldLines[i] });
			i += 1;
			j += 1;
			continue;
		}

		if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ type: "remove", line: oldLines[i] });
			i += 1;
		} else {
			ops.push({ type: "add", line: newLines[j] });
			j += 1;
		}
	}

	while (i < oldLines.length) {
		ops.push({ type: "remove", line: oldLines[i] });
		i += 1;
	}

	while (j < newLines.length) {
		ops.push({ type: "add", line: newLines[j] });
		j += 1;
	}

	return ops;
}

/**
 * Linear-time fallback diff for large files. Matches common prefix/suffix,
 * then treats the remaining middle as a bulk remove+add. Not optimal but
 * O(n+m) in both time and space.
 */
function buildLineDiffLinear(oldLines: string[], newLines: string[]): LineDiffOp[] {
	const ops: LineDiffOp[] = [];

	// Match common prefix
	let prefixLen = 0;
	const minLen = Math.min(oldLines.length, newLines.length);
	while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
		prefixLen++;
	}

	// Match common suffix (not overlapping with prefix)
	let suffixLen = 0;
	while (
		suffixLen < minLen - prefixLen &&
		oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	// Emit prefix context
	for (let i = 0; i < prefixLen; i++) {
		ops.push({ type: "context", line: oldLines[i] });
	}

	// Emit removed lines from the middle
	for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
		ops.push({ type: "remove", line: oldLines[i] });
	}

	// Emit added lines from the middle
	for (let j = prefixLen; j < newLines.length - suffixLen; j++) {
		ops.push({ type: "add", line: newLines[j] });
	}

	// Emit suffix context
	for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
		ops.push({ type: "context", line: oldLines[i] });
	}

	return ops;
}

/**
 * Compute the diff for an edit operation without applying it.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			return { error: `File not found: ${path}` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);

		const normalizedContent = normalizeToLF(content);
		const normalizedOldText = normalizeToLF(oldText);
		const normalizedNewText = normalizeToLF(newText);

		// Find the old text using fuzzy matching (tries exact match first, then fuzzy)
		const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

		if (!matchResult.found) {
			return {
				error: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
			};
		}

		// Count occurrences using fuzzy-normalized content for consistency
		const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
		const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
		const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;

		if (occurrences > 1) {
			return {
				error: `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
			};
		}

		// Compute the new content using the matched position
		// When fuzzy matching was used, contentForReplacement is the normalized version
		const baseContent = matchResult.contentForReplacement;
		const newContent =
			baseContent.substring(0, matchResult.index) +
			normalizedNewText +
			baseContent.substring(matchResult.index + matchResult.matchLength);

		// Check if it would actually change anything
		if (baseContent === newContent) {
			return {
				error: `No changes would be made to ${path}. The replacement produces identical content.`,
			};
		}

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
