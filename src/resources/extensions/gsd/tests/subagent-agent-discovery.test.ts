import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverAgents } from "../../subagent/agents.ts";

function makeProjectRoot(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "gsd-subagent-agents-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function writeAgent(root: string, configDirName: ".gsd" | ".pi", name = "ping"): string {
	const agentsDir = join(root, configDirName, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${name} agent\n---\nSay hello\n`,
	);
	return agentsDir;
}

test("discoverAgents finds project agents in .gsd/agents", (t) => {
	const root = makeProjectRoot(t);
	const agentsDir = writeAgent(root, ".gsd");

	const discovery = discoverAgents(root, "project");

	assert.equal(discovery.projectAgentsDir, agentsDir);
	assert.deepEqual(discovery.agents.map((agent) => agent.name), ["ping"]);
	assert.equal(discovery.agents[0]?.source, "project");
});

test("discoverAgents falls back to legacy .pi/agents when needed", (t) => {
	const root = makeProjectRoot(t);
	const agentsDir = writeAgent(root, ".pi");

	const discovery = discoverAgents(root, "project");

	assert.equal(discovery.projectAgentsDir, agentsDir);
	assert.deepEqual(discovery.agents.map((agent) => agent.name), ["ping"]);
});

test("discoverAgents accepts tools frontmatter as a YAML list", (t) => {
	const root = makeProjectRoot(t);
	const agentsDir = join(root, ".gsd", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "reviewer.md"),
		[
			"---",
			"name: reviewer",
			"description: review agent",
			"tools:",
			"  - bash",
			"  - read",
			"---",
			"Review code",
			"",
		].join("\n"),
	);

	const discovery = discoverAgents(root, "project");

	assert.deepEqual(discovery.agents.map((agent) => agent.name), ["reviewer"]);
	assert.deepEqual(discovery.agents[0]?.tools, ["bash", "read"]);
});

test("discoverAgents still accepts comma-separated tools frontmatter", (t) => {
	const root = makeProjectRoot(t);
	const agentsDir = join(root, ".gsd", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "reviewer.md"),
		[
			"---",
			"name: reviewer",
			"description: review agent",
			"tools: bash, read",
			"---",
			"Review code",
			"",
		].join("\n"),
	);

	const discovery = discoverAgents(root, "project");

	assert.deepEqual(discovery.agents[0]?.tools, ["bash", "read"]);
});
