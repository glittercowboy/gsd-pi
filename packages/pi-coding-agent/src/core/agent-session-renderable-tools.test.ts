import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Agent } from "@gsd/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "./extensions/types.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

let testDir: string;

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

describe("AgentSession renderable tool lookup", () => {
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "agent-session-tools-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("matches registered tool definitions case-insensitively (#3780)", async () => {
		const session = await createSession();
		const bashDefinition = {
			name: "bash",
			label: "bash",
			description: "Execute a shell command",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
		} satisfies ToolDefinition;

		(session as any)._extensionRunner = {
			getAllRegisteredTools: () => [{ definition: bashDefinition }],
		};

		assert.equal(session.getRenderableToolDefinition("Bash"), bashDefinition);
		assert.equal(session.getRenderableToolDefinition("BASH"), bashDefinition);
	});
});
