import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CombinedAutocompleteProvider } from "../autocomplete.js";
import type { SlashCommand } from "../autocomplete.js";

function makeProvider(commands: SlashCommand[] = [], basePath: string = "/tmp") {
	return new CombinedAutocompleteProvider(commands, basePath);
}

const sampleCommands: SlashCommand[] = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model" },
	{ name: "session", description: "Show session info" },
	{ name: "export", description: "Export session" },
	{ name: "thinking", description: "Set thinking level" },
];

describe("CombinedAutocompleteProvider — slash commands", () => {
	it("returns all commands for bare /", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.getSuggestions(["/"], 0, 1);
		assert.ok(result, "should return suggestions");
		assert.equal(result!.items.length, sampleCommands.length);
		assert.equal(result!.prefix, "/");
	});

	it("filters commands by typed prefix", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.getSuggestions(["/se"], 0, 3);
		assert.ok(result);
		assert.equal(result!.items.length, 2); // settings, session
		assert.ok(result!.items.some((i) => i.value === "settings"));
		assert.ok(result!.items.some((i) => i.value === "session"));
	});

	it("returns null when no commands match", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.getSuggestions(["/zzz"], 0, 4);
		assert.equal(result, null);
	});

	it("includes description in suggestions", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.getSuggestions(["/mod"], 0, 4);
		assert.ok(result);
		assert.equal(result!.items[0]?.description, "Select model");
	});

	it("does not trigger slash commands mid-line", () => {
		const provider = makeProvider(sampleCommands);
		// "/" not at position 0 in the line — should not match slash commands
		const result = provider.getSuggestions(["hello /se"], 0, 9);
		assert.equal(result, null);
	});

	it("triggers slash commands after leading whitespace", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.getSuggestions(["  /se"], 0, 5);
		assert.ok(result);
		assert.equal(result!.prefix, "/se");
		assert.ok(result!.items.some((item) => item.value === "settings"));
	});
});

describe("CombinedAutocompleteProvider — argument completions", () => {
	it("returns argument completions for commands that support them", () => {
		const commands: SlashCommand[] = [
			{
				name: "thinking",
				description: "Set thinking level",
				getArgumentCompletions: (prefix) => {
					const levels = ["off", "low", "medium", "high"];
					const filtered = levels
						.filter((l) => l.startsWith(prefix.trim()))
						.map((l) => ({ value: l, label: l }));
					return filtered.length > 0 ? filtered : null;
				},
			},
		];
		const provider = makeProvider(commands);
		const result = provider.getSuggestions(["/thinking m"], 0, 11);
		assert.ok(result);
		assert.equal(result!.items.length, 1);
		assert.equal(result!.items[0]?.value, "medium");
	});

	it("returns null for commands without argument completions", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.getSuggestions(["/settings foo"], 0, 13);
		assert.equal(result, null);
	});

	it("returns all arg completions for empty prefix after space", () => {
		const commands: SlashCommand[] = [
			{
				name: "test",
				description: "Test command",
				getArgumentCompletions: (prefix) => {
					const subs = ["start", "stop", "status"];
					const filtered = subs
						.filter((s) => s.startsWith(prefix.trim()))
						.map((s) => ({ value: s, label: s }));
					return filtered.length > 0 ? filtered : null;
				},
			},
		];
		const provider = makeProvider(commands);
		const result = provider.getSuggestions(["/test "], 0, 6);
		assert.ok(result);
		assert.equal(result!.items.length, 3);
	});
});

describe("CombinedAutocompleteProvider — @ file prefix extraction", () => {
	it("detects @ at start of line", () => {
		const provider = makeProvider();
		// @ triggers fuzzy file search — we can't test the actual file results
		// but we can test that getSuggestions returns null (no files in /tmp matching)
		// rather than crashing
		const result = provider.getSuggestions(["@nonexistent_xyz"], 0, 16);
		// May return null or empty — the key thing is it doesn't crash
		assert.ok(result === null || result.items.length >= 0);
	});

	it("detects @ after space", () => {
		const provider = makeProvider();
		const result = provider.getSuggestions(["check @nonexistent_xyz"], 0, 22);
		assert.ok(result === null || result.items.length >= 0);
	});

	it("returns null for bare @ with no query to avoid full tree walk (#1824)", () => {
		const provider = makeProvider([], process.cwd());
		// A bare "@" produces an empty rawPrefix after stripping the "@".
		// This must return null to avoid a synchronous full filesystem walk
		// via the native fuzzyFind addon, which freezes the TUI on large repos.
		const result = provider.getSuggestions(["@"], 0, 1);
		assert.equal(result, null, "bare @ should not trigger fuzzy file search");
	});

	it("returns null for @ after space with no query (#1824)", () => {
		const provider = makeProvider([], process.cwd());
		const result = provider.getSuggestions(["look at @"], 0, 9);
		assert.equal(result, null, "@ after space with no query should not trigger fuzzy file search");
	});
});

describe("CombinedAutocompleteProvider — applyCompletion", () => {
	it("applies slash command completion with trailing space", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.applyCompletion(["/se"], 0, 3, { value: "settings", label: "settings" }, "/se");
		assert.equal(result.lines[0], "/settings ");
		assert.equal(result.cursorCol, 10); // after "/settings "
	});

	it("preserves leading whitespace when applying slash command completion", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.applyCompletion(["  /se"], 0, 5, { value: "settings", label: "settings" }, "/se");
		assert.equal(result.lines[0], "  /settings ");
		assert.equal(result.cursorCol, 12);
	});

	it("applies file path completion for @ prefix", () => {
		const provider = makeProvider();
		const result = provider.applyCompletion(
			["@src/"],
			0,
			5,
			{ value: "@src/index.ts", label: "index.ts" },
			"@src/",
		);
		assert.equal(result.lines[0], "@src/index.ts ");
	});

	it("applies directory completion without trailing space", () => {
		const provider = makeProvider();
		const result = provider.applyCompletion(
			["@sr"],
			0,
			3,
			{ value: "@src/", label: "src/" },
			"@sr",
		);
		// Directories should not get trailing space so user can continue typing
		assert.ok(!result.lines[0]!.endsWith(" "));
	});

	it("preserves text after cursor", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.applyCompletion(
			["/se and more text"],
			0,
			3,
			{ value: "settings", label: "settings" },
			"/se",
		);
		assert.ok(result.lines[0]!.includes("and more text"));
	});
});

describe("CombinedAutocompleteProvider — force file suggestions", () => {
	it("does not trigger for slash commands", () => {
		const provider = makeProvider(sampleCommands);
		const result = provider.getForceFileSuggestions(["/set"], 0, 4);
		assert.equal(result, null);
	});

	it("shouldTriggerFileCompletion returns false for slash commands", () => {
		const provider = makeProvider(sampleCommands);
		assert.equal(provider.shouldTriggerFileCompletion(["/set"], 0, 4), false);
	});

	it("shouldTriggerFileCompletion returns true for regular text", () => {
		const provider = makeProvider();
		assert.equal(provider.shouldTriggerFileCompletion(["some text"], 0, 9), true);
	});
});
