// Regression test for #3616: newSession() must restore the full tool set
// when cwd is unchanged.
//
// The bug: extensions may narrow the active tool list via setActiveTools()
// during a session. Without a refresh in the else branch of newSession(),
// the narrowed set persists into the next session — breaking auto-mode
// subagent sessions that expect a full tool palette.
//
// Verified behaviourally: construct an AgentSession, wrap _refreshToolRegistry
// to record its args, call newSession() with cwd unchanged, and assert that
// a refresh was requested with includeAllExtensionTools: true.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Agent } from "@gsd/pi-agent-core";
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

describe("#3616 — newSession() restores narrowed tool set when cwd unchanged", () => {
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "agent-session-tool-refresh-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("calls _refreshToolRegistry with includeAllExtensionTools: true when cwd unchanged", async () => {
		const session = await createSession();
		// Pin _cwd so newSession()'s `process.cwd()` branch takes the
		// cwd-unchanged path. The production code compares `this._cwd !==
		// previousCwd`; we force equality by setting _cwd to current cwd.
		(session as any)._cwd = process.cwd();

		const refreshCalls: Array<{ includeAllExtensionTools?: boolean }> = [];
		const originalRefresh = (session as any)._refreshToolRegistry.bind(session);
		(session as any)._refreshToolRegistry = (options?: { includeAllExtensionTools?: boolean }) => {
			refreshCalls.push(options ?? {});
			return originalRefresh(options);
		};

		const ok = await session.newSession();
		assert.equal(ok, true);

		assert.ok(
			refreshCalls.length > 0,
			"newSession() should invoke _refreshToolRegistry in the cwd-unchanged branch",
		);
		assert.ok(
			refreshCalls.some((o) => o.includeAllExtensionTools === true),
			`at least one _refreshToolRegistry call must pass includeAllExtensionTools: true; observed=${JSON.stringify(refreshCalls)}`,
		);
	});

	it("agent.reset() does not clear _state.tools (tools persist across reset)", () => {
		// Structural invariant protecting #3616: if reset() starts clearing
		// tools, newSession()'s refresh becomes the only defense against loss.
		// Assertion is behavioural — seed tools, call reset(), observe survival.
		const agent = new Agent();
		const tool = {
			name: "test_tool",
			description: "x",
			schema: { type: "object", properties: {}, additionalProperties: false } as any,
			execute: async () => ({ content: [] }),
		};
		(agent as any)._state.tools = [tool];
		agent.reset();
		assert.deepEqual(
			(agent as any)._state.tools,
			[tool],
			"Agent.reset() must preserve _state.tools",
		);
	});

	it("takes the cwd-changed branch (rebuilds runtime) when cwd differs", async () => {
		const session = await createSession();
		// Force the cwd-changed branch: set _cwd to something that won't equal process.cwd().
		(session as any)._cwd = join(testDir, "some", "other", "cwd");

		let buildRuntimeCalled = false;
		let buildRuntimeIncludedAll = false;
		const originalBuild = (session as any)._buildRuntime.bind(session);
		(session as any)._buildRuntime = (options?: { includeAllExtensionTools?: boolean }) => {
			buildRuntimeCalled = true;
			if (options?.includeAllExtensionTools === true) buildRuntimeIncludedAll = true;
			return originalBuild(options);
		};

		const ok = await session.newSession();
		assert.equal(ok, true);

		assert.ok(buildRuntimeCalled, "cwd-changed branch must rebuild the tool runtime");
		assert.ok(
			buildRuntimeIncludedAll,
			"cwd-changed branch must rebuild with includeAllExtensionTools: true",
		);
	});
});
