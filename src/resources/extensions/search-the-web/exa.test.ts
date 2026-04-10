import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Mock fetch for testing
let lastFetchRequest: { url: string; method: string; headers: Record<string, string>; body: string } | null = null;
let mockFetchResponse: { ok: boolean; status: number; body: string } | null = null;
const originalFetch = globalThis.fetch;

function mockFetch(_url: string | URL, init?: RequestInit): Promise<Response> {
  lastFetchRequest = {
    url: typeof _url === "string" ? _url : _url.toString(),
    method: init?.method ?? "GET",
    headers: init?.headers as Record<string, string> ?? {},
    body: init?.body as string ?? "",
  };
  if (!mockFetchResponse) {
    return Promise.resolve(new Response("not configured", { status: 500 }));
  }
  return Promise.resolve(
    new Response(mockFetchResponse.body, { status: mockFetchResponse.status }),
  );
}

beforeEach(() => {
  globalThis.fetch = mockFetch as typeof fetch;
  lastFetchRequest = null;
  mockFetchResponse = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Import after mock setup
import { callExaCodeSearch, callExaWebSearch } from "./exa.js";

describe("Exa API module", () => {
  describe("callExaCodeSearch()", () => {
    it("should send JSON-RPC request to Exa MCP endpoint", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: 'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"React useState example code"}]}}\n\n',
      };

      const result = await callExaCodeSearch("React useState", 5000);

      assert.ok(lastFetchRequest, "fetch should have been called");
      assert.strictEqual(lastFetchRequest!.method, "POST");
      assert.strictEqual(lastFetchRequest!.url, "https://mcp.exa.ai/mcp");
      assert.strictEqual(lastFetchRequest!.headers["content-type"], "application/json");

      const body = JSON.parse(lastFetchRequest!.body);
      assert.strictEqual(body.jsonrpc, "2.0");
      assert.strictEqual(body.method, "tools/call");
      assert.strictEqual(body.params.name, "get_code_context_exa");
      assert.strictEqual(body.params.arguments.query, "React useState");
      assert.strictEqual(body.params.arguments.tokensNum, 5000);

      assert.strictEqual(result, "React useState example code");
    });

    it("should return empty string when no results found", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: 'data: {"jsonrpc":"2.0","result":{"content":[]}}\n\n',
      };

      const result = await callExaCodeSearch("nonexistent query", 5000);
      assert.strictEqual(result, "");
    });

    it("should throw on HTTP error", async () => {
      mockFetchResponse = {
        ok: false,
        status: 429,
        body: "rate limited",
      };

      await assert.rejects(
        () => callExaCodeSearch("test", 5000),
        (err: Error) => err.message.includes("429"),
      );
    });

    it("should throw on API error response", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: 'data: {"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid request"}}\n\n',
      };

      await assert.rejects(
        () => callExaCodeSearch("test", 5000),
        (err: Error) => err.message.includes("Invalid request"),
      );
    });
  });

  describe("callExaWebSearch()", () => {
    it("should send JSON-RPC request with web_search_exa tool name", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: 'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Search results here"}]}}\n\n',
      };

      const result = await callExaWebSearch("Node.js 22 release", {
        numResults: 5,
        type: "fast",
        livecrawl: "fallback",
      });

      assert.ok(lastFetchRequest, "fetch should have been called");
      const body = JSON.parse(lastFetchRequest!.body);
      assert.strictEqual(body.params.name, "web_search_exa");
      assert.strictEqual(body.params.arguments.query, "Node.js 22 release");
      assert.strictEqual(body.params.arguments.type, "fast");
      assert.strictEqual(body.params.arguments.numResults, 5);
      assert.strictEqual(body.params.arguments.livecrawl, "fallback");

      assert.strictEqual(result, "Search results here");
    });

    it("should use default values when options are not provided", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: 'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"results"}]}}\n\n',
      };

      await callExaWebSearch("test query");

      const body = JSON.parse(lastFetchRequest!.body);
      assert.strictEqual(body.params.arguments.type, "auto");
      assert.strictEqual(body.params.arguments.numResults, 8);
      assert.strictEqual(body.params.arguments.livecrawl, "fallback");
    });

    it("should handle SSE responses with multiple data lines", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: 'event: ping\ndata: {}\n\ndata: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"real results"}]}}\n\n',
      };

      const result = await callExaWebSearch("test");
      assert.strictEqual(result, "real results");
    });
  });
});
