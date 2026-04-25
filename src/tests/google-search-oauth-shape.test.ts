/**
 * google-search-oauth-shape.test.ts — Regression test for #2963.
 *
 * The OAuth fallback in google_search manually POSTs to the Cloud Code Assist
 * endpoint.  The original implementation sent a request body that did not match
 * the endpoint's expected contract, causing a 400 INVALID_ARGUMENT response.
 *
 * This test captures the fetch call and asserts that the URL and body conform
 * to the Cloud Code Assist wire format used by the working provider in
 * packages/pi-ai/src/providers/google-gemini-cli.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import googleSearchExtension from "../../extensions/google-search/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockPI() {
  const handlers: Array<{ event: string; handler: any }> = [];
  let registeredTool: any = null;

  return {
    handlers,
    get registeredTool() { return registeredTool; },
    on(event: string, handler: any) {
      handlers.push({ event, handler });
    },
    registerTool(tool: any) {
      registeredTool = tool;
    },
    async fire(event: string, eventData: any, ctx: any) {
      for (const h of handlers) {
        if (h.event === event) {
          await h.handler(eventData, ctx);
        }
      }
    },
  };
}

function mockModelRegistry(oauthJson?: string) {
  return {
    authStorage: {
      hasAuth: async (_id: string) => !!oauthJson,
    },
    getApiKeyForProvider: async (_provider: string) => oauthJson,
  };
}

/** A valid SSE response body matching the Cloud Code Assist wire format. */
function makeOkSSEBody() {
  const payload = {
    response: {
      candidates: [{
        content: {
          parts: [{ text: "Sunny, 85 °F in Austin today." }],
        },
        groundingMetadata: {
          groundingChunks: [
            { web: { title: "weather.com", uri: "https://weather.com/austin", domain: "weather.com" } },
          ],
          webSearchQueries: ["weather today in Austin Texas"],
        },
      }],
    },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("#2963: OAuth fallback URL must include ?alt=sse query parameter", async (t) => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;

  let capturedUrl = "";

  (global as any).fetch = async (url: string, _options: any) => {
    capturedUrl = url;
    return { ok: true, text: async () => makeOkSSEBody() };
  };

  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
  });

  const pi = createMockPI();
  googleSearchExtension(pi as any);

  const oauthJson = JSON.stringify({ token: "tok", projectId: "proj" });
  const ctx = { ui: { notify() {} }, modelRegistry: mockModelRegistry(oauthJson) };

  await pi.fire("session_start", {}, ctx);
  await pi.registeredTool.execute("c1", { query: "weather" }, new AbortController().signal, () => {}, ctx);

  assert.ok(
    capturedUrl.includes("?alt=sse"),
    `URL must contain ?alt=sse for SSE parsing to work. Got: ${capturedUrl}`,
  );
});

test("#2963: OAuth fallback body must include userAgent field", async (t) => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;

  let capturedBody: any = null;

  (global as any).fetch = async (_url: string, options: any) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, text: async () => makeOkSSEBody() };
  };

  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
  });

  const pi = createMockPI();
  googleSearchExtension(pi as any);

  const oauthJson = JSON.stringify({ token: "tok", projectId: "proj" });
  const ctx = { ui: { notify() {} }, modelRegistry: mockModelRegistry(oauthJson) };

  await pi.fire("session_start", {}, ctx);
  await pi.registeredTool.execute("c2", { query: "weather userAgent test" }, new AbortController().signal, () => {}, ctx);

  assert.ok(capturedBody, "fetch must have been called");
  assert.equal(
    typeof capturedBody.userAgent,
    "string",
    "Body must include a userAgent field (Cloud Code Assist contract)",
  );
});

test("#2963: OAuth fallback body must contain google_search tool in correct format", async (t) => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;

  let capturedBody: any = null;

  (global as any).fetch = async (_url: string, options: any) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, text: async () => makeOkSSEBody() };
  };

  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
  });

  const pi = createMockPI();
  googleSearchExtension(pi as any);

  const oauthJson = JSON.stringify({ token: "tok", projectId: "proj" });
  const ctx = { ui: { notify() {} }, modelRegistry: mockModelRegistry(oauthJson) };

  await pi.fire("session_start", {}, ctx);
  await pi.registeredTool.execute("c3", { query: "weather tools test" }, new AbortController().signal, () => {}, ctx);

  assert.ok(capturedBody, "fetch must have been called");
  const tools = capturedBody.request?.tools;
  assert.ok(Array.isArray(tools), "request.tools must be an array");
  assert.ok(
    tools.some((t: any) => t.googleSearch !== undefined),
    `tools must contain a googleSearch entry. Got: ${JSON.stringify(tools)}`,
  );
});

test("#2963: OAuth fallback body has correct top-level structure", async (t) => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;

  let capturedBody: any = null;

  (global as any).fetch = async (_url: string, options: any) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, text: async () => makeOkSSEBody() };
  };

  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
  });

  const pi = createMockPI();
  googleSearchExtension(pi as any);

  const oauthJson = JSON.stringify({ token: "tok", projectId: "proj" });
  const ctx = { ui: { notify() {} }, modelRegistry: mockModelRegistry(oauthJson) };

  await pi.fire("session_start", {}, ctx);
  await pi.registeredTool.execute("c4", { query: "weather structure test" }, new AbortController().signal, () => {}, ctx);

  assert.ok(capturedBody, "fetch must have been called");

  // Top-level fields required by CloudCodeAssistRequest
  assert.equal(capturedBody.project, "proj", "project must match the OAuth projectId");
  assert.ok(typeof capturedBody.model === "string" && capturedBody.model.length > 0, "model must be a non-empty string");
  assert.ok(capturedBody.request && typeof capturedBody.request === "object", "request must be an object");
  assert.ok(typeof capturedBody.userAgent === "string", "userAgent must be present");

  // Nested request fields
  assert.ok(Array.isArray(capturedBody.request.contents), "request.contents must be an array");
  assert.ok(Array.isArray(capturedBody.request.tools), "request.tools must be an array");
});
