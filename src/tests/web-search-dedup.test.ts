import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

/**
 * Regression test for #2029: server-side web_search tool renders 100+
 * duplicate result blocks because the message_update handler deletes
 * the pendingTools entry after rendering a webSearchResult, allowing
 * every subsequent message_update to re-create the ToolExecutionComponent.
 */

import { handleAgentEvent } from "../../packages/pi-coding-agent/src/modes/interactive/controllers/chat-controller.js";
import { initTheme } from "../../packages/pi-coding-agent/src/modes/interactive/theme/theme.js";

function makeMockUI() {
	return {
		requestRender: () => {},
		width: 80,
		height: 24,
		onResize: () => {},
		onInput: () => {},
		render: () => {},
		destroy: () => {},
	};
}

function makeMockHost() {
	const children: unknown[] = [];
	const pendingTools = new Map<string, any>();

	return {
		isInitialized: true,
		init: async () => {},
		footer: { invalidate: () => {} },
		ui: makeMockUI(),
		streamingComponent: {
			updateContent: () => {},
		},
		streamingMessage: undefined as any,
		chatContainer: {
			addChild(c: unknown) { children.push(c); },
			removeChild() {},
			clear() { children.length = 0; },
		},
		statusContainer: { clear: () => {}, addChild: () => {} },
		pendingTools,
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		settingsManager: { getShowImages: () => false },
		getMarkdownThemeWithSettings: () => ({}),
		addMessageToChat: () => {},
		formatWebSearchResult: () => "search result text",
		getRegisteredToolDefinition: () => undefined,
		checkShutdownRequested: async () => {},
		rebuildChatFromMessages: () => {},
		flushCompactionQueue: async () => {},
		showStatus: () => {},
		showError: () => {},
		updatePendingMessagesDisplay: () => {},
		updateTerminalTitle: () => {},
		updateEditorBorderColor: () => {},
		pendingMessagesContainer: { clear: () => {} },
		defaultWorkingMessage: "",
		isBashMode: false,
		compactionQueuedMessages: [],
		editorContainer: {},
		defaultEditor: { onEscape: () => {} },
		session: {},
		editor: {},
		keybindings: {},

		// expose for assertions
		get childCount() { return children.length; },
		get children() { return children; },
	};
}

function makeAssistantMessage(content: unknown[]) {
	return { role: "assistant" as const, content };
}

describe("web_search dedup (#2029)", () => {
	before(() => {
		initTheme("default", false);
	});

	it("should not re-create ToolExecutionComponent for a server tool whose result was already rendered", async () => {
		const host = makeMockHost();

		const serverToolBlock = {
			type: "serverToolUse",
			id: "ws_001",
			name: "web_search",
			input: { query: "test query" },
		};
		const webSearchResultBlock = {
			type: "webSearchResult",
			toolUseId: "ws_001",
			content: { type: "web_search_tool_result", content: [] },
		};
		const textBlock = { type: "text", text: "Here are the results..." };

		// Step 1: streaming event with serverToolUse -> component created
		await handleAgentEvent(host as any, {
			type: "message_update",
			message: makeAssistantMessage([serverToolBlock]),
		} as any);

		assert.equal(host.childCount, 1, "one component after serverToolUse");
		assert.ok(host.pendingTools.has("ws_001"), "tool in pendingTools");

		// Step 2: streaming event with both blocks -> result rendered
		await handleAgentEvent(host as any, {
			type: "message_update",
			message: makeAssistantMessage([serverToolBlock, webSearchResultBlock]),
		} as any);

		assert.equal(host.childCount, 1, "still one component after webSearchResult");

		// Step 3: subsequent text_delta streaming events -> must NOT re-create
		for (let i = 0; i < 50; i++) {
			await handleAgentEvent(host as any, {
				type: "message_update",
				message: makeAssistantMessage([
					serverToolBlock,
					webSearchResultBlock,
					{ ...textBlock, text: textBlock.text + " ".repeat(i) },
				]),
			} as any);
		}

		assert.equal(
			host.childCount,
			1,
			`expected 1 component but got ${host.childCount} -- duplicate re-creation loop detected`,
		);
	});

	it("should still render the result for the component when webSearchResult arrives", async () => {
		const host = makeMockHost();

		const serverToolBlock = {
			type: "serverToolUse",
			id: "ws_002",
			name: "web_search",
			input: { query: "another query" },
		};
		const webSearchResultBlock = {
			type: "webSearchResult",
			toolUseId: "ws_002",
			content: { type: "web_search_tool_result", content: [] },
		};

		// Step 1: serverToolUse creates the component
		await handleAgentEvent(host as any, {
			type: "message_update",
			message: makeAssistantMessage([serverToolBlock]),
		} as any);

		const component = host.pendingTools.get("ws_002");
		assert.ok(component, "component should exist");

		// Track updateResult calls
		let updateResultCalled = false;
		const origUpdateResult = component.updateResult.bind(component);
		component.updateResult = (...args: any[]) => {
			updateResultCalled = true;
			return origUpdateResult(...args);
		};

		// Step 2: webSearchResult arrives
		await handleAgentEvent(host as any, {
			type: "message_update",
			message: makeAssistantMessage([serverToolBlock, webSearchResultBlock]),
		} as any);

		assert.ok(updateResultCalled, "updateResult should be called on the component");
	});

	it("agent_end should clear pendingTools so no leak occurs", async () => {
		const host = makeMockHost();

		const serverToolBlock = {
			type: "serverToolUse",
			id: "ws_003",
			name: "web_search",
			input: { query: "query" },
		};

		// Create a pending tool
		await handleAgentEvent(host as any, {
			type: "message_update",
			message: makeAssistantMessage([serverToolBlock]),
		} as any);

		assert.ok(host.pendingTools.size > 0, "pendingTools should have entries");

		// agent_end should clear pendingTools
		await handleAgentEvent(host as any, {
			type: "agent_end",
		} as any);

		assert.equal(host.pendingTools.size, 0, "pendingTools cleared after agent_end");
	});
});
