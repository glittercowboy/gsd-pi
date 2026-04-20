import test from "node:test";
import assert from "node:assert/strict";
import googleSearchExtension from "../resources/extensions/google-search/index.js";

function createMockPI() {
  const handlers: any[] = [];
  let registeredTool: any = null;

  return {
    handlers,
    registeredTool,
    on(event: string, handler: any) {
      handlers.push({ event, handler });
    },
    registerTool(tool: any) {
      this.registeredTool = tool;
    },
    async fire(event: string, eventData: any, ctx: any) {
      for (const h of handlers) {
        if (h.event === event) {
          await h.handler(eventData, ctx);
        }
      }
    }
  };
}

/**
 * Build a mock modelRegistry whose getApiKeyForProvider returns the given
 * JSON string (matching what the real OAuth provider's getApiKey produces).
 */
function mockModelRegistry(oauthJson?: string) {
  return {
    authStorage: {
      hasAuth: async (_id: string) => !!oauthJson,
    },
    getApiKeyForProvider: async (_provider: string) => oauthJson,
  };
}

test("fix: google-search uses OAuth if GEMINI_API_KEY is missing", async (t) => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const originalFetch = global.fetch;
  (global as any).fetch = async (url: string, options: any) => {
    assert.ok(url.includes("cloudcode-pa.googleapis.com"), "Should use Cloud Code Assist endpoint");
    assert.equal(options.headers.Authorization, "Bearer mock-token", "Should use correct bearer token");
    return {
      ok: true,
      json: async () => ({
        response: {
          candidates: [{ content: { parts: [{ text: "Mocked AI Answer" }] } }]
        }
      }),
      text: async () => JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "Mocked AI Answer" }] } }]
        }
      }),
    };
  };

  t.after(() => {
    global.fetch = originalFetch;
    process.env.GEMINI_API_KEY = originalKey;
  });
  const pi = createMockPI();
  googleSearchExtension(pi as any);

  const oauthJson = JSON.stringify({ token: "mock-token", projectId: "mock-project" });
  const mockCtx = {
    ui: { notify() {} },
    modelRegistry: mockModelRegistry(oauthJson),
  };

  await pi.fire("session_start", {}, mockCtx);
  const registeredTool = (pi as any).registeredTool;
  const result = await registeredTool.execute("call-1", { query: "test" }, new AbortController().signal, () => {}, mockCtx);

  assert.equal(result.isError, undefined);
  assert.ok(result.content[0].text.includes("Mocked AI Answer"));
});

test("google-search warns if NO authentication is present", async (t) => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  t.after(() => process.env.GEMINI_API_KEY = originalKey);
  const pi = createMockPI();
  googleSearchExtension(pi as any);

  const notifications: any[] = [];
  const mockCtx = {
    ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
    modelRegistry: mockModelRegistry(undefined),
  };

  await pi.fire("session_start", {}, mockCtx);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].msg.includes("No authentication set"));

  const registeredTool = (pi as any).registeredTool;
  const result = await registeredTool.execute("call-2", { query: "test" }, new AbortController().signal, () => {}, mockCtx);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("No authentication found"));
});

test("google-search uses GEMINI_API_KEY if present (precedence)", async (t) => {
  process.env.GEMINI_API_KEY = "mock-api-key";

  t.after(() => delete process.env.GEMINI_API_KEY);
  const pi = createMockPI();
  googleSearchExtension(pi as any);

  const notifications: any[] = [];
  const mockCtx = {
    ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
    modelRegistry: mockModelRegistry(JSON.stringify({ token: "should-not-be-used", projectId: "mock-project" })),
  };

  await pi.fire("session_start", {}, mockCtx);
  assert.equal(notifications.length, 0, "Should NOT notify if API Key is present");
});
