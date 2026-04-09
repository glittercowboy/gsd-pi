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
import { registerSearchTool, resetSearchLoopGuardState } from "../resources/extensions/search-the-web/tool-search.ts";
import searchExtension from "../resources/extensions/search-the-web/index.ts";

const ORIGINAL_ENV = {
  BRAVE_API_KEY: process.env.BRAVE_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
};

function restoreSearchEnv() {
  if (ORIGINAL_ENV.BRAVE_API_KEY === undefined) delete process.env.BRAVE_API_KEY;
  else process.env.BRAVE_API_KEY = ORIGINAL_ENV.BRAVE_API_KEY;

  if (ORIGINAL_ENV.TAVILY_API_KEY === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = ORIGINAL_ENV.TAVILY_API_KEY;

  if (ORIGINAL_ENV.OLLAMA_API_KEY === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = ORIGINAL_ENV.OLLAMA_API_KEY;
}

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

  let activeTools: string[] = [];

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
    getActiveTools() { return activeTools; },
    setActiveTools(tools: string[]) { activeTools = tools; },
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

test("search loop guard fires after MAX_CONSECUTIVE_DUPES duplicates", async (t) => {
  process.env.BRAVE_API_KEY = "test-key-loop-guard";
  delete process.env.TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  const restoreFetch = mockFetch(makeBraveResponse());

  t.after(() => {
    restoreFetch();
    restoreSearchEnv();
  });

  const pi = createMockPI();
  registerSearchTool(pi as any);
  const tool = pi.getRegisteredTool();
  assert.ok(tool, "search tool should be registered");

  const execute = tool.execute.bind(tool);

  // Call 1: first call should succeed (MAX_CONSECUTIVE_DUPES = 1)
  const result1 = await callSearch(execute, "loop test query", "call-1");
  assert.notEqual(result1.isError, true, "call 1 should not trigger loop guard");

  // Call 2: identical query — guard fires immediately (threshold = 1)
  const result2 = await callSearch(execute, "loop test query", "call-2");
  assert.equal(result2.isError, true, "call 2 should trigger the loop guard");
  assert.equal(result2.details?.errorKind, "search_loop");
  assert.ok(
    result2.content[0].text.includes("Search loop detected"),
    "error message should mention search loop"
  );
});

test("search loop guard resets at session_start boundary", async (t) => {
  process.env.BRAVE_API_KEY = "test-key-loop-guard-session";
  delete process.env.TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  const restoreFetch = mockFetch(makeBraveResponse());
  const query = "session boundary query";

  t.after(() => {
    restoreFetch();
    restoreSearchEnv();
  });

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

  // Trigger guard in session 1 (call 1 succeeds, call 2 fires guard)
  await callSearch(execute, query, "s1-call-1");
  const guardResult = await callSearch(execute, query, "s1-call-2");
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
});

test("search loop guard stays armed after firing — subsequent duplicates immediately re-trigger (#1671)", async (t) => {
  process.env.BRAVE_API_KEY = "test-key-loop-guard-2";
  delete process.env.TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  const restoreFetch = mockFetch(makeBraveResponse());

  // Use a unique query so module-level state from previous test doesn't interfere
  const query = "persistent loop query";

  t.after(() => {
    restoreFetch();
    restoreSearchEnv();
  });

  const pi = createMockPI();
  registerSearchTool(pi as any);
  const tool = pi.getRegisteredTool();
  const execute = tool.execute.bind(tool);

  // Call 1 succeeds, call 2 fires guard (MAX_CONSECUTIVE_DUPES = 1)
  await callSearch(execute, query, "call-1");
  const guardFirst = await callSearch(execute, query, "call-2");
  assert.equal(guardFirst.isError, true, "call 2 should trigger the loop guard");

  // Key regression test: call 3 (and beyond) must ALSO trigger the guard.
  // The original bug reset state on trigger, so call 3 was treated as a fresh
  // first search and the loop restarted.
  const guardSecond = await callSearch(execute, query, "call-3");
  assert.equal(
    guardSecond.isError, true,
    "call 3 should STILL trigger the loop guard (guard must stay armed after firing)"
  );
  assert.equal(guardSecond.details?.errorKind, "search_loop");

  // Call 4 as well — guard should keep firing
  const guardThird = await callSearch(execute, query, "call-4");
  assert.equal(
    guardThird.isError, true,
    "call 4 should STILL trigger the loop guard"
  );
});

test("search loop guard resets cleanly when a different query is issued", async (t) => {
  process.env.BRAVE_API_KEY = "test-key-loop-guard-3";
  delete process.env.TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  const restoreFetch = mockFetch(makeBraveResponse());

  const queryA = "query alpha reset test";
  const queryB = "query beta reset test";

  t.after(() => {
    restoreFetch();
    restoreSearchEnv();
  });

  const pi = createMockPI();
  registerSearchTool(pi as any);
  const tool = pi.getRegisteredTool();
  const execute = tool.execute.bind(tool);

  // Trigger guard for queryA (call 1 succeeds, call 2 fires guard)
  await callSearch(execute, queryA, "call-a-1");
  await callSearch(execute, queryA, "call-a-2");

  // Issue a different query — should succeed (resets the duplicate counter)
  const resultB = await callSearch(execute, queryB, "call-b-1");
  assert.notEqual(
    resultB.isError, true,
    "a different query after guard should not be treated as a loop"
  );
});

test("session search budget blocks after MAX_SEARCHES_PER_SESSION varied queries", async (t) => {
  process.env.BRAVE_API_KEY = "test-key-budget";
  delete process.env.TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  const restoreFetch = mockFetch(makeBraveResponse());

  t.after(() => {
    restoreFetch();
    restoreSearchEnv();
  });

  // Reset guard state (including session budget) and register directly
  resetSearchLoopGuardState();
  const pi = createMockPI();
  registerSearchTool(pi as any);

  const tool = pi.getRegisteredTool();
  assert.ok(tool, "search tool should be registered");
  const execute = tool.execute.bind(tool);

  // Issue 15 unique queries — all should succeed (budget = 15)
  for (let i = 1; i <= 15; i++) {
    const result = await callSearch(execute, `unique budget query ${i}`, `budget-${i}`);
    assert.notEqual(result.isError, true, `query ${i} should succeed within budget`);
  }

  // Query 16: budget exhausted — should be blocked
  const blocked = await callSearch(execute, "one more query", "budget-16");
  assert.equal(blocked.isError, true, "query 16 should be blocked by budget");
  assert.equal(blocked.details?.errorKind, "budget_exhausted");
  assert.ok(
    blocked.content[0].text.includes("Search budget exhausted"),
    "error message should mention budget"
  );
});

test("session search budget resets via resetSearchLoopGuardState", async (t) => {
  process.env.BRAVE_API_KEY = "test-key-budget-reset";
  delete process.env.TAVILY_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  const restoreFetch = mockFetch(makeBraveResponse());

  t.after(() => {
    restoreFetch();
    restoreSearchEnv();
  });

  // Reset and register directly
  resetSearchLoopGuardState();
  const pi = createMockPI();
  registerSearchTool(pi as any);

  const tool = pi.getRegisteredTool();
  const execute = tool.execute.bind(tool);

  // Exhaust budget
  for (let i = 1; i <= 15; i++) {
    await callSearch(execute, `budget reset query ${i}`, `br-${i}`);
  }
  const exhausted = await callSearch(execute, "exhausted query", "br-exhausted");
  assert.equal(exhausted.isError, true, "budget should be exhausted");

  // Reset simulates new session
  resetSearchLoopGuardState();
  const fresh = await callSearch(execute, "fresh session query", "br-fresh");
  assert.notEqual(fresh.isError, true, "first query after reset should succeed");
});
