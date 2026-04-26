import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentProcessArgs } from "../index.js";
import type { AgentConfig } from "../agents.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "A test agent",
		systemPrompt: "You are a test agent",
		source: "project" as const,
		tools: [],
		...overrides,
	} as AgentConfig;
}

describe("buildSubagentProcessArgs model override", () => {
	it("uses modelOverride when provided", () => {
		const agent = makeAgent({ model: "claude-haiku-4-5-20251001" });
		const args = buildSubagentProcessArgs(agent, "do something", null, "claude-sonnet-4-6");
		const modelIndex = args.indexOf("--model");
		assert.notEqual(modelIndex, -1, "should include --model flag");
		assert.equal(args[modelIndex + 1], "claude-sonnet-4-6");
	});

	it("falls back to agent.model when no override provided", () => {
		const agent = makeAgent({ model: "claude-haiku-4-5-20251001" });
		const args = buildSubagentProcessArgs(agent, "do something", null);
		const modelIndex = args.indexOf("--model");
		assert.notEqual(modelIndex, -1, "should include --model flag");
		assert.equal(args[modelIndex + 1], "claude-haiku-4-5-20251001");
	});

	it("omits --model when neither override nor agent.model is set", () => {
		const agent = makeAgent({ model: undefined });
		const args = buildSubagentProcessArgs(agent, "do something", null);
		assert.equal(args.indexOf("--model"), -1, "should not include --model flag");
	});

	it("override takes precedence over agent.model", () => {
		const agent = makeAgent({ model: "model-a" });
		const args = buildSubagentProcessArgs(agent, "task", null, "model-b");
		const modelIndex = args.indexOf("--model");
		assert.equal(args[modelIndex + 1], "model-b");
	});

	it("uses override even when agent has no model", () => {
		const agent = makeAgent({ model: undefined });
		const args = buildSubagentProcessArgs(agent, "task", null, "model-override");
		const modelIndex = args.indexOf("--model");
		assert.notEqual(modelIndex, -1);
		assert.equal(args[modelIndex + 1], "model-override");
	});
});
