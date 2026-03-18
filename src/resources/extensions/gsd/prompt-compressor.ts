/**
 * Prompt Compressor — deterministic text compression for context reduction.
 *
 * Applies a series of lossless and near-lossless transformations to reduce
 * token count while preserving semantic meaning. No LLM calls, no external
 * dependencies. Sub-millisecond for typical prompt sizes.
 *
 * Compression techniques (applied in order):
 * 1. Redundant whitespace normalization
 * 2. Markdown formatting reduction (collapse verbose tables, lists)
 * 3. Common phrase abbreviation
 * 4. Repeated pattern deduplication
 * 5. Low-information content removal (empty sections, boilerplate)
 */

export type CompressionLevel = "light" | "moderate" | "aggressive";

export interface CompressionResult {
	/** The compressed content */
	content: string;
	/** Original character count */
	originalChars: number;
	/** Compressed character count */
	compressedChars: number;
	/** Savings percentage (0-100) */
	savingsPercent: number;
	/** Which compression level was applied */
	level: CompressionLevel;
	/** Number of transformations applied */
	transformationsApplied: number;
}

export interface CompressionOptions {
	/** Compression intensity. Default: "moderate" */
	level?: CompressionLevel;
	/** Preserve markdown headings (useful for section-boundary truncation). Default: true */
	preserveHeadings?: boolean;
	/** Preserve code blocks verbatim. Default: true */
	preserveCodeBlocks?: boolean;
	/** Target character count (compression stops when achieved). Default: no target */
	targetChars?: number;
}

// ─── Phrase Abbreviation Map ────────────────────────────────────────────────

/**
 * Build a regex that matches a verbose phrase even when split across lines.
 * Whitespace between words is matched with \s+ to handle line wrapping.
 */
function phraseRegex(phrase: string): RegExp {
	const words = phrase.split(/\s+/);
	const pattern = `\\b${words.join("\\s+")}\\b`;
	return new RegExp(pattern, "gi");
}

const VERBOSE_PHRASES: Array<[RegExp, string]> = [
	[phraseRegex("In order to"), "To"],
	[phraseRegex("It is important to note that"), "Note:"],
	[phraseRegex("As mentioned previously"), "(see above)"],
	[phraseRegex("The following"), "These"],
	[phraseRegex("In addition to"), "Also,"],
	[phraseRegex("Due to the fact that"), "Because"],
	[phraseRegex("At this point in time"), "Now"],
	[phraseRegex("For the purpose of"), "For"],
	[phraseRegex("In the event that"), "If"],
	[phraseRegex("With regard to"), "Re:"],
	[phraseRegex("Prior to"), "Before"],
	[phraseRegex("Subsequent to"), "After"],
	[phraseRegex("In accordance with"), "Per"],
	[phraseRegex("A number of"), "Several"],
	[phraseRegex("In the case of"), "For"],
	[phraseRegex("On the basis of"), "Based on"],
];

// ─── Code Block Extraction ──────────────────────────────────────────────────

interface ExtractedBlocks {
	text: string;
	blocks: Map<string, string>;
}

function extractCodeBlocks(content: string): ExtractedBlocks {
	const blocks = new Map<string, string>();
	let counter = 0;

	const text = content.replace(/```[\s\S]*?```/g, (match) => {
		const placeholder = `\x00CODEBLOCK_${counter++}\x00`;
		blocks.set(placeholder, match);
		return placeholder;
	});

	return { text, blocks };
}

function restoreCodeBlocks(text: string, blocks: Map<string, string>): string {
	let result = text;
	for (const [placeholder, block] of blocks) {
		result = result.replace(placeholder, block);
	}
	return result;
}

// ─── Light Transformations ──────────────────────────────────────────────────

function normalizeWhitespace(content: string): string {
	// Collapse 3+ consecutive blank lines to 2
	let result = content.replace(/(\n\s*){3,}\n/g, "\n\n");
	// Trim trailing whitespace on every line
	result = result.replace(/[ \t]+$/gm, "");
	return result;
}

function removeMarkdownComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

function removeHorizontalRules(content: string): string {
	// Remove horizontal rules (---, ***, ___) that stand alone on a line
	return content.replace(/^\s*[-*_]{3,}\s*$/gm, "");
}

function collapseEmptyListItems(content: string): string {
	// Collapse repeated empty list items (- \n- \n- \n) into one
	return content.replace(/(^[ \t]*[-*+]\s*$\n){2,}/gm, "$1");
}

function applyLightTransformations(content: string): { content: string; count: number } {
	let count = 0;
	let result = content;

	const after1 = normalizeWhitespace(result);
	if (after1 !== result) count++;
	result = after1;

	const after2 = removeMarkdownComments(result);
	if (after2 !== result) count++;
	result = after2;

	const after3 = removeHorizontalRules(result);
	if (after3 !== result) count++;
	result = after3;

	const after4 = collapseEmptyListItems(result);
	if (after4 !== result) count++;
	result = after4;

	return { content: result, count };
}

// ─── Moderate Transformations ───────────────────────────────────────────────

function abbreviateVerbosePhrases(content: string): { content: string; count: number } {
	let count = 0;
	let result = content;

	for (const [pattern, replacement] of VERBOSE_PHRASES) {
		const after = result.replace(pattern, replacement);
		if (after !== result) count++;
		result = after;
	}

	return { content: result, count };
}

function removeBoilerplateLines(content: string): string {
	const lines = content.split("\n");
	const filtered = lines.filter((line) => {
		const trimmed = line.trim();
		// Remove lines that are just N/A, (none), (empty), (not applicable)
		if (/^(?:N\/A|\(none\)|\(empty\)|\(not applicable\))$/i.test(trimmed)) {
			return false;
		}
		return true;
	});
	return filtered.join("\n");
}

function deduplicateConsecutiveLines(content: string): string {
	const lines = content.split("\n");
	const result: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (i === 0 || lines[i] !== lines[i - 1] || lines[i].trim() === "") {
			result.push(lines[i]);
		}
	}

	return result.join("\n");
}

function collapseTableFormatting(content: string): string {
	// Remove excessive padding in markdown table cells
	// Matches table rows like |  cell  |  cell  | and collapses to | cell | cell |
	return content.replace(/\|[ \t]{2,}([^|\n]*?)[ \t]{2,}\|/g, (_, cellContent) => {
		return `| ${cellContent.trim()} |`;
	});
}

function applyModerateTransformations(content: string): { content: string; count: number } {
	let count = 0;
	let result = content;

	const phraseResult = abbreviateVerbosePhrases(result);
	count += phraseResult.count;
	result = phraseResult.content;

	const after1 = removeBoilerplateLines(result);
	if (after1 !== result) count++;
	result = after1;

	const after2 = deduplicateConsecutiveLines(result);
	if (after2 !== result) count++;
	result = after2;

	const after3 = collapseTableFormatting(result);
	if (after3 !== result) count++;
	result = after3;

	return { content: result, count };
}

// ─── Aggressive Transformations ─────────────────────────────────────────────

function removeMarkdownEmphasis(content: string): string {
	// Bold: **text** or __text__
	let result = content.replace(/\*\*(.+?)\*\*/g, "$1");
	result = result.replace(/__(.+?)__/g, "$1");
	// Italic: *text* or _text_ (single, not inside words)
	result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "$1");
	result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "$1");
	return result;
}

function removeMarkdownLinks(content: string): string {
	// [text](url) → text
	return content.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function truncateLongLines(content: string): string {
	const lines = content.split("\n");
	const result = lines.map((line) => {
		if (line.length <= 300) return line;
		// Find a sentence boundary (. ! ?) near the 300 char mark
		const truncateZone = line.slice(0, 300);
		const lastSentenceEnd = Math.max(
			truncateZone.lastIndexOf(". "),
			truncateZone.lastIndexOf("! "),
			truncateZone.lastIndexOf("? "),
		);
		if (lastSentenceEnd > 150) {
			return line.slice(0, lastSentenceEnd + 1);
		}
		// Fallback: cut at last space before 300
		const lastSpace = truncateZone.lastIndexOf(" ");
		if (lastSpace > 150) {
			return line.slice(0, lastSpace);
		}
		return truncateZone;
	});
	return result.join("\n");
}

function removeBulletMarkers(content: string): string {
	// Remove bullet markers: - , * , + , numbered (1. 2. etc)
	return content.replace(/^[ \t]*(?:[-*+]|\d+\.)\s+/gm, "");
}

function removeBlockquoteMarkers(content: string): string {
	return content.replace(/^[ \t]*>+\s?/gm, "");
}

function deduplicateStructuralPatterns(content: string): string {
	// Deduplicate consecutive lines that match the same "Key: value" pattern
	const lines = content.split("\n");
	const result: string[] = [];
	const seen = new Set<string>();
	let lastWasStructural = false;

	for (const line of lines) {
		const trimmed = line.trim();
		// Detect structural patterns: "Key: value"
		const structMatch = trimmed.match(/^(\w[\w\s]*?):\s+(.+)$/);
		if (structMatch) {
			if (seen.has(trimmed)) {
				lastWasStructural = true;
				continue;
			}
			seen.add(trimmed);
			lastWasStructural = true;
		} else {
			// Reset seen set when structural block ends
			if (!lastWasStructural || trimmed === "") {
				seen.clear();
			}
			lastWasStructural = false;
		}
		result.push(line);
	}

	return result.join("\n");
}

function applyAggressiveTransformations(
	content: string,
	preserveHeadings: boolean,
): { content: string; count: number } {
	let count = 0;
	let result = content;

	const after1 = removeMarkdownEmphasis(result);
	if (after1 !== result) count++;
	result = after1;

	const after2 = removeMarkdownLinks(result);
	if (after2 !== result) count++;
	result = after2;

	const after3 = truncateLongLines(result);
	if (after3 !== result) count++;
	result = after3;

	const after4 = removeBulletMarkers(result);
	if (after4 !== result) count++;
	result = after4;

	const after5 = removeBlockquoteMarkers(result);
	if (after5 !== result) count++;
	result = after5;

	const after6 = deduplicateStructuralPatterns(result);
	if (after6 !== result) count++;
	result = after6;

	return { content: result, count };
}

// ─── Heading Preservation ───────────────────────────────────────────────────

interface ExtractedHeadings {
	text: string;
	headings: Map<string, string>;
}

function extractHeadings(content: string): ExtractedHeadings {
	const headings = new Map<string, string>();
	let counter = 0;

	const text = content.replace(/^(#{1,6}\s.+)$/gm, (match) => {
		const placeholder = `\x00HEADING_${counter++}\x00`;
		headings.set(placeholder, match);
		return placeholder;
	});

	return { text, headings };
}

function restoreHeadings(text: string, headings: Map<string, string>): string {
	let result = text;
	for (const [placeholder, heading] of headings) {
		result = result.replace(placeholder, heading);
	}
	return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compress prompt content using deterministic text transformations.
 */
export function compressPrompt(content: string, options?: CompressionOptions): CompressionResult {
	const level = options?.level ?? "moderate";
	const preserveHeadings = options?.preserveHeadings ?? true;
	const preserveCodeBlocks = options?.preserveCodeBlocks ?? true;

	if (content === "") {
		return {
			content: "",
			originalChars: 0,
			compressedChars: 0,
			savingsPercent: 0,
			level,
			transformationsApplied: 0,
		};
	}

	const originalChars = content.length;
	let working = content;
	let totalTransformations = 0;

	// Extract code blocks if preserving
	let codeBlocks: Map<string, string> | null = null;
	if (preserveCodeBlocks) {
		const extracted = extractCodeBlocks(working);
		working = extracted.text;
		codeBlocks = extracted.blocks;
	}

	// Extract headings if preserving
	let headings: Map<string, string> | null = null;
	if (preserveHeadings) {
		const extracted = extractHeadings(working);
		working = extracted.text;
		headings = extracted.headings;
	}

	// Apply light transformations (always)
	const lightResult = applyLightTransformations(working);
	working = lightResult.content;
	totalTransformations += lightResult.count;

	// Check target
	if (options?.targetChars && getRestoredLength(working, codeBlocks, headings) <= options.targetChars) {
		return buildResult(working, originalChars, level, totalTransformations, codeBlocks, headings);
	}

	// Apply moderate transformations
	if (level === "moderate" || level === "aggressive") {
		const modResult = applyModerateTransformations(working);
		working = modResult.content;
		totalTransformations += modResult.count;

		if (options?.targetChars && getRestoredLength(working, codeBlocks, headings) <= options.targetChars) {
			return buildResult(working, originalChars, level, totalTransformations, codeBlocks, headings);
		}
	}

	// Apply aggressive transformations
	if (level === "aggressive") {
		const aggResult = applyAggressiveTransformations(working, preserveHeadings);
		working = aggResult.content;
		totalTransformations += aggResult.count;
	}

	return buildResult(working, originalChars, level, totalTransformations, codeBlocks, headings);
}

/**
 * Compress with a target size — applies progressively more aggressive
 * compression until the target is reached or all transformations exhausted.
 */
export function compressToTarget(content: string, targetChars: number): CompressionResult {
	if (content.length <= targetChars) {
		return {
			content,
			originalChars: content.length,
			compressedChars: content.length,
			savingsPercent: 0,
			level: "light",
			transformationsApplied: 0,
		};
	}

	const levels: CompressionLevel[] = ["light", "moderate", "aggressive"];

	for (const level of levels) {
		const result = compressPrompt(content, { level, targetChars });
		if (result.compressedChars <= targetChars) {
			return result;
		}
		// If aggressive and still over target, return best effort
		if (level === "aggressive") {
			return result;
		}
	}

	// Unreachable, but satisfy TypeScript
	return compressPrompt(content, { level: "aggressive" });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getRestoredLength(
	text: string,
	codeBlocks: Map<string, string> | null,
	headings: Map<string, string> | null,
): number {
	let result = text;
	if (headings) result = restoreHeadings(result, headings);
	if (codeBlocks) result = restoreCodeBlocks(result, codeBlocks);
	return result.length;
}

function buildResult(
	working: string,
	originalChars: number,
	level: CompressionLevel,
	transformationsApplied: number,
	codeBlocks: Map<string, string> | null,
	headings: Map<string, string> | null,
): CompressionResult {
	let content = working;
	if (headings) content = restoreHeadings(content, headings);
	if (codeBlocks) content = restoreCodeBlocks(content, codeBlocks);

	const compressedChars = content.length;
	const savingsPercent = originalChars > 0
		? Math.round(((originalChars - compressedChars) / originalChars) * 10000) / 100
		: 0;

	return {
		content,
		originalChars,
		compressedChars,
		savingsPercent,
		level,
		transformationsApplied,
	};
}
