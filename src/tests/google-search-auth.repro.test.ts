import test from "node:test";
import assert from "node:assert/strict";
import googleSearchExtension from "../resources/extensions/google-search/index.ts";

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

test("fix: google-search uses OAuth if GEMINI_API_KEY is missing", async () => {
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

  try {
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
  } finally {
    global.fetch = originalFetch;
    process.env.GEMINI_API_KEY = originalKey;
  }
});

test("google-search warns if NO authentication is present", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const origBrave = process.env.BRAVE_API_KEY;
  const origTavily = process.env.TAVILY_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;

  try {
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
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
    if (origBrave) process.env.BRAVE_API_KEY = origBrave;
    else delete process.env.BRAVE_API_KEY;
    if (origTavily) process.env.TAVILY_API_KEY = origTavily;
    else delete process.env.TAVILY_API_KEY;
  }
});

test("#2027: google-search does NOT warn when TAVILY_API_KEY is set", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const origTavily = process.env.TAVILY_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.TAVILY_API_KEY = "tvly-test-key";

  try {
    const pi = createMockPI();
    googleSearchExtension(pi as any);

    const notifications: any[] = [];
    const mockCtx = {
      ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
      modelRegistry: mockModelRegistry(undefined),
    };

    await pi.fire("session_start", {}, mockCtx);
    assert.equal(notifications.length, 0, "Should NOT warn about Google auth when Tavily is configured");
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
    if (origTavily) process.env.TAVILY_API_KEY = origTavily;
    else delete process.env.TAVILY_API_KEY;
  }
});

test("#2027: google-search does NOT warn when BRAVE_API_KEY is set", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const origBrave = process.env.BRAVE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.BRAVE_API_KEY = "test-brave-key";

  try {
    const pi = createMockPI();
    googleSearchExtension(pi as any);

    const notifications: any[] = [];
    const mockCtx = {
      ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
      modelRegistry: mockModelRegistry(undefined),
    };

    await pi.fire("session_start", {}, mockCtx);
    assert.equal(notifications.length, 0, "Should NOT warn about Google auth when Brave is configured");
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
    if (origBrave) process.env.BRAVE_API_KEY = origBrave;
    else delete process.env.BRAVE_API_KEY;
  }
});

test("google-search uses GEMINI_API_KEY if present (precedence)", async () => {
  process.env.GEMINI_API_KEY = "mock-api-key";

  try {
    const pi = createMockPI();
    googleSearchExtension(pi as any);

    const notifications: any[] = [];
    const mockCtx = {
      ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
      modelRegistry: mockModelRegistry(JSON.stringify({ token: "should-not-be-used", projectId: "mock-project" })),
    };

    await pi.fire("session_start", {}, mockCtx);
    assert.equal(notifications.length, 0, "Should NOT notify if API Key is present");
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});
