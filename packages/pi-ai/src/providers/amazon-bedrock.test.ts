/**
 * Regression guards for #4392
 *
 * Verifies that `supportsAdaptiveThinking()` in amazon-bedrock.ts correctly
 * recognises all current adaptive-thinking-capable models: opus-4-7,
 * sonnet-4-7, and haiku-4-5 (in addition to the previously supported
 * opus-4-6 / sonnet-4-6 family).
 *
 * Related: #4392 (opus-4-7 adaptive thinking not recognised on Bedrock)
 *          #4352 (pre-existing: only opus-4-6 / sonnet-4-6 whitelisted)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    supportsAdaptiveThinking,
    mapThinkingLevelToEffort,
    buildAdditionalModelRequestFields,
    type BedrockOptions,
} from "./amazon-bedrock.js";

import type { Model } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal stub `Model` for the given ID to use in unit tests. */
function makeModel(id: string): Model<"bedrock-converse-stream"> {
    return {
        id,
        name: id,
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock" as any,
        baseUrl: "",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
    };
}

// ---------------------------------------------------------------------------
// supportsAdaptiveThinking — regression guards (#4392 / #4352)
// ---------------------------------------------------------------------------

describe("supportsAdaptiveThinking — regression guard #4392 / #4352: all supported models", () => {
    it("returns true for opus-4-6 (hyphen, Bedrock ARN style)", () => {
        assert.ok(supportsAdaptiveThinking("anthropic.claude-opus-4-6-20250514-v1:0"));
    });

    it("returns true for sonnet-4-6 (hyphen)", () => {
        assert.ok(supportsAdaptiveThinking("anthropic.claude-sonnet-4-6-20250514-v1:0"));
    });

    it("[#4392] returns true for opus-4-7 (hyphen, Bedrock ARN style)", () => {
        assert.ok(
            supportsAdaptiveThinking("anthropic.claude-opus-4-7-20250514-v1:0"),
            "opus-4-7 should support adaptive thinking (regression guard #4392)",
        );
    });

    it("[#4392] returns true for opus-4-7 (dot separator)", () => {
        assert.ok(
            supportsAdaptiveThinking("anthropic.claude-opus-4.7-20250514-v1:0"),
            "opus-4.7 (dot) should support adaptive thinking (regression guard #4392)",
        );
    });

    it("[#4352] returns true for sonnet-4-7 (hyphen)", () => {
        assert.ok(
            supportsAdaptiveThinking("anthropic.claude-sonnet-4-7-20250514-v1:0"),
            "sonnet-4-7 should support adaptive thinking (regression guard #4352)",
        );
    });

    it("[#4352] returns true for haiku-4-5 (hyphen)", () => {
        assert.ok(
            supportsAdaptiveThinking("anthropic.claude-haiku-4-5-20250514-v1:0"),
            "haiku-4-5 should support adaptive thinking (regression guard #4352)",
        );
    });
});

// ---------------------------------------------------------------------------
// buildAdditionalModelRequestFields — adaptive thinking output for opus-4-7
// Tests go through the public API surface to validate end-to-end behaviour.
// ---------------------------------------------------------------------------

describe("buildAdditionalModelRequestFields — Bug #4392: opus-4-7 must use adaptive thinking", () => {
    const options: BedrockOptions = { reasoning: "high" };

    it("[#4392] opus-4-7 Bedrock ARN → thinking.type === 'adaptive' (not budget_tokens)", () => {
        const model = makeModel("anthropic.claude-opus-4-7-20250514-v1:0");
        const fields = buildAdditionalModelRequestFields(model, options);
        // Regression guard: supportsAdaptiveThinking must return true for opus-4-7
        // so the function produces thinking.type='adaptive', not budget_tokens.
        assert.equal(
            fields?.thinking?.type,
            "adaptive",
            "opus-4-7 should produce thinking.type='adaptive', not budget_tokens",
        );
    });

    it("[#4392] opus-4-7 dot separator → thinking.type === 'adaptive'", () => {
        const model = makeModel("anthropic.claude-opus-4.7-20250514-v1:0");
        const fields = buildAdditionalModelRequestFields(model, options);
        assert.equal(
            fields?.thinking?.type,
            "adaptive",
            "opus-4.7 (dot) should produce thinking.type='adaptive'",
        );
    });

    it("[#4352] sonnet-4-7 → thinking.type === 'adaptive'", () => {
        const model = makeModel("anthropic.claude-sonnet-4-7-20250514-v1:0");
        const fields = buildAdditionalModelRequestFields(model, options);
        assert.equal(
            fields?.thinking?.type,
            "adaptive",
            "sonnet-4-7 should produce thinking.type='adaptive'",
        );
    });

    it("[#4352] haiku-4-5 → thinking.type === 'adaptive'", () => {
        const model = makeModel("anthropic.claude-haiku-4-5-20250514-v1:0");
        const fields = buildAdditionalModelRequestFields(model, options);
        assert.equal(
            fields?.thinking?.type,
            "adaptive",
            "haiku-4-5 should produce thinking.type='adaptive'",
        );
    });
});

// ---------------------------------------------------------------------------
// mapThinkingLevelToEffort — regression guard for xhigh on opus-4-7 (#4392)
// Fixed: Bedrock provider now returns "xhigh" for 4.7+ models instead of "max".
// ---------------------------------------------------------------------------

describe("mapThinkingLevelToEffort — regression guard #4392: opus-4-7 xhigh returns 'xhigh'", () => {
    it("[#4392] maps xhigh → 'xhigh' for opus-4-7 (native xhigh support)", () => {
        // Regression guard: mapThinkingLevelToEffort must return "xhigh" for opus-4-7,
        // not "max". Ensures the fix in #4392 does not regress.
        const result = mapThinkingLevelToEffort("xhigh", "anthropic.claude-opus-4-7-20250514-v1:0");
        assert.equal(
            result,
            "xhigh",
            "opus-4-7 supports native xhigh effort — must not be clamped to 'max'",
        );
    });

    it("[#4392] maps xhigh → 'max' for opus-4-6 (no native xhigh, clamped)", () => {
        // This already passes — regression guard.
        const result = mapThinkingLevelToEffort("xhigh", "anthropic.claude-opus-4-6-20250514-v1:0");
        assert.equal(result, "max");
    });

    it("maps high → 'high' for opus-4-7 (not affected by bug)", () => {
        const result = mapThinkingLevelToEffort("high", "anthropic.claude-opus-4-7-20250514-v1:0");
        assert.equal(result, "high");
    });
});
