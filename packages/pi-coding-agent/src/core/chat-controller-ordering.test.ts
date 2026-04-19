import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAgentEvent } from "../modes/interactive/controllers/chat-controller.js";

function makeUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistant(content: any[]) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "claude-code",
		model: "claude-sonnet-4",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createHost() {
	const chatContainer = {
		children: [] as any[],
		addChild(component: any) {
			this.children.push(component);
		},
		removeChild(component: any) {
			const idx = this.children.indexOf(component);
			if (idx !== -1) this.children.splice(idx, 1);
		},
		clear() {
			this.children = [];
		},
	};

	const pinnedMessageContainer = {
		children: [] as any[],
		addChild(component: any) {
			this.children.push(component);
		},
		removeChild(component: any) {
			const idx = this.children.indexOf(component);
			if (idx !== -1) this.children.splice(idx, 1);
		},
		clear() {
			this.children = [];
		},
	};

	const host: any = {
		isInitialized: true,
		init: async () => {},
		defaultEditor: { onEscape: undefined },
		editor: {},
		session: { retryAttempt: 0, abortCompaction: () => {}, abortRetry: () => {} },
		// rows:1 keeps the pinned-zone off-screen-threshold at its floor (1) so
		// any rendered segment after a pinnable text block triggers the pin.
		// Real terminals are larger; see chat-controller rowsRenderedAfterContentIndex.
		ui: { requestRender: () => {}, terminal: { rows: 1, columns: 80 } },
		footer: { invalidate: () => {} },
		keybindings: {},
		statusContainer: { clear: () => {}, addChild: () => {} },
		chatContainer,
		settingsManager: { getTimestampFormat: () => "date-time-iso", getShowImages: () => false },
		pendingTools: new Map(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		isBashMode: false,
		defaultWorkingMessage: "Working...",
		compactionQueuedMessages: [],
		editorContainer: {},
		pendingMessagesContainer: { clear: () => {} },
		pinnedMessageContainer,
		addMessageToChat: () => {},
		getMarkdownThemeWithSettings: () => ({}),
		formatWebSearchResult: () => "",
		getRegisteredToolDefinition: () => undefined,
		checkShutdownRequested: async () => {},
		rebuildChatFromMessages: () => {},
		flushCompactionQueue: async () => {},
		showStatus: () => {},
		showError: () => {},
		updatePendingMessagesDisplay: () => {},
		updateTerminalTitle: () => {},
		updateEditorBorderColor: () => {},
	};

	return host;
}

test("chat-controller renders content blocks in content[] index order (tool-first stream)", async () => {
	// ToolExecutionComponent uses the global theme singleton.
	// Install a minimal no-op theme implementation for this unit test.
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	const toolId = "mcp-tool-1";
	const toolCall = {
		type: "toolCall",
		id: toolId,
		name: "exec_command",
		arguments: { cmd: "echo hi" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	assert.equal(host.chatContainer.children.length, 0, "nothing should render before content arrives");

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([toolCall]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					...toolCall,
					externalResult: {
						content: [{ type: "text", text: "tool output" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([toolCall]),
			},
		} as any,
	);

	// content[0] = toolCall → ToolExecutionComponent renders first
	assert.equal(host.chatContainer.children.length, 1, "tool execution block should render immediately");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");

	host.getMarkdownThemeWithSettings = () => ({});

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([toolCall, { type: "text", text: "done" }]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "done",
				partial: makeAssistant([toolCall, { type: "text", text: "done" }]),
			},
		} as any,
	);

	// content[0]=toolCall, content[1]=text → order: tool, then text
	assert.equal(host.chatContainer.children.length, 2, "text run should render after tool in content[] order");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
});

test("chat-controller renders serverToolUse before trailing text matching content[] index order", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	const toolId = "mcp-secure-1";
	const serverToolUse = {
		type: "serverToolUse",
		id: toolId,
		name: "mcp__gsd-workflow__secure_env_collect",
		input: { projectDir: "/tmp/project", keys: [{ key: "SECURE_PASSWORD" }], destination: "dotenv" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([serverToolUse]),
			assistantMessageEvent: {
				type: "server_tool_use",
				contentIndex: 0,
				partial: makeAssistant([serverToolUse]),
			},
		} as any,
	);

	// content[0] = serverToolUse → ToolExecutionComponent renders first
	assert.equal(host.chatContainer.children.length, 1, "server tool block should render immediately");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");

	host.getMarkdownThemeWithSettings = () => ({});
	const resultMessage = makeAssistant([
		{
			...serverToolUse,
			externalResult: {
				content: [{ type: "text", text: "secure_env_collect was cancelled by user." }],
				details: {},
				isError: true,
			},
		},
		{ type: "text", text: "The secure password collection was cancelled." },
	]);

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: resultMessage,
			assistantMessageEvent: {
				type: "server_tool_use",
				contentIndex: 0,
				partial: resultMessage,
			},
		} as any,
	);

	// content[0]=serverToolUse, content[1]=text → order: tool, then text
	assert.equal(host.chatContainer.children.length, 2, "text run should render after server tool in content[] order");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
});

test("chat-controller replays final message_end content when result adds unstreamed trailing text", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const tool = {
		type: "toolCall",
		id: "mcp-end-replay-1",
		name: "read",
		mcpServer: "filesystem",
		arguments: { filePath: "/tmp/demo.txt" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	const streamedContent = [
		tool,
		{ type: "thinking", thinking: "I am analyzing tool output..." },
	];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(streamedContent),
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 1,
				delta: "I am analyzing tool output...",
				partial: makeAssistant(streamedContent),
			},
		} as any,
	);

	assert.equal(host.chatContainer.children.length, 2, "streaming shows tool + thinking only");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");

	// Final payload includes trailing text that never arrived as message_update.
	const finalContent = [
		tool,
		{ type: "thinking", thinking: "I am analyzing tool output..." },
		{ type: "text", text: "Correct anything important I missed?" },
	];
	await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) } as any);

	assert.equal(host.chatContainer.children.length, 3, "message_end should replay and include trailing text segment");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
	assert.equal(host.chatContainer.children[2]?.constructor?.name, "AssistantMessageComponent");
});

test("chat-controller keeps pre-tool prose visible until post-tool prose arrives, then prunes it", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const mcpTool = {
		type: "toolCall",
		id: "mcp-tool-1",
		name: "read",
		mcpServer: "filesystem",
		arguments: { filePath: "/tmp/demo.txt" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	// Provisional assistant text arrives first.
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "Let me inspect the workspace first." }]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Let me inspect the workspace first.",
				partial: makeAssistant([{ type: "text", text: "Let me inspect the workspace first." }]),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 1);
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");

	// MCP tool appears; provisional text should remain visible until post-tool prose exists.
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "Let me inspect the workspace first." }, mcpTool]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...mcpTool,
					externalResult: {
						content: [{ type: "text", text: "file preview" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([{ type: "text", text: "Let me inspect the workspace first." }, mcpTool]),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 2, "pre-tool prose should remain during tool-only window");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent");

	// Post-tool prose arrives: pre-tool prose should now be pruned.
	const finalContent = [
		{ type: "text", text: "Let me inspect the workspace first." },
		mcpTool,
		{ type: "text", text: "Which missing feature matters most to you?" },
	];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(finalContent),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 2,
				delta: "Which missing feature matters most to you?",
				partial: makeAssistant(finalContent),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 2);
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");

	// Finalize to tear down any pinned spinner state.
	await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) } as any);
});

test("chat-controller keeps pre-tool thinking visible for claude-code MCP turns without post-tool prose", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const mcpTool = {
		type: "toolCall",
		id: "mcp-tool-thinking-1",
		name: "read",
		mcpServer: "filesystem",
		arguments: { filePath: "/tmp/demo.txt" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	const thinkingOnly = [{ type: "thinking", thinking: "I should inspect the workspace." }];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(thinkingOnly),
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "I should inspect the workspace.",
				partial: makeAssistant(thinkingOnly),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 1);
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([thinkingOnly[0], mcpTool]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...mcpTool,
					externalResult: {
						content: [{ type: "text", text: "file preview" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([thinkingOnly[0], mcpTool]),
			},
		} as any,
	);

	assert.equal(host.chatContainer.children.length, 2, "thinking should remain visible while only tool output is present");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent");

	await handleAgentEvent(host, { type: "message_end", message: makeAssistant([thinkingOnly[0], mcpTool]) } as any);
});

test("chat-controller keeps pre-tool question text for claude-code MCP when post-tool prose exists", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const mcpTool = {
		type: "toolCall",
		id: "mcp-tool-question-1",
		name: "glob",
		mcpServer: "filesystem",
		arguments: { pattern: "**/*" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	const questionText = { type: "text", text: "Which file should I inspect?" };

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([questionText]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: questionText.text,
				partial: makeAssistant([questionText]),
			},
		} as any,
	);

	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([questionText, mcpTool]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...mcpTool,
					externalResult: {
						content: [{ type: "text", text: "glob output" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([questionText, mcpTool]),
			},
		} as any,
	);

	const postTool = { type: "text", text: "I'll review that next." };
	const finalContent = [questionText, mcpTool, postTool];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(finalContent),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 2,
				delta: postTool.text,
				partial: makeAssistant(finalContent),
			},
		} as any,
	);

	assert.equal(host.chatContainer.children.length, 3, "question text should remain alongside MCP tool and post-tool prose");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent", "pre-tool question stays visible");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent", "tool renders in the middle");
	assert.equal(host.chatContainer.children[2]?.constructor?.name, "AssistantMessageComponent", "post-tool prose renders last");

	await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) } as any);
});

test("chat-controller prunes orphaned provisional text after claude-code sub-turn shrink when MCP tools appear", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const mcpTool = {
		type: "toolCall",
		id: "mcp-tool-shrink-1",
		name: "glob",
		mcpServer: "filesystem",
		arguments: { pattern: "**/*" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	// Sub-turn 1: generate longer provisional text content.
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "Old provisional preface." }, { type: "text", text: "More old text." }]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "More old text.",
				partial: makeAssistant([{ type: "text", text: "Old provisional preface." }, { type: "text", text: "More old text." }]),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 1, "first sub-turn text run should render");

	// Sub-turn 2 starts (content shrink): old component is orphaned by design.
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "New provisional text before tool." }]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "New provisional text before tool.",
				partial: makeAssistant([{ type: "text", text: "New provisional text before tool." }]),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 2, "shrink keeps prior text until MCP tool context appears");

	// MCP tool appears in sub-turn 2: tool-only windows keep provisional prose visible.
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "New provisional text before tool." }, mcpTool]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...mcpTool,
					externalResult: {
						content: [{ type: "text", text: "glob output" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([{ type: "text", text: "New provisional text before tool." }, mcpTool]),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 3, "stale text runs are deferred until post-tool prose arrives");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
	assert.equal(host.chatContainer.children[2]?.constructor?.name, "ToolExecutionComponent");

	const finalContent = [mcpTool, { type: "text", text: "Final visible question?" }];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(finalContent),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "Final visible question?",
				partial: makeAssistant(finalContent),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 2);
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");

	await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) } as any);
});

test("chat-controller prunes orphans from multiple sub-turn shrinks before MCP post-tool prose", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const mcpTool = {
		type: "toolCall",
		id: "mcp-tool-multi-shrink-1",
		name: "glob",
		mcpServer: "filesystem",
		arguments: { pattern: "**/*" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	// Sub-turn 1: 3 text blocks (merged into one text-run).
	const subTurn1 = [
		{ type: "text", text: "First provisional A." },
		{ type: "text", text: "First provisional B." },
		{ type: "text", text: "First provisional C." },
	];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(subTurn1),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 2,
				delta: "First provisional C.",
				partial: makeAssistant(subTurn1),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 1, "first sub-turn renders 1 text-run");

	// Sub-turn 2 (first shrink 3 → 2 blocks).
	const subTurn2 = [
		{ type: "text", text: "Second provisional A." },
		{ type: "text", text: "Second provisional B." },
	];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(subTurn2),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "Second provisional B.",
				partial: makeAssistant(subTurn2),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 2, "first shrink appends, keeps prior text as frozen history");

	// Sub-turn 3 (second shrink 2 → 1 block). This is the critical step —
	// without orphan accumulation, sub-turn 1's orphaned segment would be
	// dropped from tracking here and later strand in the container.
	const subTurn3 = [{ type: "text", text: "Third provisional." }];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(subTurn3),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Third provisional.",
				partial: makeAssistant(subTurn3),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 3, "second shrink appends again, still no prune (no post-tool text)");

	// MCP tool appears — tool-only window still keeps provisional prose visible.
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "Third provisional." }, mcpTool]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...mcpTool,
					externalResult: {
						content: [{ type: "text", text: "glob output" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([{ type: "text", text: "Third provisional." }, mcpTool]),
			},
		} as any,
	);
	assert.equal(host.chatContainer.children.length, 4, "tool-only window keeps all three provisional text-runs");

	// Final post-tool text arrives — prune must drop ALL three pre-tool
	// provisional text-runs across both shrinks, leaving only tool + final text.
	const finalContent = [mcpTool, { type: "text", text: "Final answer." }];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(finalContent),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "Final answer.",
				partial: makeAssistant(finalContent),
			},
		} as any,
	);
	assert.equal(
		host.chatContainer.children.length,
		2,
		"all pre-tool provisional segments from every shrink must be pruned once post-tool prose arrives",
	);
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");

	await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) } as any);
});

test("chat-controller pins latest assistant text above editor when tool calls are present", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	const toolId = "tool-pin-1";
	const toolCall = {
		type: "toolCall",
		id: toolId,
		name: "exec_command",
		arguments: { cmd: "echo hi" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should be empty at message_start");

	// Send a message with text followed by a tool call
	host.getMarkdownThemeWithSettings = () => ({});
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([
				{ type: "text", text: "Looking at the files now." },
				toolCall,
			]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...toolCall,
					externalResult: {
						content: [{ type: "text", text: "file contents" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([{ type: "text", text: "Looking at the files now." }, toolCall]),
			},
		} as any,
	);

	// Pinned zone should now have a DynamicBorder and a Markdown component
	assert.equal(host.pinnedMessageContainer.children.length, 2, "pinned zone should have border + markdown");
	assert.equal(host.pinnedMessageContainer.children[0]?.constructor?.name, "DynamicBorder");
	assert.equal(host.pinnedMessageContainer.children[1]?.constructor?.name, "Markdown");
});

test("chat-controller clears pinned zone when a new assistant message starts", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	const toolCall = {
		type: "toolCall",
		id: "tool-clear-1",
		name: "exec_command",
		arguments: { cmd: "echo hi" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	// Populate the pinned zone
	host.getMarkdownThemeWithSettings = () => ({});
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "Working on it." }, toolCall]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...toolCall,
					externalResult: {
						content: [{ type: "text", text: "ok" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([{ type: "text", text: "Working on it." }, toolCall]),
			},
		} as any,
	);

	assert.ok(host.pinnedMessageContainer.children.length > 0, "pinned zone should be populated");

	// Start a new assistant message — pinned zone should clear
	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should clear on new assistant message");
});

test("chat-controller clears pinned zone when the agent turn ends", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	const toolCall = {
		type: "toolCall",
		id: "tool-clear-on-end-1",
		name: "exec_command",
		arguments: { cmd: "echo hi" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	host.getMarkdownThemeWithSettings = () => ({});
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "Working on it." }, toolCall]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...toolCall,
					externalResult: {
						content: [{ type: "text", text: "ok" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant([{ type: "text", text: "Working on it." }, toolCall]),
			},
		} as any,
	);

	assert.ok(host.pinnedMessageContainer.children.length > 0, "pinned zone should be populated before agent_end");

	await handleAgentEvent(host, { type: "agent_end" } as any);

	assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should clear on agent_end");
});

test("chat-controller clears pinned zone when assistant message ends", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	const toolCall = {
		type: "toolCall",
		id: "tool-msg-end-1",
		name: "exec_command",
		arguments: { cmd: "echo hi" },
	};

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	host.getMarkdownThemeWithSettings = () => ({});
	const msgContent = [{ type: "text", text: "Summary after tools." }, toolCall];
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant(msgContent),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					...toolCall,
					externalResult: {
						content: [{ type: "text", text: "ok" }],
						details: {},
						isError: false,
					},
				},
				partial: makeAssistant(msgContent),
			},
		} as any,
	);

	assert.ok(host.pinnedMessageContainer.children.length > 0, "pinned zone should be populated during streaming");

	// End the assistant message (e.g. before form elicitation) — pinned zone should clear
	await handleAgentEvent(host, { type: "message_end", message: makeAssistant(msgContent) } as any);

	assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should clear on message_end to prevent duplicate display");
});

test("chat-controller does not pin when there are no tool calls", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	host.getMarkdownThemeWithSettings = () => ({});
	await handleAgentEvent(
		host,
		{
			type: "message_update",
			message: makeAssistant([{ type: "text", text: "Just some text, no tools." }]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Just some text, no tools.",
				partial: makeAssistant([{ type: "text", text: "Just some text, no tools." }]),
			},
		} as any,
	);

	assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should stay empty without tool calls");
});

// Regression test for issue #4144: interleaved text/tool content must render in content[] index order.
// Stream: [text "A", toolCall T1, text "B", toolCall T2, text "C"]
// Expected chatContainer order: textRun(A), toolExec(T1), textRun(B), toolExec(T2), textRun(C)
// Each AssistantMessageComponent must render ONLY its own text — no duplication after message_end.
test("chat-controller renders interleaved text and tool blocks in content[] index order (#4144)", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const t1 = { type: "toolCall", id: "t1", name: "tool_one", arguments: {} };
	const t2 = { type: "toolCall", id: "t2", name: "tool_two", arguments: {} };

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	// Stream text "A" at index 0
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }]),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "A",
			partial: makeAssistant([{ type: "text", text: "A" }]),
		},
	} as any);

	// Stream toolCall T1 at index 1
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }, t1]),
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: {
				...t1,
				externalResult: { content: [{ type: "text", text: "result1" }], details: {}, isError: false },
			},
			partial: makeAssistant([{ type: "text", text: "A" }, t1]),
		},
	} as any);

	// Stream text "B" at index 2
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }]),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 2,
			delta: "B",
			partial: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }]),
		},
	} as any);

	// Stream toolCall T2 at index 3
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }, t2]),
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 3,
			toolCall: {
				...t2,
				externalResult: { content: [{ type: "text", text: "result2" }], details: {}, isError: false },
			},
			partial: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }, t2]),
		},
	} as any);

	// Stream text "C" at index 4
	const finalContent = [
		{ type: "text", text: "A" }, t1, { type: "text", text: "B" }, t2, { type: "text", text: "C" },
	];
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant(finalContent),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 4,
			delta: "C",
			partial: makeAssistant(finalContent),
		},
	} as any);

	// Finalize — exercises the message_end path where a buggy setRange(undefined) would cause duplication
	await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) } as any);

	// Assert interleaved order: textRun(A), toolExec(T1), textRun(B), toolExec(T2), textRun(C)
	assert.equal(host.chatContainer.children.length, 5, "should have 5 children in interleaved order");
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent", "index 0: text run A");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent", "index 1: tool T1");
	assert.equal(host.chatContainer.children[2]?.constructor?.name, "AssistantMessageComponent", "index 2: text run B");
	assert.equal(host.chatContainer.children[3]?.constructor?.name, "ToolExecutionComponent", "index 3: tool T2");
	assert.equal(host.chatContainer.children[4]?.constructor?.name, "AssistantMessageComponent", "index 4: text run C");

	// Helper: collect the text of all Markdown children inside an AssistantMessageComponent.
	// Structure: AssistantMessageComponent (Container) -> contentContainer (children[0]) -> Markdown nodes.
	function getRenderedTexts(comp: any): string[] {
		const contentContainer = comp.children?.[0];
		if (!contentContainer) return [];
		return (contentContainer.children ?? [])
			.filter((c: any) => c.constructor?.name === "Markdown")
			.map((c: any) => (c as any).text as string);
	}

	// Each text-run component must contain only its own text — no cross-contamination after message_end
	assert.deepEqual(getRenderedTexts(host.chatContainer.children[0]), ["A"], "text run A must contain only 'A'");
	assert.deepEqual(getRenderedTexts(host.chatContainer.children[2]), ["B"], "text run B must contain only 'B'");
	assert.deepEqual(getRenderedTexts(host.chatContainer.children[4]), ["C"], "text run C must contain only 'C'");
});

test("chat-controller does not duplicate text when content is [text, tool, text] (interleaved stream)", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const t1 = { type: "toolCall", id: "t1", name: "tool_one", arguments: {} };

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	// Step 1: text "A" at index 0
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }]),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "A",
			partial: makeAssistant([{ type: "text", text: "A" }]),
		},
	} as any);

	// Step 2: toolCall at index 1
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }, t1]),
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: {
				...t1,
				externalResult: { content: [{ type: "text", text: "result1" }], details: {}, isError: false },
			},
			partial: makeAssistant([{ type: "text", text: "A" }, t1]),
		},
	} as any);

	// Step 3: text "B" at index 2
	const finalContent = [{ type: "text", text: "A" }, t1, { type: "text", text: "B" }];
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant(finalContent),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 2,
			delta: "B",
			partial: makeAssistant(finalContent),
		},
	} as any);

	assert.equal(host.chatContainer.children.length, 3);
	assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
	assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent");
	assert.equal(host.chatContainer.children[2]?.constructor?.name, "AssistantMessageComponent");

	const firstText = host.chatContainer.children[0];
	const secondText = host.chatContainer.children[2];
	assert.notEqual(firstText, secondText, "text-before-tool and text-after-tool must be separate component instances");
	assert.deepEqual((firstText as any).range, { startIndex: 0, endIndex: 0 }, "first text-run covers only content[0]");
	assert.deepEqual((secondText as any).range, { startIndex: 2, endIndex: 2 }, "second text-run covers only content[2]");

	// Finalize — regression guard: range must NOT be cleared on message_end (would cause duplication)
	await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) } as any);

	assert.deepEqual((secondText as any).range, { startIndex: 2, endIndex: 2 }, "range must not be cleared on message_end (would cause duplication)");
});

// Regression for the claude-code sub-turn bug that followed #4144:
// an adapter can reset content[] back to 0/1 mid-lifecycle when a new provider
// sub-turn begins. The segment walker must NOT update prior-sub-turn text-run
// components in place (which would destroy earlier history) and must NOT reuse
// stale tool registrations for a new tool at the same contentIndex. Prior
// sub-turn children must stay frozen; new sub-turn segments must append after
// them, and the pinned "Latest Output" mirror must re-evaluate for the new sub-turn.
test("chat-controller freezes prior sub-turn and appends new segments when content shrinks", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const t1 = { type: "toolCall", id: "t1", name: "tool_one", arguments: {} };
	const t2 = { type: "toolCall", id: "t2", name: "tool_two", arguments: {} };

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	// Sub-turn 1: grow to [A, T1, B]
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }]),
		assistantMessageEvent: {
			type: "text_delta", contentIndex: 0, delta: "A",
			partial: makeAssistant([{ type: "text", text: "A" }]),
		},
	} as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }, t1]),
		assistantMessageEvent: {
			type: "toolcall_end", contentIndex: 1,
			toolCall: { ...t1, externalResult: { content: [{ type: "text", text: "r1" }], details: {}, isError: false } },
			partial: makeAssistant([{ type: "text", text: "A" }, t1]),
		},
	} as any);
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }]),
		assistantMessageEvent: {
			type: "text_delta", contentIndex: 2, delta: "B",
			partial: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }]),
		},
	} as any);

	assert.equal(host.chatContainer.children.length, 3, "sub-turn 1 renders 3 children");
	const priorA = host.chatContainer.children[0];
	const priorT1 = host.chatContainer.children[1];
	const priorB = host.chatContainer.children[2];

	// Sub-turn boundary: adapter resets content[] to [C]
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "C" }]),
		assistantMessageEvent: {
			type: "text_delta", contentIndex: 0, delta: "C",
			partial: makeAssistant([{ type: "text", text: "C" }]),
		},
	} as any);

	// Prior 3 children must still exist in DOM — and a NEW text-run for "C" appended after them.
	assert.equal(host.chatContainer.children.length, 4, "shrink must append new segment, not replace prior history");
	assert.equal(host.chatContainer.children[0], priorA, "prior A component stays at index 0");
	assert.equal(host.chatContainer.children[1], priorT1, "prior T1 component stays at index 1");
	assert.equal(host.chatContainer.children[2], priorB, "prior B component stays at index 2");
	assert.notEqual(host.chatContainer.children[3], priorA, "new C text-run must be a different component from prior A");
	assert.equal(host.chatContainer.children[3]?.constructor?.name, "AssistantMessageComponent");

	// Prior A component must still render "A", not be overwritten with "C".
	function getRenderedTexts(comp: any): string[] {
		const contentContainer = comp.children?.[0];
		if (!contentContainer) return [];
		return (contentContainer.children ?? [])
			.filter((c: any) => c.constructor?.name === "Markdown")
			.map((c: any) => (c as any).text as string);
	}
	assert.deepEqual(getRenderedTexts(priorA), ["A"], "prior A text-run must still contain 'A' after shrink");
	assert.deepEqual(getRenderedTexts(priorB), ["B"], "prior B text-run must still contain 'B' after shrink");
	assert.deepEqual(getRenderedTexts(host.chatContainer.children[3]), ["C"], "new text-run must contain only 'C'");

	// Sub-turn 2 grows with a new tool T2 at contentIndex=1.
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "C" }, t2]),
		assistantMessageEvent: {
			type: "toolcall_end", contentIndex: 1,
			toolCall: { ...t2, externalResult: { content: [{ type: "text", text: "r2" }], details: {}, isError: false } },
			partial: makeAssistant([{ type: "text", text: "C" }, t2]),
		},
	} as any);

	// T2 must be appended after the new C text-run, not conflated with the stale T1 registration.
	assert.equal(host.chatContainer.children.length, 5, "new tool appends after new text-run");
	assert.equal(host.chatContainer.children[4]?.constructor?.name, "ToolExecutionComponent");
	assert.notEqual(host.chatContainer.children[4], priorT1, "new T2 must be a different component from prior T1");

	// Finalize so the module-level pinned spinner (setInterval) is torn down and the test process can exit.
	await handleAgentEvent(host, { type: "message_end", message: makeAssistant([{ type: "text", text: "C" }, t2]) } as any);
});

// Regression: after a sub-turn shrink, lastPinnedText must be cleared so the
// pinned "Latest Output" mirror can display text from the new sub-turn instead
// of staying frozen on a stale snapshot (the "bottom green stays" symptom).
test("chat-controller updates pinned zone after sub-turn shrink", async () => {
	(globalThis as any)[Symbol.for("@gsd/pi-coding-agent:theme")] = {
		fg: (_key: string, text: string) => text,
		bg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		truncate: (text: string) => text,
	};

	const host = createHost();
	host.getMarkdownThemeWithSettings = () => ({});

	const t1 = { type: "toolCall", id: "t1", name: "tool_one", arguments: {} };
	const t2 = { type: "toolCall", id: "t2", name: "tool_two", arguments: {} };

	await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) } as any);

	// Sub-turn 1 with pinnable text before a tool → populates pinned zone with "first".
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "first" }, t1]),
		assistantMessageEvent: {
			type: "toolcall_end", contentIndex: 1,
			toolCall: { ...t1, externalResult: { content: [{ type: "text", text: "r1" }], details: {}, isError: false } },
			partial: makeAssistant([{ type: "text", text: "first" }, t1]),
		},
	} as any);
	const pinnedMarkdown = host.pinnedMessageContainer.children[1];
	assert.equal((pinnedMarkdown as any)?.text, "first", "pinned zone seeded with sub-turn 1 text");

	// Sub-turn boundary: content resets to [second, t2].
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "second" }, t2]),
		assistantMessageEvent: {
			type: "toolcall_end", contentIndex: 1,
			toolCall: { ...t2, externalResult: { content: [{ type: "text", text: "r2" }], details: {}, isError: false } },
			partial: makeAssistant([{ type: "text", text: "second" }, t2]),
		},
	} as any);

	// Pinned markdown must now reflect the new sub-turn's text, not stay frozen on "first".
	assert.equal((pinnedMarkdown as any)?.text, "second", "pinned zone must update after sub-turn shrink (#4144 regression)");

	// Finalize so the module-level pinned spinner (setInterval) is torn down and the test process can exit.
	await handleAgentEvent(host, { type: "message_end", message: makeAssistant([{ type: "text", text: "second" }, t2]) } as any);
});

test("chat-controller: agent_end without message_end must not remove streaming component from DOM (regression #4197)", async () => {
	const host = createHost();

	await handleAgentEvent(host, {
		type: "message_start",
		message: makeAssistant([]),
	} as any);

	// Simulate partial streaming that creates an AssistantMessageComponent
	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant([{ type: "text", text: "partial answer" }]),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "partial answer",
			partial: makeAssistant([{ type: "text", text: "partial answer" }]),
		},
	} as any);

	// Precondition: component is in DOM
	assert.equal(
		host.chatContainer.children.length,
		1,
		"streaming component must be in DOM after message_update",
	);
	const comp = host.chatContainer.children[0];

	// Simulate abort: agent_end fires WITHOUT message_end
	await handleAgentEvent(host, { type: "agent_end" } as any);

	assert.equal(
		host.chatContainer.children.length,
		1,
		"agent_end must NOT remove the streaming component from the DOM (issue #4197)",
	);
	assert.equal(
		host.chatContainer.children[0],
		comp,
		"the same component instance must remain in the DOM after agent_end",
	);
});

test("chat-controller: agent_end after message_end must not alter DOM", async () => {
	const host = createHost();
	const content = [{ type: "text", text: "complete answer" }];

	await handleAgentEvent(host, {
		type: "message_start",
		message: makeAssistant([]),
	} as any);

	await handleAgentEvent(host, {
		type: "message_update",
		message: makeAssistant(content),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "complete answer",
			partial: makeAssistant(content),
		},
	} as any);

	await handleAgentEvent(host, {
		type: "message_end",
		message: makeAssistant(content),
	} as any);

	const countAfterMessageEnd = host.chatContainer.children.length;
	assert.ok(countAfterMessageEnd > 0, "component must be present after message_end");

	await handleAgentEvent(host, { type: "agent_end" } as any);

	assert.equal(
		host.chatContainer.children.length,
		countAfterMessageEnd,
		"agent_end after message_end must not add or remove DOM nodes",
	);
});
