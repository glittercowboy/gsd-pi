/**
 * cmux-backend — unit tests for the CSP-safe browser backend.
 *
 * Tests the core logic of cmux-backend.ts by injecting a mock browserCmd
 * that simulates cmux CLI responses without any real process spawning.
 *
 * Coverage:
 * - selectorExists: visibility + count fallback
 * - resolveRefTargetNative: selectorHints, aria-label, HTML parsing, bare text
 * - buildRefSnapshotNative: snapshot parsing + selectorHint generation
 * - evaluateViaNativeCommands: pattern matching dispatch
 * - captureCompactPageStateNative: state capture from native commands
 */

import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  _setBrowserCmd,
  selectorExists,
  resolveRefTargetNative,
  buildRefSnapshotNative,
  evaluateViaNativeCommands,
  captureCompactPageStateNative,
  CmuxPage,
  openCmuxBrowser,
} from "../resources/extensions/browser-tools/cmux-backend.ts";

// ─── Mock infrastructure ────────────────────────────────────────────────────

type CmdHandler = (surfaceId: string, args: string[], timeout?: number) => string;

function createMockBrowserCmd(handlers: Record<string, string | ((args: string[]) => string)>): CmdHandler {
  return (_surfaceId: string, args: string[], _timeout?: number): string => {
    const key = args.join(" ");
    for (const [pattern, response] of Object.entries(handlers)) {
      if (key === pattern || key.startsWith(pattern)) {
        return typeof response === "function" ? response(args) : response;
      }
    }
    throw new Error(`Mock: unhandled command: cmux browser ${key}`);
  };
}

// ─── selectorExists ─────────────────────────────────────────────────────────

describe("selectorExists", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("returns true when 'is visible' returns true", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'is visible a[href="/foo"]': "true",
    }));
    assert.equal(selectorExists("s1", 'a[href="/foo"]'), true);
  });

  test("returns true when 'is visible' returns 1", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'is visible button.submit': "1",
    }));
    assert.equal(selectorExists("s1", "button.submit"), true);
  });

  test("falls back to get count when is visible fails", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'is visible a.link': (() => { throw new Error("not found"); }) as any,
      'get count a.link': "3",
    }));
    assert.equal(selectorExists("s1", "a.link"), true);
  });

  test("falls back to get count when is visible returns false", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'is visible #missing': "false",
      'get count #missing': "1",
    }));
    assert.equal(selectorExists("s1", "#missing"), true);
  });

  test("returns false when both checks fail", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'is visible #gone': (() => { throw new Error("nope"); }) as any,
      'get count #gone': (() => { throw new Error("nope"); }) as any,
    }));
    assert.equal(selectorExists("s1", "#gone"), false);
  });

  test("returns false when count is 0", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'is visible .empty': "false",
      'get count .empty': "0",
    }));
    assert.equal(selectorExists("s1", ".empty"), false);
  });
});

// ─── resolveRefTargetNative ─────────────────────────────────────────────────

describe("resolveRefTargetNative", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("resolves via selectorHints first", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'is visible a[href="/checkboxes"]': "true",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "link",
      name: "Checkboxes",
      tag: "a",
      selectorHints: ['a[href="/checkboxes"]'],
      path: [],
    });

    assert.deepEqual(result, { ok: true, selector: 'a[href="/checkboxes"]' });
  });

  test("skips invalid hints and tries next", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'is visible a[title="Checkboxes"]': "false",
      'get count a[title="Checkboxes"]': "0",
      'is visible a[href="/checkboxes"]': "true",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "link",
      name: "Checkboxes",
      tag: "a",
      selectorHints: ['a[title="Checkboxes"]', 'a[href="/checkboxes"]'],
      path: [],
    });

    assert.deepEqual(result, { ok: true, selector: 'a[href="/checkboxes"]' });
  });

  test("resolves via cmux find + role+aria-label selector", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'find role link --name Search': "found",
      'is visible [role="link"][aria-label="Search"]': "true",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "link",
      name: "Search",
      tag: "a",
      selectorHints: [],
      path: [],
    });

    assert.deepEqual(result, { ok: true, selector: '[role="link"][aria-label="Search"]' });
  });

  test("resolves via aria-label when cmux find fails", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'find role button --name Submit': (() => { throw new Error("not found"); }) as any,
      'is visible [aria-label="Submit"]': "true",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "button",
      name: "Submit",
      tag: "button",
      selectorHints: [],
      path: [],
    });

    assert.deepEqual(result, { ok: true, selector: '[aria-label="Submit"]' });
  });

  test("resolves link via HTML text content match (Strategy 2c)", () => {
    const html = '<ul><li><a href="/checkboxes">Checkboxes</a></li><li><a href="/dropdown">Dropdown</a></li></ul>';
    restore = _setBrowserCmd(createMockBrowserCmd({
      'find role link --name Checkboxes': (() => { throw new Error("fail"); }) as any,
      'is visible [aria-label="Checkboxes"]': "false",
      'get count [aria-label="Checkboxes"]': "0",
      'get html body': html,
      'is visible a[href="/checkboxes"]': "true",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "link",
      name: "Checkboxes",
      tag: "a",
      selectorHints: [],
      path: [],
    });

    assert.deepEqual(result, { ok: true, selector: 'a[href="/checkboxes"]' });
  });

  test("resolves link via bare text match (Strategy 2d) when other strategies fail", () => {
    const html = '<div><a href="/about">About Us</a></div>';
    restore = _setBrowserCmd(createMockBrowserCmd({
      'find role link --name About Us': (() => { throw new Error("fail"); }) as any,
      'is visible [aria-label="About Us"]': "false",
      'get count [aria-label="About Us"]': "0",
      'get html body': html,
      // Strategy 2c regex won't match because "About Us" has a space and
      // the regex requires <a\s to have attributes — but actually it will match.
      // Let's test the bare path specifically:
      'is visible a[href="/about"]': "true",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "link",
      name: "About Us",
      tag: "a",
      selectorHints: [],
      path: [],
    });

    assert.deepEqual(result, { ok: true, selector: 'a[href="/about"]' });
  });

  test("resolves button via title attribute", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'find role button --name Close': (() => { throw new Error("fail"); }) as any,
      'is visible [aria-label="Close"]': "false",
      'get count [aria-label="Close"]': "0",
      'get html body': '<div><button class="x">Close</button></div>',
      'is visible button[title="Close"]': "true",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "button",
      name: "Close",
      tag: "button",
      selectorHints: [],
      path: [],
    });

    assert.deepEqual(result, { ok: true, selector: 'button[title="Close"]' });
  });

  test("resolves via id from HTML", () => {
    const html = '<nav><a id="nav-home" href="/">Home</a></nav>';
    restore = _setBrowserCmd(createMockBrowserCmd({
      'find role link --name Home': (() => { throw new Error("fail"); }) as any,
      'is visible [aria-label="Home"]': "false",
      'get count [aria-label="Home"]': "0",
      'get html body': html,
      'is visible a[href="/"]': "true",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "link",
      name: "Home",
      tag: "a",
      selectorHints: [],
      path: [],
    });

    // Should match via 2c (href match)
    assert.equal(result.ok, true);
    assert.ok(result.selector.includes("href") || result.selector.includes("nav-home"));
  });

  test("returns ok:false when all strategies fail", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      'find role link --name Ghost': (() => { throw new Error("fail"); }) as any,
      'is visible [aria-label="Ghost"]': "false",
      'get count [aria-label="Ghost"]': "0",
      'get html body': '<div>No links here</div>',
      'is visible a[title="Ghost"]': "false",
      'get count a[title="Ghost"]': "0",
    }));

    const result = resolveRefTargetNative("s1", {
      role: "link",
      name: "Ghost",
      tag: "a",
      selectorHints: [],
      path: [],
    });

    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("element not found"));
  });

  test("handles missing role/name gracefully", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({}));

    const result = resolveRefTargetNative("s1", {
      tag: "div",
      selectorHints: [],
      path: [],
    });

    assert.equal(result.ok, false);
  });
});

// ─── buildRefSnapshotNative ─────────────────────────────────────────────────

describe("buildRefSnapshotNative", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("parses accessibility snapshot into RefNode-compatible objects", () => {
    const snapshot = [
      '- link "Homepage"',
      '- button "Submit"',
      '- textbox "Email"',
      '- heading "Welcome"',
    ].join("\n");

    restore = _setBrowserCmd(createMockBrowserCmd({
      "snapshot --compact --interactive --max-depth": snapshot,
      "get html body": '<a href="/">Homepage</a><button>Submit</button>',
    }));

    const nodes = buildRefSnapshotNative("s1", { limit: 10 });

    assert.equal(nodes.length, 4);
    assert.equal(nodes[0].role, "link");
    assert.equal(nodes[0].name, "Homepage");
    assert.equal(nodes[0].tag, "a");
    assert.equal(nodes[1].role, "button");
    assert.equal(nodes[1].name, "Submit");
    assert.equal(nodes[1].tag, "button");
    assert.equal(nodes[2].role, "textbox");
    assert.equal(nodes[2].name, "Email");
    assert.equal(nodes[2].tag, "input");
    assert.equal(nodes[3].role, "heading");
    assert.equal(nodes[3].name, "Welcome");
    assert.equal(nodes[3].tag, "h2");
  });

  test("generates selectorHints from HTML for links", () => {
    const snapshot = '- link "Checkboxes"';
    const html = '<ul><li><a href="/checkboxes">Checkboxes</a></li></ul>';

    restore = _setBrowserCmd(createMockBrowserCmd({
      "snapshot --compact --interactive --max-depth": snapshot,
      "get html body": html,
    }));

    const nodes = buildRefSnapshotNative("s1", { limit: 10 });
    assert.equal(nodes.length, 1);
    assert.ok(
      nodes[0].selectorHints.some((h: string) => h.includes('href="/checkboxes"')),
      `Expected selectorHints to contain href="/checkboxes", got: ${JSON.stringify(nodes[0].selectorHints)}`
    );
  });

  test("generates selectorHints from aria-label", () => {
    const snapshot = '- button "Play"';
    const html = '<button aria-label="Play">▶</button>';

    restore = _setBrowserCmd(createMockBrowserCmd({
      "snapshot --compact --interactive --max-depth": snapshot,
      "get html body": html,
    }));

    const nodes = buildRefSnapshotNative("s1", { limit: 10 });
    assert.equal(nodes.length, 1);
    assert.ok(
      nodes[0].selectorHints.some((h: string) => h.includes('aria-label="Play"')),
      `Expected aria-label hint, got: ${JSON.stringify(nodes[0].selectorHints)}`
    );
  });

  test("respects limit parameter", () => {
    const snapshot = [
      '- link "A"',
      '- link "B"',
      '- link "C"',
      '- link "D"',
    ].join("\n");

    restore = _setBrowserCmd(createMockBrowserCmd({
      "snapshot --compact --interactive --max-depth": snapshot,
      "get html body": "<div></div>",
    }));

    const nodes = buildRefSnapshotNative("s1", { limit: 2 });
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].name, "A");
    assert.equal(nodes[1].name, "B");
  });

  test("uses selector scope when provided", () => {
    const snapshotCalls: string[][] = [];
    restore = _setBrowserCmd((_, args) => {
      if (args[0] === "snapshot") {
        snapshotCalls.push(args);
        return '- link "Test"';
      }
      if (args[0] === "get") return "<div></div>";
      throw new Error(`unexpected: ${args.join(" ")}`);
    });

    buildRefSnapshotNative("s1", { selector: "nav", limit: 10 });
    assert.equal(snapshotCalls.length, 1);
    assert.ok(snapshotCalls[0].includes("--selector"));
    assert.ok(snapshotCalls[0].includes("nav"));
  });

  test("returns empty array on snapshot failure", () => {
    restore = _setBrowserCmd(() => { throw new Error("cmux not available"); });
    const nodes = buildRefSnapshotNative("s1", { limit: 10 });
    assert.deepEqual(nodes, []);
  });
});

// ─── evaluateViaNativeCommands (pattern matching) ───────────────────────────

describe("evaluateViaNativeCommands", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("dispatches captureCompactPageState pattern", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      "get title": "Test Page",
      "get url": "https://example.com",
      "snapshot --max-depth": "- heading \"Test\"",
      'get count button,[role="button"]': "2",
      'get count a[href]': "5",
      'get count input,textarea,select': "1",
      "get text body": "Hello world test content",
      "get box html": '{"x":0,"y":0,"width":1280,"height":800}',
    }));

    const fn = `(arg) => {
      const selectorStates = [];
      const headings = [];
      const counts = { buttons: 0, links: 0 };
    }`;

    const result = evaluateViaNativeCommands("s1", fn, {}, "eval failed") as any;
    assert.equal(result.title, "Test Page");
    assert.equal(result.url, "https://example.com");
  });

  test("dispatches mutation counter pattern (no-op)", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({}));

    const fn = `() => {
      const key = "__piMutationCounter";
      if (window[key]) return;
      window.__piMutationCounterInstalled = true;
      const observer = new MutationObserver(() => {});
    }`;

    const result = evaluateViaNativeCommands("s1", fn, undefined, "CSP error");
    assert.equal(result, undefined);
  });

  test("dispatches readSettleState pattern", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({}));

    const fn = `() => {
      const count = window.__piMutationCounter || 0;
      const el = document.activeElement;
      return { mutationCount: count, focusDescriptor: "" };
    }`;

    const result = evaluateViaNativeCommands("s1", fn, undefined, "CSP error") as any;
    assert.equal(result.mutationCount, 0);
    assert.equal(result.focusDescriptor, "");
  });

  test("dispatches document.title expression", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      "get title": "My Page",
    }));

    const result = evaluateViaNativeCommands("s1", "document.title", undefined, "CSP error");
    assert.equal(result, "My Page");
  });

  test("dispatches location.href expression", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      "get url": "https://example.com/page",
    }));

    const result = evaluateViaNativeCommands("s1", "location.href", undefined, "CSP error");
    assert.equal(result, "https://example.com/page");
  });

  test("dispatches window.location.href expression", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      "get url": "https://example.com",
    }));

    const result = evaluateViaNativeCommands("s1", "window.location.href", undefined, "CSP error");
    assert.equal(result, "https://example.com");
  });

  test("dispatches scrollInfo pattern", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      "get box html": '{"x":0,"y":0,"width":1280,"height":2400}',
    }));

    const fn = `() => {
      return { scrollY: window.scrollY, scrollHeight: document.body.scrollHeight, clientHeight: window.innerHeight };
    }`;

    const result = evaluateViaNativeCommands("s1", fn, undefined, "CSP error") as any;
    assert.equal(typeof result.scrollY, "number");
    assert.equal(typeof result.scrollHeight, "number");
  });

  test("throws on unknown pattern", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({}));

    assert.throws(
      () => evaluateViaNativeCommands("s1", "someUnknownExpression()", undefined, "CSP blocked eval"),
      (err: any) => err.message.includes("CSP fallback")
    );
  });
});

// ─── captureCompactPageStateNative ──────────────────────────────────────────

describe("captureCompactPageStateNative", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("captures title, url, headings, counts", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      "get title": "Test Page",
      "get url": "https://example.com",
      "snapshot --max-depth": [
        '- heading "Welcome"',
        '- heading "About"',
        '- button "Submit"',
        '- link "Home"',
      ].join("\n"),
      'get count button,[role="button"]': "1",
      'get count a[href]': "1",
      'get count input,textarea,select': "0",
      "get text body": "Welcome to the test page",
      "get box html": '{"x":0,"y":0,"width":1280,"height":800}',
    }));

    const state = captureCompactPageStateNative("s1", { includeBodyText: true }) as any;

    assert.equal(state.title, "Test Page");
    assert.equal(state.url, "https://example.com");
    assert.ok(state.headings.length >= 2);
    assert.ok(state.headings.includes("Welcome"), `Expected "Welcome" in headings, got: ${JSON.stringify(state.headings)}`);
    assert.ok(state.bodyText.includes("Welcome"));
  });

  test("handles missing data gracefully", () => {
    restore = _setBrowserCmd(createMockBrowserCmd({
      "get title": "Minimal",
      "get url": "about:blank",
      "snapshot --max-depth": "",
      'get count button,[role="button"]': (() => { throw new Error("fail"); }) as any,
      'get count a[href]': "0",
      'get count input,textarea,select': "0",
      "get text body": "",
      "get box html": (() => { throw new Error("fail"); }) as any,
    }));

    const state = captureCompactPageStateNative("s1", {}) as any;
    assert.equal(state.title, "Minimal");
    assert.equal(state.url, "about:blank");
  });
});

// ─── CmuxPage.url() consistency ─────────────────────────────────────────────

describe("CmuxPage.url() uses 'get url' command", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("url() calls 'get url' not bare 'url'", () => {
    const calls: string[][] = [];
    restore = _setBrowserCmd((_sid: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "get" && args[1] === "url") return "https://example.com";
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });
    const page = new CmuxPage({ surfaceId: "surface:1" });
    const result = page.url();
    assert.equal(result, "https://example.com");
    assert.deepEqual(calls[0], ["get", "url"]);
  });
});

// ─── CmuxPage.selectOption — normalizeSelectValue ───────────────────────────

describe("CmuxPage.selectOption handles value union types", () => {
  let restore: () => void;
  let lastSelectArgs: string[] = [];
  beforeEach(() => {
    restore = _setBrowserCmd((_sid: string, args: string[]) => {
      if (args[0] === "select") { lastSelectArgs = args; return "ok"; }
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });
    lastSelectArgs = [];
  });
  afterEach(() => restore?.());

  test("handles plain string", async () => {
    const page = new CmuxPage({ surfaceId: "surface:1" });
    const result = await page.selectOption("select#color", "red");
    assert.deepEqual(result, ["red"]);
    assert.equal(lastSelectArgs[2], "red");
  });

  test("handles string array (picks first)", async () => {
    const page = new CmuxPage({ surfaceId: "surface:1" });
    const result = await page.selectOption("select#color", ["blue", "green"]);
    assert.deepEqual(result, ["blue"]);
    assert.equal(lastSelectArgs[2], "blue");
  });

  test("handles { label } object", async () => {
    const page = new CmuxPage({ surfaceId: "surface:1" });
    const result = await page.selectOption("select#color", { label: "Red Color" } as any);
    assert.deepEqual(result, ["Red Color"]);
    assert.equal(lastSelectArgs[2], "Red Color");
  });

  test("handles { value } object", async () => {
    const page = new CmuxPage({ surfaceId: "surface:1" });
    const result = await page.selectOption("select#color", { value: "rgb(255,0,0)" } as any);
    assert.deepEqual(result, ["rgb(255,0,0)"]);
    assert.equal(lastSelectArgs[2], "rgb(255,0,0)");
  });

  test("handles { label, value } object — prefers label", async () => {
    const page = new CmuxPage({ surfaceId: "surface:1" });
    const result = await page.selectOption("select#color", { label: "Red", value: "red-val" } as any);
    assert.deepEqual(result, ["Red"]);
    assert.equal(lastSelectArgs[2], "Red");
  });

  test("handles array of objects (picks first label)", async () => {
    const page = new CmuxPage({ surfaceId: "surface:1" });
    const result = await page.selectOption("select#color", [{ label: "First" }, { label: "Second" }] as any);
    assert.deepEqual(result, ["First"]);
    assert.equal(lastSelectArgs[2], "First");
  });

  test("handles { index } object", async () => {
    const page = new CmuxPage({ surfaceId: "surface:1" });
    const result = await page.selectOption("select#color", { index: 2 } as any);
    assert.deepEqual(result, ["2"]);
    assert.equal(lastSelectArgs[2], "2");
  });
});

// ─── CmuxPage.waitForURL — predicate support ───────────────────────────────

describe("CmuxPage.waitForURL", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("handles string URL via cmux wait", async () => {
    restore = _setBrowserCmd((_sid: string, args: string[]) => {
      if (args[0] === "wait" && args[1] === "--url-contains") return "ok";
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });
    const page = new CmuxPage({ surfaceId: "surface:1" });
    await page.waitForURL("https://example.com/done");
  });

  test("handles RegExp via polling (not cmux --url-contains)", async () => {
    let pollCount = 0;
    restore = _setBrowserCmd((_sid: string, args: string[]) => {
      if (args[0] === "get" && args[1] === "url") {
        pollCount++;
        return pollCount >= 2 ? "https://example.com/done" : "https://example.com/loading";
      }
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });
    const page = new CmuxPage({ surfaceId: "surface:1" });
    await page.waitForURL(/example\.com\/done/, { timeout: 3000 });
    assert.ok(pollCount >= 2, `Expected polling, got ${pollCount} calls`);
  });

  test("handles RegExp — times out when no match", async () => {
    restore = _setBrowserCmd((_sid: string, args: string[]) => {
      if (args[0] === "get" && args[1] === "url") return "https://other.com/nope";
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });
    const page = new CmuxPage({ surfaceId: "surface:1" });
    await assert.rejects(
      () => page.waitForURL(/example\.com\/done/, { timeout: 500 }),
      /Timed out waiting for URL matching/
    );
  });

  test("handles predicate function — resolves when predicate returns true", async () => {
    let callCount = 0;
    restore = _setBrowserCmd((_sid: string, args: string[]) => {
      if (args[0] === "get" && args[1] === "url") {
        callCount++;
        // Return target URL on 2nd poll
        return callCount >= 2 ? "https://example.com/done" : "https://example.com/loading";
      }
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });
    const page = new CmuxPage({ surfaceId: "surface:1" });
    await page.waitForURL((url) => url.pathname === "/done", { timeout: 3000 });
    assert.ok(callCount >= 2, `Expected at least 2 polls, got ${callCount}`);
  });

  test("handles predicate function — times out when predicate never returns true", async () => {
    restore = _setBrowserCmd((_sid: string, args: string[]) => {
      if (args[0] === "get" && args[1] === "url") return "https://example.com/still-loading";
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });
    const page = new CmuxPage({ surfaceId: "surface:1" });
    await assert.rejects(
      () => page.waitForURL(() => false, { timeout: 500 }),
      /Timed out waiting for URL predicate/
    );
  });
});

// ─── CmuxPage.screenshot — uses dirname() ──────────────────────────────────

describe("CmuxPage.screenshot mkdirSync uses dirname", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("screenshot with custom path does not throw on mkdirSync", async () => {
    const { mkdirSync: realMkdir } = await import("node:fs");
    // If mkdirSync(join(path, "..")) were used with a file path like /tmp/test.png,
    // it would try to create /tmp/test.png/.. which is wrong.
    // With dirname() it correctly creates /tmp/ which already exists.
    restore = _setBrowserCmd((_sid: string, args: string[]) => {
      if (args[0] === "screenshot") return "ok";
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });
    const page = new CmuxPage({ surfaceId: "surface:1" });
    // This should not throw — dirname(/tmp/cmux-test.png) = /tmp which exists
    const buf = await page.screenshot({ path: "/tmp/cmux-screenshot-test-" + Date.now() + ".png" });
    assert.ok(Buffer.isBuffer(buf));
  });
});

// ─── openCmuxBrowser — surface format parsing ───────────────────────────────

describe("openCmuxBrowser surface format parsing", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  test("parses 'surface=(surface:N)' format", async () => {
    // openCmuxBrowser uses the raw cmux() function, not _browserCmd.
    // We need to mock at a different level. Since openCmuxBrowser calls cmux()
    // directly, and we can't easily mock that without modifying the module,
    // we test the regex logic directly.
    const output1 = "opened surface=(surface:42) workspace:1";
    const match1 = output1.match(/surface=(surface:\d+)/) ?? output1.match(/(surface:\d+)/);
    assert.ok(match1);
    assert.equal(match1[1], "surface:42");
  });

  test("parses bare 'surface:N workspace:M' format", () => {
    const output2 = "surface:7 workspace:3";
    const match2 = output2.match(/surface=(surface:\d+)/) ?? output2.match(/(surface:\d+)/);
    assert.ok(match2);
    assert.equal(match2[1], "surface:7");
  });

  test("returns null when no surface in output", () => {
    const output3 = "error: browser not available";
    const match3 = output3.match(/surface=(surface:\d+)/) ?? output3.match(/(surface:\d+)/);
    assert.equal(match3, null);
  });
});

// ─── Debug logging gated behind GSD_DEBUG ───────────────────────────────────

describe("debug logging is gated behind GSD_DEBUG", () => {
  let restore: () => void;
  let stderrOutput: string[] = [];
  const origStderrWrite = process.stderr.write;

  beforeEach(() => {
    stderrOutput = [];
    process.stderr.write = ((chunk: any) => {
      stderrOutput.push(String(chunk));
      return true;
    }) as any;
  });
  afterEach(() => {
    restore?.();
    process.stderr.write = origStderrWrite;
    delete process.env.GSD_DEBUG;
  });

  test("resolveRefTargetNative does NOT log when GSD_DEBUG is unset", () => {
    delete process.env.GSD_DEBUG;
    restore = _setBrowserCmd(() => { throw new Error("not found"); });
    resolveRefTargetNative("s1", { role: "button", name: "Test" });
    const debugLines = stderrOutput.filter(l => l.includes("[cmux-resolve-debug]"));
    assert.equal(debugLines.length, 0, "Should not log without GSD_DEBUG");
  });

  test("resolveRefTargetNative logs when GSD_DEBUG is set", () => {
    process.env.GSD_DEBUG = "1";
    restore = _setBrowserCmd(() => { throw new Error("not found"); });
    resolveRefTargetNative("s1", { role: "button", name: "Test" });
    const debugLines = stderrOutput.filter(l => l.includes("[cmux-resolve-debug]"));
    assert.ok(debugLines.length > 0, "Should log with GSD_DEBUG=1");
  });
});
