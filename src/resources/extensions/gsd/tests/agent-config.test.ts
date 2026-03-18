import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { resolveAgentConfig, mergeAgentConfigs } from "../agent-config.js";
import type { ResolvedAgentConfig } from "../agent-config.js";
import type { Component, AgentSpec } from "../component-types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgentComponent(spec: Partial<AgentSpec> = {}, overrides: Partial<Component> = {}): Component {
	const fullSpec: AgentSpec = {
		systemPrompt: "prompt.md",
		...spec,
	};
	return {
		id: overrides.id ?? "test-agent",
		kind: "agent",
		metadata: {
			name: overrides.metadata?.name ?? "test-agent",
			description: "A test agent",
		},
		spec: fullSpec,
		dirPath: overrides.dirPath ?? "/agents/test",
		filePath: overrides.filePath ?? "/agents/test/component.yaml",
		source: "builtin",
		format: "component-yaml",
		enabled: true,
		...overrides,
	};
}

// ─── Defaults ───────────────────────────────────────────────────────────────

test("resolveAgentConfig applies defaults", () => {
	const agent = makeAgentComponent();
	const config = resolveAgentConfig(agent);

	assert.equal(config.name, "test-agent");
	assert.equal(config.maxTurns, 50);
	assert.equal(config.timeoutMinutes, 15);
	assert.equal(config.thinking, "standard");
	assert.equal(config.outputFormat, "text");
	assert.equal(config.isolation, "none");
	assert.deepEqual(config.tools, []);
	assert.deepEqual(config.deniedTools, []);
	assert.deepEqual(config.modelFallbacks, []);
	assert.deepEqual(config.contextFiles, []);
});

test("resolveAgentConfig resolves systemPromptPath relative to dirPath", () => {
	const agent = makeAgentComponent({ systemPrompt: "prompts/system.md" }, { dirPath: "/my/agents/scout" });
	const config = resolveAgentConfig(agent);
	assert.equal(config.systemPromptPath, path.resolve("/my/agents/scout", "prompts/system.md"));
});

// ─── Spec overrides ─────────────────────────────────────────────────────────

test("resolveAgentConfig uses spec values over defaults", () => {
	const agent = makeAgentComponent({
		systemPrompt: "prompt.md",
		model: "claude-opus-4-6",
		maxTurns: 100,
		timeoutMinutes: 30,
		thinking: "full",
		outputFormat: "markdown",
		isolation: "worktree",
		temperature: 0.5,
		maxTokens: 4096,
	});
	const config = resolveAgentConfig(agent);

	assert.equal(config.model, "claude-opus-4-6");
	assert.equal(config.maxTurns, 100);
	assert.equal(config.timeoutMinutes, 30);
	assert.equal(config.thinking, "full");
	assert.equal(config.outputFormat, "markdown");
	assert.equal(config.isolation, "worktree");
	assert.equal(config.temperature, 0.5);
	assert.equal(config.maxTokens, 4096);
});

// ─── Tool normalization ─────────────────────────────────────────────────────

test("resolveAgentConfig normalizes string[] tools to allow list", () => {
	const agent = makeAgentComponent({
		systemPrompt: "prompt.md",
		tools: ["read", "grep", "bash"],
	});
	const config = resolveAgentConfig(agent);
	assert.deepEqual(config.tools, ["read", "grep", "bash"]);
	assert.deepEqual(config.deniedTools, []);
});

test("resolveAgentConfig normalizes AgentToolConfig", () => {
	const agent = makeAgentComponent({
		systemPrompt: "prompt.md",
		tools: { allow: ["read", "grep"], deny: ["bash"] },
	});
	const config = resolveAgentConfig(agent);
	assert.deepEqual(config.tools, ["read", "grep"]);
	assert.deepEqual(config.deniedTools, ["bash"]);
});

// ─── Context files ──────────────────────────────────────────────────────────

test("resolveAgentConfig extracts context files", () => {
	const agent = makeAgentComponent({
		systemPrompt: "prompt.md",
		context: { alwaysInclude: ["README.md", "ARCHITECTURE.md"] },
	});
	const config = resolveAgentConfig(agent);
	assert.deepEqual(config.contextFiles, ["README.md", "ARCHITECTURE.md"]);
});

// ─── Inheritance via registry ───────────────────────────────────────────────

test("resolveAgentConfig merges with parent when extends is set", () => {
	const parent = makeAgentComponent(
		{
			systemPrompt: "parent-prompt.md",
			model: "claude-sonnet-4-6",
			maxTurns: 200,
			tools: ["read", "grep"],
		},
		{ id: "parent-agent", metadata: { name: "parent-agent", description: "parent" }, dirPath: "/agents/parent" },
	);

	const child = makeAgentComponent(
		{
			systemPrompt: "child-prompt.md",
			extends: "parent-agent",
			maxTurns: 75,
		},
		{ id: "child-agent", metadata: { name: "child-agent", description: "child" }, dirPath: "/agents/child" },
	);

	const registry = {
		resolve: (ref: string) => (ref === "parent-agent" ? parent : undefined),
	};

	const config = resolveAgentConfig(child, registry);

	// Child overrides
	assert.equal(config.maxTurns, 75);
	assert.equal(config.systemPromptPath, path.resolve("/agents/child", "child-prompt.md"));

	// Inherited from parent
	assert.equal(config.model, "claude-sonnet-4-6");
});

// ─── mergeAgentConfigs ──────────────────────────────────────────────────────

test("mergeAgentConfigs child overrides parent fields", () => {
	const parent: ResolvedAgentConfig = {
		name: "parent",
		model: "claude-sonnet-4-6",
		modelFallbacks: ["claude-haiku-4-5"],
		tools: ["read"],
		deniedTools: [],
		maxTurns: 50,
		timeoutMinutes: 15,
		thinking: "standard",
		outputFormat: "text",
		isolation: "none",
		systemPromptPath: "/parent/prompt.md",
		contextFiles: ["parent-context.md"],
	};

	const childSpec: Partial<AgentSpec> = {
		model: "claude-opus-4-6",
		maxTurns: 100,
		thinking: "full",
	};

	const merged = mergeAgentConfigs(parent, childSpec, "/child");

	assert.equal(merged.model, "claude-opus-4-6");
	assert.equal(merged.maxTurns, 100);
	assert.equal(merged.thinking, "full");
	// Inherited
	assert.deepEqual(merged.tools, ["read"]);
	assert.equal(merged.timeoutMinutes, 15);
	assert.equal(merged.systemPromptPath, "/parent/prompt.md");
});

test("mergeAgentConfigs child systemPrompt overrides parent path", () => {
	const parent: ResolvedAgentConfig = {
		name: "parent",
		modelFallbacks: [],
		tools: [],
		deniedTools: [],
		maxTurns: 50,
		timeoutMinutes: 15,
		thinking: "standard",
		outputFormat: "text",
		isolation: "none",
		systemPromptPath: "/parent/prompt.md",
		contextFiles: [],
	};

	const merged = mergeAgentConfigs(parent, { systemPrompt: "my-prompt.md" }, "/child/dir");
	assert.equal(merged.systemPromptPath, path.resolve("/child/dir", "my-prompt.md"));
});
