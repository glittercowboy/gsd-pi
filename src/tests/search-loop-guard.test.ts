/**
 * Regression tests for the consecutive duplicate search loop guard.
 *
 * Covers:
 * - Guard fires after MAX_CONSECUTIVE_DUPES identical calls (#949)
 * - Guard stays armed after firing — subsequent duplicates immediately
 *   re-trigger the error (#1671: the original fix reset state on trigger,
 *   allowing the loop to restart)
 * - Guard resets cleanly when a different query is issued
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerSearchTool } from "../resources/extensions/search-the-web/tool-search.ts";
import searchExtension from "../resources/extensions/search-the-web/index.ts";

// =============================================================================
// Mock helpers
// =============================================================================

/** Minimal Brave search API response fixture. */
function makeBraveResponse() {
  return {
    query: { original: "test query", more_results_available: false },
    web: {
      results: [
        {
          title: "Result One",
          url: "https://example.com/one",
          description: "First result description.",
        },
      ],
    },
  };
}

/** Install a mock global fetch that always returns the given body. */
function mockFetch(body: unknown, status = 200) {
  const original = global.fetch;
  (global as any).fetch = async () => ({
    ok: status === 200,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  return () => {
    global.fetch = original;
  };
}

/** Create a minimal mock PI that captures the registered search tool. */
function createMockPI() {
  const handlers: Array<{ event: string; handler: (...args: any[]) => unknown }> = [];
  const toolsByName = new Map<string, any>();
  let registeredTool: any = null;

  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.push({ event, handler });
    },
    registerCommand(_name: string, _command: unknown) {},
    registerTool(tool: any) {
      if (typeof tool?.name === "string") {
        toolsByName.set(tool.name, tool);
      }
      registeredTool = tool;
    },
    async fire(event: string, eventData: unknown, ctx: unknown) {
      for (const h of handlers) {
        if (h.event === event) await h.handler(eventData, ctx);
      }
    },
    getRegisteredTool(name = "search-the-web") {
      return toolsByName.get(name) ?? registeredTool;
    },
    writeTempFile: async (_content: string, _opts?: unknown) => "/tmp/search-out.txt",
  };

  return pi;
}

/** Call the search tool execute function with the given query. */
async function callSearch(
  execute: (...args: any[]) => Promise<any>,
  query: string,
  callId = "call-1"
) {
  const mockCtx = { ui: { notify() {} } };
  return execute(callId, { query }, new AbortController().signal, () => {}, mockCtx);
}

// =============================================================================
// Tests
// =============================================================================

/**
 * Each test file gets its own module registry, so the module-level loop guard
 * state (lastSearchKey, consecutiveDupeCount) starts fresh here.
 */

test("search loop guard fires after MAX_CONSECUTIVE_DUPES duplicates", async () => {
  process.env.BRAVE_API_KEY = "test-key-loop-guard";
  const restoreFetch = mockFetch(makeBraveResponse());

  try {
    const pi = createMockPI();
    registerSearchTool(pi as any);
    const tool = pi.getRegisteredTool();
    assert.ok(tool, "search tool should be registered");

    const execute = tool.execute.bind(tool);

    // Calls 1–3: below threshold, should return search results (not an error)
    for (let i = 1; i <= 3; i++) {
      const result = await callSearch(execute, "loop test query", `call-${i}`);
      assert.notEqual(result.isError, true, `call ${i} should not trigger loop guard`);
    }

    // Call 4: hits the threshold — guard fires
    const result4 = await callSearch(execute, "loop test query", "call-4");
    assert.equal(result4.isError, true, "call 4 should trigger the loop guard");
    assert.equal(result4.details?.errorKind, "search_loop");
    assert.ok(
      result4.content[0].text.includes("Search loop detected"),
      "error message should mention search loop"
    );
  } finally {
    restoreFetch();
    delete process.env.BRAVE_API_KEY;
  }
});

test("search loop guard resets at session_start boundary", async () => {
  process.env.BRAVE_API_KEY = "test-key-loop-guard-session";
  const restoreFetch = mockFetch(makeBraveResponse());
  const query = "session boundary query";

  try {
    const pi = createMockPI();
    const mockCtx = {
      hasUI: false,
      ui: { notify() {} },
    };
    searchExtension(pi as any);
    await pi.fire("session_start", {}, mockCtx);

    const tool = pi.getRegisteredTool();
    assert.ok(tool, "search tool should be registered");
    const execute = tool.execute.bind(tool);

    // Trigger guard in session 1
    for (let i = 1; i <= 4; i++) {
      await callSearch(execute, query, `s1-call-${i}`);
    }
    const guardResult = await callSearch(execute, query, "s1-call-5");
    assert.equal(guardResult.isError, true, "session 1 should be guarded");
    assert.equal(guardResult.details?.errorKind, "search_loop");

    // New session should clear guard state
    await pi.fire("session_start", {}, mockCtx);
    const firstCallSession2 = await callSearch(execute, query, "s2-call-1");
    assert.notEqual(
      firstCallSession2.isError,
      true,
      "first identical query in a new session should not be blocked by prior session state",
    );
  } finally {
    restoreFetch();
    delete process.env.BRAVE_API_KEY;
  }
});

test("search loop guard stays armed after firing — subsequent duplicates immediately re-trigger (#1671)", async () => {
  process.env.BRAVE_API_KEY = "test-key-loop-guard-2";
  const restoreFetch = mockFetch(makeBraveResponse());

  // Use a unique query so module-level state from previous test doesn't interfere
  const query = "persistent loop query";

  try {
    const pi = createMockPI();
    registerSearchTool(pi as any);
    const tool = pi.getRegisteredTool();
    const execute = tool.execute.bind(tool);

    // Exhaust the initial window (calls 1–3 succeed, call 4 fires guard)
    for (let i = 1; i <= 3; i++) {
      await callSearch(execute, query, `call-${i}`);
    }
    const guardFirst = await callSearch(execute, query, "call-4");
    assert.equal(guardFirst.isError, true, "call 4 should trigger the loop guard");

    // Key regression test: call 5 (and beyond) must ALSO trigger the guard.
    // The original bug reset state on trigger, so call 5 was treated as a fresh
    // first search and the loop restarted.
    const guardSecond = await callSearch(execute, query, "call-5");
    assert.equal(
      guardSecond.isError, true,
      "call 5 should STILL trigger the loop guard (guard must stay armed after firing)"
    );
    assert.equal(guardSecond.details?.errorKind, "search_loop");

    // Call 6 as well — guard should keep firing
    const guardThird = await callSearch(execute, query, "call-6");
    assert.equal(
      guardThird.isError, true,
      "call 6 should STILL trigger the loop guard"
    );
  } finally {
    restoreFetch();
    delete process.env.BRAVE_API_KEY;
  }
});

test("search loop guard resets cleanly when a different query is issued", async () => {
  process.env.BRAVE_API_KEY = "test-key-loop-guard-3";
  const restoreFetch = mockFetch(makeBraveResponse());

  const queryA = "query alpha reset test";
  const queryB = "query beta reset test";

  try {
    const pi = createMockPI();
    registerSearchTool(pi as any);
    const tool = pi.getRegisteredTool();
    const execute = tool.execute.bind(tool);

    // Trigger guard for queryA
    for (let i = 1; i <= 4; i++) {
      await callSearch(execute, queryA, `call-a-${i}`);
    }

    // Issue a different query — should succeed (resets the duplicate counter)
    const resultB = await callSearch(execute, queryB, "call-b-1");
    assert.notEqual(
      resultB.isError, true,
      "a different query after guard should not be treated as a loop"
    );
  } finally {
    restoreFetch();
    delete process.env.BRAVE_API_KEY;
  }
});
