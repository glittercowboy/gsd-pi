/**
 * TTSR Extension — Time Traveling Stream Rules
 *
 * Zero-context-cost guardrails that monitor streaming output against regex
 * patterns. On match: abort stream, inject rule as system reminder, retry.
 * Rules cost nothing until they fire.
 *
 * Hooks:
 *   session_start  → load rules, populate manager
 *   turn_start     → reset buffers
 *   message_update → check delta against rules, abort on match
 *   turn_end       → increment message count
 *   agent_end      → if pending violation, inject rule via sendMessage
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { AssistantMessageEvent } from "@gsd/pi-ai";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TtsrManager, type Rule, type TtsrMatchContext } from "./ttsr-manager.js";
import { loadRules } from "./rule-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PendingViolation {
	rules: Rule[];
}

function buildInterruptContent(rule: Rule): string {
	const template = readFileSync(join(__dirname, "ttsr-interrupt.md"), "utf-8");
	return template
		.replace("{{name}}", rule.name)
		.replace("{{path}}", rule.path)
		.replace("{{content}}", rule.content);
}

/**
 * Extract match context from an AssistantMessageEvent delta.
 * Returns null for non-delta events.
 */
function extractDeltaContext(
	event: AssistantMessageEvent,
): { delta: string; context: TtsrMatchContext } | null {
	if (event.type === "text_delta") {
		return {
			delta: event.delta,
			context: { source: "text", streamKey: "text" },
		};
	}
	if (event.type === "thinking_delta") {
		return {
			delta: event.delta,
			context: { source: "thinking", streamKey: "thinking" },
		};
	}
	if (event.type === "toolcall_delta") {
		// Extract tool name and file paths from the partial message
		const partial = event.partial;
		const contentBlock = partial?.content?.[event.contentIndex];
		const toolName = contentBlock && "name" in contentBlock ? (contentBlock as any).name : undefined;

		// Try to extract file paths from partial JSON arguments
		const filePaths: string[] = [];
		if (contentBlock && "partialJson" in contentBlock) {
			const json = (contentBlock as any).partialJson as string | undefined;
			if (json) {
				// Look for file_path or path in partial JSON
				const pathMatch = json.match(/"(?:file_path|path)"\s*:\s*"([^"]+)"/);
				if (pathMatch) filePaths.push(pathMatch[1]);
			}
		}

		return {
			delta: event.delta,
			context: {
				source: "tool",
				toolName,
				filePaths: filePaths.length > 0 ? filePaths : undefined,
				streamKey: `toolcall:${event.contentIndex}`,
			},
		};
	}
	return null;
}

// Re-exports for external consumers
export { TtsrManager } from "./ttsr-manager.js";
export type { Rule, TtsrMatchContext } from "./ttsr-manager.js";
export { loadRules } from "./rule-loader.js";

export default function (pi: ExtensionAPI) {
	let manager: TtsrManager | null = null;
	let pendingViolation: PendingViolation | null = null;

	// ── session_start: load rules, populate manager ─────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const rules = loadRules(ctx.cwd);
		if (rules.length === 0) {
			manager = null;
			return;
		}

		manager = new TtsrManager();
		let loaded = 0;
		for (const rule of rules) {
			if (manager.addRule(rule)) loaded++;
		}

		if (loaded === 0) {
			manager = null;
		}
	});

	// ── turn_start: reset buffers ───────────────────────────────────────
	pi.on("turn_start", async () => {
		if (!manager) return;
		manager.resetBuffer();
		pendingViolation = null;
	});

	// ── message_update: check delta against rules ───────────────────────
	pi.on("message_update", async (event, ctx) => {
		if (!manager || !manager.hasRules()) return;
		if (pendingViolation) return; // Already matched, waiting for agent_end

		const extracted = extractDeltaContext(event.assistantMessageEvent);
		if (!extracted) return;

		const { delta, context } = extracted;
		const matches = manager.checkDelta(delta, context);
		if (matches.length === 0) return;

		// Match found — set pending violation and abort
		pendingViolation = { rules: matches };
		manager.markInjected(matches);
		ctx.abort();
	});

	// ── turn_end: increment message count ───────────────────────────────
	pi.on("turn_end", async () => {
		if (!manager) return;
		manager.incrementMessageCount();
	});

	// ── agent_end: inject violation if pending ──────────────────────────
	pi.on("agent_end", async () => {
		if (!manager || !pendingViolation) return;

		const violation = pendingViolation;
		pendingViolation = null;

		// Build interrupt content for all matching rules
		const interruptParts = violation.rules.map(buildInterruptContent);
		const fullInterrupt = interruptParts.join("\n\n");

		// Inject as a message that triggers a new turn
		pi.sendMessage(
			{
				customType: "ttsr-violation",
				content: fullInterrupt,
				display: false,
			},
			{ triggerTurn: true },
		);
	});
}
