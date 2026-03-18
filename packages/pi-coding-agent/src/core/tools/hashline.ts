/**
 * Hashline edit mode — a line-addressable edit format using content-hash anchors.
 *
 * Each line in a file is identified by its 1-indexed line number and a short
 * hash derived from the normalized line text (xxHash32, truncated to 2 chars
 * from a custom nibble alphabet).
 *
 * The combined `LINE#ID` reference acts as both an address and a staleness check:
 * if the file has changed since the caller last read it, hash mismatches are caught
 * before any mutation occurs.
 *
 * Displayed format: `LINENUM#HASH:TEXT`
 * Reference format: `"LINENUM#HASH"` (e.g. `"5#QQ"`)
 *
 * Adapted from Oh My Pi's hashline implementation for Node.js (no Bun dependency).
 */

import { xxHash32 } from "@gsd/native/xxhash";

// ═══════════════════════════════════════════════════════════════════════════
// Hash Computation
// ═══════════════════════════════════════════════════════════════════════════

export type Anchor = { line: number; hash: string };
export type HashlineEdit =
	| { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] };

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

/**
 * Compute a short hash of a single line.
 *
 * Uses xxHash32 on a trailing-whitespace-trimmed, CR-stripped line, truncated to 2 chars
 * from the nibble alphabet. For lines containing no alphanumeric characters (only
 * punctuation/symbols/whitespace), the line number is mixed in to reduce hash collisions.
 */
export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, "").trimEnd();

	let seed = 0;
	if (!RE_SIGNIFICANT.test(line)) {
		seed = idx;
	}
	return DICT[xxHash32(line, seed) & 0xff];
}

/**
 * Formats a tag given the line number and text.
 */
export function formatLineTag(line: number, text: string): string {
	return `${line}#${computeLineHash(line, text)}`;
}

/**
 * Format file text with hashline prefixes for display.
 *
 * Each line becomes `LINENUM#HASH:TEXT` where LINENUM is 1-indexed.
 */
export function formatHashLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines
		.map((line, i) => {
			const num = startLine + i;
			return `${formatLineTag(num, line)}:${line}`;
		})
		.join("\n");
}

/**
 * Parse a line reference string like `"5#QQ"` into structured form.
 *
 * @throws Error if the format is invalid
 */
export function parseTag(ref: string): Anchor {
	const match = ref.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
	if (!match) {
		throw new Error(`Invalid line reference "${ref}". Expected format "LINE#ID" (e.g. "5#QQ").`);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) {
		throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	}
	return { line, hash: match[2] };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hash Mismatch Error
// ═══════════════════════════════════════════════════════════════════════════

export interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

const MISMATCH_CONTEXT = 2;

/**
 * Error thrown when one or more hashline references have stale hashes.
 * Displays grep-style output with `>>>` markers on mismatched lines,
 * showing the correct `LINE#ID` so the caller can fix all refs at once.
 */
export class HashlineMismatchError extends Error {
	readonly mismatches: HashMismatch[];
	readonly fileLines: string[];
	readonly remaps: ReadonlyMap<string, string>;
	constructor(
		mismatches: HashMismatch[],
		fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
		this.mismatches = mismatches;
		this.fileLines = fileLines;
		const remaps = new Map<string, string>();
		for (const m of mismatches) {
			const actual = computeLineHash(m.line, fileLines[m.line - 1]);
			remaps.set(`${m.line}#${m.expected}`, `${m.line}#${actual}`);
		}
		this.remaps = remaps;
	}

	static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Map<number, HashMismatch>();
		for (const m of mismatches) {
			mismatchSet.set(m.line, m);
		}

		const displayLines = new Set<number>();
		for (const m of mismatches) {
			const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
			const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
			for (let i = lo; i <= hi; i++) {
				displayLines.add(i);
			}
		}

		const sorted = [...displayLines].sort((a, b) => a - b);
		const lines: string[] = [];

		lines.push(
			`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).`,
		);
		lines.push("");

		let prevLine = -1;
		for (const lineNum of sorted) {
			if (prevLine !== -1 && lineNum > prevLine + 1) {
				lines.push("    ...");
			}
			prevLine = lineNum;

			const text = fileLines[lineNum - 1];
			const hash = computeLineHash(lineNum, text);
			const prefix = `${lineNum}#${hash}`;

			if (mismatchSet.has(lineNum)) {
				lines.push(`>>> ${prefix}:${text}`);
			} else {
				lines.push(`    ${prefix}:${text}`);
			}
		}
		return lines.join("\n");
	}
}

/**
 * Validate that a line reference points to an existing line with a matching hash.
 */
export function validateLineRef(ref: Anchor, fileLines: string[]): void {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
	const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
	if (actualHash !== ref.hash) {
		throw new HashlineMismatchError([{ line: ref.line, expected: ref.hash, actual: actualHash }], fileLines);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Prefix Stripping
// ═══════════════════════════════════════════════════════════════════════════

/** Pattern matching hashline display format prefixes: `LINE#ID:CONTENT` and `#ID:CONTENT` */
const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;

/** Pattern matching a unified-diff added-line `+` prefix (but not `++`). */
const DIFF_PLUS_RE = /^[+](?![+])/;

/**
 * Strip hashline display prefixes and diff `+` markers from replacement lines.
 *
 * Models frequently copy the `LINE#ID` prefix from read output into their
 * replacement content. This strips them heuristically before application.
 */
export function stripNewLinePrefixes(lines: string[]): string[] {
	let hashPrefixCount = 0;
	let diffPlusCount = 0;
	let nonEmpty = 0;
	for (const l of lines) {
		if (l.length === 0) continue;
		nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
		if (DIFF_PLUS_RE.test(l)) diffPlusCount++;
	}
	if (nonEmpty === 0) return lines;

	const stripHash = hashPrefixCount > 0 && hashPrefixCount === nonEmpty;
	const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;
	if (!stripHash && !stripPlus) return lines;

	return lines.map(l => {
		if (stripHash) return l.replace(HASHLINE_PREFIX_RE, "");
		if (stripPlus) return l.replace(DIFF_PLUS_RE, "");
		return l;
	});
}

/**
 * Parse edit content — handles string, array, or null input.
 * Strips hashline prefixes and diff markers from model output.
 */
export function parseHashlineText(edit: string[] | string | null): string[] {
	if (edit === null) return [];
	if (typeof edit === "string") {
		const normalizedEdit = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
		edit = normalizedEdit.replaceAll("\r", "").split("\n");
	}
	return stripNewLinePrefixes(edit);
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-correction Heuristics
// ═══════════════════════════════════════════════════════════════════════════

function maybeAutocorrectEscapedTabIndentation(edits: HashlineEdit[], warnings: string[]): void {
	for (const edit of edits) {
		if (edit.lines.length === 0) continue;
		const hasEscapedTabs = edit.lines.some(line => line.includes("\\t"));
		if (!hasEscapedTabs) continue;
		const hasRealTabs = edit.lines.some(line => line.includes("\t"));
		if (hasRealTabs) continue;
		let correctedCount = 0;
		const corrected = edit.lines.map(line =>
			line.replace(/^((?:\\t)+)/, escaped => {
				correctedCount += escaped.length / 2;
				return "\t".repeat(escaped.length / 2);
			}),
		);
		if (correctedCount === 0) continue;
		edit.lines = corrected;
		warnings.push(
			`Auto-corrected escaped tab indentation in edit: converted leading \\t sequence(s) to real tab characters`,
		);
	}
}

const MIN_AUTOCORRECT_LENGTH = 2;

function shouldAutocorrect(line: string, otherLine: string): boolean {
	if (!line || line !== otherLine) return false;
	line = line.trim();
	if (line.length < MIN_AUTOCORRECT_LENGTH) {
		return line.endsWith("}") || line.endsWith(")");
	}
	return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Edit Application
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply an array of hashline edits to file content.
 *
 * Each edit operation identifies target lines directly (`replace`,
 * `append`, `prepend`). Line references are resolved via parseTag
 * and hashes validated before any mutation.
 *
 * Edits are sorted bottom-up (highest effective line first) so earlier
 * splices don't invalidate later line numbers.
 *
 * @returns The modified content and the 1-indexed first changed line number
 */
export function applyHashlineEdits(
	text: string,
	edits: HashlineEdit[],
): {
	lines: string;
	firstChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: Array<{ editIndex: number; loc: string; current: string }>;
} {
	if (edits.length === 0) {
		return { lines: text, firstChangedLine: undefined };
	}

	const fileLines = text.split("\n");
	const originalFileLines = [...fileLines];
	let firstChangedLine: number | undefined;
	const noopEdits: Array<{ editIndex: number; loc: string; current: string }> = [];
	const warnings: string[] = [];

	// Pre-validate: collect all hash mismatches before mutating
	const mismatches: HashMismatch[] = [];
	function validateRef(ref: Anchor): boolean {
		if (ref.line < 1 || ref.line > fileLines.length) {
			throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
		}
		const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
		if (actualHash === ref.hash) {
			return true;
		}
		mismatches.push({ line: ref.line, expected: ref.hash, actual: actualHash });
		return false;
	}
	for (const edit of edits) {
		switch (edit.op) {
			case "replace": {
				if (edit.end) {
					const startValid = validateRef(edit.pos);
					const endValid = validateRef(edit.end);
					if (!startValid || !endValid) continue;
					if (edit.pos.line > edit.end.line) {
						throw new Error(`Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`);
					}
				} else {
					if (!validateRef(edit.pos)) continue;
				}
				break;
			}
			case "append": {
				if (edit.pos && !validateRef(edit.pos)) continue;
				if (edit.lines.length === 0) {
					edit.lines = [""];
				}
				break;
			}
			case "prepend": {
				if (edit.pos && !validateRef(edit.pos)) continue;
				if (edit.lines.length === 0) {
					edit.lines = [""];
				}
				break;
			}
		}
	}
	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}
	maybeAutocorrectEscapedTabIndentation(edits, warnings);

	// Deduplicate identical edits targeting the same line(s)
	const seenEditKeys = new Map<string, number>();
	const dedupIndices = new Set<number>();
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		let lineKey: string;
		switch (edit.op) {
			case "replace":
				lineKey = edit.end ? `r:${edit.pos.line}:${edit.end.line}` : `s:${edit.pos.line}`;
				break;
			case "append":
				lineKey = edit.pos ? `i:${edit.pos.line}` : "ieof";
				break;
			case "prepend":
				lineKey = edit.pos ? `ib:${edit.pos.line}` : "ibef";
				break;
		}
		const dstKey = `${lineKey}:${edit.lines.join("\n")}`;
		if (seenEditKeys.has(dstKey)) {
			dedupIndices.add(i);
		} else {
			seenEditKeys.set(dstKey, i);
		}
	}
	if (dedupIndices.size > 0) {
		for (let i = edits.length - 1; i >= 0; i--) {
			if (dedupIndices.has(i)) edits.splice(i, 1);
		}
	}

	// Compute sort key (descending) — bottom-up application
	const annotated = edits.map((edit, idx) => {
		let sortLine: number;
		let precedence: number;
		switch (edit.op) {
			case "replace":
				sortLine = edit.end ? edit.end.line : edit.pos.line;
				precedence = 0;
				break;
			case "append":
				sortLine = edit.pos ? edit.pos.line : fileLines.length + 1;
				precedence = 1;
				break;
			case "prepend":
				sortLine = edit.pos ? edit.pos.line : 0;
				precedence = 2;
				break;
		}
		return { edit, idx, sortLine, precedence };
	});

	annotated.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx);

	function trackFirstChanged(line: number): void {
		if (firstChangedLine === undefined || line < firstChangedLine) {
			firstChangedLine = line;
		}
	}

	// Apply edits bottom-up
	for (const { edit, idx } of annotated) {
		switch (edit.op) {
			case "replace": {
				if (!edit.end) {
					const origLines = originalFileLines.slice(edit.pos.line - 1, edit.pos.line);
					const newLines = edit.lines;
					if (origLines.length === newLines.length && origLines.every((line, i) => line === newLines[i])) {
						noopEdits.push({
							editIndex: idx,
							loc: `${edit.pos.line}#${edit.pos.hash}`,
							current: origLines.join("\n"),
						});
						break;
					}
					fileLines.splice(edit.pos.line - 1, 1, ...newLines);
					trackFirstChanged(edit.pos.line);
				} else {
					const count = edit.end.line - edit.pos.line + 1;
					const newLines = [...edit.lines];
					const trailingReplacementLine = newLines[newLines.length - 1]?.trimEnd();
					const nextSurvivingLine = fileLines[edit.end.line]?.trimEnd();
					if (
						shouldAutocorrect(trailingReplacementLine, nextSurvivingLine) &&
						fileLines[edit.end.line - 1]?.trimEnd() !== trailingReplacementLine
					) {
						newLines.pop();
						warnings.push(
							`Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed trailing replacement line "${trailingReplacementLine}" that duplicated next surviving line`,
						);
					}
					const leadingReplacementLine = newLines[0]?.trimEnd();
					const prevSurvivingLine = fileLines[edit.pos.line - 2]?.trimEnd();
					if (
						shouldAutocorrect(leadingReplacementLine, prevSurvivingLine) &&
						fileLines[edit.pos.line - 1]?.trimEnd() !== leadingReplacementLine
					) {
						newLines.shift();
						warnings.push(
							`Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed leading replacement line "${leadingReplacementLine}" that duplicated preceding surviving line`,
						);
					}
					fileLines.splice(edit.pos.line - 1, count, ...newLines);
					trackFirstChanged(edit.pos.line);
				}
				break;
			}
			case "append": {
				const inserted = edit.lines;
				if (inserted.length === 0) {
					noopEdits.push({
						editIndex: idx,
						loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "EOF",
						current: edit.pos ? originalFileLines[edit.pos.line - 1] : "",
					});
					break;
				}
				if (edit.pos) {
					fileLines.splice(edit.pos.line, 0, ...inserted);
					trackFirstChanged(edit.pos.line + 1);
				} else {
					if (fileLines.length === 1 && fileLines[0] === "") {
						fileLines.splice(0, 1, ...inserted);
						trackFirstChanged(1);
					} else {
						fileLines.splice(fileLines.length, 0, ...inserted);
						trackFirstChanged(fileLines.length - inserted.length + 1);
					}
				}
				break;
			}
			case "prepend": {
				const inserted = edit.lines;
				if (inserted.length === 0) {
					noopEdits.push({
						editIndex: idx,
						loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "BOF",
						current: edit.pos ? originalFileLines[edit.pos.line - 1] : "",
					});
					break;
				}
				if (edit.pos) {
					fileLines.splice(edit.pos.line - 1, 0, ...inserted);
					trackFirstChanged(edit.pos.line);
				} else {
					if (fileLines.length === 1 && fileLines[0] === "") {
						fileLines.splice(0, 1, ...inserted);
					} else {
						fileLines.splice(0, 0, ...inserted);
					}
					trackFirstChanged(1);
				}
				break;
			}
		}
	}

	return {
		lines: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
		...(noopEdits.length > 0 ? { noopEdits } : {}),
	};
}
