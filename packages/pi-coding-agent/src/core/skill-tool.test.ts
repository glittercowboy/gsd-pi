import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Agent } from "@gsd/pi-agent-core";
import { AuthStorage } from "./auth-storage.js";
import { AgentSession } from "./agent-session.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

let testDir: string;

function writeSkill(
	cwd: string,
	name: string,
	description: string,
	body = `# ${name}\n`,
	options?: { disableModelInvocation?: boolean },
): string {
	const skillDir = join(cwd, ".pi", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	const disableModelInvocation = options?.disableModelInvocation === true;
	writeFileSync(
		skillPath,
		`---\nname: ${name}\ndescription: ${description}${disableModelInvocation ? "\ndisable-model-invocation: true" : ""}\n---\n\n${body}`,
	);
	return skillPath;
}

describe("Skill tool", () => {
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "skill-tool-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	async function createSession() {
		const agentDir = join(testDir, "agent-home");
		const authStorage = AuthStorage.inMemory({});
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: testDir,
			agentDir,
			settingsManager,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();

		return new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(testDir),
			settingsManager,
			cwd: testDir,
			resourceLoader,
			modelRegistry,
		});
	}

	it("resolves a project-level skill to the exact skill block format", async () => {
		const skillPath = writeSkill(
			testDir,
			"swift-testing",
			"Use for Swift Testing assertions and verification patterns.",
			"# Swift Testing\nUse this skill.\n",
		);
		const session = await createSession();

		const tool = session.state.tools.find((entry) => entry.name === "Skill");
		assert.ok(tool, "Skill tool should be registered");

		const result = await tool.execute("call-1", { skill: "swift-testing" });
		assert.equal(
			result.content[0]?.type === "text" ? result.content[0].text : "",
			`<skill name="swift-testing" location="${skillPath}">\nReferences are relative to ${join(testDir, ".pi", "skills", "swift-testing")}.\n\n# Swift Testing\nUse this skill.\n</skill>`,
		);
	});

	it("returns a helpful error for unknown skills", async () => {
		writeSkill(testDir, "swift-testing", "Use for Swift Testing assertions and verification patterns.");
		const session = await createSession();
		const tool = session.state.tools.find((entry) => entry.name === "Skill");
		assert.ok(tool, "Skill tool should be registered");

		const result = await tool.execute("call-2", { skill: "nonexistent" });
		const message = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(message, /^Skill "nonexistent" not found\. Available skills: /);
		assert.match(message, /swift-testing/);
	});

	it("does not expose disable-model-invocation skills through the Skill tool", async () => {
		writeSkill(testDir, "visible-skill", "Visible skill description.");
		writeSkill(
			testDir,
			"hidden-skill",
			"Hidden skill description.",
			"# Hidden Skill\nUse only via explicit /skill command.\n",
			{ disableModelInvocation: true },
		);
		const session = await createSession();
		const tool = session.state.tools.find((entry) => entry.name === "Skill");
		assert.ok(tool, "Skill tool should be registered");

		const result = await tool.execute("call-3", { skill: "hidden-skill" });
		const message = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(message, /^Skill "hidden-skill" not found\. Available skills: /);
		assert.match(message, /visible-skill/);
		assert.doesNotMatch(message, /Available skills: .*hidden-skill/);
	});

	it("still expands disable-model-invocation skills via explicit /skill commands", async () => {
		const skillPath = writeSkill(
			testDir,
			"hidden-skill",
			"Hidden skill description.",
			"# Hidden Skill\nUse only via explicit /skill command.\n",
			{ disableModelInvocation: true },
		);
		const session = await createSession();

		const expanded = (session as any)._expandSkillCommand("/skill:hidden-skill") as string;
		assert.equal(
			expanded,
			`<skill name="hidden-skill" location="${skillPath}">\nReferences are relative to ${join(testDir, ".pi", "skills", "hidden-skill")}.\n\n# Hidden Skill\nUse only via explicit /skill command.\n</skill>`,
		);
	});

	it("includes skill catalog in the default session prompt", async () => {
		writeSkill(testDir, "swift-testing", "Use for Swift Testing assertions and verification patterns.");
		writeSkill(
			testDir,
			"hidden-skill",
			"Hidden skill description.",
			"# Hidden Skill\nUse only via explicit /skill command.\n",
			{ disableModelInvocation: true },
		);
		const session = await createSession();

		assert.ok(session.getActiveToolNames().includes("Skill"));
		assert.ok(session.systemPrompt.includes("<available_skills>"));
		assert.ok(session.systemPrompt.includes("swift-testing"));
		assert.ok(!session.systemPrompt.includes("hidden-skill"));
	});

	it("includes skill catalog in the session prompt when read is disabled but Skill is preserved", async () => {
		writeSkill(testDir, "swift-testing", "Use for Swift Testing assertions and verification patterns.");
		const session = await createSession();

		session.setActiveToolsByName(["bash"]);

		assert.deepEqual(session.getActiveToolNames().sort(), ["Skill", "bash"]);
		assert.ok(session.systemPrompt.includes("<available_skills>"));
		assert.ok(session.systemPrompt.includes("swift-testing"));
		assert.ok(!session.getActiveToolNames().includes("read"));
	});
});
