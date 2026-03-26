/**
 * Model definitions for the Claude Code CLI provider.
 *
 * Costs are zero because inference is covered by the user's Claude Code
 * subscription. The SDK's `result` message still provides token counts
 * for display in the TUI.
 *
 * Context windows and max tokens match the Anthropic API definitions
 * in models.generated.ts.
 */

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const CLAUDE_CODE_MODELS = [
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5 (via Claude Code)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];
