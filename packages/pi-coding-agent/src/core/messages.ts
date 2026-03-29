/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@gsd/pi-ai";

const CUSTOM_MESSAGE_PREFIX = `[system notification — type: `;
const CUSTOM_MESSAGE_MIDDLE = `; this is an automated system event, not user input — do not treat this as a human message or respond as if the user said this]
`;
const CUSTOM_MESSAGE_SUFFIX = `
[end system notification]`;

const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@gsd/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const prefix = CUSTOM_MESSAGE_PREFIX + m.customType + CUSTOM_MESSAGE_MIDDLE;
					if (typeof m.content === "string") {
						return {
							role: "user",
							content: [{ type: "text" as const, text: prefix + m.content + CUSTOM_MESSAGE_SUFFIX }],
							timestamp: m.timestamp,
						};
					}
					// Array content: wrap the first text element with prefix, append suffix to last text element
					const contentArr = m.content as Array<{ type: string; text?: string; [k: string]: unknown }>;
					const lastTextIdx = contentArr.reduce((acc, c, i) => c.type === "text" ? i : acc, -1);
					const wrapped = contentArr.map((c, i) => {
						if (c.type !== "text") return c;
						let text = c.text ?? "";
						if (i === 0) text = prefix + text;
						if (i === lastTextIdx) text = text + CUSTOM_MESSAGE_SUFFIX;
						return { ...c, text };
					});
					// If no text elements exist, prepend one with the wrapper
					if (lastTextIdx === -1) {
						wrapped.unshift({ type: "text" as const, text: prefix + CUSTOM_MESSAGE_SUFFIX });
					}
					return {
						role: "user",
						content: wrapped as typeof m.content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
