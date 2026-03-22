import test from "node:test";
import assert from "node:assert/strict";
import {
  registerNativeSearchHooks,
  type NativeSearchPI,
} from "../resources/extensions/search-the-web/native-search.ts";

/**
 * Regression tests for #2027: BRAVE_API_KEY & GEMINI warnings spam
 * despite ONLY Tavily configured.
 *
 * When the user has Tavily (or another alternative) configured as their
 * search provider, they should NOT see warnings about missing BRAVE_API_KEY
 * or GEMINI_API_KEY on model switch or session start.
 */

// ─── Mock ExtensionAPI (copied from native-search.test.ts) ──────────────────

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

// ─── Bug #2027: Brave warning suppressed when Tavily configured ─────────────

test("#2027: no BRAVE_API_KEY warning on non-Anthropic model when TAVILY_API_KEY is set", async () => {
  const origBrave = process.env.BRAVE_API_KEY;
  const origTavily = process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_API_KEY;
  process.env.TAVILY_API_KEY = "tvly-test-key";

  try {
    const pi = createMockPI();
    registerNativeSearchHooks(pi);

    await pi.fire("model_select", {
      type: "model_select",
      model: { provider: "openai", name: "gpt-4o" },
      previousModel: undefined,
      source: "set",
    });

    const warning = pi.notifications.find(
      (n) => n.level === "warning" && n.message.includes("BRAVE_API_KEY")
    );
    assert.equal(
      warning, undefined,
      "Should NOT warn about BRAVE_API_KEY when TAVILY_API_KEY is set"
    );
  } finally {
    if (origBrave) process.env.BRAVE_API_KEY = origBrave;
    else delete process.env.BRAVE_API_KEY;
    if (origTavily) process.env.TAVILY_API_KEY = origTavily;
    else delete process.env.TAVILY_API_KEY;
  }
});

test("#2027: no BRAVE_API_KEY warning on model switch (Ctrl+P) when TAVILY_API_KEY is set", async () => {
  const origBrave = process.env.BRAVE_API_KEY;
  const origTavily = process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_API_KEY;
  process.env.TAVILY_API_KEY = "tvly-test-key";

  try {
    const pi = createMockPI();
    registerNativeSearchHooks(pi);

    // Start on Anthropic
    await pi.fire("model_select", {
      type: "model_select",
      model: { provider: "anthropic", name: "claude-sonnet-4-6" },
      previousModel: undefined,
      source: "set",
    });

    pi.notifications.length = 0; // clear

    // Switch to non-Anthropic (Ctrl+P model switch)
    await pi.fire("model_select", {
      type: "model_select",
      model: { provider: "openai", name: "gpt-4o" },
      previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
      source: "set",
    });

    const warning = pi.notifications.find(
      (n) => n.level === "warning" && n.message.includes("BRAVE_API_KEY")
    );
    assert.equal(
      warning, undefined,
      "Should NOT warn about BRAVE_API_KEY when switching models with Tavily configured"
    );
  } finally {
    if (origBrave) process.env.BRAVE_API_KEY = origBrave;
    else delete process.env.BRAVE_API_KEY;
    if (origTavily) process.env.TAVILY_API_KEY = origTavily;
    else delete process.env.TAVILY_API_KEY;
  }
});

test("#2027: no BRAVE_API_KEY warning when GEMINI_API_KEY is set", async () => {
  const origBrave = process.env.BRAVE_API_KEY;
  const origGemini = process.env.GEMINI_API_KEY;
  delete process.env.BRAVE_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";

  try {
    const pi = createMockPI();
    registerNativeSearchHooks(pi);

    await pi.fire("model_select", {
      type: "model_select",
      model: { provider: "openai", name: "gpt-4o" },
      previousModel: undefined,
      source: "set",
    });

    const warning = pi.notifications.find(
      (n) => n.level === "warning" && n.message.includes("BRAVE_API_KEY")
    );
    assert.equal(
      warning, undefined,
      "Should NOT warn about BRAVE_API_KEY when GEMINI_API_KEY is set"
    );
  } finally {
    if (origBrave) process.env.BRAVE_API_KEY = origBrave;
    else delete process.env.BRAVE_API_KEY;
    if (origGemini) process.env.GEMINI_API_KEY = origGemini;
    else delete process.env.GEMINI_API_KEY;
  }
});

test("#2027: BRAVE_API_KEY warning still shown when NO search provider is configured", async () => {
  const origBrave = process.env.BRAVE_API_KEY;
  const origTavily = process.env.TAVILY_API_KEY;
  const origGemini = process.env.GEMINI_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    const pi = createMockPI();
    registerNativeSearchHooks(pi);

    await pi.fire("model_select", {
      type: "model_select",
      model: { provider: "openai", name: "gpt-4o" },
      previousModel: undefined,
      source: "set",
    });

    const warning = pi.notifications.find((n) => n.level === "warning");
    assert.ok(
      warning,
      "Should still warn when no search provider is configured at all"
    );
  } finally {
    if (origBrave) process.env.BRAVE_API_KEY = origBrave;
    else delete process.env.BRAVE_API_KEY;
    if (origTavily) process.env.TAVILY_API_KEY = origTavily;
    else delete process.env.TAVILY_API_KEY;
    if (origGemini) process.env.GEMINI_API_KEY = origGemini;
    else delete process.env.GEMINI_API_KEY;
  }
});
