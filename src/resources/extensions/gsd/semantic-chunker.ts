// GSD Extension — Semantic Chunker with TF-IDF Relevance Scoring
// Splits code/text into semantic chunks and selects the most relevant ones for a given task.
// Pure TypeScript — no external dependencies.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Chunk {
	content: string;
	startLine: number;
	endLine: number;
	score: number;
}

export interface ChunkResult {
	chunks: Chunk[];
	totalChunks: number;
	omittedChunks: number;
	savingsPercent: number;
}

interface ChunkOptions {
	minLines?: number;
	maxLines?: number;
}

interface RelevanceOptions {
	maxChunks?: number;
	minChunkLines?: number;
	maxChunkLines?: number;
	minScore?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CODE_BOUNDARY_RE = /^(export\s+)?(async\s+)?(function|class|interface|type|const|enum)\s/;

const MARKDOWN_HEADING_RE = /^#{1,6}\s/;

const STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in",
	"for", "on", "with", "at", "by", "from", "this", "that", "it", "as",
	"or", "and", "not", "but", "if", "do", "no", "so", "up", "its", "has",
	"had", "get", "set", "can", "may", "all", "use", "new", "one", "two",
	"also", "each", "than", "been", "into", "most", "only", "over", "such",
	"how", "some", "any", "our", "his", "her", "out", "did", "let", "say", "she",
]);

const DEFAULT_MIN_LINES = 3;
const DEFAULT_MAX_LINES = 80;
const DEFAULT_MAX_CHUNKS = 5;
const DEFAULT_MIN_SCORE = 0.1;

// ─── Content Type Detection ─────────────────────────────────────────────────

type ContentType = "code" | "markdown" | "text";

function detectContentType(lines: string[]): ContentType {
	let codeSignals = 0;
	let mdSignals = 0;
	const sampleSize = Math.min(lines.length, 50);

	for (let i = 0; i < sampleSize; i++) {
		const line = lines[i];
		if (CODE_BOUNDARY_RE.test(line) || /^\s*import\s/.test(line)) {
			codeSignals++;
		}
		if (MARKDOWN_HEADING_RE.test(line)) {
			mdSignals++;
		}
	}

	if (mdSignals >= 2 && mdSignals > codeSignals) return "markdown";
	if (codeSignals >= 2) return "code";
	return "text";
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[\s\W]+/)
		.filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

// ─── splitIntoChunks ────────────────────────────────────────────────────────

export function splitIntoChunks(
	content: string,
	options?: ChunkOptions,
): Chunk[] {
	if (!content || content.trim().length === 0) return [];

	const minLines = options?.minLines ?? DEFAULT_MIN_LINES;
	const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
	const lines = content.split("\n");

	if (lines.length === 0) return [];

	const contentType = detectContentType(lines);
	let boundaries: number[];

	switch (contentType) {
		case "code":
			boundaries = findCodeBoundaries(lines);
			break;
		case "markdown":
			boundaries = findMarkdownBoundaries(lines);
			break;
		default:
			boundaries = findTextBoundaries(lines);
			break;
	}

	// Always include 0 as first boundary
	if (boundaries.length === 0 || boundaries[0] !== 0) {
		boundaries.unshift(0);
	}

	// Build raw chunks from boundaries
	const rawChunks: Chunk[] = [];
	for (let i = 0; i < boundaries.length; i++) {
		const start = boundaries[i];
		const end = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : lines.length - 1;
		const chunkLines = lines.slice(start, end + 1);
		rawChunks.push({
			content: chunkLines.join("\n"),
			startLine: start + 1,  // 1-based
			endLine: end + 1,      // 1-based
			score: 0,
		});
	}

	// Split oversized chunks at maxLines
	const splitChunks: Chunk[] = [];
	for (const chunk of rawChunks) {
		const chunkLineCount = chunk.endLine - chunk.startLine + 1;
		if (chunkLineCount <= maxLines) {
			splitChunks.push(chunk);
		} else {
			const chunkLines = chunk.content.split("\n");
			for (let offset = 0; offset < chunkLines.length; offset += maxLines) {
				const slice = chunkLines.slice(offset, offset + maxLines);
				splitChunks.push({
					content: slice.join("\n"),
					startLine: chunk.startLine + offset,
					endLine: chunk.startLine + offset + slice.length - 1,
					score: 0,
				});
			}
		}
	}

	// Merge tiny chunks into predecessor
	const merged: Chunk[] = [];
	for (const chunk of splitChunks) {
		const chunkLineCount = chunk.endLine - chunk.startLine + 1;
		if (chunkLineCount < minLines && merged.length > 0) {
			const prev = merged[merged.length - 1];
			prev.content += "\n" + chunk.content;
			prev.endLine = chunk.endLine;
		} else {
			merged.push({ ...chunk });
		}
	}

	return merged;
}

function findCodeBoundaries(lines: string[]): number[] {
	const boundaries: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (CODE_BOUNDARY_RE.test(lines[i])) {
			// Also consider a blank line before a boundary marker
			if (i > 0 && lines[i - 1].trim() === "" && !boundaries.includes(i)) {
				boundaries.push(i);
			} else if (!boundaries.includes(i)) {
				boundaries.push(i);
			}
		}
	}
	return boundaries;
}

function findMarkdownBoundaries(lines: string[]): number[] {
	const boundaries: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (MARKDOWN_HEADING_RE.test(lines[i])) {
			boundaries.push(i);
		}
	}
	return boundaries;
}

function findTextBoundaries(lines: string[]): number[] {
	const boundaries: number[] = [0];
	for (let i = 1; i < lines.length; i++) {
		if (lines[i - 1].trim() === "" && lines[i].trim() !== "") {
			boundaries.push(i);
		}
	}
	return boundaries;
}

// ─── scoreChunks ────────────────────────────────────────────────────────────

export function scoreChunks(chunks: Chunk[], query: string): Chunk[] {
	if (chunks.length === 0) return [];

	const queryTerms = tokenize(query);
	if (queryTerms.length === 0) {
		return chunks.map((c) => ({ ...c, score: 0 }));
	}

	const totalChunks = chunks.length;

	// Pre-compute IDF for each query term
	const termChunkCounts = new Map<string, number>();
	const chunkTokenSets: Set<string>[] = [];

	for (const chunk of chunks) {
		const tokens = new Set(tokenize(chunk.content));
		chunkTokenSets.push(tokens);
		for (const term of queryTerms) {
			if (tokens.has(term)) {
				termChunkCounts.set(term, (termChunkCounts.get(term) ?? 0) + 1);
			}
		}
	}

	const idf = new Map<string, number>();
	for (const term of queryTerms) {
		const df = termChunkCounts.get(term) ?? 0;
		idf.set(term, Math.log(1 + totalChunks / (1 + df)));
	}

	// Score each chunk
	const scored = chunks.map((chunk, idx) => {
		const chunkTokens = tokenize(chunk.content);
		const totalTerms = chunkTokens.length;
		if (totalTerms === 0) return { ...chunk, score: 0 };

		// Count term frequencies
		const termFreq = new Map<string, number>();
		for (const token of chunkTokens) {
			termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
		}

		let score = 0;
		for (const term of queryTerms) {
			const tf = (termFreq.get(term) ?? 0) / totalTerms;
			const termIdf = idf.get(term) ?? 0;
			score += tf * termIdf;
		}

		return { ...chunk, score };
	});

	// Normalize to 0-1
	const maxScore = Math.max(...scored.map((c) => c.score));
	if (maxScore > 0) {
		for (const chunk of scored) {
			chunk.score = chunk.score / maxScore;
		}
	}

	return scored;
}

// ─── chunkByRelevance ───────────────────────────────────────────────────────

export function chunkByRelevance(
	content: string,
	query: string,
	options?: RelevanceOptions,
): ChunkResult {
	const maxChunks = options?.maxChunks ?? DEFAULT_MAX_CHUNKS;
	const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
	const minLines = options?.minChunkLines ?? DEFAULT_MIN_LINES;
	const maxLines = options?.maxChunkLines ?? DEFAULT_MAX_LINES;

	const rawChunks = splitIntoChunks(content, { minLines, maxLines });
	if (rawChunks.length === 0) {
		return { chunks: [], totalChunks: 0, omittedChunks: 0, savingsPercent: 0 };
	}

	const scored = scoreChunks(rawChunks, query);

	// Filter by minScore and take top maxChunks by score
	const qualifying = scored
		.filter((c) => c.score >= minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxChunks);

	// Return in original document order (by startLine)
	const selected = qualifying.sort((a, b) => a.startLine - b.startLine);

	const totalChars = content.length;
	const selectedChars = selected.reduce((sum, c) => sum + c.content.length, 0);
	const savingsPercent = totalChars > 0
		? Math.round(((totalChars - selectedChars) / totalChars) * 100)
		: 0;

	return {
		chunks: selected,
		totalChunks: rawChunks.length,
		omittedChunks: rawChunks.length - selected.length,
		savingsPercent: Math.max(0, savingsPercent),
	};
}

// ─── formatChunks ───────────────────────────────────────────────────────────

export function formatChunks(result: ChunkResult, filePath: string): string {
	if (result.chunks.length === 0) {
		return `[${filePath}: empty or no relevant chunks]`;
	}

	const parts: string[] = [];
	let lastEndLine = 0;

	for (const chunk of result.chunks) {
		// Show omission gap
		if (lastEndLine > 0 && chunk.startLine > lastEndLine + 1) {
			const gapLines = chunk.startLine - lastEndLine - 1;
			parts.push(`[...${gapLines} lines omitted...]`);
		}

		parts.push(`[Lines ${chunk.startLine}-${chunk.endLine}]`);
		parts.push(chunk.content);

		lastEndLine = chunk.endLine;
	}

	return parts.join("\n");
}
