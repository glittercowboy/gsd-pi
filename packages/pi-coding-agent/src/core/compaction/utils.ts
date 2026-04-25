/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage, Message } from "@gsd/pi-ai";
import { TOOL_RESULT_MAX_CHARS } from "../constants.js";

// Head/tail split for head+tail truncation. Keeps first half + last half up to
// TOOL_RESULT_MAX_CHARS total. Tool results and other large blocks put their
// information-dense content (exit codes, verdicts, commit hashes, pass/fail
// counts) at the tail — pure head-slicing discards that signal. See issue #4665.
const HEAD_TAIL_HALF = Math.floor(TOOL_RESULT_MAX_CHARS / 2);
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.js";
import type { SessionEntry } from "../session-manager.js";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from a session entry.
 *
 * Handles all entry types: message, custom_message, branch_summary, and compaction.
 * Returns undefined for entries that don't contribute to LLM context (e.g., settings changes).
 *
 * @param skipToolResults - If true, skips toolResult messages (used by branch summarization
 *   where tool call context is sufficient). Default false.
 */
export function getMessageFromEntry(entry: SessionEntry, skipToolResults = false): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			if (skipToolResults && entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
			return undefined;
	}
}

/**
 * Collect AgentMessages from a range of session entries.
 *
 * @param entries - Session entries array
 * @param startIndex - First index (inclusive)
 * @param endIndex - Last index (exclusive)
 * @param skipToolResults - If true, skips toolResult messages. Default false.
 */
export function collectMessages(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	skipToolResults = false,
): AgentMessage[] {
	const result: AgentMessage[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i], skipToolResults);
		if (msg) result.push(msg);
	}
	return result;
}

// ============================================================================
// Text Content Extraction
// ============================================================================

/**
 * Extract text from an array of content blocks, filtering to text-type blocks.
 * Replaces the recurring `.filter(c => c.type === "text").map(c => c.text).join(sep)` pattern.
 */
export function extractTextContent(
	content: Array<{ type: string; text?: string }>,
	separator = "\n",
): string {
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(separator);
}

// ============================================================================
// Summarization Message Construction
// ============================================================================

/**
 * Create a single-message array for summarization prompts.
 * Wraps promptText in the standard `[{ role: "user", content: [{ type: "text", text }], timestamp }]` shape.
 */
export function createSummarizationMessage(promptText: string): [{ role: "user"; content: [{ type: "text"; text: string }]; timestamp: number }] {
	return [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];
}

// ============================================================================
// Message Serialization
// ============================================================================

// TOOL_RESULT_MAX_CHARS imported from ../constants.js

/**
 * Truncate text to a maximum character length for summarization, keeping both
 * the head AND the tail. The tail is where information density lives for tool
 * output (exit codes, verdicts, pass/fail counts, commit hashes), so pure
 * head-slicing produced degenerate summaries (see issue #4665).
 *
 * Exported for test access only.
 */
export function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const half = Math.floor(maxChars / 2);
	const head = text.slice(0, half);
	const tail = text.slice(text.length - half);
	const truncatedChars = text.length - (head.length + tail.length);
	return `${head}\n\n[... ${truncatedChars} more characters truncated ...]\n\n${tail}`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Every content block with a character count above TOOL_RESULT_MAX_CHARS is
 * head+tail truncated. The issue #4665 fix broadened this from tool-results-
 * only to every block type — large user pastes, assistant thinking, tool-call
 * args, and bashExecution-derived blocks also bloat summarization input if
 * uncapped.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	const cap = TOOL_RESULT_MAX_CHARS;

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`**User said:** ${truncateForSummary(content, cap)}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`**Assistant thinking:** ${truncateForSummary(thinkingParts.join("\n"), cap)}`);
			}
			if (textParts.length > 0) {
				parts.push(`**Assistant responded:** ${truncateForSummary(textParts.join("\n"), cap)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`**Assistant tool calls:** ${truncateForSummary(toolCalls.join("; "), cap)}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`**Tool result:** ${truncateForSummary(content, cap)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Token estimation for post-serialization size
// ============================================================================

/**
 * Estimate tokens for a message AFTER the summarization serializer will have
 * capped its large content blocks. Use this when deciding chunk sizes for
 * summarization — NOT when deciding whether to compact in the first place
 * (that needs the real in-memory content size via `estimateTokens`).
 *
 * See issue #4665: the old chunker used real content size but the serializer
 * truncated tool results to 2000 chars, so a single 400K-char tool result
 * looked like 100K tokens (triggering tens of unnecessary chunks) but actually
 * serialized to ~600 tokens.
 *
 * Colocated with `truncateForSummary` / `serializeConversation` so the two
 * stay in sync — if the serialization cap changes, both functions pick it up
 * from `TOOL_RESULT_MAX_CHARS`.
 */
export function estimateSerializedTokens(message: AgentMessage): number {
	const cap = TOOL_RESULT_MAX_CHARS;
	const capLen = (len: number) => Math.min(len, cap);
	let chars = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				chars = capLen(content.length);
			} else if (Array.isArray(content)) {
				let total = 0;
				for (const block of content) {
					if (block.type === "text" && block.text) total += block.text.length;
				}
				chars = capLen(total);
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			let textLen = 0;
			let thinkingLen = 0;
			let toolCallsLen = 0;
			for (const block of assistant.content) {
				if (block.type === "text") textLen += block.text.length;
				else if (block.type === "thinking") thinkingLen += block.thinking.length;
				else if (block.type === "toolCall") toolCallsLen += block.name.length + JSON.stringify(block.arguments).length;
			}
			chars = capLen(textLen) + capLen(thinkingLen) + capLen(toolCallsLen);
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				chars = capLen(message.content.length);
			} else {
				let textLen = 0;
				let imageChars = 0;
				for (const block of message.content) {
					if (block.type === "text" && block.text) textLen += block.text.length;
					if (block.type === "image") imageChars += 4800;
				}
				chars = capLen(textLen) + imageChars;
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = capLen(message.command.length + message.output.length);
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			// Summary messages are already concise; don't truncate them.
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
