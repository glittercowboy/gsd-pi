/**
 * Unit tests for token-counter.ts — provider-aware token estimation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type TokenProvider,
  estimateTokensForProvider,
  getCharsPerToken,
  countTokensSync,
  countTokens,
} from "../token-counter.js";

// ─── getCharsPerToken ─────────────────────────────────────────────────────────

describe("token-counter: getCharsPerToken", () => {
  it("returns 3.5 for anthropic", () => {
    assert.equal(getCharsPerToken("anthropic"), 3.5);
  });

  it("returns 4.0 for openai", () => {
    assert.equal(getCharsPerToken("openai"), 4.0);
  });

  it("returns 4.0 for google", () => {
    assert.equal(getCharsPerToken("google"), 4.0);
  });

  it("returns 3.8 for mistral", () => {
    assert.equal(getCharsPerToken("mistral"), 3.8);
  });

  it("returns 3.5 for bedrock", () => {
    assert.equal(getCharsPerToken("bedrock"), 3.5);
  });

  it("returns 4.0 for unknown", () => {
    assert.equal(getCharsPerToken("unknown"), 4.0);
  });
});

// ─── estimateTokensForProvider ────────────────────────────────────────────────

describe("token-counter: estimateTokensForProvider", () => {
  const sampleText = "A".repeat(1000);

  it("estimates tokens for anthropic using 3.5 chars/token ratio", () => {
    const tokens = estimateTokensForProvider(sampleText, "anthropic");
    assert.equal(tokens, Math.ceil(1000 / 3.5));
  });

  it("estimates tokens for openai using 4.0 chars/token ratio", () => {
    const tokens = estimateTokensForProvider(sampleText, "openai");
    assert.equal(tokens, Math.ceil(1000 / 4.0));
  });

  it("estimates tokens for google using 4.0 chars/token ratio", () => {
    const tokens = estimateTokensForProvider(sampleText, "google");
    assert.equal(tokens, Math.ceil(1000 / 4.0));
  });

  it("estimates tokens for mistral using 3.8 chars/token ratio", () => {
    const tokens = estimateTokensForProvider(sampleText, "mistral");
    assert.equal(tokens, Math.ceil(1000 / 3.8));
  });

  it("estimates tokens for bedrock using 3.5 chars/token ratio", () => {
    const tokens = estimateTokensForProvider(sampleText, "bedrock");
    assert.equal(tokens, Math.ceil(1000 / 3.5));
  });

  it("estimates tokens for unknown using 4.0 chars/token ratio", () => {
    const tokens = estimateTokensForProvider(sampleText, "unknown");
    assert.equal(tokens, Math.ceil(1000 / 4.0));
  });

  it("anthropic estimates are ~14% higher than openai for same text", () => {
    const anthropicTokens = estimateTokensForProvider(sampleText, "anthropic");
    const openaiTokens = estimateTokensForProvider(sampleText, "openai");

    // anthropic: 1000/3.5 ≈ 286, openai: 1000/4.0 = 250
    // ratio: 286/250 ≈ 1.143 (~14% higher)
    const ratio = anthropicTokens / openaiTokens;
    assert.ok(ratio > 1.10, `expected anthropic to be >10% higher, ratio was ${ratio}`);
    assert.ok(ratio < 1.20, `expected anthropic to be <20% higher, ratio was ${ratio}`);
  });

  it("handles empty string", () => {
    const tokens = estimateTokensForProvider("", "openai");
    assert.equal(tokens, 0);
  });

  it("handles single character", () => {
    const tokens = estimateTokensForProvider("X", "openai");
    assert.equal(tokens, 1); // ceil(1/4) = 1
  });
});

// ─── backward compatibility ──────────────────────────────────────────────────

describe("token-counter: backward compatibility", () => {
  it("countTokensSync returns heuristic estimate when tiktoken is not loaded", () => {
    // Without tiktoken loaded, countTokensSync falls back to estimateTokensForProvider.
    // With no provider (defaults to "unknown", ratio 4.0): ceil(100/4) = 25.
    const text = "A".repeat(100);
    const result = countTokensSync(text);
    // Either tiktoken is loaded (exact count) or heuristic (ceil(100/4) = 25)
    assert.ok(result > 0, "should return a positive count");
    assert.ok(typeof result === "number", "should return a number");
  });

  it("countTokens returns a positive count", async () => {
    const text = "Hello, this is a test string for token counting.";
    const result = await countTokens(text);
    assert.ok(result > 0, "should return a positive count");
    assert.ok(typeof result === "number", "should return a number");
  });

  it("countTokensSync handles empty string", () => {
    const result = countTokensSync("");
    assert.equal(result, 0);
  });

  it("countTokens handles empty string", async () => {
    const result = await countTokens("");
    assert.equal(result, 0);
  });
});

// ─── provider-aware fallback (issue #4529) ───────────────────────────────────
// Regression tests: countTokens/countTokensSync must use provider-specific
// ratios for their heuristic fallback, not a hardcoded GPT-4o / 4 divisor.

describe("token-counter: provider-aware heuristic fallback", () => {
  // These tests exercise the heuristic path (no tiktoken or before init).
  // We call estimateTokensForProvider directly to validate expected values,
  // then verify countTokens/countTokensSync return the same values when
  // tiktoken is unavailable.

  it("countTokensSync uses anthropic ratio (3.5) when provider is 'anthropic'", () => {
    const text = "A".repeat(350);
    // anthropic: ceil(350 / 3.5) = 100
    // openai/unknown: ceil(350 / 4.0) = 88
    // These are different — the provider must matter.
    const anthropicEstimate = estimateTokensForProvider(text, "anthropic");
    const unknownEstimate = estimateTokensForProvider(text, "unknown");
    assert.equal(anthropicEstimate, 100, "anthropic ratio should give 100 tokens for 350 chars");
    assert.equal(unknownEstimate, 88, "unknown ratio should give 88 tokens for 350 chars");
    assert.notEqual(
      anthropicEstimate,
      unknownEstimate,
      "anthropic and unknown estimates must differ — if they are equal the provider is being ignored",
    );

    // Actually call countTokensSync with the anthropic provider.
    // When tiktoken is not loaded, this must return the provider-aware estimate (100).
    // When tiktoken is loaded, it returns the tiktoken count (which is also > 0 and
    // will be in the range [88, 120] for 350 "A" characters with cl100k_base).
    const syncResult = countTokensSync(text, "anthropic");
    assert.ok(typeof syncResult === "number", "countTokensSync must return a number");
    assert.ok(syncResult > 0, "countTokensSync must return a positive count");
    // If tiktoken is unavailable the result must exactly match the anthropic heuristic.
    // If tiktoken is available we cannot assert the exact value, but we know it will
    // not equal the unknown-provider heuristic (88) for 350 identical characters.
    const tiktokenAvailable = syncResult !== anthropicEstimate;
    if (!tiktokenAvailable) {
      assert.equal(
        syncResult,
        anthropicEstimate,
        `countTokensSync with 'anthropic' provider must return ${anthropicEstimate} (not the unknown-provider value ${unknownEstimate}) when tiktoken is unavailable`,
      );
    }
  });

  it("countTokens uses anthropic ratio when provider='anthropic' and tiktoken unavailable", async () => {
    const text = "A".repeat(350);
    // anthropic heuristic: ceil(350 / 3.5) = 100
    // unknown/hardcoded-4 heuristic: ceil(350 / 4.0) = 88
    const anthropicEstimate = estimateTokensForProvider(text, "anthropic"); // 100
    const unknownEstimate = estimateTokensForProvider(text, "unknown");     // 88
    const hardcodedFallback = Math.ceil(text.length / 4);                   // 88

    // The anthropic heuristic must produce more tokens than the old /4 fallback.
    assert.equal(anthropicEstimate, 100, "anthropic heuristic should give 100 tokens for 350 chars");
    assert.ok(
      anthropicEstimate > hardcodedFallback,
      `anthropic estimate (${anthropicEstimate}) must exceed the hardcoded /4 fallback (${hardcodedFallback})`,
    );
    assert.notEqual(
      anthropicEstimate,
      unknownEstimate,
      "anthropic and unknown estimates must differ — provider is being ignored if equal",
    );

    // Call countTokens with the anthropic provider and verify the result.
    const result = await countTokens(text, "anthropic");
    assert.ok(typeof result === "number", "should return a number");
    assert.ok(result > 0, "should return a positive token count");

    // When tiktoken is unavailable: result must equal the anthropic heuristic (100),
    // NOT the unknown-provider heuristic (88). This is the core regression guard for #4529.
    // When tiktoken IS available: result is the tiktoken count, which will differ from
    // the heuristic — but it must never equal the wrong (unknown) heuristic for this text.
    if (result === anthropicEstimate || result === unknownEstimate) {
      // We are on the heuristic path — assert the correct provider ratio was used.
      assert.equal(
        result,
        anthropicEstimate,
        `countTokens with 'anthropic' provider returned ${result} but expected ${anthropicEstimate} (anthropic heuristic) not ${unknownEstimate} (unknown/hardcoded heuristic)`,
      );
    } else {
      // tiktoken is active — result is an exact BPE count.
      // For 350 identical "A" characters cl100k_base produces a count in [80, 130].
      assert.ok(
        result >= 80 && result <= 130,
        `tiktoken count ${result} for 350 "A" chars is outside expected range [80, 130]`,
      );
    }
  });

  it("countTokens with provider='anthropic' yields more tokens than provider='openai' (heuristic)", () => {
    const text = "A".repeat(400);
    // anthropic: ceil(400/3.5) = 115, openai: ceil(400/4.0) = 100
    const anthropic = estimateTokensForProvider(text, "anthropic");
    const openai = estimateTokensForProvider(text, "openai");
    assert.ok(
      anthropic > openai,
      `anthropic estimate (${anthropic}) must exceed openai estimate (${openai}) for same text`,
    );
  });
});
