import test, { describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { TOOL_KEYS, loadToolApiKeys } from "../commands-config.ts";

function makeAuthDir(data: Record<string, unknown>): string {
  const home = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(home, ".gsd", "agent"), { recursive: true });
  writeFileSync(join(home, ".gsd", "agent", "auth.json"), JSON.stringify(data), "utf-8");
  return home;
}

// ── TOOL_KEYS ─────────────────────────────────────────────────────────────────

describe("TOOL_KEYS", () => {
  test("contains all five expected tool entries", () => {
    const ids = TOOL_KEYS.map((t) => t.id);
    assert.equal(ids.length, 5);
    assert.ok(ids.includes("tavily"));
    assert.ok(ids.includes("brave"));
    assert.ok(ids.includes("context7"));
    assert.ok(ids.includes("jina"));
    assert.ok(ids.includes("groq"));
  });

  test("each entry has id, env, label, and hint", () => {
    for (const t of TOOL_KEYS) {
      assert.ok(t.id, `missing id`);
      assert.ok(t.env, `${t.id} missing env`);
      assert.ok(t.label, `${t.id} missing label`);
      assert.ok(t.hint, `${t.id} missing hint`);
    }
  });
});

// ── loadToolApiKeys ────────────────────────────────────────────────────────────

describe("loadToolApiKeys", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  const savedEnvVars: Record<string, string | undefined> = {};

  before(() => {
    savedHome = process.env.HOME;
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  beforeEach(() => {
    for (const t of TOOL_KEYS) {
      savedEnvVars[t.env] = process.env[t.env];
      delete process.env[t.env];
    }
  });

  afterEach(() => {
    for (const t of TOOL_KEYS) {
      const saved = savedEnvVars[t.env];
      if (saved === undefined) delete process.env[t.env];
      else process.env[t.env] = saved;
    }
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  test("sets env var from valid api_key in auth.json", () => {
    tmpHome = makeAuthDir({ tavily: { type: "api_key", key: "tvly-test-123" } });
    process.env.HOME = tmpHome;
    loadToolApiKeys();
    assert.equal(process.env.TAVILY_API_KEY, "tvly-test-123");
  });

  test("does not set env var for empty api_key entry", () => {
    tmpHome = makeAuthDir({ brave: { type: "api_key", key: "" } });
    process.env.HOME = tmpHome;
    loadToolApiKeys();
    assert.equal(process.env.BRAVE_API_KEY, undefined);
  });

  test("does not overwrite already-set env var", () => {
    tmpHome = makeAuthDir({ context7: { type: "api_key", key: "new-key" } });
    process.env.HOME = tmpHome;
    process.env.CONTEXT7_API_KEY = "existing-key";
    loadToolApiKeys();
    assert.equal(process.env.CONTEXT7_API_KEY, "existing-key");
  });

  test("finds valid key when empty-key entry exists at index 0", () => {
    // auth.get(tool.id) returns the first credential (empty), but
    // getCredentialsForProvider + find skips it and returns the real key.
    tmpHome = makeAuthDir({
      groq: [{ type: "api_key", key: "" }, { type: "api_key", key: "gsk-real-key" }],
    });
    process.env.HOME = tmpHome;
    loadToolApiKeys();
    assert.equal(process.env.GROQ_API_KEY, "gsk-real-key");
  });

  test("does nothing when auth.json does not exist", () => {
    tmpHome = join(tmpdir(), `gsd-test-${randomUUID()}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    loadToolApiKeys();
    for (const t of TOOL_KEYS) {
      assert.equal(process.env[t.env], undefined, `${t.env} should not be set`);
    }
  });
});
