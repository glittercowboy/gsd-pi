// Tests for the SEPARATOR_PREFIX convention used by ExtensionSelectorComponent.
// We cannot import the component directly in node:test because its transitive
// dependency (countdown-timer.ts) uses TypeScript parameter properties which
// are unsupported under --experimental-strip-types. Instead we duplicate the
// separator detection logic here and verify the contract.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

/** Must match the constant exported from extension-selector.ts */
const SEPARATOR_PREFIX = "───";

function isSeparator(options: string[], index: number): boolean {
	return options[index]?.startsWith(SEPARATOR_PREFIX) ?? false;
}

function nextSelectable(options: string[], from: number, direction: 1 | -1): number {
	let idx = from;
	while (idx >= 0 && idx < options.length && isSeparator(options, idx)) {
		idx += direction;
	}
	if (idx < 0 || idx >= options.length) {
		return Math.max(0, Math.min(from, options.length - 1));
	}
	return idx;
}

describe("separator detection", () => {
	const options = [
		`${SEPARATOR_PREFIX} anthropic (2) ${SEPARATOR_PREFIX}`,
		"claude-opus-4-6 · anthropic",
		"claude-sonnet-4-5 · anthropic",
		`${SEPARATOR_PREFIX} openai (1) ${SEPARATOR_PREFIX}`,
		"gpt-4o · openai",
		"(keep current)",
		"(clear)",
	];

	test("identifies separator rows correctly", () => {
		assert.ok(isSeparator(options, 0));
		assert.ok(!isSeparator(options, 1));
		assert.ok(!isSeparator(options, 2));
		assert.ok(isSeparator(options, 3));
		assert.ok(!isSeparator(options, 4));
	});

	test("nextSelectable skips leading separator", () => {
		assert.strictEqual(nextSelectable(options, 0, 1), 1);
	});

	test("nextSelectable skips separator going down", () => {
		// From index 2 (claude-sonnet), next is index 3 (separator), should skip to 4
		assert.strictEqual(nextSelectable(options, 3, 1), 4);
	});

	test("nextSelectable skips separator going up", () => {
		// From index 4 (gpt-4o), prev is index 3 (separator), should skip to 2
		assert.strictEqual(nextSelectable(options, 3, -1), 2);
	});

	test("nextSelectable clamps to bounds", () => {
		assert.strictEqual(nextSelectable(options, 6, 1), 6);
	});

	test("works with no separators", () => {
		const plain = ["alpha", "beta", "gamma"];
		assert.strictEqual(nextSelectable(plain, 0, 1), 0);
		assert.strictEqual(nextSelectable(plain, 1, 1), 1);
	});
});

describe("model grouping", () => {
	test("groups models by provider with separator headers", () => {
		// Simulate the grouping logic from configureModels
		const availableModels = [
			{ id: "claude-opus-4-6", provider: "anthropic" },
			{ id: "gpt-4o", provider: "openai" },
			{ id: "claude-sonnet-4-5", provider: "anthropic" },
			{ id: "o3-mini", provider: "openai" },
		];

		const byProvider = new Map<string, typeof availableModels>();
		for (const m of availableModels) {
			let group = byProvider.get(m.provider);
			if (!group) {
				group = [];
				byProvider.set(m.provider, group);
			}
			group.push(m);
		}
		const providers = Array.from(byProvider.keys()).sort((a, b) => a.localeCompare(b));

		const modelOptions: string[] = [];
		for (const provider of providers) {
			const group = byProvider.get(provider)!;
			modelOptions.push(`${SEPARATOR_PREFIX} ${provider} (${group.length}) ${SEPARATOR_PREFIX}`);
			for (const m of group) {
				modelOptions.push(`${m.id} · ${m.provider}`);
			}
		}
		modelOptions.push("(keep current)", "(clear)");

		// Verify structure
		assert.strictEqual(modelOptions[0], `${SEPARATOR_PREFIX} anthropic (2) ${SEPARATOR_PREFIX}`);
		assert.strictEqual(modelOptions[1], "claude-opus-4-6 · anthropic");
		assert.strictEqual(modelOptions[2], "claude-sonnet-4-5 · anthropic");
		assert.strictEqual(modelOptions[3], `${SEPARATOR_PREFIX} openai (2) ${SEPARATOR_PREFIX}`);
		assert.strictEqual(modelOptions[4], "gpt-4o · openai");
		assert.strictEqual(modelOptions[5], "o3-mini · openai");
		assert.strictEqual(modelOptions[6], "(keep current)");
		assert.strictEqual(modelOptions[7], "(clear)");

		// Verify separators are correctly detected
		assert.ok(isSeparator(modelOptions, 0));
		assert.ok(!isSeparator(modelOptions, 1));
		assert.ok(isSeparator(modelOptions, 3));
		assert.ok(!isSeparator(modelOptions, 6));

		// Verify first selectable is index 1, not the separator at 0
		assert.strictEqual(nextSelectable(modelOptions, 0, 1), 1);
	});
});
