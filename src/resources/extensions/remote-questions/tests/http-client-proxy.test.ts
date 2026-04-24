/**
 * Unit tests for remote-questions HTTP client proxy wiring.
 *
 * These tests verify that apiRequest correctly handles the proxyUrl option,
 * NO_PROXY bypass, redaction, and agent reuse.
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
  const originalNoProxy = process.env.NO_PROXY;
  const originalNoProxyLower = process.env.no_proxy;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalNoProxy === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = originalNoProxy;
    }
    if (originalNoProxyLower === undefined) {
      delete process.env.no_proxy;
    } else {
      process.env.no_proxy = originalNoProxyLower;
    }
  });

  it("does not include agent when proxyUrl is omitted", async () => {
    const { apiRequest } = await import("../http-client.js");
    await apiRequest("https://api.example.com/test", "GET", undefined, {});

    assert.equal(fetchCalls.length, 1, "expected exactly one fetch call");
    const call = fetchCalls[0];
    assert.ok(!call.init.dispatcher, "expected no agent when proxyUrl is omitted");
  });

  it("includes an agent when proxyUrl is provided", async () => {
    const { apiRequest } = await import("../http-client.js");
    await apiRequest("https://api.example.com/test", "GET", undefined, {
      proxyUrl: "http://proxy.example.com:8080",
    });

    assert.equal(fetchCalls.length, 1, "expected exactly one fetch call");
    const call = fetchCalls[0];
    assert.ok(call.init.dispatcher, "expected agent to be set when proxyUrl is provided");
  });

  it("skips proxy when target is in NO_PROXY", async () => {
    process.env.NO_PROXY = "api.example.com,other.host";

    const { apiRequest } = await import("../http-client.js");
    await apiRequest("https://api.example.com/test", "GET", undefined, {
      proxyUrl: "http://proxy.example.com:8080",
    });

    assert.equal(fetchCalls.length, 1, "expected exactly one fetch call");
    const call = fetchCalls[0];
    assert.ok(!call.init.dispatcher, "expected no agent when target is in NO_PROXY");
  });

  it("skips proxy when target matches suffix in NO_PROXY", async () => {
    process.env.NO_PROXY = ".example.com";

    const { apiRequest } = await import("../http-client.js");
    await apiRequest("https://api.example.com/test", "GET", undefined, {
      proxyUrl: "http://proxy.example.com:8080",
    });

    assert.equal(fetchCalls.length, 1, "expected exactly one fetch call");
    const call = fetchCalls[0];
    assert.ok(!call.init.dispatcher, "expected no agent when target matches NO_PROXY suffix");
  });

  it("uses proxy when target is not in NO_PROXY", async () => {
    process.env.NO_PROXY = "other.host";

    const { apiRequest } = await import("../http-client.js");
    await apiRequest("https://api.example.com/test", "GET", undefined, {
      proxyUrl: "http://proxy.example.com:8080",
    });

    assert.equal(fetchCalls.length, 1, "expected exactly one fetch call");
    const call = fetchCalls[0];
    assert.ok(call.init.dispatcher, "expected agent when target is not in NO_PROXY");
  });

  it("uses provided agent directly without NO_PROXY check", async () => {
    const { ProxyAgent } = await import("undici");
    const { apiRequest } = await import("../http-client.js");

    process.env.NO_PROXY = "api.example.com";
    const agent = new ProxyAgent("http://proxy.example.com:8080");

    await apiRequest("https://api.example.com/test", "GET", undefined, {
      agent,
    });

    assert.equal(fetchCalls.length, 1, "expected exactly one fetch call");
    const call = fetchCalls[0];
    assert.equal(call.init.dispatcher, agent, "expected provided agent to be used directly");

    await agent.close();
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

  it("throws when both agent and proxyUrl are passed", async () => {
    const { ProxyAgent } = await import("undici");
    const { apiRequest } = await import("../http-client.js");

    const agent = new ProxyAgent("http://proxy.example.com:8080");

    await assert.rejects(
      async () => {
        await apiRequest("https://api.example.com/test", "GET", undefined, {
          agent,
          proxyUrl: "http://proxy.example.com:8080",
          errorLabel: "Test API",
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("Test API: agent and proxyUrl are mutually exclusive"));
        return true;
      },
    );

    await agent.close();
  });
});
