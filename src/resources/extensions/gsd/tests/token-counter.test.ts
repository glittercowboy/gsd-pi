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
    // Without tiktoken loaded, countTokensSync falls back to ceil(len/4)
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
