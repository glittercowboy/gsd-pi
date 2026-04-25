// Manually-maintained model definitions for providers NOT tracked by models.dev.
//
// The auto-generated files under models/generated/*.ts are rebuilt from the
// models.dev third-party catalog. Providers that use proprietary endpoints and
// are not listed on models.dev must be defined here so they survive regeneration.
//
// See: https://github.com/gsd-build/gsd-2/issues/2339
//
// To add a custom provider:
//   1. Add its model definitions below following the existing pattern.
//   2. Add its API key mapping to env-api-keys.ts.
//   3. Add its provider name to KnownProvider in types.ts (if not already there).

import type { Model } from "../types.js";

export const CUSTOM_MODELS = {
	// ─── Alibaba Coding Plan ─────────────────────────────────────────────
	// Direct Alibaba DashScope Coding Plan endpoint (OpenAI-compatible).
	// NOT the same as alibaba/* models on OpenRouter — different endpoint & auth.
	// Original PR: #295 | Fixes: #1003, #1055, #1057
	"alibaba-coding-plan": {
		"qwen3.5-plus": {
			id: "qwen3.5-plus",
			name: "Qwen3.5 Plus",
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 983616,
			maxTokens: 65536,
			compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"qwen3-max-2026-01-23": {
			id: "qwen3-max-2026-01-23",
			name: "Qwen3 Max 2026-01-23",
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 258048,
			maxTokens: 32768,
			compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"qwen3-coder-next": {
			id: "qwen3-coder-next",
			name: "Qwen3 Coder Next",
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 204800,
			maxTokens: 65536,
			compat: { supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"qwen3-coder-plus": {
			id: "qwen3-coder-plus",
			name: "Qwen3 Coder Plus",
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 997952,
			maxTokens: 65536,
			compat: { supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"MiniMax-M2.5": {
			id: "MiniMax-M2.5",
			name: "MiniMax M2.5",
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 196608,
			maxTokens: 65536,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			},
		} satisfies Model<"openai-completions">,
		"glm-5": {
			id: "glm-5",
			name: "GLM-5",
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 202752,
			maxTokens: 16384,
			compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"glm-4.7": {
			id: "glm-4.7",
			name: "GLM-4.7",
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 169984,
			maxTokens: 16384,
			compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"kimi-k2.5": {
			id: "kimi-k2.5",
			name: "Kimi K2.5",
			api: "openai-completions",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 258048,
			maxTokens: 32768,
			compat: { thinkingFormat: "zai", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
	},

	// ─── Alibaba DashScope ───────────────────────────────────────────────
	// Regular DashScope API for users without the Coding Plan.
	// Uses the international OpenAI-compatible endpoint.
	// Requires DASHSCOPE_API_KEY from: dashscope.console.aliyun.com
	// Pricing: https://www.alibabacloud.com/help/en/model-studio/model-pricing
	"alibaba-dashscope": {
		"qwen3-max": {
			id: "qwen3-max",
			name: "Qwen3 Max",
			api: "openai-completions",
			provider: "alibaba-dashscope",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 1.2,
				output: 6,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 32768,
			compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"qwen3.5-plus": {
			id: "qwen3.5-plus",
			name: "Qwen3.5 Plus",
			api: "openai-completions",
			provider: "alibaba-dashscope",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.4,
				output: 1.2,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"qwen3.5-flash": {
			id: "qwen3.5-flash",
			name: "Qwen3.5 Flash",
			api: "openai-completions",
			provider: "alibaba-dashscope",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0.1,
				output: 0.4,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 32768,
			compat: { supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"qwen3-coder-plus": {
			id: "qwen3-coder-plus",
			name: "Qwen3 Coder Plus",
			api: "openai-completions",
			provider: "alibaba-dashscope",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 1.0,
				output: 5.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: { supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
		"qwen3.6-plus": {
			id: "qwen3.6-plus",
			name: "Qwen3.6 Plus",
			api: "openai-completions",
			provider: "alibaba-dashscope",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.5,
				output: 3.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
	},

	// ─── Z.AI (GLM-5.1) ────────────────────────────────────────────────
	// GLM-5.1 is the latest GLM model from Zhipu AI, not yet in models.dev.
	// Uses the Z.AI Coding Plan endpoint (OpenAI-compatible).
	// Ref: https://docs.z.ai/devpack/using5.1
	"zai": {
		"glm-5.1": {
			id: "glm-5.1",
			name: "GLM-5.1",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 1,
				output: 3.2,
				cacheRead: 0.2,
				cacheWrite: 0,
			},
			contextWindow: 204800,
			maxTokens: 131072,
			compat: { thinkingFormat: "zai", supportsDeveloperRole: false },
		} satisfies Model<"openai-completions">,
	},

	// ─── MiniMax additive hotfixes ───────────────────────────────────────
	// models.dev currently omits MiniMax-M2.1-highspeed in some snapshots.
	// Keep this additive (no overrides) so generated models still win when present.
	"minimax": {
		"MiniMax-M2.1-highspeed": {
			id: "MiniMax-M2.1-highspeed",
			name: "MiniMax-M2.1-highspeed",
			api: "anthropic-messages",
			provider: "minimax",
			baseUrl: "https://api.minimax.io/anthropic",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.6,
				output: 2.4,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 204800,
			maxTokens: 131072,
		} satisfies Model<"anthropic-messages">,
	},
	"minimax-cn": {
		"MiniMax-M2.1-highspeed": {
			id: "MiniMax-M2.1-highspeed",
			name: "MiniMax-M2.1-highspeed",
			api: "anthropic-messages",
			provider: "minimax-cn",
			baseUrl: "https://api.minimaxi.com/anthropic",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.6,
				output: 2.4,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 204800,
			maxTokens: 131072,
		} satisfies Model<"anthropic-messages">,
	},
} as const;
