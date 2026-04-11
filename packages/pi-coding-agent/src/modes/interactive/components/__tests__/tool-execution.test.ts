import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { ToolExecutionComponent } from "../tool-execution.js";
import { initTheme } from "../../theme/theme.js";

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
});
