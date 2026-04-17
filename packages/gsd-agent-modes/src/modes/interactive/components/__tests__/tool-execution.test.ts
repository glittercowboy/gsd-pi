import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { ToolExecutionComponent } from "../tool-execution.js";
import { initTheme } from "@gsd/pi-coding-agent";

initTheme("dark", false);

function renderTool(
	toolName: string,
	args: Record<string, unknown>,
	result?: {
		content: Array<{ type: string; text?: string }>;
		isError: boolean;
		details?: Record<string, unknown>;
	},
): string {
	const component = new ToolExecutionComponent(
		toolName,
		args,
		{},
		undefined,
		{ requestRender() {} } as any,
	);
	component.setExpanded(true);
	if (result) component.updateResult(result);
	return stripAnsi(component.render(120).join("\n"));
}

function renderToolCollapsed(
	toolName: string,
	args: Record<string, unknown>,
	result?: {
		content: Array<{ type: string; text?: string }>;
		isError: boolean;
		details?: Record<string, unknown>;
	},
): string {
	const component = new ToolExecutionComponent(
		toolName,
		args,
		{},
		undefined,
		{ requestRender() {} } as any,
	);
	if (result) component.updateResult(result);
	return stripAnsi(component.render(120).join("\n"));
}

describe("ToolExecutionComponent", () => {
	test("renders capitalized Claude Code Bash tool names with bash output instead of generic args JSON", () => {
		const rendered = renderTool(
			"Bash",
			{ command: "pwd" },
			{ content: [{ type: "text", text: "/tmp/gsd-pr-fix" }], isError: false },
		);

		assert.match(rendered, /\$ pwd/);
		assert.match(rendered, /\/tmp\/gsd-pr-fix/);
		assert.doesNotMatch(rendered, /^\{\s*\}$/m);
	});

	test("renders capitalized Claude Code Read tool names with read output", () => {
		const rendered = renderTool(
			"Read",
			{ path: "/tmp/demo.txt" },
			{ content: [{ type: "text", text: "hello\nworld" }], isError: false },
		);

		assert.match(rendered, /read .*demo\.txt/);
		assert.match(rendered, /hello/);
		assert.match(rendered, /world/);
	});

	test("generic fallback strips mcp__<server>__ prefix and shows server·tool title", () => {
		const rendered = renderTool(
			"mcp__context7__resolve_library_id",
			{ name: "react" },
			{ content: [{ type: "text", text: "react@18.3.1" }], isError: false },
		);

		assert.match(rendered, /context7\u00b7resolve_library_id/);
		assert.doesNotMatch(rendered, /mcp__/);
		assert.match(rendered, /name="react"/);
		assert.match(rendered, /react@18\.3\.1/);
	});

	test("generic fallback renders compact key=value args for primitive args", () => {
		const rendered = renderTool(
			"some_unknown_tool",
			{ count: 3, enabled: true, label: "hello" },
		);

		assert.match(rendered, /some_unknown_tool/);
		assert.match(rendered, /count=3/);
		assert.match(rendered, /enabled=true/);
		assert.match(rendered, /label="hello"/);
		assert.doesNotMatch(rendered, /^\{$/m);
	});

	test("generic fallback truncates long output when collapsed", () => {
		const longOutput = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
		const rendered = renderToolCollapsed(
			"mcp__demo__do_thing",
			{ ok: true },
			{ content: [{ type: "text", text: longOutput }], isError: false },
		);

		assert.match(rendered, /line 1\b/);
		assert.match(rendered, /line 10\b/);
		assert.doesNotMatch(rendered, /line 20\b/);
		assert.match(rendered, /\(15 more lines/);
	});

	test("generic fallback falls back to truncated JSON for complex args", () => {
		const rendered = renderTool(
			"mcp__demo__nested",
			{ payload: { nested: { deeply: ["a", "b", "c"] } }, name: "x" },
		);

		assert.match(rendered, /demo\u00b7nested/);
		// Multi-line JSON dump for the complex payload
		assert.match(rendered, /"payload"/);
		assert.match(rendered, /"nested"/);
	});

	// TOOL-01: edits[] array format (pi 0.67.2 edit tool API)
	test("edit tool renders path label when called with edits[] array format (TOOL-01)", () => {
		const rendered = renderTool(
			"Edit",
			{ path: "/tmp/test.ts", edits: [{ oldText: "old content", newText: "new content" }] },
		);

		assert.match(rendered, /test\.ts/);
		assert.doesNotMatch(rendered, /"oldText"/);
	});

	test("edit tool renders path label when called with single oldText/newText format (TOOL-01)", () => {
		const rendered = renderTool(
			"Edit",
			{ path: "/tmp/test.ts", oldText: "old content", newText: "new content" },
		);

		assert.match(rendered, /test\.ts/);
	});

	test("edit tool handles edits[] with no valid elements without crashing (TOOL-01 type guard)", () => {
		assert.doesNotThrow(() => {
			renderTool(
				"Edit",
				{ path: "/tmp/test.ts", edits: [{ bad: "data" }, null, { also: "bad" }] },
			);
		});
	});

	test("edit tool handles empty edits[] without crashing (TOOL-01 edge case)", () => {
		assert.doesNotThrow(() => {
			renderTool("Edit", { path: "/tmp/test.ts", edits: [] });
		});
	});

	// TOOL-02: computeEditDiff invocation via lowercase "edit" tool name
	test("edit tool (lowercase) triggers diff path for edits[] format without crashing (TOOL-02)", () => {
		assert.doesNotThrow(() => {
			renderTool(
				"edit",
				{ path: "/tmp/nonexistent-for-test.ts", edits: [{ oldText: "a", newText: "b" }] },
			);
		});
	});
});
