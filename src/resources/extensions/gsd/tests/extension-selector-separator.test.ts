// Tests for the SEPARATOR_PREFIX convention used by ExtensionSelectorComponent
// and the two-step provider→model picker in configureModels.
//
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

describe("two-step provider→model picker", () => {
	// Simulate the grouping logic from configureModels
	const availableModels = [
		{ id: "claude-opus-4-6", provider: "anthropic" },
		{ id: "gpt-4o", provider: "openai" },
		{ id: "claude-sonnet-4-5", provider: "anthropic" },
		{ id: "o3-mini", provider: "openai" },
		{ id: "claude-haiku-4-5", provider: "anthropic" },
	];

	function buildProviderGroups() {
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
		for (const group of byProvider.values()) {
			group.sort((a, b) => a.id.localeCompare(b.id));
		}
		return { byProvider, providers };
	}

	test("provider menu lists providers with model counts", () => {
		const { providers, byProvider } = buildProviderGroups();
		const providerOptions = providers.map(p => {
			const count = byProvider.get(p)!.length;
			return `${p} (${count} models)`;
		});
		providerOptions.push("(keep current)", "(clear)", "(type manually)");

		assert.strictEqual(providerOptions[0], "anthropic (3 models)");
		assert.strictEqual(providerOptions[1], "openai (2 models)");
		assert.strictEqual(providerOptions[2], "(keep current)");
		assert.strictEqual(providerOptions[3], "(clear)");
		assert.strictEqual(providerOptions[4], "(type manually)");
	});

	test("model menu for a provider is sorted alphabetically", () => {
		const { byProvider } = buildProviderGroups();
		const anthropicModels = byProvider.get("anthropic")!;
		const modelOptions = anthropicModels.map(m => m.id);

		assert.strictEqual(modelOptions[0], "claude-haiku-4-5");
		assert.strictEqual(modelOptions[1], "claude-opus-4-6");
		assert.strictEqual(modelOptions[2], "claude-sonnet-4-5");
	});

	test("provider name is extracted correctly from choice string", () => {
		const choice = "anthropic (3 models)";
		const providerName = choice.replace(/ \(\d+ models?\)$/, "");
		assert.strictEqual(providerName, "anthropic");

		const singleChoice = "ollama (1 model)";
		const singleProvider = singleChoice.replace(/ \(\d+ models?\)$/, "");
		assert.strictEqual(singleProvider, "ollama");
	});

	test("openai models are sorted within their group", () => {
		const { byProvider } = buildProviderGroups();
		const openaiModels = byProvider.get("openai")!;
		const modelOptions = openaiModels.map(m => m.id);

		assert.strictEqual(modelOptions[0], "gpt-4o");
		assert.strictEqual(modelOptions[1], "o3-mini");
	});
});
