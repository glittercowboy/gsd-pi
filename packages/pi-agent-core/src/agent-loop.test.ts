// agent-loop tests
// Covers: pauseTurn handling (#2869), schema overload retry cap (#2783)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { agentLoop, MAX_CONSECUTIVE_VALIDATION_FAILURES } from "./agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentTool, AgentEvent, AgentMessage } from "./types.js";
import { AssistantMessageEventStream, EventStream } from "@gsd/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@gsd/pi-ai";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("agent-loop — pauseTurn handling (#2869)", () => {
	it("continues to a second assistant turn when stopReason is pauseTurn", async () => {
		const pauseTurn = makeAssistantMessage({
			content: [{ type: "text", text: "Still working..." }],
			stopReason: "pauseTurn",
		});
		const finalStop = makeAssistantMessage({
			content: [{ type: "text", text: "Done." }],
			stopReason: "stop",
		});

		let streamCallCount = 0;
		const seenLastRoles: string[] = [];
		const streamFn = (_model: Model<any>, llmContext: any): AssistantMessageEventStream => {
			streamCallCount++;
			seenLastRoles.push(llmContext.messages.at(-1)?.role ?? "none");
			const message = streamCallCount === 1 ? pauseTurn : finalStop;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", message });
				stream.end(message);
			});
			return stream;
		};

		const context: AgentContext = {
			systemPrompt: "You are a test agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "Keep going" }], timestamp: Date.now() }],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: TEST_MODEL,
			convertToLlm: (msgs) => msgs.filter((m): m is any => m.role !== "custom"),
			toolExecution: "sequential",
		};

		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "Keep going" }], timestamp: Date.now() }],
			context,
			config,
			undefined,
			streamFn as any,
		);

		const events = await collectEvents(stream);
		const assistantMessages = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		const turnStarts = events.filter((event) => event.type === "turn_start");

		assert.equal(streamCallCount, 2, "pauseTurn must cause a second provider call");
		assert.equal(assistantMessages.length, 2, "expected two assistant turns");
		assert.equal(assistantMessages[0].message.stopReason, "pauseTurn");
		assert.equal(assistantMessages[1].message.stopReason, "stop");
		assert.equal(turnStarts.length, 2, "expected a second turn_start after pauseTurn");
		assert.deepEqual(seenLastRoles, ["user", "assistant"], "second turn must continue from the paused assistant state");
	});

	it("pauseTurn is in the StopReason union type", () => {
		// Read the pi-ai types to ensure pauseTurn is a valid StopReason
		const typesPath = join(__dirname, "..", "..", "pi-ai", "src", "types.ts");
		const typesSource = readFileSync(typesPath, "utf-8");
		assert.match(
			typesSource,
			/["']pauseTurn["']/,
			'StopReason type must include "pauseTurn"',
		);
	});

	it("uses provider-supplied external tool results instead of the placeholder", async () => {
		const externalMessage = makeAssistantMessage({
			content: [
				{
					type: "toolCall",
					id: "tc-external-1",
					name: "bash",
					arguments: { command: "echo hi" },
					externalResult: {
						content: [{ type: "text", text: "hi\n" }],
						details: { source: "claude-code" },
						isError: false,
					},
				} as any,
			],
			stopReason: "toolUse",
			provider: "claude-code",
		});

		const mockStream = createMockStreamFn([externalMessage]);

		const context: AgentContext = {
			systemPrompt: "You are a test agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "Run the command" }], timestamp: Date.now() }],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: { ...TEST_MODEL, provider: "claude-code" },
			convertToLlm: (msgs) => msgs.filter((m): m is any => m.role !== "custom"),
			toolExecution: "sequential",
			externalToolExecution: true,
		};

		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "Run the command" }], timestamp: Date.now() }],
			context,
			config,
			undefined,
			mockStream as any,
		);

		const events = await collectEvents(stream);
		const toolEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);

		assert.ok(toolEnd, "expected tool_execution_end event");
		assert.deepEqual(toolEnd.result.content, [{ type: "text", text: "hi\n" }]);
		assert.deepEqual(toolEnd.result.details, { source: "claude-code" });
		assert.equal(toolEnd.isError, false);
	});

	it("injects queued steering messages before the next assistant turn and skips remaining tools", async () => {
		const tool = makeToolWithSchema();
		const steeringMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Stop after the first tool." }],
			timestamp: Date.now(),
		};
		const toolTurn = makeAssistantMessage({
			content: [
				{
					type: "toolCall",
					id: "write-1",
					name: "write_file",
					arguments: { path: "/tmp/one", content: "first" },
				},
				{
					type: "toolCall",
					id: "write-2",
					name: "write_file",
					arguments: { path: "/tmp/two", content: "second" },
				},
			],
			stopReason: "toolUse",
		});
		const finalStop = makeAssistantMessage({
			content: [{ type: "text", text: "Stopped after the first tool." }],
			stopReason: "stop",
		});

		let steeringPollCount = 0;
		const seenLastMessages: unknown[] = [];
		const streamFn = (_model: Model<any>, llmContext: any): AssistantMessageEventStream => {
			seenLastMessages.push(llmContext.messages.at(-1));
			const message = seenLastMessages.length === 1 ? toolTurn : finalStop;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", message });
				stream.end(message);
			});
			return stream;
		};

		const context: AgentContext = {
			systemPrompt: "You are a test agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "Write both files" }], timestamp: Date.now() }],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: TEST_MODEL,
			convertToLlm: (msgs) => msgs.filter((m): m is any => m.role !== "custom"),
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				steeringPollCount++;
				return steeringPollCount === 2 ? [steeringMessage] : [];
			},
		};

		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "Write both files" }], timestamp: Date.now() }],
			context,
			config,
			undefined,
			streamFn as any,
		);

		const events = await collectEvents(stream);
		const toolEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		const steeringEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" &&
				event.message.role === "user" &&
				(event.message.content[0] as any)?.text === "Stop after the first tool.",
		);

		assert.equal(toolEnds.length, 2, "expected one executed tool and one skipped tool");
		assert.ok(
			toolEnds.some((event) => JSON.stringify(event.result.content) === JSON.stringify([{ type: "text", text: "done" }])),
			"expected one completed tool result",
		);
		assert.ok(
			toolEnds.some(
				(event) =>
					JSON.stringify(event.result.content) ===
					JSON.stringify([{ type: "text", text: "Skipped due to queued user message." }]),
			),
			"expected one skipped tool result after steering interruption",
		);
		assert.ok(steeringEnd, "queued steering message should be emitted before the next assistant turn");
		assert.equal((seenLastMessages[1] as any)?.content?.[0]?.text, "Stop after the first tool.");
	});

	it("restarts the outer loop when follow-up messages arrive after a stop", async () => {
		const initialStop = makeAssistantMessage({
			content: [{ type: "text", text: "First answer." }],
			stopReason: "stop",
		});
		const followUpStop = makeAssistantMessage({
			content: [{ type: "text", text: "Follow-up answer." }],
			stopReason: "stop",
		});
		const followUpMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "One more thing." }],
			timestamp: Date.now(),
		};

		let followUpPollCount = 0;
		const seenLastMessages: unknown[] = [];
		const streamFn = (_model: Model<any>, llmContext: any): AssistantMessageEventStream => {
			seenLastMessages.push(llmContext.messages.at(-1));
			const message = seenLastMessages.length === 1 ? initialStop : followUpStop;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", message });
				stream.end(message);
			});
			return stream;
		};

		const context: AgentContext = {
			systemPrompt: "You are a test agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "Initial prompt" }], timestamp: Date.now() }],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: TEST_MODEL,
			convertToLlm: (msgs) => msgs.filter((m): m is any => m.role !== "custom"),
			toolExecution: "sequential",
			getFollowUpMessages: async () => {
				followUpPollCount++;
				return followUpPollCount === 1 ? [followUpMessage] : [];
			},
		};

		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "Initial prompt" }], timestamp: Date.now() }],
			context,
			config,
			undefined,
			streamFn as any,
		);

		const events = await collectEvents(stream);
		const assistantEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		const followUpEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" &&
				event.message.role === "user" &&
				(event.message.content[0] as any)?.text === "One more thing.",
		);

		assert.equal(assistantEnds.length, 2, "expected the agent loop to restart for the follow-up turn");
		assert.ok(followUpEnd, "follow-up message should be emitted before the restarted assistant turn");
		assert.equal((seenLastMessages[1] as any)?.content?.[0]?.text, "One more thing.");
	});
});

/**
 * Regression tests for #2783: Stuck-loop on execute-task — tool-call schema
 * overload causes unbounded retry + budget burn.
 *
 * When the LLM repeatedly emits tool calls with arguments that fail schema
 * validation, the agent loop retries indefinitely. Each failed validation
 * returns an error tool result, the LLM retries with the same broken args,
 * and the cycle never breaks — burning budget with no progress.
 *
 * The fix caps consecutive validation failures per turn at
 * MAX_CONSECUTIVE_VALIDATION_FAILURES (default 3). Once the cap is hit, the
 * loop injects a synthetic stop so the agent terminates cleanly instead of
 * spinning forever.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_MODEL: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	contextWindow: 200_000,
	maxOutput: 4096,
	supportsImages: false,
	supportsPromptCache: false,
	thinkingLevel: undefined,
};

function makeToolWithSchema(): AgentTool<any> {
	return {
		name: "write_file",
		label: "Write File",
		description: "Write content to a file",
		parameters: Type.Object({
			path: Type.String(),
			content: Type.String(),
		}),
		execute: async () => ({
			content: [{ type: "text" as const, text: "done" }],
			details: {},
		}),
	};
}

/**
 * Creates a mock streamFn that returns assistant messages from a queue.
 * Each call pops the next message. The messages simulate the LLM repeatedly
 * emitting the same tool call with broken arguments.
 */
function createMockStreamFn(responses: AssistantMessage[]) {
	let callIndex = 0;

	return function mockStreamFn(): AssistantMessageEventStream {
		const message = responses[callIndex] ?? responses[responses.length - 1];
		callIndex++;

		const stream = new AssistantMessageEventStream();
		// Simulate async delivery
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", message });
			stream.end(message);
		});
		return stream;
	};
}

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function makeToolCallMessage(toolCallArgs: Record<string, unknown>): AssistantMessage {
	return makeAssistantMessage({
		content: [
			{
				type: "toolCall",
				id: `tc_${Date.now()}_${Math.random()}`,
				name: "write_file",
				arguments: toolCallArgs,
			},
		],
		stopReason: "toolUse",
	});
}

function collectEvents(stream: EventStream<AgentEvent, AgentMessage[]>): Promise<AgentEvent[]> {
	return new Promise(async (resolve) => {
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		resolve(events);
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("agent-loop — schema overload retry cap (#2783)", () => {

	it("terminates after MAX_CONSECUTIVE_VALIDATION_FAILURES consecutive schema failures", async () => {
		const tool = makeToolWithSchema();

		// LLM keeps sending tool calls with invalid args (missing required 'content' field)
		const badToolCall = makeToolCallMessage({ path: "/tmp/test" }); // missing 'content'
		const finalStop = makeAssistantMessage({ content: [{ type: "text", text: "I give up." }], stopReason: "stop" });

		// Create enough bad responses to exceed the cap, plus a final stop
		const responses: AssistantMessage[] = [];
		for (let i = 0; i < MAX_CONSECUTIVE_VALIDATION_FAILURES + 5; i++) {
			responses.push(badToolCall);
		}
		responses.push(finalStop);

		const mockStream = createMockStreamFn(responses);

		const context: AgentContext = {
			systemPrompt: "You are a test agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "Write a file" }], timestamp: Date.now() }],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: TEST_MODEL,
			convertToLlm: (msgs) => msgs.filter((m): m is any => m.role !== "custom"),
			toolExecution: "sequential",
		};

		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "Write a file" }], timestamp: Date.now() }],
			context,
			config,
			undefined,
			mockStream as any,
		);

		const events = await collectEvents(stream);

		// Must have terminated (agent_end event present)
		const agentEnd = events.find((e) => e.type === "agent_end");
		assert.ok(agentEnd, "agent loop must emit agent_end after hitting retry cap");

		// Count how many turns had validation errors (tool_execution_end with isError: true)
		const toolErrors = events.filter(
			(e) => e.type === "tool_execution_end" && e.isError === true,
		);

		// Must not exceed the cap
		assert.ok(
			toolErrors.length <= MAX_CONSECUTIVE_VALIDATION_FAILURES,
			`Expected at most ${MAX_CONSECUTIVE_VALIDATION_FAILURES} validation error tool results, got ${toolErrors.length}`,
		);
	});

	it("resets the failure counter when a tool call succeeds", async () => {
		const tool = makeToolWithSchema();

		// Pattern: 2 failures, 1 success, 2 failures, 1 success, then stop
		const badCall = makeToolCallMessage({ path: "/tmp/test" }); // missing 'content'
		const goodCall = makeToolCallMessage({ path: "/tmp/test", content: "hello" });
		const finalStop = makeAssistantMessage({ content: [{ type: "text", text: "Done." }], stopReason: "stop" });

		const responses = [badCall, badCall, goodCall, badCall, badCall, goodCall, finalStop];
		const mockStream = createMockStreamFn(responses);

		const context: AgentContext = {
			systemPrompt: "You are a test agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "Write a file" }], timestamp: Date.now() }],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: TEST_MODEL,
			convertToLlm: (msgs) => msgs.filter((m): m is any => m.role !== "custom"),
			toolExecution: "sequential",
		};

		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "Write a file" }], timestamp: Date.now() }],
			context,
			config,
			undefined,
			mockStream as any,
		);

		const events = await collectEvents(stream);

		// Must complete successfully since failures never reached cap consecutively
		const agentEnd = events.find((e) => e.type === "agent_end");
		assert.ok(agentEnd, "agent loop must complete normally when failures are interspersed with successes");

		// Should have processed all 6 tool-bearing turns
		const toolExecEnds = events.filter((e) => e.type === "tool_execution_end");
		assert.ok(toolExecEnds.length >= 4, `Expected at least 4 tool executions (2 bad + 1 good + 2 bad + 1 good), got ${toolExecEnds.length}`);
	});

	it("exports MAX_CONSECUTIVE_VALIDATION_FAILURES as a configurable constant", () => {
		assert.equal(typeof MAX_CONSECUTIVE_VALIDATION_FAILURES, "number");
		assert.ok(MAX_CONSECUTIVE_VALIDATION_FAILURES >= 2, "Cap must be at least 2 to allow one retry");
		assert.ok(MAX_CONSECUTIVE_VALIDATION_FAILURES <= 10, "Cap must not be unreasonably high");
	});

	it("does NOT trip schema overload cap on tool execution errors like bash exit code 1 (#3618)", async () => {
		// Simulates the real scenario: a tool (bash) that passes validation but
		// throws during execution (e.g. rg/grep returning exit code 1 = no matches).
		// These are valid tool invocations — the schema was correct, the tool ran,
		// it just returned a non-zero exit code. The cap should only trigger for
		// preparation/schema failures, not execution failures.
		const bashTool: AgentTool<any> = {
			name: "bash",
			label: "Bash",
			description: "Run a bash command",
			parameters: Type.Object({
				command: Type.String(),
			}),
			execute: async () => {
				// Simulate bash tool rejecting on non-zero exit code
				throw new Error("(no output)\n\nCommand exited with code 1");
			},
		};

		// LLM sends valid tool calls (schema is correct) that fail at execution
		const validBashCall = makeAssistantMessage({
			content: [
				{
					type: "toolCall",
					id: `tc_bash_${Date.now()}_${Math.random()}`,
					name: "bash",
					arguments: { command: "rg -l 'nonexistent' src/" },
				},
			],
			stopReason: "toolUse",
		});
		const finalStop = makeAssistantMessage({
			content: [{ type: "text", text: "No references found." }],
			stopReason: "stop",
		});

		// Send more than MAX_CONSECUTIVE_VALIDATION_FAILURES bash calls that throw
		const responses: AssistantMessage[] = [];
		for (let i = 0; i < MAX_CONSECUTIVE_VALIDATION_FAILURES + 2; i++) {
			responses.push(validBashCall);
		}
		responses.push(finalStop);

		const mockStream = createMockStreamFn(responses);

		const context: AgentContext = {
			systemPrompt: "You are a test agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "Search for references" }], timestamp: Date.now() }],
			tools: [bashTool],
		};

		const config: AgentLoopConfig = {
			model: TEST_MODEL,
			convertToLlm: (msgs) => msgs.filter((m): m is any => m.role !== "custom"),
			toolExecution: "sequential",
		};

		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "Search for references" }], timestamp: Date.now() }],
			context,
			config,
			undefined,
			mockStream as any,
		);

		const events = await collectEvents(stream);

		// Must complete normally — execution errors should NOT trigger the cap
		const agentEnd = events.find((e) => e.type === "agent_end");
		assert.ok(agentEnd, "agent loop must emit agent_end");

		// Count tool execution errors
		const toolErrors = events.filter(
			(e) => e.type === "tool_execution_end" && e.isError === true,
		);

		// All bash calls should have been attempted (not capped early)
		assert.ok(
			toolErrors.length >= MAX_CONSECUTIVE_VALIDATION_FAILURES + 2,
			`Expected all ${MAX_CONSECUTIVE_VALIDATION_FAILURES + 2} bash execution errors to be processed (not capped), got ${toolErrors.length}`,
		);

		// The stop message should NOT contain the schema overload text
		const allMessages = (agentEnd as any).messages as AgentMessage[];
		const lastMessage = allMessages[allMessages.length - 1];
		const lastText = lastMessage.role === "assistant"
			? (lastMessage as AssistantMessage).content.find((c) => c.type === "text")
			: undefined;
		if (lastText && lastText.type === "text") {
			assert.ok(
				!lastText.text.includes("consecutive turns with all tool calls failing"),
				"Final message must NOT contain schema overload stop text for execution-only errors",
			);
		}
	});
});
