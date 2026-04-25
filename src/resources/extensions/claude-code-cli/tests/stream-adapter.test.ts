import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	makeStreamExhaustedErrorMessage,
	getResultErrorMessage,
	makeAbortedMessage,
	mergePendingToolCalls,
	buildFinalAssistantContent,
	resolveClaudePermissionMode,
	buildPromptFromContext,
	buildSdkQueryPrompt,
	buildSdkOptions,
	createClaudeCodeCanUseToolHandler,
	buildBashPermissionPattern,
	buildBashPermissionPatternOptions,
	bashCommandMatchesSavedRules,
	createClaudeCodeElicitationHandler,
	extractImageBlocksFromContext,
	extractToolResultsFromSdkUserMessage,
	getClaudeLookupCommand,
	parseAskUserQuestionsElicitation,
	parseTextInputElicitation,
	parseClaudeLookupOutput,
	resolveBundledClaudeCliPath,
	normalizeClaudePathForSdk,
	roundResultToElicitationContent,
} from "../stream-adapter.ts";
import type { AssistantMessage, Context, Message } from "@gsd/pi-ai";
import type { SDKUserMessage } from "../sdk-types.ts";

// ---------------------------------------------------------------------------
// Env helpers — `GSD_WORKFLOW_MCP_*` save/restore
//
// The naive pattern `process.env.X = prev.X` breaks when `prev.X` is
// undefined: Node coerces the assignment to the literal string
// "undefined", which then pollutes subsequent tests that read the var
// and assume it's absent. Issue #4808 documents the resulting bleed.
//
// `setWorkflowMcpEnv` returns a `restore()` closure that either
// re-assigns the previous string value OR `delete`s the key when the
// original was absent. Call in a try/finally; restore in the finally.
// ---------------------------------------------------------------------------

const WORKFLOW_MCP_ENV_KEYS = [
	"GSD_WORKFLOW_MCP_COMMAND",
	"GSD_WORKFLOW_MCP_NAME",
	"GSD_WORKFLOW_MCP_ARGS",
	"GSD_WORKFLOW_MCP_ENV",
	"GSD_WORKFLOW_MCP_CWD",
] as const;

type WorkflowMcpEnvKey = (typeof WORKFLOW_MCP_ENV_KEYS)[number];

function setWorkflowMcpEnv(
	values: Partial<Record<WorkflowMcpEnvKey, string>>,
): () => void {
	const prev: Partial<Record<WorkflowMcpEnvKey, string | undefined>> = {};
	for (const key of WORKFLOW_MCP_ENV_KEYS) {
		prev[key] = process.env[key];
	}
	for (const [key, value] of Object.entries(values)) {
		process.env[key] = value;
	}
	return function restore() {
		for (const key of WORKFLOW_MCP_ENV_KEYS) {
			const previous = prev[key];
			if (previous === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous;
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Existing tests — exhausted stream fallback (#2575)
// ---------------------------------------------------------------------------

describe("stream-adapter — exhausted stream fallback (#2575)", () => {
	test("generator exhaustion becomes an error message instead of clean completion", () => {
		const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "partial answer");

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "stream_exhausted_without_result");
		assert.deepEqual(message.content, [{ type: "text", text: "partial answer" }]);
	});

	test("generator exhaustion without prior text still exposes a classifiable error", () => {
		const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "");

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "stream_exhausted_without_result");
		assert.match(String((message.content[0] as any)?.text ?? ""), /Claude Code error: stream_exhausted_without_result/);
	});
});

describe("stream-adapter — result error text (#3776)", () => {
	test("prefers SDK result text when an error arrives with subtype success", () => {
		const message = getResultErrorMessage({
			type: "result",
			subtype: "success",
			uuid: "uuid-1",
			session_id: "session-1",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		});

		assert.match(message, /API Error: 529/);
		assert.doesNotMatch(message, /^success$/i);
	});

	test("falls back to a stable classifier when success errors have no text", () => {
		const message = getResultErrorMessage({
			type: "result",
			subtype: "success",
			uuid: "uuid-2",
			session_id: "session-2",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			result: "   ",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		});

		assert.equal(message, "claude_code_request_failed");
	});
});

// ---------------------------------------------------------------------------
// Bug #2859 — stateless provider regression tests
// ---------------------------------------------------------------------------

describe("stream-adapter — full context prompt (#2859)", () => {
	test("buildPromptFromContext includes all user and assistant messages, not just the last user message", () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "What is 2+2?" } as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "4" }],
					api: "anthropic-messages",
					provider: "claude-code",
					model: "claude-sonnet-4-20250514",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as Message,
				{ role: "user", content: "Now multiply that by 3" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);

		// Must contain content from BOTH user messages, not just the last
		assert.ok(prompt.includes("2+2"), "prompt must include first user message");
		assert.ok(prompt.includes("multiply"), "prompt must include second user message");
		// Must contain assistant response for continuity
		assert.ok(prompt.includes("4"), "prompt must include assistant reply for context");
	});

	test("buildPromptFromContext includes system prompt when present", () => {
		const context: Context = {
			systemPrompt: "You are a coding assistant.",
			messages: [
				{ role: "user", content: "Write a function" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);
		assert.ok(prompt.includes("coding assistant"), "prompt must include system prompt");
	});

	test("buildPromptFromContext handles array content parts in user messages", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "First part" },
						{ type: "text", text: "Second part" },
					],
				} as Message,
				{ role: "user", content: "Follow-up" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);
		assert.ok(prompt.includes("First part"), "prompt must include array content parts");
		assert.ok(prompt.includes("Second part"), "prompt must include all text parts");
		assert.ok(prompt.includes("Follow-up"), "prompt must include follow-up message");
	});

	test("buildPromptFromContext returns empty string for empty messages", () => {
		const context: Context = { messages: [] };
		const prompt = buildPromptFromContext(context);
		assert.equal(prompt, "");
	});
});

describe("stream-adapter — image prompt forwarding (#4183)", () => {
	test("extractImageBlocksFromContext maps user image parts to Anthropic base64 image blocks", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{
							type: "image",
							data: "data:image/png;base64,abc123",
							mimeType: "image/png",
						},
					],
				} as Message,
			],
		};

		const imageBlocks = extractImageBlocksFromContext(context);
		assert.deepEqual(imageBlocks, [
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "abc123",
				},
			},
		]);
	});

	test("buildSdkQueryPrompt returns plain string when no images exist in context", () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello" } as Message],
		};
		const textPrompt = buildPromptFromContext(context);

		const prompt = buildSdkQueryPrompt(context, textPrompt);
		assert.equal(typeof prompt, "string");
		assert.equal(prompt, textPrompt);
	});

	test("buildSdkQueryPrompt wraps images and prompt text in an SDK user message iterable", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg" },
						{ type: "text", text: "What is in this image?" },
					],
				} as Message,
			],
		};
		const textPrompt = buildPromptFromContext(context);

		const prompt = buildSdkQueryPrompt(context, textPrompt);
		assert.notEqual(typeof prompt, "string");
		assert.ok(prompt && typeof (prompt as any)[Symbol.asyncIterator] === "function");

		const messages: any[] = [];
		for await (const item of prompt as AsyncIterable<any>) {
			messages.push(item);
		}
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0], {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "ZmFrZQ==",
						},
					},
					{ type: "text", text: textPrompt },
				],
			},
			parent_tool_use_id: null,
		});
	});
});

// ---------------------------------------------------------------------------
// Bug #4102 — transcript fabrication regression tests
// ---------------------------------------------------------------------------

describe("stream-adapter — no transcript fabrication (#4102)", () => {
	test("buildPromptFromContext never emits forbidden [User]/[Assistant] bracket headers", () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "First" } as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "Second" }],
					api: "anthropic-messages",
					provider: "claude-code",
					model: "claude-sonnet-4-20250514",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as Message,
				{ role: "user", content: "Third" } as Message,
			],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(!prompt.includes("[User]"), "prompt must not include literal [User] bracket header");
		assert.ok(!prompt.includes("[Assistant]"), "prompt must not include literal [Assistant] bracket header");
		assert.ok(!prompt.includes("[System]"), "prompt must not include literal [System] bracket header");
	});

	test("buildPromptFromContext wraps history in XML-tag structure", () => {
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [
				{ role: "user", content: "Hello" } as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there" }],
					api: "anthropic-messages",
					provider: "claude-code",
					model: "claude-sonnet-4-20250514",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as Message,
			],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(prompt.includes("<conversation_history>"), "prompt must wrap history in <conversation_history>");
		assert.ok(prompt.includes("</conversation_history>"), "prompt must close <conversation_history>");
		assert.ok(prompt.includes("<user_message>\nHello\n</user_message>"), "user turn must use <user_message> tags");
		assert.ok(prompt.includes("<assistant_message>\nHi there\n</assistant_message>"), "assistant turn must use <assistant_message> tags");
		assert.ok(prompt.includes("<prior_system_context>\nYou are helpful.\n</prior_system_context>"), "system prompt must use <prior_system_context> tags");
	});

	test("buildPromptFromContext includes a do-not-echo-tags directive as primary instruction", () => {
		const context: Context = {
			messages: [{ role: "user", content: "Anything" } as Message],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(
			prompt.startsWith("Respond only to the final user message"),
			"primary directive must lead the prompt",
		);
		assert.ok(prompt.includes("Do not emit <user_message>"), "directive must forbid emitting user_message tag");
		assert.ok(prompt.includes("<assistant_message>"), "directive must mention assistant_message tag");
	});

	test("buildPromptFromContext omits <conversation_history> when there are no messages but a system prompt", () => {
		const context: Context = {
			systemPrompt: "Seed",
			messages: [],
		};

		const prompt = buildPromptFromContext(context);

		assert.ok(prompt.includes("<prior_system_context>"), "system prompt must still render");
		assert.ok(!prompt.includes("<conversation_history>"), "no history wrapper when messages are empty");
	});

	test("buildPromptFromContext still returns empty string when context is entirely empty", () => {
		const context: Context = { messages: [] };
		const prompt = buildPromptFromContext(context);
		assert.equal(prompt, "", "empty context must not emit a bare directive");
	});
});

describe("stream-adapter — Claude Code external tool results", () => {
	test("extractToolResultsFromSdkUserMessage maps tool_result content to tool payloads", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-bash-1",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-bash-1",
						content: "line 1\nline 2",
						is_error: false,
					},
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results, [
			{
				toolUseId: "tool-bash-1",
				result: {
					content: [{ type: "text", text: "line 1\nline 2" }],
					// extractStructuredDetailsFromBlock returns undefined when no
					// structured payload exists, restoring the pre-#4477 nullable
					// contract (#4477 review feedback).
					details: undefined,
					isError: false,
				},
			},
		]);
	});

	test("extractToolResultsFromSdkUserMessage reads structuredContent as a sibling field (#4472)", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-mcp-1",
			message: {
				role: "user",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "tool-mcp-1",
						content: [{ type: "text", text: "Gate Q3 result saved: verdict=pass" }],
						is_error: false,
						structuredContent: { gateId: "Q3", verdict: "pass" },
					} as unknown as Record<string, unknown>,
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results[0].result.details, { gateId: "Q3", verdict: "pass" });
	});

	test("extractToolResultsFromSdkUserMessage reads structuredContent from a content sub-block (#4472)", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-mcp-2",
			message: {
				role: "user",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "tool-mcp-2",
						content: [
							{ type: "text", text: "Gate Q4 result saved: verdict=flag" },
							{ type: "structuredContent", structuredContent: { gateId: "Q4", verdict: "flag" } },
						],
						is_error: false,
					} as unknown as Record<string, unknown>,
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results[0].result.details, { gateId: "Q4", verdict: "flag" });
	});

	test("#4477 extractToolResultsFromSdkUserMessage does NOT leak structuredContent pseudo-blocks into visible content", () => {
		// Regression: when a content sub-block carries `type: "structuredContent"`,
		// it carries the structured payload (extracted separately into `details`)
		// and must NOT appear in the visible `content` array — otherwise the
		// renderer stringifies the JSON pseudo-block and shows it next to the
		// actual tool output. See PR #4477 review (CodeRabbit, post-fix-round).
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-mcp-strip",
			message: {
				role: "user",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "tool-mcp-strip",
						content: [
							{ type: "text", text: "Gate Q5 result saved: verdict=pass" },
							{ type: "structuredContent", structuredContent: { gateId: "Q5", verdict: "pass" } },
							{ type: "text", text: "second visible line" },
							// snake_case variant — also a pseudo-block; also must be stripped
							{ type: "structured_content", structured_content: { extra: "data" } },
						],
						is_error: false,
					} as unknown as Record<string, unknown>,
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.equal(results.length, 1, "should extract one result");
		const result = results[0].result;

		// The structured payload IS extracted to `details`.
		assert.deepEqual(result.details, { gateId: "Q5", verdict: "pass" });

		// The visible content has the two text blocks but NEITHER pseudo-block.
		const visibleTexts = result.content.map((c: any) => c.text);
		assert.deepEqual(
			visibleTexts,
			["Gate Q5 result saved: verdict=pass", "second visible line"],
			"visible content must include only the two text blocks; both structuredContent variants must be stripped",
		);

		// Belt-and-suspenders: assert no rendered text shows the JSON serialization
		// of a pseudo-block. We don't check for bare keys like "gateId" or "verdict"
		// because those are legitimate words in the gate-result message text. The
		// regression signature would be a JSON-shaped substring that could only
		// appear via stringification.
		const allText = visibleTexts.join("\n");
		assert.ok(
			!allText.includes('"structuredContent"'),
			"rendered content must not include the pseudo-block type marker as JSON text",
		);
		assert.ok(
			!allText.includes('"structured_content"'),
			"rendered content must not include the snake_case pseudo-block type marker as JSON text",
		);
	});

	test("extractToolResultsFromSdkUserMessage accepts snake_case structured_content defensively (#4472)", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-mcp-3",
			message: {
				role: "user",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "tool-mcp-3",
						content: [{ type: "text", text: "ok" }],
						structured_content: { operation: "save_gate_result" },
					} as unknown as Record<string, unknown>,
				],
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results[0].result.details, { operation: "save_gate_result" });
	});

	test("extractToolResultsFromSdkUserMessage falls back to tool_use_result", () => {
		const message: SDKUserMessage = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tool-read-1",
			message: { role: "user", content: [] },
			tool_use_result: {
				tool_use_id: "tool-read-1",
				content: "file contents",
				is_error: true,
			},
		};

		const results = extractToolResultsFromSdkUserMessage(message);
		assert.deepEqual(results, [
			{
				toolUseId: "tool-read-1",
				result: {
					content: [{ type: "text", text: "file contents" }],
					// undefined (not {}) per the restored nullable contract — see
					// the analogous assertion in the tool_result test above.
					details: undefined,
					isError: true,
				},
			},
		]);
	});

	test("buildFinalAssistantContent preserves intermediate tool calls with attached external results", () => {
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [
				{
					type: "toolCall",
					id: "tool-bash-1",
					name: "bash",
					arguments: { command: "echo hi" },
				} as any,
			],
			pendingContent: [{ type: "text", text: "All done." }],
			toolResultsById: new Map([
				[
					"tool-bash-1",
					{
						content: [{ type: "text", text: "hi\n" }],
						details: { source: "claude-code" },
						isError: false,
					},
				],
			]),
		});

		assert.equal(finalContent[0]?.type, "toolCall");
		assert.deepEqual((finalContent[0] as any).externalResult, {
			content: [{ type: "text", text: "hi\n" }],
			details: { source: "claude-code" },
			isError: false,
		});
		assert.deepEqual(finalContent[1], { type: "text", text: "All done." });
	});

	test("buildFinalAssistantContent keeps final-turn tool calls when result arrives without a synthetic user boundary", () => {
		const finalContent = buildFinalAssistantContent({
			intermediateToolBlocks: [],
			pendingContent: [
				{
					type: "toolCall",
					id: "tool-read-1",
					name: "read",
					arguments: { path: "README.md" },
				} as any,
				{ type: "text", text: "Read complete." },
			],
			toolResultsById: new Map([
				[
					"tool-read-1",
					{
						content: [{ type: "text", text: "file contents" }],
						details: { path: "README.md" },
						isError: false,
					},
				],
			]),
		});

		assert.equal(finalContent[0]?.type, "toolCall");
		assert.deepEqual((finalContent[0] as any).externalResult, {
			content: [{ type: "text", text: "file contents" }],
			details: { path: "README.md" },
			isError: false,
		});
		assert.deepEqual(finalContent[1], { type: "text", text: "Read complete." });
	});
});

describe("stream-adapter — session persistence (#2859)", () => {
	test("buildSdkOptions enables persistSession by default", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
		assert.equal(options.persistSession, true, "persistSession must default to true");
	});

	test("buildSdkOptions sets model and prompt correctly", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world");
		assert.equal(options.model, "claude-sonnet-4-20250514");
	});

	test("buildSdkOptions enables betas for sonnet models", () => {
		const sonnetOpts = buildSdkOptions("claude-sonnet-4-20250514", "test");
		assert.ok(
			Array.isArray(sonnetOpts.betas) && sonnetOpts.betas.length > 0,
			"sonnet models should have betas enabled",
		);

		const opusOpts = buildSdkOptions("claude-opus-4-20250514", "test");
		assert.ok(
			Array.isArray(opusOpts.betas) && opusOpts.betas.length === 0,
			"non-sonnet models should have empty betas",
		);
	});

	test("buildSdkOptions enables context-1m beta for opus-4-7 (#4348)", () => {
		const opts = buildSdkOptions("claude-opus-4-7", "test");
		assert.ok(
			Array.isArray(opts.betas) && opts.betas.includes("context-1m-2025-08-07"),
			"claude-opus-4-7 should have context-1m beta enabled for 1M token context window",
		);
	});

	test("buildSdkOptions maps reasoning to effort for adaptive Claude Code models (#3917)", () => {
		const options = buildSdkOptions("claude-sonnet-4-6", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high");
	});

	test("buildSdkOptions upgrades xhigh reasoning to max for opus 4.6 (#3917)", () => {
		const options = buildSdkOptions("claude-opus-4-6", "test", undefined, { reasoning: "xhigh" });
		assert.equal(options.effort, "max");
	});

	test("buildSdkOptions maps reasoning to effort for opus-4-7 (#4348)", () => {
		const options = buildSdkOptions("claude-opus-4-7", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high");
	});

	test("buildSdkOptions passes xhigh reasoning natively for opus-4-7 (#4348)", () => {
		const options = buildSdkOptions("claude-opus-4-7", "test", undefined, { reasoning: "xhigh" });
		assert.equal(options.effort, "xhigh");
	});

	test("buildSdkOptions omits effort when reasoning is undefined (#3917)", () => {
		const options = buildSdkOptions("claude-sonnet-4-6", "test");
		assert.equal("effort" in options, false);
	});

	test("buildSdkOptions omits effort for non-adaptive Claude models (#3917)", () => {
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { reasoning: "high" });
		assert.equal("effort" in options, false);
	});

	// --- Bug fixes #4392: thinking field & model coverage ---

	test("buildSdkOptions sets thinking disabled when reasoning is undefined on adaptive model (#4392)", () => {
		// Bug C: thinkingLevel="off" means reasoning===undefined; SDK needs thinking:{type:"disabled"}
		const options = buildSdkOptions("claude-sonnet-4-6", "test", undefined, {});
		assert.deepEqual(
			(options as any).thinking,
			{ type: "disabled" },
			"thinking must be {type:'disabled'} when reasoning is undefined so SDK stops adaptive thinking",
		);
	});

	test("buildSdkOptions omits effort when reasoning is undefined (thinking disabled) (#4392)", () => {
		// Bug C corollary: no effort when thinking is off
		const options = buildSdkOptions("claude-sonnet-4-6", "test", undefined, {});
		assert.equal("effort" in options, false, "effort must not be set when reasoning is undefined");
	});

	test("buildSdkOptions sets thinking adaptive when reasoning is provided (#4392)", () => {
		// Bug B: when effort is set, thinking:{type:"adaptive"} must also be present
		const options = buildSdkOptions("claude-opus-4-6", "test", undefined, { reasoning: "high" });
		assert.deepEqual(
			(options as any).thinking,
			{ type: "adaptive" },
			"thinking must be {type:'adaptive'} alongside effort when reasoning is set",
		);
	});

	test("buildSdkOptions includes both effort and thinking.type=adaptive when reasoning is set (#4392)", () => {
		// Bug B: both fields must be present together
		const options = buildSdkOptions("claude-opus-4-6", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "effort must be set");
		assert.deepEqual((options as any).thinking, { type: "adaptive" }, "thinking must be adaptive");
	});

	test("buildSdkOptions maps reasoning to effort for sonnet-4-7 (modelSupportsAdaptiveThinking #4392)", () => {
		// Bug D: sonnet-4-7 was missing from modelSupportsAdaptiveThinking
		const options = buildSdkOptions("claude-sonnet-4-7", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "sonnet-4-7 must support adaptive thinking and map effort");
	});

	test("buildSdkOptions maps reasoning to effort for haiku-4-5 (modelSupportsAdaptiveThinking #4392)", () => {
		// Bug D: haiku-4-5 was missing from modelSupportsAdaptiveThinking
		const options = buildSdkOptions("claude-haiku-4-5", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "haiku-4-5 must support adaptive thinking and map effort");
	});

	test("buildSdkOptions maps reasoning to effort for sonnet-4.7 dot-form (modelSupportsAdaptiveThinking #4392)", () => {
		// Dot-form aliases (e.g. claude-sonnet-4.7) must also be recognised
		const options = buildSdkOptions("claude-sonnet-4.7", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "claude-sonnet-4.7 must support adaptive thinking and map effort");
	});

	test("buildSdkOptions maps reasoning to effort for haiku-4.5 dot-form (modelSupportsAdaptiveThinking #4392)", () => {
		// Dot-form aliases (e.g. claude-haiku-4.5) must also be recognised
		const options = buildSdkOptions("claude-haiku-4.5", "test", undefined, { reasoning: "high" });
		assert.equal(options.effort, "high", "claude-haiku-4.5 must support adaptive thinking and map effort");
	});

	test("buildSdkOptions does not set thinking field for non-adaptive model when reasoning is undefined (#4392)", () => {
		// Non-adaptive models (e.g. claude-sonnet-4-20250514) don't use the thinking API at all;
		// no thinking field should be set when reasoning is undefined
		const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, {});
		assert.equal("thinking" in options, false, "non-adaptive models must not receive a thinking field");
	});

	test("buildSdkOptions includes workflow MCP server config when env is set", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		try {

			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["gsd-workflow"], "expected gsd-workflow server config");
			const srv = mcpServers["gsd-workflow"];
			assert.equal(srv.command, "node");
			assert.deepEqual(srv.args, ["packages/mcp-server/dist/cli.js"]);
			assert.equal(srv.cwd, "/tmp/project");
			assert.equal(srv.env.GSD_CLI_PATH, "/tmp/gsd");
			assert.equal(srv.env.GSD_PERSIST_WRITE_GATE_STATE, "1");
			assert.equal(srv.env.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
			assert.deepEqual(options.disallowedTools, []);
			assert.deepEqual(options.allowedTools, [
				"Read",
				"Write",
				"Edit",
				"Glob",
				"Grep",
				"Bash",
				"Agent",
				"WebFetch",
				"WebSearch",
				"AskUserQuestion",
				"mcp__gsd-workflow__*",
			]);
		} finally {
			restore();
		}
	});

	test("buildSdkOptions auto-approves every tool for custom workflow MCP server names", () => {
		const restore = setWorkflowMcpEnv({
			GSD_WORKFLOW_MCP_COMMAND: "node",
			GSD_WORKFLOW_MCP_NAME: "custom-workflow",
			GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
			GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
			GSD_WORKFLOW_MCP_CWD: "/tmp/project",
		});
		try {

			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["custom-workflow"], "expected custom workflow server config");
			assert.deepEqual(options.disallowedTools, []);
			assert.deepEqual(options.allowedTools, [
				"Read",
				"Write",
				"Edit",
				"Glob",
				"Grep",
				"Bash",
				"Agent",
				"WebFetch",
				"WebSearch",
				"AskUserQuestion",
				"mcp__custom-workflow__*",
			]);
		} finally {
			restore();
		}
	});

	test("buildSdkOptions auto-discovers bundled MCP server even without env hints", () => {
		// Use setWorkflowMcpEnv with no values to save current state;
		// restore() in finally will put it back correctly (including
		// deleting any keys that started as undefined — the #4808 bug
		// the naive `process.env.X = prev.X` pattern introduced).
		const restore = setWorkflowMcpEnv({});
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;

			const originalCwd = process.cwd();
			const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-none-"));
			process.chdir(emptyDir);
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			process.chdir(originalCwd);
			// The bundled CLI may or may not be discoverable depending on
			// whether the build output exists relative to import.meta.url.
			// Either outcome is valid — the key invariant is no crash.
			const mcpServers = (options as any).mcpServers;
			if (mcpServers) {
				assert.ok(mcpServers["gsd-workflow"], "if present, must be gsd-workflow");
				assert.deepEqual((options as any).disallowedTools, []);
			} else {
				assert.deepEqual((options as any).disallowedTools, []);
			}
			rmSync(emptyDir, { recursive: true, force: true });
		} finally {
			restore();
		}
	});

	test("buildSdkOptions auto-detects local workflow MCP dist CLI when present", () => {
		// GSD_CLI_PATH isn't in WORKFLOW_MCP_ENV_KEYS, so save+restore it
		// manually around setWorkflowMcpEnv which handles the MCP keys.
		const prevCliPath = process.env.GSD_CLI_PATH;
		const restore = setWorkflowMcpEnv({});
		const originalCwd = process.cwd();
		const repoDir = mkdtempSync(join(tmpdir(), "claude-mcp-detect-"));
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;
			process.env.GSD_CLI_PATH = "/tmp/gsd";

			const distDir = join(repoDir, "packages", "mcp-server", "dist");
			mkdirSync(distDir, { recursive: true });
			writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\n");
			process.chdir(repoDir);
			const resolvedRepoDir = realpathSync(repoDir);

			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["gsd-workflow"], "expected gsd-workflow server config");
			const srv = mcpServers["gsd-workflow"];
			assert.equal(srv.command, process.execPath);
			assert.deepEqual(srv.args, [realpathSync(resolve(repoDir, "packages", "mcp-server", "dist", "cli.js"))]);
			assert.equal(srv.cwd, resolvedRepoDir);
			assert.equal(srv.env.GSD_CLI_PATH, "/tmp/gsd");
			assert.equal(srv.env.GSD_PERSIST_WRITE_GATE_STATE, "1");
			assert.equal(srv.env.GSD_WORKFLOW_PROJECT_ROOT, resolvedRepoDir);
			assert.deepEqual(options.disallowedTools, []);
		} finally {
			process.chdir(originalCwd);
			rmSync(repoDir, { recursive: true, force: true });
			restore();
			// GSD_CLI_PATH isn't in setWorkflowMcpEnv's scope — restore it here.
			if (prevCliPath === undefined) {
				delete process.env.GSD_CLI_PATH;
			} else {
				process.env.GSD_CLI_PATH = prevCliPath;
			}
		}
	});

	test("buildSdkOptions preserves runtime callbacks such as onElicitation", () => {
		const restore = setWorkflowMcpEnv({});
		const onElicitation = async () => ({ action: "decline" as const });
		try {
			delete process.env.GSD_WORKFLOW_MCP_COMMAND;
			delete process.env.GSD_WORKFLOW_MCP_NAME;
			delete process.env.GSD_WORKFLOW_MCP_ARGS;
			delete process.env.GSD_WORKFLOW_MCP_ENV;
			delete process.env.GSD_WORKFLOW_MCP_CWD;
			const options = buildSdkOptions("claude-sonnet-4-20250514", "test", undefined, { onElicitation });
			assert.equal(options.onElicitation, onElicitation);
		} finally {
			restore();
		}
	});
});

describe("stream-adapter — MCP elicitation bridge", () => {
	const askUserQuestionsRequest = {
		serverName: "gsd-workflow",
		message: "Please answer the following question(s).",
		mode: "form" as const,
		requestedSchema: {
			type: "object" as const,
			properties: {
				storage_scope: {
					type: "string",
					title: "Storage",
					description: "Does this app need to sync across devices?",
					oneOf: [
						{ const: "Local-only (Recommended)", title: "Local-only (Recommended)" },
						{ const: "Cloud-synced", title: "Cloud-synced" },
						{ const: "None of the above", title: "None of the above" },
					],
				},
				storage_scope__note: {
					type: "string",
					title: "Storage Note",
					description: "Optional note for None of the above.",
				},
				platform: {
					type: "array",
					title: "Platform",
					description: "Where should it run?",
					items: {
						anyOf: [
							{ const: "Web", title: "Web" },
							{ const: "Desktop", title: "Desktop" },
							{ const: "Mobile", title: "Mobile" },
						],
					},
				},
			},
		},
	};

	test("parseAskUserQuestionsElicitation rebuilds interview questions from the MCP schema", () => {
		const questions = parseAskUserQuestionsElicitation(askUserQuestionsRequest);
		assert.deepEqual(questions, [
			{
				id: "storage_scope",
				header: "Storage",
				question: "Does this app need to sync across devices?",
				options: [
					{ label: "Local-only (Recommended)", description: "" },
					{ label: "Cloud-synced", description: "" },
				],
				noteFieldId: "storage_scope__note",
			},
			{
				id: "platform",
				header: "Platform",
				question: "Where should it run?",
				options: [
					{ label: "Web", description: "" },
					{ label: "Desktop", description: "" },
					{ label: "Mobile", description: "" },
				],
				allowMultiple: true,
			},
		]);
	});

	test("roundResultToElicitationContent preserves notes for None of the above", () => {
		const questions = parseAskUserQuestionsElicitation(askUserQuestionsRequest);
		assert.ok(questions);

		const content = roundResultToElicitationContent(questions, {
			endInterview: false,
			answers: {
				storage_scope: {
					selected: "None of the above",
					notes: "Needs selective sync later",
				},
				platform: {
					selected: ["Web", "Desktop"],
					notes: "",
				},
			},
		});

		assert.deepEqual(content, {
			storage_scope: "None of the above",
			storage_scope__note: "Needs selective sync later",
			platform: ["Web", "Desktop"],
		});
	});

	test("createClaudeCodeElicitationHandler accepts interview-style answers from custom UI", async () => {
		const handler = createClaudeCodeElicitationHandler({
			custom: async (_factory: any) => ({
				endInterview: false,
				answers: {
					storage_scope: {
						selected: "Cloud-synced",
						notes: "",
					},
					platform: {
						selected: ["Web", "Mobile"],
						notes: "",
					},
				},
			}),
		} as any);

		assert.ok(handler);
		const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
		assert.deepEqual(result, {
			action: "accept",
			content: {
				storage_scope: "Cloud-synced",
				platform: ["Web", "Mobile"],
			},
		});
	});

	test("createClaudeCodeElicitationHandler falls back to dialog prompts when custom UI is unavailable", async () => {
		const ui = {
			custom: async () => undefined,
			select: async (_title: string, options: string[], opts?: { allowMultiple?: boolean }) => {
				if (opts?.allowMultiple) return ["Desktop", "Mobile"];
				return options.includes("None of the above") ? "None of the above" : options[0];
			},
			input: async () => "CLI-only deployment target",
		};
		const handler = createClaudeCodeElicitationHandler(ui as any);
		assert.ok(handler);

		const result = await handler!(askUserQuestionsRequest, { signal: new AbortController().signal });
		assert.deepEqual(result, {
			action: "accept",
			content: {
				storage_scope: "None of the above",
				storage_scope__note: "CLI-only deployment target",
				platform: ["Desktop", "Mobile"],
			},
		});
	});

	test("parseTextInputElicitation recognizes secure free-text MCP forms", () => {
		const request = {
			serverName: "gsd-workflow",
			message: "Enter values for environment variables.",
			mode: "form" as const,
			requestedSchema: {
				type: "object" as const,
				properties: {
					TEST_PASSWORD: {
						type: "string",
						title: "TEST_PASSWORD",
						description: "Format: min 8 characters\nLeave empty to skip.",
					},
					PROJECT_NAME: {
						type: "string",
						title: "PROJECT_NAME",
						description: "Human-readable project name.",
					},
				},
			},
		};

		const parsed = parseTextInputElicitation(request as any);
		assert.deepEqual(parsed, [
			{
				id: "TEST_PASSWORD",
				title: "TEST_PASSWORD",
				description: "Format: min 8 characters\nLeave empty to skip.",
				required: false,
				secure: true,
			},
			{
				id: "PROJECT_NAME",
				title: "PROJECT_NAME",
				description: "Human-readable project name.",
				required: false,
				secure: false,
			},
		]);
	});

	test("parseTextInputElicitation accepts legacy keys schema and skips unsupported fields", () => {
		const request = {
			serverName: "gsd-workflow",
			message: "Enter secure values",
			mode: "form" as const,
			requestedSchema: {
				type: "object" as const,
				keys: {
					API_TOKEN: {
						type: "string",
						title: "API_TOKEN",
						description: "Leave empty to skip.",
					},
					META: {
						type: "object",
						title: "metadata",
					},
				},
			},
		};

		const parsed = parseTextInputElicitation(request as any);
		assert.deepEqual(parsed, [
			{
				id: "API_TOKEN",
				title: "API_TOKEN",
				description: "Leave empty to skip.",
				required: false,
				secure: true,
			},
		]);
	});

	test("createClaudeCodeElicitationHandler collects secure_env_collect fields through input dialogs", async () => {
		const secureRequest = {
			serverName: "gsd-workflow",
			message: "Enter values for environment variables.",
			mode: "form" as const,
			requestedSchema: {
				type: "object" as const,
				properties: {
					TEST_SECURE_FIELD: {
						type: "string",
						title: "TEST_SECURE_FIELD",
						description: "Format: Your secure testing password\nLeave empty to skip.",
					},
				},
			},
		};

		const secureValue = "ui-collected-value";
		const inputCalls: Array<{ opts?: { secure?: boolean } }> = [];
		const handler = createClaudeCodeElicitationHandler({
			input: async (_title: string, _placeholder?: string, opts?: { secure?: boolean }) => {
				inputCalls.push({ opts });
				return secureValue;
			},
		} as any);
		assert.ok(handler);

		const result = await handler!(secureRequest as any, { signal: new AbortController().signal });
		assert.deepEqual(result, {
			action: "accept",
			content: {
				TEST_SECURE_FIELD: secureValue,
			},
		});
		assert.equal(inputCalls.length, 1);
		assert.equal(inputCalls[0]?.opts?.secure, true, "secure_env_collect fields should request secure input");
	});
});

// ---------------------------------------------------------------------------
// F2 — abort vs stream-exhausted classification
// ---------------------------------------------------------------------------

describe("stream-adapter — abort classification (F2)", () => {
	test("makeAbortedMessage sets stopReason to 'aborted', not 'error'", () => {
		const message = makeAbortedMessage("claude-sonnet-4-6", "");
		assert.equal(message.stopReason, "aborted");
		assert.equal(message.errorMessage, undefined);
	});

	test("makeAbortedMessage preserves last-seen text content", () => {
		const message = makeAbortedMessage("claude-sonnet-4-6", "partial mid-stream text");
		assert.deepEqual(message.content, [{ type: "text", text: "partial mid-stream text" }]);
	});

	test("aborted message is distinguishable from stream-exhausted error", () => {
		const aborted = makeAbortedMessage("claude-sonnet-4-6", "");
		const exhausted = makeStreamExhaustedErrorMessage("claude-sonnet-4-6", "");
		assert.notEqual(aborted.stopReason, exhausted.stopReason);
		assert.equal(exhausted.errorMessage, "stream_exhausted_without_result");
	});
});

// ---------------------------------------------------------------------------
// F3 — final-turn tool calls not dropped
// ---------------------------------------------------------------------------

describe("stream-adapter — final-turn tool-call merge (F3)", () => {
	function toolCall(id: string, name = "bash"): AssistantMessage["content"][number] {
		return { type: "toolCall", id, name, arguments: {} };
	}

	test("mergePendingToolCalls appends tool calls not already in intermediate", () => {
		const intermediate: AssistantMessage["content"] = [toolCall("tool-1")];
		const pending: AssistantMessage["content"] = [
			toolCall("tool-2"),
			{ type: "text", text: "trailing text" },
		];
		const merged = mergePendingToolCalls(intermediate, pending);
		assert.equal(merged.length, 2);
		assert.equal((merged[0] as any).id, "tool-1");
		assert.equal((merged[1] as any).id, "tool-2");
	});

	test("mergePendingToolCalls is idempotent across duplicate ids", () => {
		const intermediate: AssistantMessage["content"] = [toolCall("tool-1")];
		const pending: AssistantMessage["content"] = [toolCall("tool-1"), toolCall("tool-2")];
		const merged = mergePendingToolCalls(intermediate, pending);
		assert.equal(merged.length, 2);
		assert.deepEqual(
			merged.map((b) => (b as any).id),
			["tool-1", "tool-2"],
		);
	});

	test("mergePendingToolCalls ignores non-toolCall blocks from pending", () => {
		const intermediate: AssistantMessage["content"] = [];
		const pending: AssistantMessage["content"] = [
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "pondering" },
			toolCall("tool-1"),
		];
		const merged = mergePendingToolCalls(intermediate, pending);
		assert.equal(merged.length, 1);
		assert.equal((merged[0] as any).id, "tool-1");
	});
});

// ---------------------------------------------------------------------------
// F10 — permission mode is configurable
// ---------------------------------------------------------------------------

describe("stream-adapter — permission mode (F10)", () => {
	// Earlier tests in this file set GSD_WORKFLOW_MCP_* env vars and restore
	// them by reassigning from `prev.*`. When `prev.*` was undefined, node
	// coerces the assignment to the literal string "undefined", which then
	// fails JSON.parse inside buildWorkflowMcpServers. Clear the relevant
	// slots before each permission-mode test so buildSdkOptions doesn't throw.
	function clearWorkflowMcpEnv(): void {
		for (const key of [
			"GSD_WORKFLOW_MCP_COMMAND",
			"GSD_WORKFLOW_MCP_NAME",
			"GSD_WORKFLOW_MCP_ARGS",
			"GSD_WORKFLOW_MCP_ENV",
			"GSD_WORKFLOW_MCP_CWD",
		]) {
			if (process.env[key] === undefined || process.env[key] === "undefined") {
				delete process.env[key];
			}
		}
	}

	test("buildSdkOptions defaults to bypassPermissions (globally unblocks all tools)", () => {
		clearWorkflowMcpEnv();
		const opts = buildSdkOptions("claude-sonnet-4-6", "test");
		assert.equal(opts.permissionMode, "bypassPermissions");
		assert.equal(
			opts.allowDangerouslySkipPermissions,
			true,
			"allowDangerouslySkipPermissions must be true when permissionMode is bypassPermissions",
		);
	});

	test("buildSdkOptions respects explicit acceptEdits override", () => {
		clearWorkflowMcpEnv();
		const opts = buildSdkOptions("claude-sonnet-4-6", "test", { permissionMode: "acceptEdits" });
		assert.equal(opts.permissionMode, "acceptEdits");
		assert.equal(
			opts.allowDangerouslySkipPermissions,
			false,
			"allowDangerouslySkipPermissions must be false for non-bypass modes",
		);
	});

	test("resolveClaudePermissionMode defaults to bypassPermissions when no env var is set (globally unblocks all tools)", async () => {
		const mode = await resolveClaudePermissionMode({});
		assert.equal(mode, "bypassPermissions");
	});

	test("resolveClaudePermissionMode honours the GSD_CLAUDE_CODE_PERMISSION_MODE env override", async () => {
		const env = { GSD_CLAUDE_CODE_PERMISSION_MODE: "acceptEdits" } as NodeJS.ProcessEnv;
		const mode = await resolveClaudePermissionMode(env);
		assert.equal(mode, "acceptEdits");
	});

	test("resolveClaudePermissionMode rejects unknown override values (fallback path)", async () => {
		const env = { GSD_CLAUDE_CODE_PERMISSION_MODE: "nonsense" } as NodeJS.ProcessEnv;
		const mode = await resolveClaudePermissionMode(env);
		// Unknown override falls back to auto-detect → either bypass or acceptEdits
		assert.ok(
			mode === "bypassPermissions" || mode === "acceptEdits",
			`expected bypass or acceptEdits, got ${mode}`,
		);
	});

	test("resolveClaudePermissionMode flips to bypassPermissions when GSD_HEADLESS=1 (#4657)", async () => {
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			const env = { GSD_HEADLESS: "1" } as NodeJS.ProcessEnv;
			const mode = await resolveClaudePermissionMode(env);
			assert.equal(mode, "bypassPermissions");
		} finally {
			console.warn = originalWarn;
		}
	});

	test("resolveClaudePermissionMode: explicit override wins over GSD_HEADLESS=1", async () => {
		const env = {
			GSD_HEADLESS: "1",
			GSD_CLAUDE_CODE_PERMISSION_MODE: "acceptEdits",
		} as NodeJS.ProcessEnv;
		const mode = await resolveClaudePermissionMode(env);
		assert.equal(mode, "acceptEdits");
	});
});

describe("stream-adapter — Windows Claude path lookup (#3770)", () => {
	test("getClaudeLookupCommand uses where on Windows", () => {
		assert.equal(getClaudeLookupCommand("win32"), "where claude");
	});

	test("getClaudeLookupCommand uses which on non-Windows platforms", () => {
		assert.equal(getClaudeLookupCommand("darwin"), "which claude");
		assert.equal(getClaudeLookupCommand("linux"), "which claude");
	});

	test("parseClaudeLookupOutput prefers .exe on win32 when where output includes shims", () => {
		const output = [
			"C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude",
			"C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude.cmd",
			"C:\\Program Files\\Claude\\claude.exe",
		].join("\r\n");
		assert.equal(parseClaudeLookupOutput(output, "win32"), "C:\\Program Files\\Claude\\claude.exe");
	});

	test("parseClaudeLookupOutput keeps first line on non-win32 platforms", () => {
		const output = "/usr/local/bin/claude\n/opt/homebrew/bin/claude\n";
		assert.equal(parseClaudeLookupOutput(output, "darwin"), "/usr/local/bin/claude");
	});

	test("normalizeClaudePathForSdk swaps Windows shim paths to bundled cli.js", () => {
		const shimPath = "C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude";
		const bundled = "C:\\repo\\node_modules\\@anthropic-ai\\claude-agent-sdk\\cli.js";
		assert.equal(normalizeClaudePathForSdk(shimPath, "win32", bundled), bundled);
		assert.equal(normalizeClaudePathForSdk("C:\\Program Files\\Claude\\claude.exe", "win32", bundled), "C:\\Program Files\\Claude\\claude.exe");
	});

	test("resolveBundledClaudeCliPath returns a .js path when SDK package is present", () => {
		const resolved = resolveBundledClaudeCliPath();
		assert.ok(resolved, "expected sdk cli.js to be resolvable in test workspace");
		assert.match(resolved!, /[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]cli\.js$/);
	});
});

// ---------------------------------------------------------------------------
// canUseTool handler (#4383)
// ---------------------------------------------------------------------------

describe("stream-adapter — canUseTool handler", () => {
	function makeOptions(overrides: Partial<{ signal: AbortSignal; suggestions: Array<Record<string, unknown>>; title: string; description: string; toolUseID: string }> = {}) {
		return {
			signal: overrides.signal ?? new AbortController().signal,
			toolUseID: overrides.toolUseID ?? "toolu_test123",
			...(overrides.title !== undefined ? { title: overrides.title } : {}),
			...(overrides.description !== undefined ? { description: overrides.description } : {}),
			...(overrides.suggestions !== undefined ? { suggestions: overrides.suggestions } : {}),
		};
	}

	// Point process.cwd() at an empty temp dir so the real repo's
	// .claude/settings.local.json (which may already contain rules like
	// "Bash(gh pr list:*)") does not short-circuit the permission flow.
	// Returns a cleanup function that restores cwd and removes the temp dir.
	// biome-ignore lint/suspicious/noExplicitAny: test-only monkey-patch
	function withIsolatedCwd(): () => void {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-canusetool-")));
		const orig = process.cwd;
		process.cwd = () => dir;
		return () => {
			process.cwd = orig;
			rmSync(dir, { recursive: true, force: true });
		};
	}

	test("returns undefined when no UI context is provided", () => {
		const handler = createClaudeCodeCanUseToolHandler(undefined);
		assert.equal(handler, undefined);
	});

	test("shows select dialog with Allow/Always Allow/Deny and returns allow", async () => {
		let selectPrompt = "";
		let selectOptions: string[] = [];
		const ui = {
			select: async (prompt: string, options: string[]) => {
				selectPrompt = prompt;
				selectOptions = options;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		assert.ok(handler);

		const input = { command: "ls -la" };
		const result = await handler!("Bash", input, makeOptions({
			title: "Claude wants to run: ls -la",
			description: "List directory contents",
		}));

		assert.equal(result.behavior, "allow");
		assert.deepEqual((result as any).updatedInput, input);
		assert.equal((result as any).toolUseID, "toolu_test123");
		// Allow (one-time) should NOT include updatedPermissions
		assert.equal((result as any).updatedPermissions, undefined);
		assert.deepEqual(selectOptions, ["Allow", "Always Allow", "Deny"]);
		// Prompt includes title and input summary
		assert.ok(selectPrompt.includes("Claude wants to run: ls -la"));
		assert.ok(selectPrompt.includes("ls -la"));
	});

	test("returns deny when user selects Deny", async () => {
		const ui = {
			select: async () => "Deny",
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", { command: "rm -rf /" }, makeOptions());

		assert.equal(result.behavior, "deny");
		assert.equal((result as any).message, "User denied");
		assert.equal((result as any).toolUseID, "toolu_test123");
	});

	test("returns deny when user dismisses dialog (undefined)", async () => {
		const ui = {
			select: async () => undefined,
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", { command: "echo hi" }, makeOptions());

		assert.equal(result.behavior, "deny");
		assert.equal((result as any).message, "User denied");
	});

	test("Always Allow for Bash patches SDK suggestions with smart ruleContent", async () => {
		const notified: string[] = [];
		const ui = { select: async (_p: string, opts: string[]) => opts.find((o) => o.startsWith("Always Allow"))!, notify: (msg: string) => notified.push(msg) };
		const suggestions = [{
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "ls -la /tmp" }],
			behavior: "allow",
			destination: "localSettings",
		}];

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", { command: "ls -la /tmp" }, makeOptions({ suggestions }));

		assert.equal(result.behavior, "allow");
		// Should patch ruleContent with our smart pattern, preserving SDK structure
		assert.deepEqual((result as any).updatedPermissions, [{
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
			behavior: "allow",
			destination: "localSettings",
		}]);
		assert.equal(notified.length, 1);
		assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(ls:*)"));
	});

	test("Always Allow for Bash with subcommand-sensitive CLI captures verb", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const notified: string[] = [];
			// First select call: pick "Always Allow ..."; second call (level
			// picker): pick the "git push" granularity explicitly.
			let selectCall = 0;
			const ui = {
				select: async (_p: string, opts: string[]) => {
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					return "Bash(git push:*)";
				},
				notify: (msg: string) => notified.push(msg),
			};
			const suggestions = [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "git push origin main" }],
				behavior: "allow",
				destination: "localSettings",
			}];

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "git push origin main" }, makeOptions({ suggestions }));

			assert.equal(result.behavior, "allow");
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
			assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(git push:*)"));
		} finally {
			cleanup();
		}
	});

	test("Always Allow for Bash without suggestions builds proper PermissionUpdate", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const notified: string[] = [];
			let selectCall = 0;
			const ui = {
				select: async (_p: string, opts: string[]) => {
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					return "Bash(gh pr list:*)";
				},
				notify: (msg: string) => notified.push(msg),
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "gh pr list" }, makeOptions());

			assert.equal(result.behavior, "allow");
			// No SDK suggestions → builds PermissionUpdate from scratch
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "gh pr list:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
			assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(gh pr list:*)"));
		} finally {
			cleanup();
		}
	});

	test("Always Allow for non-Bash tools passes SDK suggestions through", async () => {
		const notified: string[] = [];
		const ui = { select: async (_p: string, opts: string[]) => opts.find((o) => o.startsWith("Always Allow"))!, notify: (msg: string) => notified.push(msg) };
		const suggestions = [{
			type: "addRules",
			rules: [{ toolName: "Write" }],
			behavior: "allow",
			destination: "localSettings",
		}];

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Write", { file_path: "/tmp/test.txt" }, makeOptions({ suggestions }));

		assert.equal(result.behavior, "allow");
		assert.deepEqual((result as any).updatedPermissions, suggestions);
		// Non-Bash tools don't emit a post-selection notification (only Bash runs the level picker)
		assert.equal(notified.length, 0);
	});

	test("Always Allow for non-Bash without suggestions omits updatedPermissions", async () => {
		const notified: string[] = [];
		const ui = { select: async (_p: string, opts: string[]) => opts.find((o) => o.startsWith("Always Allow"))!, notify: (msg: string) => notified.push(msg) };

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Write", { file_path: "/tmp/test.txt" }, makeOptions());

		assert.equal(result.behavior, "allow");
		assert.equal((result as any).updatedPermissions, undefined);
		// No suggestions → no notification
		assert.equal(notified.length, 0);
	});

	test("prompt includes command text for Bash tools", async () => {
		let selectPrompt = "";
		const ui = {
			select: async (prompt: string) => {
				selectPrompt = prompt;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		await handler!("Bash", { command: "git status" }, makeOptions());
		assert.ok(selectPrompt.includes("git status"), `prompt should include command: ${selectPrompt}`);
	});

	test("prompt includes file_path for file tools", async () => {
		let selectPrompt = "";
		const ui = {
			select: async (prompt: string) => {
				selectPrompt = prompt;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		await handler!("Write", { file_path: "/tmp/test.txt", content: "hello" }, makeOptions());
		assert.ok(selectPrompt.includes("/tmp/test.txt"), `prompt should include file path: ${selectPrompt}`);
	});

	test("uses title from options when available", async () => {
		let selectPrompt = "";
		const ui = {
			select: async (prompt: string) => {
				selectPrompt = prompt;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		await handler!("WebFetch", {}, makeOptions({ title: "Claude wants to fetch: https://example.com" }));
		assert.ok(selectPrompt.includes("Claude wants to fetch: https://example.com"));
	});

	test("falls back to default title when options.title is missing", async () => {
		let selectPrompt = "";
		const ui = {
			select: async (prompt: string) => {
				selectPrompt = prompt;
				return "Allow";
			},
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		await handler!("WebFetch", { url: "https://example.com" }, makeOptions());
		assert.ok(selectPrompt.includes("Allow Claude Code to use: WebFetch?"));
	});

	test("returns deny when signal is already aborted", async () => {
		const ui = {
			select: async () => { throw new Error("should not be called"); },
		};

		const controller = new AbortController();
		controller.abort();

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", {}, makeOptions({ signal: controller.signal }));

		assert.equal(result.behavior, "deny");
		assert.equal((result as any).message, "Aborted");
	});

	test("returns deny when ui.select throws", async () => {
		const ui = {
			select: async () => { throw new Error("dialog crashed"); },
		};

		const handler = createClaudeCodeCanUseToolHandler(ui as any);
		const result = await handler!("Bash", {}, makeOptions());

		assert.equal(result.behavior, "deny");
		assert.equal((result as any).message, "Aborted");
	});

	test("buildSdkOptions passes canUseTool through extraOptions", () => {
		const canUseTool = async () => ({ behavior: "allow" as const, updatedInput: {}, toolUseID: "test" });
		const opts = buildSdkOptions("claude-sonnet-4-6", "test", undefined, { canUseTool });
		assert.equal(opts.canUseTool, canUseTool);
	});

	test("Always Allow shows level picker and user broadens to base command", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const prompts: string[] = [];
			const levelOpts: string[][] = [];
			let selectCall = 0;
			const ui = {
				select: async (prompt: string, opts: string[]) => {
					prompts.push(prompt);
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					levelOpts.push(opts);
					return "Bash(gh:*)";
				},
				notify: () => {},
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "gh pr list" }, makeOptions());

			assert.equal(result.behavior, "allow");
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "gh:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
			// Second dialog offered every granularity level
			assert.deepEqual(levelOpts[0], [
				"Bash(gh:*)",
				"Bash(gh pr:*)",
				"Bash(gh pr list:*)",
			]);
			assert.ok(prompts[1].includes("Save permission at which level?"));
		} finally {
			cleanup();
		}
	});

	test("Always Allow narrows to mid-level pattern when user picks Bash(gh pr:*)", async () => {
		const cleanup = withIsolatedCwd();
		try {
			let selectCall = 0;
			const ui = {
				select: async (_p: string, opts: string[]) => {
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					return "Bash(gh pr:*)";
				},
				notify: () => {},
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "gh pr list --limit 5" }, makeOptions());

			assert.equal(result.behavior, "allow");
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "gh pr:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
		} finally {
			cleanup();
		}
	});

	test("Always Allow skips level picker when only one pattern is available", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const prompts: string[] = [];
			const ui = {
				select: async (prompt: string, opts: string[]) => {
					prompts.push(prompt);
					return opts.find((o) => o.startsWith("Always Allow"))!;
				},
				notify: () => {},
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "ls -la /tmp" }, makeOptions());

			assert.equal(result.behavior, "allow");
			// "ls" has no subcommand tokens before the flag → single-option path
			assert.equal(prompts.length, 1, "should not show a second dialog");
			assert.deepEqual((result as any).updatedPermissions, [{
				type: "addRules",
				rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
				behavior: "allow",
				destination: "localSettings",
			}]);
		} finally {
			cleanup();
		}
	});

	test("Always Allow denies the tool when level picker is dismissed", async () => {
		const cleanup = withIsolatedCwd();
		try {
			const notified: string[] = [];
			let selectCall = 0;
			const ui = {
				select: async (_p: string, opts: string[]) => {
					selectCall++;
					if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"))!;
					return undefined; // user dismissed level picker
				},
				notify: (msg: string) => notified.push(msg),
			};

			const handler = createClaudeCodeCanUseToolHandler(ui as any);
			const result = await handler!("Bash", { command: "gh pr list" }, makeOptions());

			// Dismissing the level picker cancels the tool use — a one-time allow
			// would leave the spawned agent running even though the user bailed.
			assert.equal(result.behavior, "deny");
			assert.equal((result as any).updatedPermissions, undefined);
			assert.equal(notified.length, 0, "no 'Saved:' notification when nothing was saved");
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// buildBashPermissionPattern — smart permission granularity
// ---------------------------------------------------------------------------

describe("buildBashPermissionPattern", () => {
	test("simple command wildcards all args", () => {
		assert.equal(buildBashPermissionPattern("ping -n 4 localhost"), "Bash(ping:*)");
		assert.equal(buildBashPermissionPattern("echo hello world"), "Bash(echo:*)");
		assert.equal(buildBashPermissionPattern("ls -la /tmp"), "Bash(ls:*)");
		assert.equal(buildBashPermissionPattern("node server.js"), "Bash(node:*)");
	});

	test("git captures one subcommand", () => {
		assert.equal(buildBashPermissionPattern("git push origin main"), "Bash(git push:*)");
		assert.equal(buildBashPermissionPattern("git log --oneline"), "Bash(git log:*)");
		assert.equal(buildBashPermissionPattern("git status"), "Bash(git status:*)");
	});

	test("gh captures two subcommands", () => {
		assert.equal(buildBashPermissionPattern("gh pr list"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("gh pr create --title foo"), "Bash(gh pr create:*)");
		assert.equal(buildBashPermissionPattern("gh issue view 123"), "Bash(gh issue view:*)");
	});

	test("npm captures one subcommand", () => {
		assert.equal(buildBashPermissionPattern("npm install lodash"), "Bash(npm install:*)");
		assert.equal(buildBashPermissionPattern("npm publish"), "Bash(npm publish:*)");
		assert.equal(buildBashPermissionPattern("npm run test"), "Bash(npm run:*)");
	});

	test("npx captures package name", () => {
		assert.equal(buildBashPermissionPattern("npx vitest run"), "Bash(npx vitest:*)");
		assert.equal(buildBashPermissionPattern("npx --version"), "Bash(npx --version:*)");
	});

	test("docker captures one subcommand", () => {
		assert.equal(buildBashPermissionPattern("docker ps -a"), "Bash(docker ps:*)");
		assert.equal(buildBashPermissionPattern("docker rm container1"), "Bash(docker rm:*)");
	});

	test("aws captures two subcommands", () => {
		assert.equal(buildBashPermissionPattern("aws s3 cp file.txt s3://bucket/"), "Bash(aws s3 cp:*)");
		assert.equal(buildBashPermissionPattern("aws ec2 describe-instances"), "Bash(aws ec2 describe-instances:*)");
	});

	test("skips sudo wrapper", () => {
		assert.equal(buildBashPermissionPattern("sudo ping localhost"), "Bash(ping:*)");
		assert.equal(buildBashPermissionPattern("sudo git push"), "Bash(git push:*)");
	});

	test("skips env wrapper and VAR=val assignments", () => {
		assert.equal(buildBashPermissionPattern("env NODE_ENV=prod node server.js"), "Bash(node:*)");
		assert.equal(buildBashPermissionPattern("NODE_ENV=prod node server.js"), "Bash(node:*)");
		assert.equal(buildBashPermissionPattern("FOO=bar BAZ=qux git push"), "Bash(git push:*)");
	});

	test("strips path from executable", () => {
		assert.equal(buildBashPermissionPattern("/usr/bin/git push"), "Bash(git push:*)");
		assert.equal(buildBashPermissionPattern("C:\\Windows\\ping.exe localhost"), "Bash(ping:*)");
	});

	test("empty or whitespace-only command", () => {
		assert.equal(buildBashPermissionPattern(""), "Bash(*)");
		assert.equal(buildBashPermissionPattern("   "), "Bash(*)");
	});

	test("chained commands — extracts pattern from the meaningful segment", () => {
		assert.equal(buildBashPermissionPattern("cd /foo && gh pr list --limit 5"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("cd C:/Users/djeff/repos/gsd-2 && gh pr list --limit 5"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("cd /tmp && git push origin main"), "Bash(git push:*)");
		assert.equal(buildBashPermissionPattern("export FOO=1 && npm install lodash"), "Bash(npm install:*)");
		assert.equal(buildBashPermissionPattern("mkdir -p out; docker ps -a"), "Bash(docker ps:*)");
		assert.equal(buildBashPermissionPattern("echo start || ping localhost"), "Bash(ping:*)");
	});

	test("skips trailing || true / || : error suppressors", () => {
		assert.equal(
			buildBashPermissionPattern("cd C:/Users/djeff/repos/gsd-2 && gh pr create --dry-run --title \"test\" --body \"test\" 2>&1 || true"),
			"Bash(gh pr create:*)",
		);
		assert.equal(buildBashPermissionPattern("gh pr list || true"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("git push || :"), "Bash(git push:*)");
		assert.equal(buildBashPermissionPattern("cd /tmp && npm install || echo failed"), "Bash(npm install:*)");
	});

	test("single command is unaffected by chain extraction", () => {
		assert.equal(buildBashPermissionPattern("gh pr list"), "Bash(gh pr list:*)");
		assert.equal(buildBashPermissionPattern("git push origin main"), "Bash(git push:*)");
	});
});

// ---------------------------------------------------------------------------
// buildBashPermissionPatternOptions — granularity level menu
// ---------------------------------------------------------------------------

describe("buildBashPermissionPatternOptions", () => {
	test("offers every prefix from base to full subcommand chain", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("gh pr list"), [
			"Bash(gh:*)",
			"Bash(gh pr:*)",
			"Bash(gh pr list:*)",
		]);
		assert.deepEqual(buildBashPermissionPatternOptions("git push origin main"), [
			"Bash(git:*)",
			"Bash(git push:*)",
			"Bash(git push origin:*)",
			"Bash(git push origin main:*)",
		]);
	});

	test("stops at first flag — flags are args, not verbs", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("gh pr create --title foo"), [
			"Bash(gh:*)",
			"Bash(gh pr:*)",
			"Bash(gh pr create:*)",
		]);
		assert.deepEqual(buildBashPermissionPatternOptions("git log --oneline"), [
			"Bash(git:*)",
			"Bash(git log:*)",
		]);
	});

	test("single-option when there is no subcommand to choose from", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("ls -la /tmp"), ["Bash(ls:*)"]);
		assert.deepEqual(buildBashPermissionPatternOptions("ping -n 4 localhost"), ["Bash(ping:*)"]);
		assert.deepEqual(buildBashPermissionPatternOptions("node"), ["Bash(node:*)"]);
	});

	test("extracts meaningful segment from compound commands", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("cd /foo && gh pr list"), [
			"Bash(gh:*)",
			"Bash(gh pr:*)",
			"Bash(gh pr list:*)",
		]);
		assert.deepEqual(buildBashPermissionPatternOptions("gh pr create --dry-run || true"), [
			"Bash(gh:*)",
			"Bash(gh pr:*)",
			"Bash(gh pr create:*)",
		]);
	});

	test("caps at three subcommand tokens to keep the menu short", () => {
		const result = buildBashPermissionPatternOptions("foo bar baz qux quux corge");
		// base + 3 sub tokens = 4 patterns max
		assert.equal(result.length, 4);
		assert.deepEqual(result, [
			"Bash(foo:*)",
			"Bash(foo bar:*)",
			"Bash(foo bar baz:*)",
			"Bash(foo bar baz qux:*)",
		]);
	});

	test("skips sudo/env wrappers like the single-pattern variant", () => {
		assert.deepEqual(buildBashPermissionPatternOptions("sudo git push origin"), [
			"Bash(git:*)",
			"Bash(git push:*)",
			"Bash(git push origin:*)",
		]);
		assert.deepEqual(buildBashPermissionPatternOptions("NODE_ENV=prod node server.js"), [
			"Bash(node:*)",
			"Bash(node server.js:*)",
		]);
	});

	test("empty command returns the catch-all pattern", () => {
		assert.deepEqual(buildBashPermissionPatternOptions(""), ["Bash(*)"]);
		assert.deepEqual(buildBashPermissionPatternOptions("   "), ["Bash(*)"]);
	});
});

// ---------------------------------------------------------------------------
// bashCommandMatchesSavedRules — compound command bypass for saved rules
// ---------------------------------------------------------------------------

describe("bashCommandMatchesSavedRules — compound command bypass", () => {
	let tempDir: string;
	let originalCwd: string;

	// Create a temp project directory with .claude/settings.local.json
	function setupSettings(allow: string[]): void {
		const claudeDir = join(tempDir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify({ permissions: { allow } }),
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: test-only monkey-patch
	let origCwd: any;

	// Monkey-patch process.cwd() to point at our temp dir
	function setCwd(dir: string): void {
		origCwd = process.cwd;
		process.cwd = () => dir;
	}
	function restoreCwd(): void {
		if (origCwd) process.cwd = origCwd;
	}

	test("matches cd-prefixed compound command against saved prefix rule", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /some/path && gh pr list --limit 5"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("matches cd-prefixed compound command with exact subcommand", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd C:/Users/foo/repos/bar && gh pr list"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("rejects when leading segment is not cd", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			// "rm -rf /tmp" is not a cd command — should not auto-approve
			assert.equal(
				bashCommandMatchesSavedRules("rm -rf /tmp && gh pr list"),
				false,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("rejects when meaningful segment does not match any rule", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /path && gh issue create --title foo"),
				false,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("matches simple (non-compound) commands against on-disk rules", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			// Simple commands must also be checked — the SDK's in-memory cache
			// may be stale if the rule was added mid-session via "Always Allow"
			assert.equal(bashCommandMatchesSavedRules("gh pr list --limit 5"), true);
			assert.equal(bashCommandMatchesSavedRules("gh pr list"), true);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("returns false for simple commands with no matching rule", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr list:*)"]);
			setCwd(tempDir);
			assert.equal(bashCommandMatchesSavedRules("gh issue list --limit 5"), false);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("returns false when no settings file exists", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			// No .claude/settings.local.json created
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /path && gh pr list"),
				false,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("matches exact rule (non-prefix)", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(ping -n 4 localhost)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /path && ping -n 4 localhost"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("handles multiple cd segments before the meaningful command", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(npm install:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /home && cd project && npm install lodash"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("matches compound command with trailing || true suppressor", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			setupSettings(["Bash(gh pr create:*)"]);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules('cd C:/Users/djeff/repos/gsd-2 && gh pr create --dry-run --title "test" --body "test" 2>&1 || true'),
				true,
			);
			assert.equal(
				bashCommandMatchesSavedRules("gh pr create --dry-run || true"),
				true,
			);
			assert.equal(
				bashCommandMatchesSavedRules("cd /tmp && git push || :"),
				false, // rule is for gh pr create, not git push
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("reads rules from settings.json as well as settings.local.json", () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
		try {
			const claudeDir = join(tempDir, ".claude");
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(
				join(claudeDir, "settings.json"),
				JSON.stringify({ permissions: { allow: ["Bash(git push:*)"] } }),
			);
			setCwd(tempDir);
			assert.equal(
				bashCommandMatchesSavedRules("cd /repo && git push origin main"),
				true,
			);
		} finally {
			restoreCwd();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
