// Regression test for #4243 — abort() must be called BEFORE
// _disconnectFromAgent() inside newSession() and switchSession() so that
// message_end/agent_end events (and the #4216 finalization code) fire
// before we unsubscribe from the event bus.
//
// Verified behaviourally: we construct a real AgentSession, wrap `abort`
// and `_disconnectFromAgent` with call-order recording, trigger each
// session-transition method, and assert the observed call order.

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

async function createSession(opts: { persistSessions?: boolean } = {}): Promise<AgentSession> {
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

	// switchSession() needs a sessionFile; in-memory manager returns undefined.
	// Use file-backed manager when the test needs to resume.
	const sessionManager = opts.persistSessions
		? SessionManager.create(testDir, join(testDir, "sessions"))
		: SessionManager.inMemory(testDir);

	return new AgentSession({
		agent: new Agent(),
		sessionManager,
		settingsManager,
		cwd: testDir,
		resourceLoader,
		modelRegistry,
	});
}

/**
 * Wrap two methods on the same object so their call order is recorded.
 * Returns the recording array — assertions use index lookups.
 */
function recordCallOrder<O extends object>(
	target: O,
	methods: Array<keyof O>,
): string[] {
	const order: string[] = [];
	for (const method of methods) {
		const name = String(method);
		const original = (target as any)[name] as (...args: unknown[]) => unknown;
		if (typeof original !== "function") {
			throw new Error(`recordCallOrder: ${name} is not a function on target`);
		}
		(target as any)[name] = function (this: O, ...args: unknown[]) {
			order.push(name);
			return original.apply(this, args);
		};
	}
	return order;
}

describe("#4243 — abort() must run before _disconnectFromAgent()", () => {
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "agent-session-abort-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("newSession() invokes abort() before _disconnectFromAgent()", async () => {
		const session = await createSession();
		const order = recordCallOrder(session as any, ["abort", "_disconnectFromAgent"]);

		const ok = await session.newSession();
		assert.equal(ok, true);

		const abortIdx = order.indexOf("abort");
		const disconnectIdx = order.indexOf("_disconnectFromAgent");
		assert.ok(abortIdx >= 0, `newSession should call abort(); order=${order.join(",")}`);
		assert.ok(
			disconnectIdx >= 0,
			`newSession should call _disconnectFromAgent(); order=${order.join(",")}`,
		);
		assert.ok(
			abortIdx < disconnectIdx,
			`abort() must run before _disconnectFromAgent(); order=${order.join(",")}`,
		);
	});

	it("switchSession() invokes abort() before _disconnectFromAgent()", async () => {
		const session = await createSession({ persistSessions: true });
		// Seed a session file to switch to (switchSession reads from the session manager).
		await session.newSession();
		const sessionFile = session.sessionFile;
		assert.ok(typeof sessionFile === "string" && sessionFile.length > 0, "need a session file to switch to");

		const order = recordCallOrder(session as any, ["abort", "_disconnectFromAgent"]);

		const ok = await session.switchSession(sessionFile);
		assert.equal(ok, true);

		const abortIdx = order.indexOf("abort");
		const disconnectIdx = order.indexOf("_disconnectFromAgent");
		assert.ok(abortIdx >= 0, `switchSession should call abort(); order=${order.join(",")}`);
		assert.ok(
			disconnectIdx >= 0,
			`switchSession should call _disconnectFromAgent(); order=${order.join(",")}`,
		);
		assert.ok(
			abortIdx < disconnectIdx,
			`abort() must run before _disconnectFromAgent() in switchSession; order=${order.join(",")}`,
		);
	});
});
