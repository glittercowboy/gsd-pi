import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { ExtensionRunner } from "./runner.js";
import type { Extension, ExtensionRuntime, ToolCallEvent } from "./index.js";
import { SessionManager } from "../session-manager.js";
import { ModelRegistry } from "../model-registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage } from "../auth-storage.js";

function makeMinimalRuntime(): ExtensionRuntime {
	return {
		sendMessage: async () => {},
		sendUserMessage: async () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => {},
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
}

function makeThrowingExtension(eventType: string, error: Error): Extension {
	const handlers = new Map();
	handlers.set(eventType, [
		async () => {
			throw error;
		},
	]);
	return {
		path: "/test/throwing-ext",
		handlers,
		commands: [],
		shortcuts: [],
		diagnostics: [],
	} as unknown as Extension;
}

describe("ExtensionRunner.emitToolCall", () => {
	it("catches throwing extension handler and routes to emitError", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
		t.after(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		const sessionManager = SessionManager.create(dir, dir);
		const authStorage = AuthStorage.create();
		const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.json"));

		const throwingExt = makeThrowingExtension("tool_call", new Error("handler crashed"));
		const runtime = makeMinimalRuntime();
		const runner = new ExtensionRunner([throwingExt], runtime, dir, sessionManager, modelRegistry);

		const errors: any[] = [];
		runner.onError((err) => errors.push(err));

		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "test-123",
			toolName: "test_tool",
			input: {},
		} as ToolCallEvent;

		const result = await runner.emitToolCall(event);

		// Should not throw — error is caught and routed to emitError
		assert.equal(result, undefined);
		assert.equal(errors.length, 1);
		assert.equal(errors[0].error, "handler crashed");
		assert.equal(errors[0].event, "tool_call");
		assert.equal(errors[0].extensionPath, "/test/throwing-ext");
	});
});
