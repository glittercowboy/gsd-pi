// Regression test: explicit model switches must cancel any in-flight retry
// BEFORE applying the new model. Otherwise stale provider backoff errors
// from the previous model can continue to land after the switch.
//
// Verified behaviourally: construct a real AgentSession, wrap
// `_retryHandler.abortRetry` and `agent.setModel` to record call order,
// invoke setModel(), and assert the observed order.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Agent } from "@gsd/pi-agent-core";
import { getModel } from "@gsd/pi-ai";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

let testDir: string;

async function createSession(): Promise<AgentSession> {
	const agentDir = join(testDir, "agent-home");
	const authStorage = AuthStorage.inMemory({});
	// Seed a runtime anthropic API key so modelRegistry.isProviderRequestReady()
	// returns true and setModel() doesn't throw on missing credentials.
	authStorage.setRuntimeApiKey("anthropic", "sk-test-not-used");
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

describe("AgentSession — explicit model switch cancels retry before applying new model", () => {
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "agent-session-model-switch-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("setModel() calls _retryHandler.abortRetry() before agent.setModel()", async () => {
		const session = await createSession();

		const order: string[] = [];
		const retryHandler = (session as any)._retryHandler;
		const originalAbortRetry = retryHandler.abortRetry.bind(retryHandler);
		retryHandler.abortRetry = () => {
			order.push("abortRetry");
			return originalAbortRetry();
		};

		const agent = (session as any).agent;
		const originalSetModel = agent.setModel.bind(agent);
		agent.setModel = (model: unknown) => {
			order.push("setModel");
			return originalSetModel(model);
		};

		const newModel = getModel("anthropic", "claude-3-5-sonnet-20241022");
		await session.setModel(newModel, { persist: false });

		const abortIdx = order.indexOf("abortRetry");
		const setIdx = order.indexOf("setModel");
		assert.ok(abortIdx >= 0, `setModel should cancel in-flight retry; order=${order.join(",")}`);
		assert.ok(setIdx >= 0, `setModel should call agent.setModel; order=${order.join(",")}`);
		assert.ok(
			abortIdx < setIdx,
			`retry cancellation must happen before applying the new model; order=${order.join(",")}`,
		);
	});
});
