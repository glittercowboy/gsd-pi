/**
 * doctor-providers.test.ts — Tests for provider & integration health checks.
 *
 * Tests:
 *   - LLM provider key detection from env vars
 *   - LLM provider key detection from auth.json
 *   - Missing required provider → error status
 *   - Backed-off credentials → warning status
 *   - Remote questions channel check (configured vs missing token)
 *   - Optional provider unconfigured status
 *   - formatProviderReport output
 *   - summariseProviderIssues compaction
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runProviderChecks,
  formatProviderReport,
  summariseProviderIssues,
  type ProviderCheckResult,
} from "../doctor-providers.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function withCwd(nextCwd: string, fn: () => void): void {
  const saved = process.cwd();
  process.chdir(nextCwd);
  try {
    fn();
  } finally {
    process.chdir(saved);
  }
}

const PRESENT_TEST_VALUE = "configured";

// ─── formatProviderReport ─────────────────────────────────────────────────────

test("formatProviderReport returns fallback for empty results", () => {
  const out = formatProviderReport([]);
  assert.equal(out, "No provider checks run.");
});

test("formatProviderReport shows ok icon for ok status", () => {
  const results: ProviderCheckResult[] = [{
    name: "anthropic",
    label: "Anthropic (Claude)",
    category: "llm",
    status: "ok",
    message: "Anthropic (Claude) — key present (env)",
    required: true,
  }];
  const out = formatProviderReport(results);
  assert.ok(out.includes("✓"), "should include checkmark for ok");
  assert.ok(out.includes("Anthropic"), "should include provider name");
});

test("formatProviderReport shows error icon and detail for error status", () => {
  const results: ProviderCheckResult[] = [{
    name: "anthropic",
    label: "Anthropic (Claude)",
    category: "llm",
    status: "error",
    message: "Anthropic (Claude) — no API key found",
    detail: "Set ANTHROPIC_API_KEY or run /gsd keys",
    required: true,
  }];
  const out = formatProviderReport(results);
  assert.ok(out.includes("✗"), "should include cross for error");
  assert.ok(out.includes("ANTHROPIC_API_KEY"), "should include detail");
});

test("formatProviderReport shows warning icon for warning status", () => {
  const results: ProviderCheckResult[] = [{
    name: "slack_bot",
    label: "Slack Bot",
    category: "remote",
    status: "warning",
    message: "Slack Bot — channel configured but token not found",
    required: true,
  }];
  const out = formatProviderReport(results);
  assert.ok(out.includes("⚠"), "should include warning icon");
});

test("formatProviderReport groups by category", () => {
  const results: ProviderCheckResult[] = [
    { name: "anthropic", label: "Anthropic", category: "llm", status: "ok", message: "ok", required: true },
    { name: "brave", label: "Brave Search", category: "search", status: "unconfigured", message: "not configured", required: false },
  ];
  const out = formatProviderReport(results);
  assert.ok(out.includes("LLM Providers"), "should have LLM section");
  assert.ok(out.includes("Search"), "should have Search section");
});

test("formatProviderReport omits detail for ok status", () => {
  const results: ProviderCheckResult[] = [{
    name: "openai",
    label: "OpenAI",
    category: "llm",
    status: "ok",
    message: "OpenAI — key present (env)",
    detail: "should not appear",
    required: true,
  }];
  const out = formatProviderReport(results);
  assert.ok(!out.includes("should not appear"), "detail should not show for ok");
});

// ─── summariseProviderIssues ──────────────────────────────────────────────────

test("summariseProviderIssues returns null when no required issues", () => {
  const results: ProviderCheckResult[] = [
    { name: "anthropic", label: "Anthropic", category: "llm", status: "ok", message: "ok", required: true },
    { name: "brave", label: "Brave", category: "search", status: "unconfigured", message: "not configured", required: false },
  ];
  assert.equal(summariseProviderIssues(results), null);
});

test("summariseProviderIssues returns error summary for missing required key", () => {
  const results: ProviderCheckResult[] = [{
    name: "anthropic",
    label: "Anthropic (Claude)",
    category: "llm",
    status: "error",
    message: "no key",
    required: true,
  }];
  const summary = summariseProviderIssues(results);
  assert.ok(summary !== null, "should return a summary");
  assert.ok(summary!.includes("Anthropic"), "should name the provider");
  assert.ok(summary!.includes("✗"), "should use error icon");
});

test("summariseProviderIssues returns warning for backed-off required provider", () => {
  const results: ProviderCheckResult[] = [{
    name: "anthropic",
    label: "Anthropic (Claude)",
    category: "llm",
    status: "warning",
    message: "backed off",
    required: true,
  }];
  const summary = summariseProviderIssues(results);
  assert.ok(summary !== null, "should return summary");
  assert.ok(summary!.includes("⚠"), "should use warning icon");
});

test("summariseProviderIssues appends count when multiple issues", () => {
  const results: ProviderCheckResult[] = [
    { name: "anthropic", label: "Anthropic", category: "llm", status: "error", message: "err", required: true },
    { name: "openai",    label: "OpenAI",    category: "llm", status: "error", message: "err", required: true },
    { name: "google",    label: "Google",    category: "llm", status: "error", message: "err", required: true },
  ];
  const summary = summariseProviderIssues(results);
  assert.ok(summary!.includes("+2 more"), "should show overflow count");
});

test("summariseProviderIssues ignores unconfigured optional providers", () => {
  const results: ProviderCheckResult[] = [
    { name: "anthropic", label: "Anthropic", category: "llm",    status: "ok",           message: "ok", required: true },
    { name: "brave",     label: "Brave",     category: "search", status: "unconfigured", message: "nc", required: false },
    { name: "tavily",    label: "Tavily",    category: "search", status: "unconfigured", message: "nc", required: false },
  ];
  assert.equal(summariseProviderIssues(results), null, "optional missing providers should not raise issue");
});

// ─── runProviderChecks — env var detection ────────────────────────────────────

test("runProviderChecks detects Anthropic key from ANTHROPIC_API_KEY env var", () => {
  // Isolate from real HOME so loadEffectiveGSDPreferences returns null (default → anthropic)
  // and auth.json lookups hit an empty directory.
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-env-test-")));
  withEnv({ ANTHROPIC_API_KEY: "sk-ant-test-key", ANTHROPIC_OAUTH_TOKEN: undefined, HOME: tmpHome }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic!.status, "ok", "should be ok when env var set");
      assert.ok(anthropic!.message.includes("env"), "should report env source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

test("runProviderChecks returns error for Anthropic when no key present", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-test-")));
  withEnv({
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_OAUTH_TOKEN: undefined,
    // Clear cross-provider routing env vars (GitHub Copilot can serve Claude models)
    COPILOT_GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    HOME: tmpHome,
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(anthropic, "anthropic should be present (default required)");
      assert.equal(anthropic!.status, "error", "should be error when no key");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

test("runProviderChecks optional providers have required=false", () => {
  const results = runProviderChecks();
  const optional = results.filter(r => ["brave", "tavily", "jina", "context7"].includes(r.name));
  for (const r of optional) {
    assert.equal(r.required, false, `${r.name} should not be required`);
  }
});

test("runProviderChecks optional providers show unconfigured when no key", () => {
  withEnv(
    { BRAVE_API_KEY: undefined, TAVILY_API_KEY: undefined, JINA_API_KEY: undefined, CONTEXT7_API_KEY: undefined },
    () => {
      const origHome = process.env.HOME;
      process.env.HOME = mkdtempSync(join(tmpdir(), "gsd-providers-test-"));
      try {
        const results = runProviderChecks();
        const brave = results.find(r => r.name === "brave");
        assert.ok(brave, "brave should be present");
        assert.equal(brave!.status, "unconfigured", "should be unconfigured");
      } finally {
        rmSync(process.env.HOME!, { recursive: true, force: true });
        process.env.HOME = origHome;
      }
    }
  );
});

test("runProviderChecks optional providers show ok when key set", () => {
  withEnv({ BRAVE_API_KEY: "test-brave-key" }, () => {
    const results = runProviderChecks();
    const brave = results.find(r => r.name === "brave");
    assert.ok(brave, "brave should be present");
    assert.equal(brave!.status, "ok", "should be ok when env var set");
  });
});

// ─── runProviderChecks — auth.json detection ─────────────────────────────────

test("runProviderChecks detects key from auth.json", () => {
  withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
    const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-test-")));
    const agentDir = join(tmpHome, ".gsd", "agent");
    mkdirSync(agentDir, { recursive: true });

    // AuthStorage persists credentials with provider ID as the top-level key:
    // { "anthropic": { "type": "api_key", "key": "..." } }
    const authData = {
      anthropic: { type: "api_key", key: "sk-ant-from-auth-json" },
    };
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));

    withEnv({ HOME: tmpHome }, () => {
      const results = runProviderChecks();
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(anthropic, "anthropic should be present");
      assert.equal(anthropic!.status, "ok", "should be ok with auth.json key");
      assert.ok(anthropic!.message.includes("auth.json"), "should report auth.json source");
    });

    rmSync(tmpHome, { recursive: true, force: true });
  });
});

test("runProviderChecks ignores empty placeholder keys in auth.json", () => {
  withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, () => {
    const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-test-")));
    const agentDir = join(tmpHome, ".gsd", "agent");
    mkdirSync(agentDir, { recursive: true });

    // Empty key — what onboarding writes when user skips
    const authData = {
      anthropic: { type: "api_key", key: "" },
    };
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));

    withEnv({ HOME: tmpHome }, () => {
      const results = runProviderChecks();
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(anthropic, "anthropic should be present");
      assert.equal(anthropic!.status, "error", "empty placeholder key should count as not configured");
    });

    rmSync(tmpHome, { recursive: true, force: true });
  });
});

// ─── runProviderChecks — cross-provider routing ──────────────────────────────

test("runProviderChecks reports ok for Anthropic when GitHub Copilot env var is set", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-copilot-test-")));
  withEnv({
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_OAUTH_TOKEN: undefined,
    COPILOT_GITHUB_TOKEN: PRESENT_TEST_VALUE,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    HOME: tmpHome,
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic!.status, "ok", "should be ok when Copilot auth is available");
      assert.ok(anthropic!.message.includes("GitHub Copilot"), "should mention cross-provider source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

test("runProviderChecks reports ok for Anthropic via GITHUB_TOKEN cross-provider routing", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-ghtoken-test-")));
  withEnv({
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_OAUTH_TOKEN: undefined,
    COPILOT_GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: PRESENT_TEST_VALUE,
    HOME: tmpHome,
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic!.status, "ok", "should be ok when GITHUB_TOKEN provides Copilot access");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

test("runProviderChecks detects ANTHROPIC_OAUTH_TOKEN as valid Anthropic auth", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-oauth-test-")));
  withEnv({
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_OAUTH_TOKEN: PRESENT_TEST_VALUE,
    COPILOT_GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    HOME: tmpHome,
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic!.status, "ok", "should be ok when ANTHROPIC_OAUTH_TOKEN is set");
      assert.ok(anthropic!.message.includes("env"), "should report env source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

test("runProviderChecks reports ok via Copilot auth.json for Anthropic", () => {
  withEnv({
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_OAUTH_TOKEN: undefined,
    COPILOT_GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  }, () => {
    const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-copilot-auth-test-")));
    const agentDir = join(tmpHome, ".gsd", "agent");
    mkdirSync(agentDir, { recursive: true });

    // GitHub Copilot OAuth in auth.json
    const authData = {
      "github-copilot": { type: "oauth", apiKey: "ghu_copilot-key", expires: Date.now() + 3_600_000 },
    };
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));

    withEnv({ HOME: tmpHome }, () => {
      const results = runProviderChecks();
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic!.status, "ok", "should be ok when Copilot is authenticated in auth.json");
      assert.ok(anthropic!.message.includes("GitHub Copilot"), "should mention Copilot as source");
    });

    rmSync(tmpHome, { recursive: true, force: true });
  });
});

test("runProviderChecks uses provider-qualified anthropic-vertex model IDs", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-vertex-prefix-home-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-vertex-prefix-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution: anthropic-vertex/claude-sonnet-4-6",
      "---",
      "",
    ].join("\n"),
  );

  withEnv({
    HOME: tmpHome,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_OAUTH_TOKEN: undefined,
    ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const vertex = results.find(r => r.name === "anthropic-vertex");
      const anthropic = results.find(r => r.name === "anthropic");
      assert.ok(vertex, "anthropic-vertex result should exist");
      assert.equal(vertex!.status, "ok", "should accept ANTHROPIC_VERTEX_PROJECT_ID as configured");
      assert.ok(!anthropic || !anthropic.required, "plain anthropic should not be required for anthropic-vertex config");
    });
  });

  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

test("runProviderChecks uses object provider field for anthropic-vertex models", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-vertex-provider-home-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-vertex-provider-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution:",
      "    model: claude-sonnet-4-6",
      "    provider: anthropic-vertex",
      "---",
      "",
    ].join("\n"),
  );

  withEnv({
    HOME: tmpHome,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_OAUTH_TOKEN: undefined,
    ANTHROPIC_VERTEX_PROJECT_ID: undefined,
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const vertex = results.find(r => r.name === "anthropic-vertex");
      assert.ok(vertex, "anthropic-vertex result should exist");
      assert.equal(vertex!.status, "error", "missing vertex config should be reported against anthropic-vertex");
      assert.ok(vertex!.detail?.includes("ANTHROPIC_VERTEX_PROJECT_ID"), "should point to vertex setup");
    });
  });

  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

// ─── Cross-provider routing: Codex & Gemini CLI (#2922) ────────────────────

test("runProviderChecks reports ok for Google via google-gemini-cli auth.json (#2922)", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-gemini-cli-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution: gemini-2.5-pro",
      "---",
      "",
    ].join("\n"),
  );

  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-gemini-cli-home-")));
  const agentDir = join(tmpHome, ".gsd", "agent");
  mkdirSync(agentDir, { recursive: true });

  // google-gemini-cli OAuth in auth.json (no google API key)
  const authData = {
    "google-gemini-cli": { type: "oauth", apiKey: "ya29.gemini-cli-token", expires: Date.now() + 3_600_000 },
  };
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));

  withEnv({
    HOME: tmpHome,
    GEMINI_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const google = results.find(r => r.name === "google");
      assert.ok(google, "google result should exist");
      assert.equal(google!.status, "ok", "should be ok when google-gemini-cli auth is available (#2922)");
      assert.ok(google!.message.includes("Google Gemini CLI"), "should mention Gemini CLI as the source (#2922)");
    });
  });

  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

test("runProviderChecks reports ok for OpenAI via openai-codex auth.json (#2922)", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-codex-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution: gpt-4o",
      "---",
      "",
    ].join("\n"),
  );

  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-codex-home-")));
  const agentDir = join(tmpHome, ".gsd", "agent");
  mkdirSync(agentDir, { recursive: true });

  // openai-codex OAuth in auth.json (no openai API key)
  const authData = {
    "openai-codex": { type: "oauth", apiKey: "codex-token", expires: Date.now() + 3_600_000 },
  };
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));

  withEnv({
    HOME: tmpHome,
    OPENAI_API_KEY: undefined,
    // Clear Copilot env vars so it doesn't route through Copilot
    COPILOT_GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const openai = results.find(r => r.name === "openai");
      assert.ok(openai, "openai result should exist");
      assert.equal(openai!.status, "ok", "should be ok when openai-codex auth is available (#2922)");
      assert.ok(openai!.message.includes("Codex"), "should mention Codex as the source (#2922)");
    });
  });

  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

test("PROVIDER_ROUTES includes google-gemini-cli as route for google (#2922)", async () => {
  const { readFileSync: readFS } = await import("node:fs");
  const { dirname: dirn, join: joinPath } = await import("node:path");
  const { fileURLToPath: fileUrl } = await import("node:url");
  const __dir = dirn(fileUrl(import.meta.url));
  const src = readFS(joinPath(__dir, "..", "doctor-providers.ts"), "utf-8");

  // PROVIDER_ROUTES must map google -> [..., "google-gemini-cli"]
  assert.ok(
    src.includes('"google-gemini-cli"'),
    'PROVIDER_ROUTES must include "google-gemini-cli" as a route (#2922)',
  );
});

test("PROVIDER_ROUTES includes openai-codex as route for openai (#2922)", async () => {
  const { readFileSync: readFS } = await import("node:fs");
  const { dirname: dirn, join: joinPath } = await import("node:path");
  const { fileURLToPath: fileUrl } = await import("node:url");
  const __dir = dirn(fileUrl(import.meta.url));
  const src = readFS(joinPath(__dir, "..", "doctor-providers.ts"), "utf-8");

  // PROVIDER_ROUTES must map openai -> [..., "openai-codex"]
  assert.ok(
    src.includes('"openai-codex"'),
    'PROVIDER_ROUTES must include "openai-codex" as a route (#2922)',
  );
});
