import test from "node:test";
import assert from "node:assert/strict";
import {
  registerNativeSearchHooks,
  stripThinkingFromHistory,
  BRAVE_TOOL_NAMES,
  CUSTOM_SEARCH_TOOL_NAMES,
  MAX_NATIVE_SEARCHES_PER_SESSION,
  type NativeSearchPI,
} from "../resources/extensions/search-the-web/native-search.ts";

/**
 * Tests for native Anthropic web search injection.
 *
 * Tests the hook logic in native-search.ts directly (no heavy tool deps).
 */

// ─── Mock ExtensionAPI ──────────────────────────────────────────────────────

interface MockHandler {
  event: string;
  handler: (...args: any[]) => any;
}

function createMockPI() {
  const handlers: MockHandler[] = [];
  let activeTools = ["search-the-web", "search_and_read", "google_search", "fetch_page", "bash", "read"];
  const notifications: Array<{ message: string; level: string }> = [];

  const mockCtx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  const pi: NativeSearchPI & {
    handlers: MockHandler[];
    notifications: typeof notifications;
    mockCtx: typeof mockCtx;
    fire(event: string, eventData: any, ctx?: any): Promise<any>;
  } = {
    handlers,
    notifications,
    mockCtx,
    on(event: string, handler: (...args: any[]) => any) {
      handlers.push({ event, handler });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
    async fire(event: string, eventData: any, ctx?: any) {
      let lastResult: any;
      for (const h of handlers) {
        if (h.event === event) {
          const result = await h.handler(eventData, ctx ?? mockCtx);
          if (result !== undefined) lastResult = result;
        }
      }
      return lastResult;
    },
  };

  return pi;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("before_provider_request injects web_search for claude models", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  // Confirm Anthropic provider via model_select before request
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  const tools = (result as any)?.tools ?? payload.tools;
  const nativeTool = (tools as any[]).find(
    (t: any) => t.type === "web_search_20250305"
  );
  assert.ok(nativeTool, "Should inject web_search_20250305 tool");
  assert.equal((tools as any[]).length, 2, "Should have original + injected tool");
  assert.equal(nativeTool.max_uses, 5, "Should set max_uses to 5 to prevent search loops (#817)");
});

test("before_provider_request injects web_search for claude models even without model_select", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  // NO model_select fired — simulates session restore where modelsAreEqual suppresses the event
  const payload: Record<string, unknown> = {
    model: "claude-opus-4-6",
    tools: [
      { name: "bash", type: "custom" },
      { name: "search-the-web", type: "function" },
      { name: "google_search", type: "function" },
    ],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  const names = tools.map((t: any) => t.name ?? t.type);

  assert.ok(names.includes("web_search"), "Should inject native web_search based on model name");
  assert.ok(!names.includes("search-the-web"), "Should remove search-the-web");
  assert.ok(!names.includes("google_search"), "Should remove google_search");
  assert.ok(names.includes("bash"), "Should keep non-search tools");
});

test("before_provider_request does NOT inject for non-claude models", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  const payload: Record<string, unknown> = {
    model: "gpt-4o",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  assert.equal(result, undefined, "Should not modify non-claude payload");
  const tools = payload.tools as any[];
  assert.equal(tools.length, 1, "Should not add tools to non-claude payload");
});

test("before_provider_request does NOT inject for claude model on non-Anthropic provider", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  // GitHub Copilot (or Bedrock, etc.) serving a claude model.
  // Critical: runtime model objects from copilot carry api: "anthropic-messages"
  // because copilot routes through packages/pi-ai/src/providers/anthropic.ts.
  // The earlier fixture omitted `api` and masked the #4492 regression.
  await pi.fire("model_select", {
    type: "model_select",
    model: {
      provider: "github-copilot",
      api: "anthropic-messages",
      name: "claude-sonnet-4-6",
    },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  assert.equal(result, undefined, "Should not modify payload for non-Anthropic provider");
  const tools = payload.tools as any[];
  assert.equal(tools.length, 1, "Should not inject web_search for non-Anthropic provider");
  assert.ok(
    !tools.some((t: any) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be present for non-Anthropic providers"
  );
});

// ─── Issue #444 regression: Copilot claude-* model without model_select ──────

test("before_provider_request does NOT inject when event.model indicates non-Anthropic provider (no model_select)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  // NO model_select fired — simulates a new session where model was set before
  // extensions were bound. The event.model field from the SDK reveals the true provider.
  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    // Copilot-served claude carries api: "anthropic-messages" at runtime —
    // include it so the test actually exercises the #4492 code path.
    model: {
      provider: "github-copilot",
      api: "anthropic-messages",
      id: "claude-sonnet-4-6",
    },
  });

  assert.equal(result, undefined, "Should not modify payload when event.model says non-Anthropic");
  const tools = payload.tools as any[];
  assert.equal(tools.length, 1, "Should not inject web_search for Copilot provider");
  assert.ok(
    !tools.some((t: any) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be present for Copilot"
  );
});

// ─── Issue #4492 regression: anthropic-shaped transports without native search ──

test("before_provider_request does NOT inject for github-copilot + claude-haiku-4.5 (#4492 regression)", async () => {
  // Reproduces the original report: provider=github-copilot, model=claude-haiku-4.5
  // carries api: "anthropic-messages" at runtime (copilot routes through
  // packages/pi-ai/src/providers/anthropic.ts). The #4492 change to gate on api
  // shape alone regressed this and caused every request to fail with
  // 400 "The use of the web search tool is not supported.".
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: {
      provider: "github-copilot",
      api: "anthropic-messages",
      name: "claude-haiku-4.5",
    },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-haiku-4.5",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: {
      provider: "github-copilot",
      api: "anthropic-messages",
      id: "claude-haiku-4.5",
    },
  });

  assert.equal(result, undefined, "Should not modify payload for github-copilot + claude-haiku-4.5");
  const tools = payload.tools as any[];
  assert.ok(
    !tools.some((t: any) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be injected for github-copilot — endpoint rejects it"
  );
});

test("before_provider_request does NOT inject for minimax (anthropic-shaped, no native search)", async () => {
  // MiniMax M2.x declares api: "anthropic-messages" but its endpoint does not
  // accept web_search_20250305 — same regression class as github-copilot.
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  const payload: Record<string, unknown> = {
    model: "MiniMax-M2.5",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "minimax", api: "anthropic-messages", id: "MiniMax-M2.5" },
  });

  assert.equal(result, undefined, "Should not modify payload for minimax");
  const tools = payload.tools as any[];
  assert.ok(
    !tools.some((t: any) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be injected for minimax"
  );
});

test("before_provider_request DOES inject when event.model indicates Anthropic provider (no model_select)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  // NO model_select fired, but event.model confirms Anthropic provider
  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
  });

  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  assert.ok(
    tools.some((t: any) => t.type === "web_search_20250305"),
    "Should inject web_search when event.model confirms Anthropic"
  );
});

test("before_provider_request does not double-inject", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-opus-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-opus-4-6-20250514",
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  assert.equal(result, undefined, "Should not modify when already injected");
  const tools = payload.tools as any[];
  assert.equal(tools.length, 1, "Should not duplicate web_search tool");
});

test("before_provider_request creates tools array if missing", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-haiku-4-5" },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-haiku-4-5-20251001",
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  const tools = (result as any)?.tools ?? payload.tools;
  assert.ok(Array.isArray(tools), "Should create tools array");
  assert.equal((tools as any[]).length, 1, "Should have exactly 1 tool");
  assert.equal((tools as any[])[0].type, "web_search_20250305");
  assert.equal((tools as any[])[0].max_uses, 5, "Should include max_uses limit");
});

test("before_provider_request skips when payload is falsy", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload: null,
  });

  assert.equal(result, undefined, "Should return undefined for null payload");
});

test("model_select disables Brave tools when Anthropic + no BRAVE_API_KEY", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;

  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const active = pi.getActiveTools();
  assert.ok(!active.includes("search-the-web"), "search-the-web should be disabled");
  assert.ok(!active.includes("search_and_read"), "search_and_read should be disabled");
  assert.ok(!active.includes("google_search"), "google_search should be disabled");
  assert.ok(active.includes("fetch_page"), "fetch_page should remain active");
  assert.ok(active.includes("bash"), "Other tools should remain active");
});

test("model_select disables all custom search tools when Anthropic even with BRAVE_API_KEY", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "test-key";

  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const active = pi.getActiveTools();
  assert.ok(!active.includes("search-the-web"), "search-the-web should be disabled for Anthropic");
  assert.ok(!active.includes("search_and_read"), "search_and_read should be disabled for Anthropic");
  assert.ok(!active.includes("google_search"), "google_search should be disabled for Anthropic");
  assert.ok(active.includes("fetch_page"), "fetch_page should remain active");
});

test("model_select re-enables Brave tools when switching away from Anthropic", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;

  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  // First: select Anthropic — disables Brave tools
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  let active = pi.getActiveTools();
  assert.ok(!active.includes("search-the-web"), "Should disable after Anthropic select");

  // Second: switch to non-Anthropic — re-enables
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", name: "gpt-4o" },
    previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
    source: "set",
  });

  active = pi.getActiveTools();
  assert.ok(active.includes("search-the-web"), "search-the-web should be re-enabled");
  assert.ok(active.includes("search_and_read"), "search_and_read should be re-enabled");
  assert.ok(active.includes("google_search"), "google_search should be re-enabled");
});

test("model_select shows 'Native Anthropic web search active' for Anthropic provider", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const infoNotif = pi.notifications.find(
    (n) => n.level === "info" && n.message.includes("Native")
  );
  assert.ok(infoNotif, "Should notify about native search on Anthropic model_select");
  assert.ok(
    infoNotif!.message.includes("Native Anthropic web search active"),
    `Should say 'Native Anthropic web search active' — got: ${infoNotif!.message}`
  );
});

test("model_select shows warning for non-Anthropic without Brave key", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;

  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", name: "gpt-4o" },
    previousModel: undefined,
    source: "set",
  });

  const warning = pi.notifications.find((n) => n.level === "warning");
  assert.ok(warning, "Should show warning for non-Anthropic without Brave key");
  assert.ok(
    warning!.message.includes("Anthropic"),
    `Warning should mention Anthropic — got: ${warning!.message}`
  );
});

test("session_start resets search count and shows no startup notification", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("session_start", { type: "session_start" });

  // Tool status is now shown in the welcome screen bar layout — no notification on session_start
  const infoNotif = pi.notifications.find(
    (n) => n.level === "info" && n.message.includes("v4")
  );
  assert.equal(infoNotif, undefined, "Should NOT emit a v4 startup notification (welcome screen handles this)");
});

test("BRAVE_TOOL_NAMES contains expected tool names", () => {
  assert.deepEqual(BRAVE_TOOL_NAMES, ["search-the-web", "search_and_read"]);
});

test("CUSTOM_SEARCH_TOOL_NAMES contains all custom search tools", () => {
  assert.deepEqual(CUSTOM_SEARCH_TOOL_NAMES, ["search-the-web", "search_and_read", "google_search"]);
});

test("before_provider_request removes Brave tools from payload when no BRAVE_API_KEY", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;

  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [
      { name: "bash", type: "function" },
      { name: "search-the-web", type: "function" },
      { name: "search_and_read", type: "function" },
      { name: "google_search", type: "function" },
      { name: "fetch_page", type: "function" },
    ],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  const names = tools.map((t: any) => t.name);

  assert.ok(!names.includes("search-the-web"), "search-the-web should be removed from payload");
  assert.ok(!names.includes("search_and_read"), "search_and_read should be removed from payload");
  assert.ok(!names.includes("google_search"), "google_search should be removed from payload");
  assert.ok(names.includes("bash"), "bash should remain");
  assert.ok(names.includes("fetch_page"), "fetch_page should remain");
  assert.ok(names.includes("web_search"), "native web_search should be injected");
});

test("before_provider_request removes all custom search tools from payload even with BRAVE_API_KEY", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "test-key";

  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [
      { name: "search-the-web", type: "function" },
      { name: "search_and_read", type: "function" },
      { name: "google_search", type: "function" },
      { name: "fetch_page", type: "function" },
    ],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  const names = tools.map((t: any) => t.name);

  assert.ok(!names.includes("search-the-web"), "search-the-web should be removed for Anthropic");
  assert.ok(!names.includes("search_and_read"), "search_and_read should be removed for Anthropic");
  assert.ok(!names.includes("google_search"), "google_search should be removed for Anthropic");
  assert.ok(names.includes("fetch_page"), "fetch_page should remain");
  assert.ok(names.includes("web_search"), "native web_search should be injected");
});

// ─── BUG-1 regression: duplicate Brave tools on repeated provider toggle ────

test("model_select re-enable does not duplicate Brave tools across toggle cycles", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;

  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  // Cycle 1: Anthropic disables Brave tools
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });
  assert.ok(!pi.getActiveTools().includes("search-the-web"), "Disabled after 1st Anthropic select");

  // Cycle 1: switch away re-enables
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", name: "gpt-4o" },
    previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
    source: "set",
  });
  let active = pi.getActiveTools();
  assert.equal(
    active.filter((t) => t === "search-the-web").length, 1,
    "search-the-web exactly once after first re-enable"
  );

  // Cycle 2: Anthropic again
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: { provider: "openai", name: "gpt-4o" },
    source: "set",
  });

  // Cycle 2: switch away again — must NOT accumulate duplicates
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", name: "gpt-4o" },
    previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
    source: "set",
  });
  active = pi.getActiveTools();
  assert.equal(
    active.filter((t) => t === "search-the-web").length, 1,
    "search-the-web exactly once after second re-enable (no duplicates)"
  );
  assert.equal(
    active.filter((t) => t === "search_and_read").length, 1,
    "search_and_read exactly once (no duplicates)"
  );
  assert.equal(
    active.filter((t) => t === "google_search").length, 1,
    "google_search exactly once (no duplicates)"
  );
});

// ─── BUG-3 regression: mock fire() must call all handlers, not just first ───

test("mock fire() calls all handlers for the same event", async () => {
  const pi = createMockPI();
  const callOrder: number[] = [];

  // Register two handlers for the same event
  pi.on("test_event", async () => { callOrder.push(1); return "first"; });
  pi.on("test_event", async () => { callOrder.push(2); return "second"; });

  const result = await pi.fire("test_event", {});

  assert.deepEqual(callOrder, [1, 2], "Both handlers should be called");
  assert.equal(result, "second", "Should return last non-undefined result");
});

// ─── BUG-4 regression: no notification noise on session restore ─────────────

test("model_select suppresses 'Native search active' notification on session restore", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "restore",  // session restore, not user action
  });

  const nativeNotif = pi.notifications.find(
    (n) => n.message.includes("Native Anthropic web search active")
  );
  assert.equal(
    nativeNotif, undefined,
    "Should NOT show 'Native search active' on session restore"
  );
});

test("model_select DOES show notification on explicit user set", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const nativeNotif = pi.notifications.find(
    (n) => n.message.includes("Native Anthropic web search active")
  );
  assert.ok(nativeNotif, "Should show notification on explicit 'set' source");
});

// ─── Session-level search budget (#1309) ────────────────────────────────────

test("session search budget: max_uses decreases as history accumulates search results", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  // Simulate a conversation with 10 web_search_tool_result blocks in history
  const messages: any[] = [
    { role: "user", content: "research this topic" },
    {
      role: "assistant",
      content: [
        { type: "web_search_tool_result", tool_use_id: "ws1", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws2", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws3", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws4", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws5", content: [] },
        { type: "text", text: "Here are some results..." },
      ],
    },
    { role: "user", content: "continue" },
    {
      role: "assistant",
      content: [
        { type: "web_search_tool_result", tool_use_id: "ws6", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws7", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws8", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws9", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws10", content: [] },
        { type: "text", text: "More results..." },
      ],
    },
    { role: "user", content: "keep going" },
  ];

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages,
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  const nativeTool = tools.find((t: any) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should still inject web_search when budget remaining");
  // 15 - 10 = 5 remaining, min(5, 5) = 5
  assert.equal(nativeTool.max_uses, 5, "Should cap at min(5, remaining)");
});

test("session search budget: reduces max_uses when close to limit", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  // 13 search results in history → only 2 remaining
  const searchBlocks = Array.from({ length: 13 }, (_, i) => ({
    type: "web_search_tool_result",
    tool_use_id: `ws${i}`,
    content: [],
  }));

  const messages: any[] = [
    { role: "user", content: "research" },
    { role: "assistant", content: [...searchBlocks, { type: "text", text: "results" }] },
    { role: "user", content: "more" },
  ];

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages,
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  const nativeTool = tools.find((t: any) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should still inject when budget > 0");
  // 15 - 13 = 2 remaining
  assert.equal(nativeTool.max_uses, 2, "Should reduce max_uses to remaining budget");
});

test("session search budget: omits web_search tool when budget exhausted", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  // 15+ search results in history → budget exhausted
  const searchBlocks = Array.from({ length: MAX_NATIVE_SEARCHES_PER_SESSION }, (_, i) => ({
    type: "web_search_tool_result",
    tool_use_id: `ws${i}`,
    content: [],
  }));

  const messages: any[] = [
    { role: "user", content: "research" },
    { role: "assistant", content: [...searchBlocks, { type: "text", text: "results" }] },
    { role: "user", content: "more" },
  ];

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages,
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
  });

  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  const nativeTool = tools.find((t: any) => t.type === "web_search_20250305");
  assert.equal(nativeTool, undefined, "Should NOT inject web_search when budget exhausted (#1309)");
  // Other tools should remain
  assert.ok(tools.some((t: any) => t.name === "bash"), "Non-search tools should remain");
});

test("session search budget: resets on session_start", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  // First session: exhaust budget
  const searchBlocks = Array.from({ length: MAX_NATIVE_SEARCHES_PER_SESSION }, (_, i) => ({
    type: "web_search_tool_result",
    tool_use_id: `ws${i}`,
    content: [],
  }));

  let payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages: [
      { role: "user", content: "research" },
      { role: "assistant", content: [...searchBlocks] },
      { role: "user", content: "more" },
    ],
  };

  await pi.fire("before_provider_request", { type: "before_provider_request", payload });
  let tools = (payload.tools as any[]);
  assert.ok(!tools.some((t: any) => t.type === "web_search_20250305"), "Budget should be exhausted");

  // New session starts — counter resets
  await pi.fire("session_start", { type: "session_start" });

  // New request with no history — full budget available
  payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages: [{ role: "user", content: "new research" }],
  };

  const result = await pi.fire("before_provider_request", { type: "before_provider_request", payload });
  tools = ((result as any)?.tools ?? payload.tools) as any[];
  const nativeTool = tools.find((t: any) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should inject web_search after session reset");
  assert.equal(nativeTool.max_uses, 5, "Should have full per-turn budget after reset");
});

test("MAX_NATIVE_SEARCHES_PER_SESSION is exported and equals 15", () => {
  assert.equal(MAX_NATIVE_SEARCHES_PER_SESSION, 15, "Session budget should be 15 (#1309)");
});

test("session search budget: survives context compaction (high-water mark)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  // First request: history has 12 web_search_tool_result blocks
  const searchBlocks = Array.from({ length: 12 }, (_, i) => ({
    type: "web_search_tool_result",
    tool_use_id: `ws${i}`,
    content: [],
  }));

  let payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages: [{ role: "user", content: [{ type: "text", text: "search" }, ...searchBlocks] }],
  };

  await pi.fire("before_provider_request", { type: "before_provider_request", payload });
  let tools = payload.tools as any[];
  let nativeTool = tools.find((t: any) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should still inject web_search with 12/15 used");
  assert.equal(nativeTool.max_uses, 3, "Should have 3 remaining (15 - 12)");

  // Second request: context was compacted — search blocks gone from history.
  // Without high-water mark, the budget would reset to 15.
  payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages: [{ role: "user", content: "compacted context — no search blocks" }],
  };

  await pi.fire("before_provider_request", { type: "before_provider_request", payload });
  tools = payload.tools as any[];
  nativeTool = tools.find((t: any) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should still inject web_search with 12/15 used (high-water mark)");
  assert.equal(nativeTool.max_uses, 3, "High-water mark should preserve 12 — only 3 remaining");
});

// ─── stripThinkingFromHistory tests ─────────────────────────────────────────

test("stripThinkingFromHistory removes thinking from earlier assistant messages", () => {
  const messages: any[] = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig1" },
        { type: "text", text: "Hi there" },
      ],
    },
    { role: "user", content: "search something" },
  ];

  stripThinkingFromHistory(messages);

  // First assistant message (not latest) — thinking stripped
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].type, "text");
});

test("stripThinkingFromHistory strips thinking from all assistant messages", () => {
  const messages: any[] = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first thought", signature: "sig1" },
        { type: "text", text: "response 1" },
      ],
    },
    { role: "user", content: "follow up" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "second thought", signature: "sig2" },
        { type: "text", text: "response 2" },
      ],
    },
    { role: "user", content: "another question" },
  ];

  stripThinkingFromHistory(messages);

  // Both assistant messages — thinking stripped
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].type, "text");

  assert.equal(messages[3].content.length, 1);
  assert.equal(messages[3].content[0].type, "text");
});

test("stripThinkingFromHistory removes redacted_thinking too", () => {
  const messages: any[] = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "response" },
      ],
    },
    { role: "user", content: "next" },
  ];

  stripThinkingFromHistory(messages);

  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].type, "text");
});

test("stripThinkingFromHistory strips even single assistant message", () => {
  const messages: any[] = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thought", signature: "sig" },
        { type: "text", text: "response" },
      ],
    },
    { role: "user", content: "follow up" },
  ];

  stripThinkingFromHistory(messages);

  // Thinking stripped — all assistant messages are from stored history
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].type, "text");
});

test("stripThinkingFromHistory handles no assistant messages", () => {
  const messages: any[] = [
    { role: "user", content: "hello" },
  ];

  // Should not throw
  stripThinkingFromHistory(messages);
  assert.equal(messages.length, 1);
});

test("stripThinkingFromHistory handles string content (no array)", () => {
  const messages: any[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "just a string" },
    { role: "user", content: "next" },
  ];

  // Should not throw — string content is skipped
  stripThinkingFromHistory(messages);
  assert.equal(messages[1].content, "just a string");
});

// ─── #4478 session-restore edge: model_select suppressed (same model) ──────

test("#4478 claude-code session restore with model_select suppressed still injects native search", async () => {
  // Regression: when a session is restored and the restored model equals the
  // active model, `modelsAreEqual` suppresses `model_select`. The
  // before_provider_request handler must still detect Anthropic via the
  // event.model object's `api` field — not fall through to the narrower
  // `provider === "anthropic"` fallback which misses claude-code.
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  // NO model_select fired — simulates restore-with-same-model.
  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    // Full Model object carrying `api` — matches what the runner forwards at runtime.
    model: { provider: "claude-code", id: "claude-sonnet-4-6", api: "anthropic-messages" },
  });

  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Should inject native web_search on claude-code restore even with model_select suppressed",
  );
});

// ─── #4478 regression: Anthropic-fronting transports inject native search ───

test("#4478 claude-code OAuth provider injects native web_search", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "claude-code", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  // Must NOT emit the spammy Brave warning
  const warning = pi.notifications.find((n) => n.level === "warning");
  assert.equal(warning, undefined, "Should not emit Brave warning for claude-code provider");

  // Must disable custom search tools
  assert.ok(!pi.getActiveTools().includes("search-the-web"), "Brave tools disabled on claude-code");

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "claude-code", id: "claude-sonnet-4-6", api: "anthropic-messages" },
  });
  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Should inject native web_search for claude-code",
  );
});

test("#4478 anthropic-vertex provider injects native web_search", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic-vertex", api: "anthropic-vertex", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6",
    tools: [{ name: "bash", type: "custom" }],
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "anthropic-vertex", id: "claude-sonnet-4-6", api: "anthropic-vertex" },
  });
  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Should inject native web_search for anthropic-vertex",
  );
});

test("#4478 vercel-ai-gateway with anthropic-messages api injects native web_search", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "vercel-ai-gateway", api: "anthropic-messages", name: "anthropic/claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "anthropic/claude-sonnet-4-6",
    tools: [{ name: "bash", type: "custom" }],
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "vercel-ai-gateway", id: "anthropic/claude-sonnet-4-6", api: "anthropic-messages" },
  });
  const tools = ((result as any)?.tools ?? payload.tools) as any[];
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Vercel-gateway Anthropic route should inject native web_search (same wire protocol)",
  );
});

test("#4478 amazon-bedrock provider does NOT inject (different tool schema)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "amazon-bedrock", api: "bedrock-converse-stream", name: "claude-sonnet-4-6" },
    previousModel: undefined,
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "anthropic.claude-sonnet-4-6",
    tools: [{ name: "bash", type: "custom" }],
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "amazon-bedrock", id: "claude-sonnet-4-6", api: "bedrock-converse-stream" },
  });

  assert.equal(result, undefined, "Should not modify payload for Bedrock (different tool schema)");
  const tools = payload.tools as any[];
  assert.ok(
    !tools.some((t) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be injected into Bedrock requests",
  );
});
