import test from "node:test";
import assert from "node:assert/strict";

import {
	splitIntoChunks,
	scoreChunks,
	chunkByRelevance,
	formatChunks,
} from "../semantic-chunker.js";
import type { Chunk, ChunkResult } from "../semantic-chunker.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TYPESCRIPT_CODE = `import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Config {
  name: string;
  debug: boolean;
}

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

export async function saveConfig(path: string, config: Config): Promise<void> {
  const data = JSON.stringify(config, null, 2);
  await writeFile(path, data, "utf-8");
}

export class ConfigManager {
  private config: Config;

  constructor(private path: string) {
    this.config = loadConfig(path);
  }

  get(key: keyof Config) {
    return this.config[key];
  }

  set(key: keyof Config, value: Config[keyof Config]) {
    this.config[key] = value;
  }

  save() {
    return saveConfig(this.path, this.config);
  }
}

const DEFAULT_CONFIG: Config = {
  name: "default",
  debug: false,
};`;

const MARKDOWN_CONTENT = `# Project Overview

This project provides a task management system.

## Installation

Run the following command:

\`\`\`bash
npm install gsd
\`\`\`

## Usage

Import the module and initialize:

\`\`\`typescript
import { gsd } from "gsd";
gsd.init();
\`\`\`

## API Reference

### init()

Initializes the system.

### run(task: string)

Runs a specified task.

## Contributing

Please read CONTRIBUTING.md before submitting PRs.`;

const PLAIN_TEXT = `The quick brown fox jumps over the lazy dog. This is a sample paragraph
that tests plain text chunking behavior.

Another paragraph begins here. It contains different content that should
be separated from the first paragraph by a blank line.

A third paragraph with more text. This should form its own chunk when
processed by the text boundary detection.

Final paragraph wrapping up the test content.`;

// ─── splitIntoChunks — TypeScript Code ──────────────────────────────────────

test("splitIntoChunks splits TypeScript code at function/class/export boundaries", () => {
	const chunks = splitIntoChunks(TYPESCRIPT_CODE);
	assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);

	// Should find boundaries at export interface, export function, export class, const
	const contents = chunks.map((c) => c.content);
	const hasInterface = contents.some((c) => c.includes("export interface Config"));
	const hasLoadConfig = contents.some((c) => c.includes("export function loadConfig"));
	const hasClass = contents.some((c) => c.includes("export class ConfigManager"));
	assert.ok(hasInterface, "Should have a chunk containing the interface");
	assert.ok(hasLoadConfig, "Should have a chunk containing loadConfig");
	assert.ok(hasClass, "Should have a chunk containing ConfigManager");
});

test("splitIntoChunks preserves all content across chunks", () => {
	const chunks = splitIntoChunks(TYPESCRIPT_CODE);
	const reassembled = chunks.map((c) => c.content).join("\n");
	assert.equal(reassembled, TYPESCRIPT_CODE);
});

test("splitIntoChunks assigns correct line numbers", () => {
	const chunks = splitIntoChunks(TYPESCRIPT_CODE);
	// First chunk starts at line 1
	assert.equal(chunks[0].startLine, 1);
	// Last chunk ends at total line count
	const totalLines = TYPESCRIPT_CODE.split("\n").length;
	assert.equal(chunks[chunks.length - 1].endLine, totalLines);
	// Chunks should be contiguous
	for (let i = 1; i < chunks.length; i++) {
		assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1,
			`Chunk ${i} should start right after chunk ${i - 1}`);
	}
});

// ─── splitIntoChunks — Markdown ─────────────────────────────────────────────

test("splitIntoChunks splits markdown at heading boundaries", () => {
	const chunks = splitIntoChunks(MARKDOWN_CONTENT);
	assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);

	const contents = chunks.map((c) => c.content);
	const hasOverview = contents.some((c) => c.includes("# Project Overview"));
	const hasInstallation = contents.some((c) => c.includes("## Installation"));
	const hasApi = contents.some((c) => c.includes("## API Reference"));
	assert.ok(hasOverview, "Should have overview chunk");
	assert.ok(hasInstallation, "Should have installation chunk");
	assert.ok(hasApi, "Should have API reference chunk");
});

// ─── splitIntoChunks — Plain Text ───────────────────────────────────────────

test("splitIntoChunks splits plain text at paragraph boundaries", () => {
	const chunks = splitIntoChunks(PLAIN_TEXT);
	assert.ok(chunks.length >= 2, `Expected multiple chunks, got ${chunks.length}`);
});

// ─── splitIntoChunks — Edge Cases ───────────────────────────────────────────

test("splitIntoChunks returns empty array for empty content", () => {
	assert.deepEqual(splitIntoChunks(""), []);
	assert.deepEqual(splitIntoChunks("   "), []);
});

test("splitIntoChunks handles single-line content", () => {
	const chunks = splitIntoChunks("const x = 1;");
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].content, "const x = 1;");
	assert.equal(chunks[0].startLine, 1);
	assert.equal(chunks[0].endLine, 1);
});

test("splitIntoChunks merges tiny chunks below minLines into predecessor", () => {
	const content = `export function foo() {
  return 1;
}

export function bar() {
  return 2;
}

export function baz() {
  return 3;
}

const x = 1;`;

	// With high minLines, tiny chunks get merged
	const chunks = splitIntoChunks(content, { minLines: 5, maxLines: 80 });
	for (let i = 0; i < chunks.length; i++) {
		const lineCount = chunks[i].endLine - chunks[i].startLine + 1;
		// First chunk may be smaller, but subsequent ones should be >= minLines or merged
		if (i > 0) {
			assert.ok(lineCount >= 3, `Chunk ${i} has only ${lineCount} lines`);
		}
	}
});

test("splitIntoChunks respects maxLines by splitting oversized chunks", () => {
	// Build a long function
	const longLines = ["export function longFunc() {"];
	for (let i = 0; i < 100; i++) {
		longLines.push(`  const v${i} = ${i};`);
	}
	longLines.push("}");
	const content = longLines.join("\n");

	const chunks = splitIntoChunks(content, { minLines: 1, maxLines: 30 });
	for (const chunk of chunks) {
		const lineCount = chunk.endLine - chunk.startLine + 1;
		assert.ok(lineCount <= 30, `Chunk has ${lineCount} lines, exceeding maxLines=30`);
	}
});

// ─── scoreChunks ────────────────────────────────────────────────────────────

test("scoreChunks scores chunk with query terms higher than chunk without", () => {
	const chunks: Chunk[] = [
		{ content: "function loadConfig reads configuration from disk", startLine: 1, endLine: 1, score: 0 },
		{ content: "function saveData writes data to database storage", startLine: 2, endLine: 2, score: 0 },
	];

	const scored = scoreChunks(chunks, "loadConfig configuration disk");
	const configChunk = scored.find((c) => c.content.includes("loadConfig"))!;
	const dataChunk = scored.find((c) => c.content.includes("saveData"))!;
	assert.ok(configChunk.score > dataChunk.score,
		`Config chunk (${configChunk.score}) should score higher than data chunk (${dataChunk.score})`);
});

test("scoreChunks normalizes scores between 0 and 1", () => {
	const chunks: Chunk[] = [
		{ content: "alpha beta gamma delta", startLine: 1, endLine: 1, score: 0 },
		{ content: "epsilon zeta eta theta", startLine: 2, endLine: 2, score: 0 },
	];

	const scored = scoreChunks(chunks, "alpha gamma");
	for (const chunk of scored) {
		assert.ok(chunk.score >= 0 && chunk.score <= 1,
			`Score ${chunk.score} should be between 0 and 1`);
	}
	// At least one chunk should have score 1 (the max)
	assert.ok(scored.some((c) => c.score === 1), "Max scoring chunk should be normalized to 1");
});

test("scoreChunks returns all zero scores when no query terms match", () => {
	const chunks: Chunk[] = [
		{ content: "alpha beta gamma", startLine: 1, endLine: 1, score: 0 },
		{ content: "delta epsilon zeta", startLine: 2, endLine: 2, score: 0 },
	];

	const scored = scoreChunks(chunks, "xxxxxxxxx yyyyyyyyy");
	for (const chunk of scored) {
		assert.equal(chunk.score, 0, "Non-matching chunks should have score 0");
	}
});

test("scoreChunks handles empty query gracefully", () => {
	const chunks: Chunk[] = [
		{ content: "some content here", startLine: 1, endLine: 1, score: 0 },
	];
	const scored = scoreChunks(chunks, "");
	assert.equal(scored[0].score, 0);
});

test("scoreChunks handles empty chunks array", () => {
	const scored = scoreChunks([], "some query");
	assert.deepEqual(scored, []);
});

test("scoreChunks filters stop words from query", () => {
	const chunks: Chunk[] = [
		{ content: "the configuration module handles loading", startLine: 1, endLine: 1, score: 0 },
		{ content: "database connection pool management system", startLine: 2, endLine: 2, score: 0 },
	];

	// "the" and "is" are stop words; "configuration" should be the only scoring term
	const scored = scoreChunks(chunks, "the configuration is");
	const configChunk = scored.find((c) => c.content.includes("configuration"))!;
	const dbChunk = scored.find((c) => c.content.includes("database"))!;
	assert.ok(configChunk.score > dbChunk.score);
});

// ─── chunkByRelevance ───────────────────────────────────────────────────────

test("chunkByRelevance selects top-scoring chunks up to maxChunks", () => {
	const result = chunkByRelevance(TYPESCRIPT_CODE, "ConfigManager save config", {
		maxChunks: 2,
		minScore: 0,
	});

	assert.ok(result.chunks.length <= 2, `Expected at most 2 chunks, got ${result.chunks.length}`);
	assert.ok(result.totalChunks > 2, "Total chunks should be more than selected");
	assert.ok(result.omittedChunks > 0, "Should have omitted chunks");
});

test("chunkByRelevance returns chunks in original document order", () => {
	const result = chunkByRelevance(TYPESCRIPT_CODE, "Config loadConfig saveConfig", {
		maxChunks: 10,
		minScore: 0,
	});

	for (let i = 1; i < result.chunks.length; i++) {
		assert.ok(result.chunks[i].startLine > result.chunks[i - 1].startLine,
			"Chunks should be in ascending line order");
	}
});

test("chunkByRelevance respects minScore filtering", () => {
	const result = chunkByRelevance(TYPESCRIPT_CODE, "ConfigManager", {
		maxChunks: 10,
		minScore: 0.5,
	});

	for (const chunk of result.chunks) {
		assert.ok(chunk.score >= 0.5,
			`Chunk score ${chunk.score} should be >= minScore 0.5`);
	}
});

test("chunkByRelevance calculates savings percent", () => {
	const result = chunkByRelevance(TYPESCRIPT_CODE, "ConfigManager", {
		maxChunks: 1,
		minScore: 0,
	});

	assert.ok(result.savingsPercent >= 0 && result.savingsPercent <= 100,
		`Savings ${result.savingsPercent}% should be between 0 and 100`);
	if (result.omittedChunks > 0) {
		assert.ok(result.savingsPercent > 0, "Should have positive savings when chunks are omitted");
	}
});

test("chunkByRelevance handles empty content", () => {
	const result = chunkByRelevance("", "query");
	assert.deepEqual(result.chunks, []);
	assert.equal(result.totalChunks, 0);
	assert.equal(result.omittedChunks, 0);
	assert.equal(result.savingsPercent, 0);
});

test("chunkByRelevance uses default options when none provided", () => {
	const result = chunkByRelevance(TYPESCRIPT_CODE, "Config");
	assert.ok(result.chunks.length <= 5, "Default maxChunks should be 5");
});

// ─── formatChunks ───────────────────────────────────────────────────────────

test("formatChunks produces line range markers", () => {
	const result: ChunkResult = {
		chunks: [
			{ content: "line one\nline two", startLine: 1, endLine: 2, score: 1 },
			{ content: "line ten\nline eleven", startLine: 10, endLine: 11, score: 0.5 },
		],
		totalChunks: 5,
		omittedChunks: 3,
		savingsPercent: 60,
	};

	const formatted = formatChunks(result, "src/config.ts");
	assert.ok(formatted.includes("[Lines 1-2]"), "Should include first line range");
	assert.ok(formatted.includes("[Lines 10-11]"), "Should include second line range");
	assert.ok(formatted.includes("line one\nline two"), "Should include first chunk content");
	assert.ok(formatted.includes("line ten\nline eleven"), "Should include second chunk content");
});

test("formatChunks shows omission indicators between non-contiguous chunks", () => {
	const result: ChunkResult = {
		chunks: [
			{ content: "first chunk", startLine: 1, endLine: 5, score: 1 },
			{ content: "second chunk", startLine: 81, endLine: 90, score: 0.5 },
		],
		totalChunks: 4,
		omittedChunks: 2,
		savingsPercent: 50,
	};

	const formatted = formatChunks(result, "src/main.ts");
	assert.ok(formatted.includes("[...75 lines omitted...]"),
		`Expected omission marker, got:\n${formatted}`);
});

test("formatChunks handles empty result", () => {
	const result: ChunkResult = {
		chunks: [],
		totalChunks: 0,
		omittedChunks: 0,
		savingsPercent: 0,
	};

	const formatted = formatChunks(result, "empty.ts");
	assert.ok(formatted.includes("empty.ts"), "Should mention the file path");
});

test("formatChunks does not show omission for contiguous chunks", () => {
	const result: ChunkResult = {
		chunks: [
			{ content: "chunk one", startLine: 1, endLine: 5, score: 1 },
			{ content: "chunk two", startLine: 6, endLine: 10, score: 0.8 },
		],
		totalChunks: 2,
		omittedChunks: 0,
		savingsPercent: 0,
	};

	const formatted = formatChunks(result, "src/test.ts");
	assert.ok(!formatted.includes("omitted"), "Contiguous chunks should not show omission");
});
