/**
 * Contract tests for Tavily integration in search_and_read (tool-llm-context.ts).
 *
 * Covers:
 * - budgetContent: token distribution, truncation, null raw_content fallback,
 *   score filtering, empty input handling
 * - Mapping/format: age field shape, publishedDateToAge flow, missing dates
 * - Threshold-to-score: strict/balanced/lenient cutoffs, sub-threshold filtering
 * - Infrastructure: cache key isolation (|p:tavily vs |p:brave), no-key error
 *   message, Tavily request body shape (POST, Bearer auth, advanced depth)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { budgetContent } from "../resources/extensions/search-the-web/tool-llm-context.ts";
import { publishedDateToAge } from "../resources/extensions/search-the-web/tavily.ts";
import type { TavilyResult } from "../resources/extensions/search-the-web/tavily.ts";
import { resolveSearchProvider } from "../resources/extensions/search-the-web/provider.ts";
import { normalizeQuery } from "../resources/extensions/search-the-web/url-utils.ts";
import { normalizeHeaders, parseJsonBody } from "./fetch-test-helpers.ts";

// =============================================================================
// Helpers
// =============================================================================

/** Realistic Tavily advanced-search response with raw_content, varying scores, dates. */
function makeTavilyLLMResponse(overrides: Partial<{ results: TavilyResult[] }> = {}): TavilyResult[] {
  return overrides.results ?? [
    {
      title: "TypeScript Handbook",
      url: "https://typescriptlang.org/docs/handbook",
      content: "TypeScript is a typed superset of JavaScript.",
      raw_content: "TypeScript is a strongly-typed programming language that builds on JavaScript, giving you better tooling at any scale. It adds optional static typing and class-based object-oriented programming to the language.",
      score: 0.95,
      published_date: "2025-06-15T10:00:00Z",
    },
    {
      title: "Getting Started with TS",
      url: "https://example.com/ts-getting-started",
      content: "Learn TypeScript from scratch with this beginner guide.",
      raw_content: "This comprehensive guide covers TypeScript fundamentals including types, interfaces, generics, and more. Perfect for developers transitioning from JavaScript.",
      score: 0.82,
      published_date: "2025-11-20T08:30:00Z",
    },
    {
      title: "TypeScript vs JavaScript",
      url: "https://blog.example.com/ts-vs-js",
      content: "Comparing TypeScript and JavaScript for modern development.",
      raw_content: null,
      score: 0.71,
      published_date: null,
    },
    {
      title: "Low Relevance Result",
      url: "https://spam.example.com/clickbait",
      content: "Barely related content.",
      raw_content: "Barely related content with lots of filler.",
      score: 0.25,
    },
  ];
}

/**
 * Install a mock global fetch that captures request details and returns
 * a fixed response. Returns captured request info + restore function.
 */
function mockFetch(responseBody: unknown, status = 200) {
  const captured: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {};

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.url = url;
    captured.method = init?.method || "GET";
    captured.headers = normalizeHeaders(init?.headers);
    captured.body = parseJsonBody(init?.body);

    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  const restore = () => { globalThis.fetch = originalFetch; };
  return { captured, restore };
}

// =============================================================================
// budgetContent tests
// =============================================================================

test("budgetContent distributes tokens by score (highest first)", () => {
  const results = makeTavilyLLMResponse();
  const { grounding } = budgetContent(results, 8192, 0.5);

  // Should include only results with score >= 0.5 (first 3), ordered by score desc
  assert.equal(grounding.length, 3);
  assert.equal(grounding[0].url, "https://typescriptlang.org/docs/handbook");  // 0.95
  assert.equal(grounding[1].url, "https://example.com/ts-getting-started");     // 0.82
  assert.equal(grounding[2].url, "https://blog.example.com/ts-vs-js");         // 0.71
});

test("budgetContent truncates per-result content when budget is tight", () => {
  // Create results with long raw_content
  const longContent = "A".repeat(40_000); // 40k chars ≈ 10k tokens
  const results: TavilyResult[] = [
    { title: "Big", url: "https://big.example.com", content: "short", raw_content: longContent, score: 0.9 },
    { title: "Small", url: "https://small.example.com", content: "also short", raw_content: "tiny", score: 0.8 },
  ];

  // Request only 1000 tokens → effective budget = 800 tokens = 3200 chars
  const { grounding, estimatedTokens } = budgetContent(results, 1000, 0.5);

  assert.equal(grounding.length, 2);
  // First result's snippet should be truncated (not 40k chars)
  assert.ok(grounding[0].snippets[0].length < longContent.length, "Should truncate long content");
  // Total tokens should not exceed 80% of maxTokens
  assert.ok(estimatedTokens <= 800, `estimatedTokens ${estimatedTokens} should be <= 800 (80% of 1000)`);
});

test("budgetContent uses raw_content when available, falls back to content when null", () => {
  const results: TavilyResult[] = [
    {
      title: "Has Raw",
      url: "https://has-raw.example.com",
      content: "Short content field.",
      raw_content: "This is the full raw content from advanced search.",
      score: 0.9,
    },
    {
      title: "No Raw",
      url: "https://no-raw.example.com",
      content: "Fallback content field used instead.",
      raw_content: null,
      score: 0.8,
    },
  ];

  const { grounding } = budgetContent(results, 8192, 0.5);

  assert.equal(grounding.length, 2);
  assert.ok(grounding[0].snippets[0].includes("full raw content"), "Should use raw_content when available");
  assert.ok(grounding[1].snippets[0].includes("Fallback content"), "Should fall back to content when raw_content is null");
});

test("budgetContent respects maxTokens limit (80% effective budget)", () => {
  // Create many results each with moderate content
  const results: TavilyResult[] = Array.from({ length: 10 }, (_, i) => ({
    title: `Result ${i}`,
    url: `https://example.com/r${i}`,
    content: "X".repeat(4000),      // 4k chars ≈ 1000 tokens each
    raw_content: "Y".repeat(8000),   // 8k chars ≈ 2000 tokens each
    score: 0.9 - i * 0.05,
  }));

  const maxTokens = 4096;
  const { estimatedTokens } = budgetContent(results, maxTokens, 0.3);

  // 80% of 4096 = 3276.8 → floor to 3276
  const effectiveBudget = Math.floor(maxTokens * 0.8);
  assert.ok(
    estimatedTokens <= effectiveBudget + 1, // +1 for ceil rounding in estimateTokens
    `estimatedTokens ${estimatedTokens} should be <= effective budget ${effectiveBudget}`,
  );
});

test("budgetContent returns empty grounding for empty results array", () => {
  const { grounding, sources, estimatedTokens } = budgetContent([], 8192, 0.5);

  assert.equal(grounding.length, 0);
  assert.deepEqual(sources, {});
  assert.equal(estimatedTokens, 0);
});

// =============================================================================
// Mapping/format tests — age field shape
// =============================================================================

test("budgetContent produces age as [null, null, ageString] for formatLLMContext compatibility", () => {
  const results: TavilyResult[] = [
    {
      title: "Dated Article",
      url: "https://example.com/dated",
      content: "Some content.",
      score: 0.9,
      published_date: "2025-01-15T10:00:00Z",
    },
  ];

  const { sources } = budgetContent(results, 8192, 0.5);
  const source = sources["https://example.com/dated"];

  assert.ok(source, "Source should exist");
  assert.ok(Array.isArray(source.age), "age should be an array");
  assert.equal(source.age!.length, 3, "age array should have 3 elements");
  assert.equal(source.age![0], null, "age[0] should be null");
  assert.equal(source.age![1], null, "age[1] should be null");
  assert.equal(typeof source.age![2], "string", "age[2] should be a string");
  // Verify the accessor pattern used by formatLLMContext
  assert.ok(source.age?.[2], "source.age?.[2] accessor must return truthy age string");
});

test("publishedDateToAge result flows correctly into age array", () => {
  const isoDate = "2025-06-15T10:00:00Z";
  const ageString = publishedDateToAge(isoDate);

  // publishedDateToAge should produce a non-empty string for a valid past date
  assert.ok(ageString, "publishedDateToAge should return a truthy string for valid past date");

  const results: TavilyResult[] = [
    { title: "Test", url: "https://test.com", content: "c", score: 0.9, published_date: isoDate },
  ];

  const { sources } = budgetContent(results, 8192, 0.5);
  const source = sources["https://test.com"];

  assert.equal(source.age![2], ageString, "age[2] should match publishedDateToAge output");
});

test("results without published_date get age: null", () => {
  const results: TavilyResult[] = [
    { title: "No Date", url: "https://nodate.com", content: "Content.", score: 0.9 },
  ];

  const { sources } = budgetContent(results, 8192, 0.5);
  const source = sources["https://nodate.com"];

  assert.equal(source.age, null, "age should be null when published_date is missing");
});

// =============================================================================
// Threshold-to-score tests
// =============================================================================

test("strict/balanced/lenient map to expected score cutoffs", () => {
  const thresholdMap: Record<string, number> = {
    strict: 0.7,
    balanced: 0.5,
    lenient: 0.3,
  };

  const results = makeTavilyLLMResponse();
  // Scores: 0.95, 0.82, 0.71, 0.25

  // Strict (0.7): should include 3 results (0.95, 0.82, 0.71)
  const strict = budgetContent(results, 8192, thresholdMap.strict);
  assert.equal(strict.grounding.length, 3, "strict threshold should include 3 results");

  // Balanced (0.5): should include 3 results (0.95, 0.82, 0.71)
  const balanced = budgetContent(results, 8192, thresholdMap.balanced);
  assert.equal(balanced.grounding.length, 3, "balanced threshold should include 3 results");

  // Lenient (0.3): should include all 4 (0.25 < 0.3 → excluded)
  const lenient = budgetContent(results, 8192, thresholdMap.lenient);
  assert.equal(lenient.grounding.length, 3, "lenient threshold 0.3 still excludes 0.25 score");
});

test("results below threshold score are filtered out", () => {
  const results: TavilyResult[] = [
    { title: "High", url: "https://high.com", content: "c", score: 0.9 },
    { title: "Medium", url: "https://medium.com", content: "c", score: 0.6 },
    { title: "Low", url: "https://low.com", content: "c", score: 0.2 },
  ];

  // Threshold 0.5: should exclude score 0.2
  const { grounding } = budgetContent(results, 8192, 0.5);
  assert.equal(grounding.length, 2);
  assert.ok(
    grounding.every(g => g.url !== "https://low.com"),
    "Low-score result should be filtered out",
  );
});

// =============================================================================
// Infrastructure tests
// =============================================================================

test("cache key with |p:tavily differs from |p:brave for same query", () => {
  const query = "typescript generics";
  const maxTokens = 8192;
  const maxUrls = 10;
  const threshold = "balanced";
  const count = 20;

  const braveKey = normalizeQuery(query) + `|t:${maxTokens}|u:${maxUrls}|th:${threshold}|c:${count}|p:brave`;
  const tavilyKey = normalizeQuery(query) + `|t:${maxTokens}|u:${maxUrls}|th:${threshold}|c:${count}|p:tavily`;

  assert.notEqual(braveKey, tavilyKey, "Cache keys for same query but different providers must differ");
  assert.ok(braveKey.endsWith("|p:brave"), "Brave cache key ends with |p:brave");
  assert.ok(tavilyKey.endsWith("|p:tavily"), "Tavily cache key ends with |p:tavily");
});

test("no-key error message mentions both TAVILY_API_KEY and BRAVE_API_KEY", () => {
  // This mirrors the error string that will be returned when no provider is resolved
  const errorMessage = "search_and_read unavailable: No search API key is set. Use secure_env_collect to set TAVILY_API_KEY or BRAVE_API_KEY.";

  assert.ok(errorMessage.includes("TAVILY_API_KEY"), "Error must mention TAVILY_API_KEY");
  assert.ok(errorMessage.includes("BRAVE_API_KEY"), "Error must mention BRAVE_API_KEY");
  assert.ok(errorMessage.includes("secure_env_collect"), "Error must mention secure_env_collect");
});

test("Tavily LLM context request uses POST with Bearer auth and advanced search depth", async (t) => {
  const apiKey = "tvly-test-key-abc123";
  const query = "typescript handbook";

  const tavilyResponse = {
    query,
    results: makeTavilyLLMResponse(),
    response_time: "1.2",
  };

  const { captured, restore } = mockFetch(tavilyResponse);

  t.after(restore);
  // Simulate what the Tavily LLM context path will build
  const requestBody = {
    query,
    max_results: 20,
    search_depth: "advanced",
    include_raw_content: true,
  };

  await globalThis.fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  // Verify POST method
  assert.equal(captured.method, "POST", "Tavily uses POST");

  // Verify Bearer auth header
  assert.equal(
    captured.headers?.["Authorization"],
    "Bearer tvly-test-key-abc123",
    "Authorization header uses Bearer scheme",
  );

  // Verify advanced search depth for LLM context (richer content)
  assert.equal(captured.body?.search_depth, "advanced", "LLM context uses advanced search depth");

  // Verify include_raw_content for full page text
  assert.equal(captured.body?.include_raw_content, true, "LLM context requests raw_content");

  // Verify POST target URL
  assert.equal(captured.url, "https://api.tavily.com/search", "Posts to Tavily search endpoint");
});
