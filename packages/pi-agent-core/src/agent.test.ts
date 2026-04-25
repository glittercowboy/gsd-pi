// Agent activeInferenceModel regression tests
// Verifies that activeInferenceModel is set before streaming begins and
// cleared after streaming completes — observed via the streamFn seam and
// post-condition, not the source text.
// Regression test for https://github.com/gsd-build/gsd-2/issues/1844 Bug 2

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.ts";
import { getModel, type AssistantMessageEventStream } from "@gsd/pi-ai";

function makeDoneStream(modelId: string): AssistantMessageEventStream {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: modelId,
		usage,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: message };
			yield { type: "done", message };
		},
		result: async () => message,
		[Symbol.asyncDispose]: async () => {},
	} as AssistantMessageEventStream;
}

describe("Agent — activeInferenceModel (#1844 Bug 2)", () => {
	it("_runLoop sets activeInferenceModel = model mid-stream and clears it when finished", async () => {
		const model = getModel("anthropic", "claude-3-5-sonnet-20241022");
		let midStreamModel: unknown = "<not-captured>";

		const agent = new Agent({
			initialState: { model, systemPrompt: "test", tools: [] },
			streamFn: (streamModel): AssistantMessageEventStream => {
				// streamFn is invoked AFTER `activeInferenceModel = model` and
				// BEFORE the finally block that clears it. Capture state here.
				midStreamModel = agent.state.activeInferenceModel;
				return makeDoneStream(streamModel.id);
			},
		});

		// Baseline: undefined before any inference.
		assert.equal(
			agent.state.activeInferenceModel,
			undefined,
			"activeInferenceModel must be undefined before prompt()",
		);

		await agent.prompt("hello");

		// Mid-stream: set to the inference model.
		assert.equal(
			(midStreamModel as { id?: string } | undefined)?.id,
			model.id,
			"activeInferenceModel must equal the inference model while streaming",
		);

		// Post-stream: cleared back to undefined (finally block).
		assert.equal(
			agent.state.activeInferenceModel,
			undefined,
			"activeInferenceModel must be undefined after prompt() resolves",
		);
	});

	it("activeInferenceModel is also cleared when the stream throws", async () => {
		const model = getModel("anthropic", "claude-3-5-sonnet-20241022");
		let midStreamModel: unknown = "<not-captured>";

		const agent = new Agent({
			initialState: { model, systemPrompt: "test", tools: [] },
			streamFn: (): AssistantMessageEventStream => {
				midStreamModel = agent.state.activeInferenceModel;
				return {
					async *[Symbol.asyncIterator]() {
						throw new Error("boom");
					},
					result: async () => {
						throw new Error("boom");
					},
					[Symbol.asyncDispose]: async () => {},
				} as AssistantMessageEventStream;
			},
		});

		await agent.prompt("hello");

		assert.equal(
			(midStreamModel as { id?: string } | undefined)?.id,
			model.id,
			"activeInferenceModel must be set even when the stream later throws",
		);
		assert.equal(
			agent.state.activeInferenceModel,
			undefined,
			"activeInferenceModel must be cleared in finally even after stream errors",
		);
	});

	it("getProviderOptions are forwarded into the provider stream call", async () => {
		let capturedOptions: Record<string, unknown> | undefined;
		const model = getModel("anthropic", "claude-3-5-sonnet-20241022");
		const agent = new Agent({
			initialState: { model, systemPrompt: "test", tools: [] },
			getProviderOptions: async () => ({ customRuntimeOption: "present" }),
			streamFn: (_model, _context, options): AssistantMessageEventStream => {
				capturedOptions = options as Record<string, unknown> | undefined;
				return makeDoneStream(model.id);
			},
		});

		await agent.prompt("hello");
		assert.equal(capturedOptions?.customRuntimeOption, "present");
	});
});
