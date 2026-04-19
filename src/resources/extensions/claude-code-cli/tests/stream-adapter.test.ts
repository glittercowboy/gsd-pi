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
	resolveClaudePermissionMode,
	buildPromptFromContext,
	buildSdkQueryPrompt,
	buildSdkOptions,
	createClaudeCodeElicitationHandler,
	extractImageBlocksFromContext,
	extractToolResultsFromSdkUserMessage,
	getClaudeLookupCommand,
	parseAskUserQuestionsElicitation,
	parseTextInputElicitation,
	parseClaudeLookupOutput,
	roundResultToElicitationContent,
} from "../stream-adapter.ts";
import type { AssistantMessage, Context, Message } from "@gsd/pi-ai";
import type { SDKUserMessage } from "../sdk-types.ts";

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
					details: {},
					isError: false,
				},
			},
		]);
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
					details: {},
					isError: true,
				},
			},
		]);
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
		const prev = {
			GSD_WORKFLOW_MCP_COMMAND: process.env.GSD_WORKFLOW_MCP_COMMAND,
			GSD_WORKFLOW_MCP_NAME: process.env.GSD_WORKFLOW_MCP_NAME,
			GSD_WORKFLOW_MCP_ARGS: process.env.GSD_WORKFLOW_MCP_ARGS,
			GSD_WORKFLOW_MCP_ENV: process.env.GSD_WORKFLOW_MCP_ENV,
			GSD_WORKFLOW_MCP_CWD: process.env.GSD_WORKFLOW_MCP_CWD,
		};
		try {
			process.env.GSD_WORKFLOW_MCP_COMMAND = "node";
			process.env.GSD_WORKFLOW_MCP_NAME = "gsd-workflow";
			process.env.GSD_WORKFLOW_MCP_ARGS = JSON.stringify(["packages/mcp-server/dist/cli.js"]);
			process.env.GSD_WORKFLOW_MCP_ENV = JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" });
			process.env.GSD_WORKFLOW_MCP_CWD = "/tmp/project";

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
			assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
			assert.deepEqual(options.allowedTools, [
				"Read",
				"Write",
				"Edit",
				"Glob",
				"Grep",
				"Bash(ls:*)",
				"Bash(pwd)",
				"mcp__gsd-workflow__*",
			]);
		} finally {
			process.env.GSD_WORKFLOW_MCP_COMMAND = prev.GSD_WORKFLOW_MCP_COMMAND;
			process.env.GSD_WORKFLOW_MCP_NAME = prev.GSD_WORKFLOW_MCP_NAME;
			process.env.GSD_WORKFLOW_MCP_ARGS = prev.GSD_WORKFLOW_MCP_ARGS;
			process.env.GSD_WORKFLOW_MCP_ENV = prev.GSD_WORKFLOW_MCP_ENV;
			process.env.GSD_WORKFLOW_MCP_CWD = prev.GSD_WORKFLOW_MCP_CWD;
		}
	});

	test("buildSdkOptions disables AskUserQuestion for custom workflow MCP server names", () => {
		const prev = {
			GSD_WORKFLOW_MCP_COMMAND: process.env.GSD_WORKFLOW_MCP_COMMAND,
			GSD_WORKFLOW_MCP_NAME: process.env.GSD_WORKFLOW_MCP_NAME,
			GSD_WORKFLOW_MCP_ARGS: process.env.GSD_WORKFLOW_MCP_ARGS,
			GSD_WORKFLOW_MCP_ENV: process.env.GSD_WORKFLOW_MCP_ENV,
			GSD_WORKFLOW_MCP_CWD: process.env.GSD_WORKFLOW_MCP_CWD,
		};
		try {
			process.env.GSD_WORKFLOW_MCP_COMMAND = "node";
			process.env.GSD_WORKFLOW_MCP_NAME = "custom-workflow";
			process.env.GSD_WORKFLOW_MCP_ARGS = JSON.stringify(["packages/mcp-server/dist/cli.js"]);
			process.env.GSD_WORKFLOW_MCP_ENV = JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" });
			process.env.GSD_WORKFLOW_MCP_CWD = "/tmp/project";

			const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
			const mcpServers = options.mcpServers as Record<string, any>;
			assert.ok(mcpServers?.["custom-workflow"], "expected custom workflow server config");
			assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
			assert.deepEqual(options.allowedTools, [
				"Read",
				"Write",
				"Edit",
				"Glob",
				"Grep",
				"Bash(ls:*)",
				"Bash(pwd)",
				"mcp__custom-workflow__*",
			]);
		} finally {
			process.env.GSD_WORKFLOW_MCP_COMMAND = prev.GSD_WORKFLOW_MCP_COMMAND;
			process.env.GSD_WORKFLOW_MCP_NAME = prev.GSD_WORKFLOW_MCP_NAME;
			process.env.GSD_WORKFLOW_MCP_ARGS = prev.GSD_WORKFLOW_MCP_ARGS;
			process.env.GSD_WORKFLOW_MCP_ENV = prev.GSD_WORKFLOW_MCP_ENV;
			process.env.GSD_WORKFLOW_MCP_CWD = prev.GSD_WORKFLOW_MCP_CWD;
		}
	});

	test("buildSdkOptions auto-discovers bundled MCP server even without env hints", () => {
		const prev = {
			GSD_WORKFLOW_MCP_COMMAND: process.env.GSD_WORKFLOW_MCP_COMMAND,
			GSD_WORKFLOW_MCP_NAME: process.env.GSD_WORKFLOW_MCP_NAME,
			GSD_WORKFLOW_MCP_ARGS: process.env.GSD_WORKFLOW_MCP_ARGS,
			GSD_WORKFLOW_MCP_ENV: process.env.GSD_WORKFLOW_MCP_ENV,
			GSD_WORKFLOW_MCP_CWD: process.env.GSD_WORKFLOW_MCP_CWD,
		};
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
				assert.deepEqual((options as any).disallowedTools, ["AskUserQuestion"]);
			} else {
				assert.deepEqual((options as any).disallowedTools, ["AskUserQuestion"]);
			}
			rmSync(emptyDir, { recursive: true, force: true });
		} finally {
			process.env.GSD_WORKFLOW_MCP_COMMAND = prev.GSD_WORKFLOW_MCP_COMMAND;
			process.env.GSD_WORKFLOW_MCP_NAME = prev.GSD_WORKFLOW_MCP_NAME;
			process.env.GSD_WORKFLOW_MCP_ARGS = prev.GSD_WORKFLOW_MCP_ARGS;
			process.env.GSD_WORKFLOW_MCP_ENV = prev.GSD_WORKFLOW_MCP_ENV;
			process.env.GSD_WORKFLOW_MCP_CWD = prev.GSD_WORKFLOW_MCP_CWD;
		}
	});

	test("buildSdkOptions auto-detects local workflow MCP dist CLI when present", () => {
		const prev = {
			GSD_WORKFLOW_MCP_COMMAND: process.env.GSD_WORKFLOW_MCP_COMMAND,
			GSD_WORKFLOW_MCP_NAME: process.env.GSD_WORKFLOW_MCP_NAME,
			GSD_WORKFLOW_MCP_ARGS: process.env.GSD_WORKFLOW_MCP_ARGS,
			GSD_WORKFLOW_MCP_ENV: process.env.GSD_WORKFLOW_MCP_ENV,
			GSD_WORKFLOW_MCP_CWD: process.env.GSD_WORKFLOW_MCP_CWD,
			GSD_CLI_PATH: process.env.GSD_CLI_PATH,
		};
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
			assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
		} finally {
			process.chdir(originalCwd);
			rmSync(repoDir, { recursive: true, force: true });
			process.env.GSD_WORKFLOW_MCP_COMMAND = prev.GSD_WORKFLOW_MCP_COMMAND;
			process.env.GSD_WORKFLOW_MCP_NAME = prev.GSD_WORKFLOW_MCP_NAME;
			process.env.GSD_WORKFLOW_MCP_ARGS = prev.GSD_WORKFLOW_MCP_ARGS;
			process.env.GSD_WORKFLOW_MCP_ENV = prev.GSD_WORKFLOW_MCP_ENV;
			process.env.GSD_WORKFLOW_MCP_CWD = prev.GSD_WORKFLOW_MCP_CWD;
			process.env.GSD_CLI_PATH = prev.GSD_CLI_PATH;
		}
	});

	test("buildSdkOptions preserves runtime callbacks such as onElicitation", () => {
		const prev = {
			GSD_WORKFLOW_MCP_COMMAND: process.env.GSD_WORKFLOW_MCP_COMMAND,
			GSD_WORKFLOW_MCP_NAME: process.env.GSD_WORKFLOW_MCP_NAME,
			GSD_WORKFLOW_MCP_ARGS: process.env.GSD_WORKFLOW_MCP_ARGS,
			GSD_WORKFLOW_MCP_ENV: process.env.GSD_WORKFLOW_MCP_ENV,
			GSD_WORKFLOW_MCP_CWD: process.env.GSD_WORKFLOW_MCP_CWD,
		};
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
			process.env.GSD_WORKFLOW_MCP_COMMAND = prev.GSD_WORKFLOW_MCP_COMMAND;
			process.env.GSD_WORKFLOW_MCP_NAME = prev.GSD_WORKFLOW_MCP_NAME;
			process.env.GSD_WORKFLOW_MCP_ARGS = prev.GSD_WORKFLOW_MCP_ARGS;
			process.env.GSD_WORKFLOW_MCP_ENV = prev.GSD_WORKFLOW_MCP_ENV;
			process.env.GSD_WORKFLOW_MCP_CWD = prev.GSD_WORKFLOW_MCP_CWD;
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

	test("buildSdkOptions defaults to bypassPermissions for backwards compatibility", () => {
		clearWorkflowMcpEnv();
		const opts = buildSdkOptions("claude-sonnet-4-6", "test");
		assert.equal(opts.permissionMode, "bypassPermissions");
		assert.equal(opts.allowDangerouslySkipPermissions, true);
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
});

describe("stream-adapter — Windows Claude path lookup (#3770)", () => {
	test("getClaudeLookupCommand uses where on Windows", () => {
		assert.equal(getClaudeLookupCommand("win32"), "where claude");
	});

	test("getClaudeLookupCommand uses which on non-Windows platforms", () => {
		assert.equal(getClaudeLookupCommand("darwin"), "which claude");
		assert.equal(getClaudeLookupCommand("linux"), "which claude");
	});

	test("parseClaudeLookupOutput keeps the first native path from multi-line lookup output", () => {
		const output = "C:\\Users\\Binoy\\.local\\bin\\claude.exe\r\nC:\\Program Files\\Claude\\claude.exe\r\n";
		assert.equal(parseClaudeLookupOutput(output), "C:\\Users\\Binoy\\.local\\bin\\claude.exe");
	});
});
