/**
 * Unit tests for remote-questions HTTP client proxy wiring.
 *
 * These tests verify that apiRequest correctly handles the proxyUrl option
 * by checking the dispatcher property passed to fetch.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Test double for tracking fetch calls
interface FetchCall {
  url: string;
  init: RequestInit & { dispatcher?: unknown };
}

let fetchCalls: FetchCall[] = [];

// Mock implementation that captures calls
function mockFetch(
  url: string | Request | URL,
  init?: RequestInit & { dispatcher?: unknown },
): Promise<Response> {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("apiRequest proxy integration", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not include dispatcher when proxyUrl is omitted", async () => {
    // Import the module fresh to pick up the mocked fetch
    const { apiRequest } = await import("../http-client.js");
    await apiRequest("https://api.example.com/test", "GET", undefined, {});

    assert.equal(fetchCalls.length, 1, "expected exactly one fetch call");
    const call = fetchCalls[0];
    assert.ok(!call.init.dispatcher, "expected no dispatcher when proxyUrl is omitted");
  });

  it("includes a dispatcher when proxyUrl is provided", async () => {
    const { apiRequest } = await import("../http-client.js");
    await apiRequest("https://api.example.com/test", "GET", undefined, {
      proxyUrl: "http://proxy.example.com:8080",
    });

    assert.equal(fetchCalls.length, 1, "expected exactly one fetch call");
    const call = fetchCalls[0];
    assert.ok(call.init.dispatcher, "expected dispatcher to be set when proxyUrl is provided");
  });

  it("throws a clear error when ProxyAgent cannot be created", async () => {
    const { apiRequest } = await import("../http-client.js");

    // Pass an invalid proxy URL to force ProxyAgent construction to fail
    await assert.rejects(
      async () => {
        await apiRequest("https://api.example.com/test", "GET", undefined, {
          proxyUrl: "not-a-valid-url",
          errorLabel: "Telegram API",
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("Telegram API: Failed to configure proxy"));
        return true;
      },
    );
  });
});
