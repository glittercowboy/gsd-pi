/**
 * Memory extraction pipeline orchestration.
 *
 * Two-phase pipeline:
 * - Phase 1: Scan session .jsonl files, extract durable knowledge via LLM
 * - Phase 2: Consolidate all extractions into MEMORY.md and memory_summary.md
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { getErrorMessage } from "../../../utils/error.js";
import type { MemoryStorage } from "./storage.js";

/** Inline concurrency limiter to cap parallel async operations. */
function pLimit(concurrency: number) {
	const queue: (() => void)[] = [];
	let active = 0;
	return <T>(fn: () => Promise<T>): Promise<T> => {
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				active++;
				fn().then(resolve, reject).finally(() => {
					active--;
					if (queue.length > 0) queue.shift()!();
				});
			};
			if (active < concurrency) run();
			else queue.push(run);
		});
	};
}

/** Max session file size to process (50MB) — prevents OOM with concurrent workers */
const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024;

/** Secret patterns to redact from LLM output before storage */
const SECRET_PATTERNS = [
	// API keys and tokens (sk_, pk_, api_key, etc.)
	/(?:sk|pk|api[_-]?key|token|secret|password|credential|auth)[_-]?\w*[\s:=]+['"]?[\w\-./+=]{20,}['"]?/gi,
	// AWS keys
	/AKIA[0-9A-Z]{16}/g,
	// GitHub tokens
	/gh[pousr]_[A-Za-z0-9_]{36,}/g,
	// Stripe keys (rk_live_, sk_live_, pk_live_, etc.)
	/[rsp]k_(?:live|test)_[A-Za-z0-9]{20,}/g,
	// Supabase / generic JWTs (eyJ...)
	/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g,
	// PEM private keys
	/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
	// Generic Bearer tokens
	/(?:Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
	// npm tokens
	/npm_[A-Za-z0-9]{36,}/g,
	// Anthropic API keys
	/sk-ant-[A-Za-z0-9\-_]{20,}/g,
	// OpenAI API keys
	/sk-[A-Za-z0-9]{40,}/g,
];

function redactSecrets(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, "[REDACTED]");
	}
	return result;
}

export type LLMCallFn = (
	system: string,
	user: string,
	options?: { maxTokens?: number },
) => Promise<string>;

export interface PipelineConfig {
	sessionsDir: string;
	memoryDir: string;
	cwd: string;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	stage1Concurrency: number;
}

interface SessionFileInfo {
	threadId: string;
	filePath: string;
	fileSize: number;
	fileMtime: number;
}

/**
 * Read only the first line of a file without loading the entire contents.
 */
async function readFirstLine(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf-8" }),
			crlfDelay: Infinity,
		});
		rl.on("line", (line) => {
			rl.close();
			resolve(line);
		});
		rl.on("error", reject);
		rl.on("close", () => resolve(""));
	});
}

/**
 * Scan sessions directory for .jsonl files belonging to this project (cwd).
 */
async function scanSessionFiles(sessionsDir: string, cwd: string): Promise<SessionFileInfo[]> {
	if (!existsSync(sessionsDir)) {
		return [];
	}

	const results: SessionFileInfo[] = [];

	try {
		const entries = readdirSync(sessionsDir, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory());

		for (const dir of dirs) {
			const dirPath = join(sessionsDir, dir.name);
			try {
				const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
				for (const file of files) {
					const filePath = join(dirPath, file);
					try {
						const headerLine = await readFirstLine(filePath);
						if (!headerLine) continue;
						const header = JSON.parse(headerLine);

						if (header.type === "session" && header.cwd === cwd) {
							const st = statSync(filePath);
							results.push({
								threadId: header.id,
								filePath,
								fileSize: st.size,
								fileMtime: Math.floor(st.mtimeMs),
							});
						}
					} catch {
						// Skip malformed session files
					}
				}
			} catch {
				// Skip unreadable directories
			}
		}
	} catch {
		// Sessions dir unreadable
	}

	return results;
}

/**
 * Filter session messages to persistable content for LLM extraction.
 * Strips tool results, images, and large content blocks.
 */
function filterSessionContent(filePath: string): string {
	try {
		const st = statSync(filePath);
		if (st.size > MAX_SESSION_FILE_SIZE) {
			return "[]";
		}
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim());
		const filtered: Array<{ role: string; content: string }> = [];

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);

				// Skip non-message entries
				if (entry.type !== "message") continue;

				const msg = entry.message;
				if (!msg) continue;

				const role = msg.role;
				if (role !== "user" && role !== "assistant") continue;

				// Extract text content
				let text = "";
				if (typeof msg.content === "string") {
					text = msg.content;
				} else if (Array.isArray(msg.content)) {
					const textParts = msg.content
						.filter((p: { type: string }) => p.type === "text")
						.map((p: { text: string }) => p.text);
					text = textParts.join("\n");
				}

				if (!text.trim()) continue;

				// Truncate very long messages
				if (text.length > 10_000) {
					text = text.slice(0, 10_000) + "\n[...truncated]";
				}

				filtered.push({ role, content: text });
			} catch {
				// Skip malformed lines
			}
		}

		return JSON.stringify(filtered);
	} catch {
		return "[]";
	}
}

// Prompt templates inlined to avoid ESM __dirname issues and asset copying

const PROMPTS = {
	"stage-one-system": `You are a memory extraction agent. Your task is to analyze a coding agent session transcript and extract durable, reusable knowledge.

## What to extract

Extract facts that would help a future session working on the same project:

1. **Project architecture** - frameworks, languages, build systems, directory structure patterns
2. **Conventions** - naming patterns, code style preferences, testing patterns
3. **Key decisions** - architectural choices made and their rationale
4. **Environment setup** - required tools, environment variables, deployment targets
5. **Gotchas and workarounds** - non-obvious behaviors, known issues, workarounds applied
6. **User preferences** - how the user likes to work, communication style, review preferences

## What NOT to extract

- Transient task details (specific bug fixes, one-off requests)
- Code snippets longer than 3 lines
- Information that is obvious from reading the codebase
- Secrets, API keys, tokens, or credentials (CRITICAL: redact any you encounter)

## Output format

Return a JSON array of memory objects:

\`\`\`json
[
  {
    "category": "architecture|convention|decision|environment|gotcha|preference",
    "content": "Clear, concise statement of the knowledge",
    "confidence": 0.0-1.0,
    "source_context": "Brief note on what in the session led to this extraction"
  }
]
\`\`\`

If the session contains no extractable durable knowledge, return an empty array: \`[]\`

Be selective. Quality over quantity. A typical session yields 0-5 memories.`,

	"stage-one-input": `## Session: {{thread_id}}

Analyze the following session transcript and extract durable knowledge.

<session_transcript>
{{response_items_json}}
</session_transcript>

Extract memories as specified in your instructions. Return ONLY the JSON array.`,

	"consolidation": `Merge and deduplicate these extracted memories into a clean, organized markdown document.

## Tasks

1. **Deduplicate** - Merge memories that express the same knowledge
2. **Resolve conflicts** - When memories contradict, prefer higher-confidence and more recent ones
3. **Rank** - Order by importance (most useful for future sessions first)
4. **Prune** - Remove memories that are subsumed by more general ones
5. **Categorize** - Group by category for readability

## Output format

Return a markdown document with the following structure:

# Project Memory

## Architecture
- [memory item]

## Conventions
- [memory item]

## Key Decisions
- [memory item]

## Environment
- [memory item]

## Gotchas
- [memory item]

## Preferences
- [memory item]

Only include sections that have entries. Each item should be a single clear sentence or short paragraph.

CRITICAL: Never include secrets, API keys, tokens, or credentials.

## Input memories

{{memories_json}}`,

	"read-path": `## Project Memory (auto-extracted)

The following knowledge was automatically extracted from previous sessions working on this project. Use it to inform your responses, but verify against the actual codebase when making changes.

{{memory_content}}`,
} as const;

function getPrompt(name: keyof typeof PROMPTS): string {
	return PROMPTS[name];
}

/**
 * Run Phase 1: Extract memories from individual session files.
 */
async function runPhase1(
	storage: MemoryStorage,
	config: PipelineConfig,
	llmCall: LLMCallFn,
	workerId: string,
): Promise<{ processed: number; errors: number }> {
	let processed = 0;
	let errors = 0;

	const systemPrompt = getPrompt("stage-one-system");
	const inputTemplate = getPrompt("stage-one-input");

	// Claim jobs in batches
	const jobs = storage.claimStage1Jobs(workerId, config.stage1Concurrency, 300);

	if (jobs.length === 0) {
		return { processed: 0, errors: 0 };
	}

	// Process jobs with bounded concurrency to avoid memory spikes
	const limit = pLimit(5);
	const promises = jobs.map((job) => limit(async () => {
		try {
			const thread = storage.getThread(job.threadId);
			if (!thread) {
				storage.failStage1Job(job.threadId, "Thread not found");
				errors++;
				return;
			}

			const sessionContent = filterSessionContent(thread.file_path);
			if (sessionContent === "[]") {
				// No content to extract from - mark as done with empty output
				storage.completeStage1Job(job.threadId, "[]");
				processed++;
				return;
			}

			const userPrompt = inputTemplate
				.replace("{{thread_id}}", job.threadId)
				.replace("{{response_items_json}}", sessionContent);

			const response = await llmCall(systemPrompt, userPrompt, { maxTokens: 4096 });
			const redacted = redactSecrets(response);

			// Validate JSON output
			try {
				JSON.parse(redacted);
			} catch {
				// Try to extract JSON array from the response
				const match = redacted.match(/\[[\s\S]*\]/);
				if (match) {
					JSON.parse(match[0]);
					storage.completeStage1Job(job.threadId, match[0]);
					processed++;
					return;
				}
				storage.failStage1Job(job.threadId, "LLM output is not valid JSON");
				errors++;
				return;
			}

			storage.completeStage1Job(job.threadId, redacted);
			processed++;
		} catch (err) {
			storage.failStage1Job(job.threadId, getErrorMessage(err));
			errors++;
		}
	}));

	await Promise.all(promises);
	return { processed, errors };
}

/**
 * Run Phase 2: Consolidate all stage1 outputs into MEMORY.md.
 */
async function runPhase2(
	storage: MemoryStorage,
	config: PipelineConfig,
	llmCall: LLMCallFn,
	workerId: string,
): Promise<boolean> {
	const phase2 = storage.tryClaimGlobalPhase2Job(workerId, 600);
	if (!phase2) {
		return false;
	}

	try {
		const outputs = storage.getStage1OutputsForCwd(config.cwd);
		if (outputs.length === 0) {
			storage.completePhase2Job(phase2.jobId);
			return true;
		}

		// Collect all memories
		const allMemories: unknown[] = [];
		for (const output of outputs) {
			try {
				const memories = JSON.parse(output.extractionJson);
				if (Array.isArray(memories)) {
					allMemories.push(...memories);
				}
			} catch {
				// Skip malformed outputs
			}
		}

		if (allMemories.length === 0) {
			// Write empty memory files
			if (!existsSync(config.memoryDir)) {
				mkdirSync(config.memoryDir, { recursive: true });
			}
			writeFileSync(join(config.memoryDir, "MEMORY.md"), "# Project Memory\n\nNo memories extracted yet.\n");
			writeFileSync(join(config.memoryDir, "memory_summary.md"), "");
			storage.completePhase2Job(phase2.jobId);
			return true;
		}

		// Save raw memories
		if (!existsSync(config.memoryDir)) {
			mkdirSync(config.memoryDir, { recursive: true });
		}
		writeFileSync(
			join(config.memoryDir, "raw_memories.md"),
			`# Raw Extracted Memories\n\n\`\`\`json\n${JSON.stringify(allMemories, null, 2)}\n\`\`\`\n`,
		);

		// Call LLM for consolidation
		const consolidationPrompt = getPrompt("consolidation").replace(
			"{{memories_json}}",
			JSON.stringify(allMemories, null, 2),
		);

		const consolidatedMemory = await llmCall(
			"You are a memory consolidation agent. Merge the extracted memories into a clean, organized markdown document.",
			consolidationPrompt,
			{ maxTokens: 8192 },
		);

		const redactedMemory = redactSecrets(consolidatedMemory);

		// Write MEMORY.md
		writeFileSync(join(config.memoryDir, "MEMORY.md"), redactedMemory);

		// Write memory_summary.md (truncated version for injection)
		const summaryLines = redactedMemory.split("\n").slice(0, 100);
		const summary = summaryLines.join("\n");
		writeFileSync(join(config.memoryDir, "memory_summary.md"), summary);

		storage.completePhase2Job(phase2.jobId);
		return true;
	} catch (err) {
		// Phase 2 failed - job will expire and can be retried
		return false;
	}
}

/**
 * Run the full pipeline startup sequence.
 */
export async function runStartup(
	storage: MemoryStorage,
	config: PipelineConfig,
	llmCall: LLMCallFn,
): Promise<{ phase1: { processed: number; errors: number }; phase2: boolean }> {
	const workerId = `worker-${Date.now()}`;

	// Step 1: Scan sessions and upsert threads
	const sessionFiles = await scanSessionFiles(config.sessionsDir, config.cwd);

	// Apply age and idle filters
	const now = Date.now();
	const maxAgeMs = config.maxRolloutAgeDays * 24 * 60 * 60 * 1000;
	const minIdleMs = config.minRolloutIdleHours * 60 * 60 * 1000;

	const eligible = sessionFiles
		.filter((f) => {
			const age = now - f.fileMtime;
			return age <= maxAgeMs && age >= minIdleMs;
		})
		.slice(0, config.maxRolloutsPerStartup);

	if (eligible.length > 0) {
		storage.upsertThreads(
			eligible.map((f) => ({
				threadId: f.threadId,
				filePath: f.filePath,
				fileSize: f.fileSize,
				fileMtime: f.fileMtime,
				cwd: config.cwd,
			})),
		);
	}

	// Step 2: Run Phase 1
	const phase1Result = await runPhase1(storage, config, llmCall, workerId);

	// Step 3: Run Phase 2 (only if phase 1 did work)
	let phase2Result = false;
	if (phase1Result.processed > 0) {
		phase2Result = await runPhase2(storage, config, llmCall, workerId);
	}

	return { phase1: phase1Result, phase2: phase2Result };
}

/**
 * Get the memory summary for injection into the system prompt.
 */
export function getMemorySummary(memoryDir: string): string | null {
	const summaryPath = join(memoryDir, "memory_summary.md");
	if (!existsSync(summaryPath)) {
		return null;
	}

	try {
		const content = readFileSync(summaryPath, "utf-8").trim();
		if (!content) {
			return null;
		}

		const readPathTemplate = getPrompt("read-path");
		return readPathTemplate.replace("{{memory_content}}", content);
	} catch {
		return null;
	}
}

/**
 * Get the full MEMORY.md content.
 */
export function getFullMemory(memoryDir: string): string | null {
	const memoryPath = join(memoryDir, "MEMORY.md");
	if (!existsSync(memoryPath)) {
		return null;
	}

	try {
		return readFileSync(memoryPath, "utf-8");
	} catch {
		return null;
	}
}
