import test from "node:test";
import assert from "node:assert/strict";
import { AuthStorage } from "@gsd/pi-coding-agent";
import {
  maskKey,
  formatDuration,
  describeCredential,
  findProvider,
  getAllKeyStatuses,
  formatKeyDashboard,
  formatTestResults,
  runKeyDoctor,
  formatDoctorFindings,
  PROVIDER_REGISTRY,
} from "../key-manager.ts";

function makeAuth(data: Record<string, any> = {}): AuthStorage {
  return AuthStorage.inMemory(data);
}

// ─── maskKey ────────────────────────────────────────────────────────────────────

test("maskKey masks a normal API key showing first 4 and last 4", () => {
  assert.equal(maskKey("sk-ant-api03-abcdefghijklmnop"), "sk-a***mnop");
});

test("maskKey masks a short key showing first 2 and last 2", () => {
  assert.equal(maskKey("abc12345"), "ab***45");
});

test("maskKey returns (empty) for empty string", () => {
  assert.equal(maskKey(""), "(empty)");
});

test("maskKey handles very short keys gracefully", () => {
  assert.equal(maskKey("ab"), "ab***ab");
});

test("maskKey handles 12-char boundary", () => {
  assert.equal(maskKey("123456789012"), "1234***9012");
});

// ─── formatDuration ─────────────────────────────────────────────────────────────

test("formatDuration formats seconds", () => {
  assert.equal(formatDuration(30_000), "30s");
});

test("formatDuration formats minutes", () => {
  assert.equal(formatDuration(5 * 60_000), "5m");
});

test("formatDuration formats hours and minutes", () => {
  assert.equal(formatDuration(90 * 60_000), "1h 30m");
});

test("formatDuration formats exact hours without minutes", () => {
  assert.equal(formatDuration(2 * 60 * 60_000), "2h");
});

test("formatDuration returns expired for zero or negative", () => {
  assert.equal(formatDuration(0), "expired");
  assert.equal(formatDuration(-1000), "expired");
});

// ─── describeCredential ─────────────────────────────────────────────────────────

test("describeCredential describes an API key with masked value", () => {
  const result = describeCredential({ type: "api_key", key: "sk-ant-test-key-12345" });
  assert.ok(result.includes("API key"));
  assert.ok(result.includes("sk-a"));
  assert.ok(result.includes("2345"));
});

test("describeCredential describes an empty API key", () => {
  assert.equal(describeCredential({ type: "api_key", key: "" }), "empty key");
});

test("describeCredential describes an OAuth token with expiry", () => {
  const result = describeCredential({
    type: "oauth",
    access: "token",
    refresh: "refresh",
    expires: Date.now() + 60 * 60_000,
  });
  assert.ok(result.includes("OAuth"));
  assert.ok(result.includes("expires in"));
});

test("describeCredential describes an expired OAuth token", () => {
  const result = describeCredential({
    type: "oauth",
    access: "token",
    refresh: "refresh",
    expires: Date.now() - 1000,
  });
  assert.ok(result.includes("expired"));
});

// ─── findProvider ───────────────────────────────────────────────────────────────

test("findProvider finds by exact ID", () => {
  assert.equal(findProvider("anthropic")?.id, "anthropic");
});

test("findProvider finds by ID case-insensitively", () => {
  assert.equal(findProvider("OPENAI")?.id, "openai");
});

test("findProvider finds by label", () => {
  assert.equal(findProvider("Brave Search")?.id, "brave");
});

test("findProvider returns undefined for unknown", () => {
  assert.equal(findProvider("nonexistent"), undefined);
});

// ─── PROVIDER_REGISTRY ──────────────────────────────────────────────────────────

test("PROVIDER_REGISTRY has at least 15 providers", () => {
  assert.ok(PROVIDER_REGISTRY.length >= 15);
});

test("PROVIDER_REGISTRY has unique IDs", () => {
  const ids = PROVIDER_REGISTRY.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("PROVIDER_REGISTRY every provider has id, label, and category", () => {
  const validCategories = ["llm", "tool", "search", "remote"];
  for (const p of PROVIDER_REGISTRY) {
    assert.ok(p.id, `provider missing id`);
    assert.ok(p.label, `provider ${p.id} missing label`);
    assert.ok(validCategories.includes(p.category), `provider ${p.id} has invalid category: ${p.category}`);
  }
});

test("PROVIDER_REGISTRY includes all major LLM providers", () => {
  const ids = PROVIDER_REGISTRY.map((p) => p.id);
  assert.ok(ids.includes("anthropic"));
  assert.ok(ids.includes("openai"));
  assert.ok(ids.includes("google"));
  assert.ok(ids.includes("groq"));
  assert.ok(ids.includes("minimax"));
  assert.ok(ids.includes("minimax-cn"));
});

test("PROVIDER_REGISTRY includes claude-code as a first-class LLM provider (#4541)", () => {
  const entry = PROVIDER_REGISTRY.find((p) => p.id === "claude-code");
  assert.ok(entry, "claude-code must be in PROVIDER_REGISTRY");
  assert.equal(entry!.category, "llm");
  assert.ok(entry!.hasOAuth, "claude-code uses OAuth (CLI auth)");
});

test("PROVIDER_REGISTRY includes all tool/search providers", () => {
  const ids = PROVIDER_REGISTRY.map((p) => p.id);
  assert.ok(ids.includes("tavily"));
  assert.ok(ids.includes("brave"));
  assert.ok(ids.includes("context7"));
  assert.ok(ids.includes("jina"));
});

// ─── getAllKeyStatuses ───────────────────────────────────────────────────────────

test("getAllKeyStatuses shows unconfigured providers as not configured", () => {
  const auth = makeAuth();
  const statuses = getAllKeyStatuses(auth);
  const anthropic = statuses.find((s) => s.provider.id === "anthropic");
  assert.equal(anthropic?.configured, false);
  assert.equal(anthropic?.source, "none");
});

test("getAllKeyStatuses detects keys in auth.json", () => {
  const auth = makeAuth({ anthropic: { type: "api_key", key: "sk-ant-test" } });
  const statuses = getAllKeyStatuses(auth);
  const anthropic = statuses.find((s) => s.provider.id === "anthropic");
  assert.equal(anthropic?.configured, true);
  assert.equal(anthropic?.source, "auth.json");
  assert.equal(anthropic?.credentialCount, 1);
});

test("getAllKeyStatuses detects multiple keys", () => {
  const auth = makeAuth({
    openai: [
      { type: "api_key", key: "sk-key1" },
      { type: "api_key", key: "sk-key2" },
    ],
  });
  const statuses = getAllKeyStatuses(auth);
  const openai = statuses.find((s) => s.provider.id === "openai");
  assert.equal(openai?.configured, true);
  assert.equal(openai?.credentialCount, 2);
  assert.ok(openai?.description.includes("round-robin"));
});

test("getAllKeyStatuses detects empty keys as not configured", () => {
  const auth = makeAuth({ groq: { type: "api_key", key: "" } });
  const statuses = getAllKeyStatuses(auth);
  const groq = statuses.find((s) => s.provider.id === "groq");
  assert.equal(groq?.configured, false);
  // Empty-key entries are filtered out, so provider appears unconfigured
  assert.equal(groq?.source, "none");
});

test("getAllKeyStatuses finds valid keys even when empty-key entry exists at index 0", () => {
  const auth = makeAuth({
    groq: [
      { type: "api_key", key: "" },
      { type: "api_key", key: "gsk-real-key" },
    ],
  });
  const statuses = getAllKeyStatuses(auth);
  const groq = statuses.find((s) => s.provider.id === "groq");
  assert.equal(groq?.configured, true);
  assert.equal(groq?.source, "auth.json");
  assert.equal(groq?.credentialCount, 1); // only the valid key counts
});

test("getAllKeyStatuses detects env var keys", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-test";
  try {
    const auth = makeAuth();
    const statuses = getAllKeyStatuses(auth);
    const openai = statuses.find((s) => s.provider.id === "openai");
    assert.equal(openai?.configured, true);
    assert.equal(openai?.source, "env");
  } finally {
    if (original === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = original;
    }
  }
});

// ─── formatKeyDashboard ─────────────────────────────────────────────────────────

test("formatKeyDashboard includes header and category sections", () => {
  const auth = makeAuth({ anthropic: { type: "api_key", key: "sk-ant-test-key" } });
  const statuses = getAllKeyStatuses(auth);
  const output = formatKeyDashboard(statuses);

  assert.ok(output.includes("GSD API Key Manager"));
  assert.ok(output.includes("LLM Providers"));
  assert.ok(output.includes("Search Providers"));
  assert.ok(output.includes("Tool Keys"));
  assert.ok(output.includes("Remote Integrations"));
});

test("formatKeyDashboard shows configured counts", () => {
  const auth = makeAuth({
    anthropic: { type: "api_key", key: "sk-ant-test" },
    tavily: { type: "api_key", key: "tvly-test" },
  });
  const statuses = getAllKeyStatuses(auth);
  const output = formatKeyDashboard(statuses);
  assert.ok(output.includes("configured"));
  assert.ok(output.includes("auth.json"));
});

// ─── formatTestResults ──────────────────────────────────────────────────────────

test("formatTestResults formats valid results with checkmark", () => {
  const results = [
    {
      provider: { id: "anthropic", label: "Anthropic", category: "llm" as const },
      status: "valid" as const,
      message: "valid",
      latencyMs: 142,
    },
  ];
  const output = formatTestResults(results);
  assert.ok(output.includes("✓"));
  assert.ok(output.includes("anthropic"));
  assert.ok(output.includes("142ms"));
  assert.ok(output.includes("1 valid"));
});

test("formatTestResults formats invalid results with X", () => {
  const results = [
    {
      provider: { id: "groq", label: "Groq", category: "llm" as const },
      status: "invalid" as const,
      message: "invalid key (401)",
      latencyMs: 89,
    },
  ];
  const output = formatTestResults(results);
  assert.ok(output.includes("✗"));
  assert.ok(output.includes("invalid"));
});

test("formatTestResults formats skipped results with dash", () => {
  const results = [
    {
      provider: { id: "jina", label: "Jina", category: "tool" as const },
      status: "skipped" as const,
      message: "not configured",
    },
  ];
  const output = formatTestResults(results);
  assert.ok(output.includes("—"));
  assert.ok(output.includes("1 skipped"));
});

test("formatTestResults shows summary counts for mixed results", () => {
  const results = [
    { provider: { id: "a", label: "A", category: "llm" as const }, status: "valid" as const, message: "ok", latencyMs: 100 },
    { provider: { id: "b", label: "B", category: "llm" as const }, status: "invalid" as const, message: "401", latencyMs: 50 },
    { provider: { id: "c", label: "C", category: "tool" as const }, status: "skipped" as const, message: "n/a" },
  ];
  const output = formatTestResults(results);
  assert.ok(output.includes("1 valid"));
  assert.ok(output.includes("1 invalid"));
  assert.ok(output.includes("1 skipped"));
});

// ─── runKeyDoctor ───────────────────────────────────────────────────────────────

test("runKeyDoctor reports empty keys", () => {
  const auth = makeAuth({ groq: { type: "api_key", key: "" } });
  const findings = runKeyDoctor(auth);
  const emptyFinding = findings.find((f) => f.message.includes("empty key"));
  assert.ok(emptyFinding, "should find empty key warning");
  assert.equal(emptyFinding?.severity, "warning");
});

test("runKeyDoctor reports expired OAuth", () => {
  const auth = makeAuth({
    anthropic: { type: "oauth", access: "t", refresh: "r", expires: Date.now() - 10_000 },
  });
  const findings = runKeyDoctor(auth);
  const oauthFinding = findings.find((f) => f.message.includes("expired"));
  assert.ok(oauthFinding, "should find expired OAuth warning");
  assert.equal(oauthFinding?.severity, "warning");
});

test("runKeyDoctor reports soon-to-expire OAuth as info", () => {
  const auth = makeAuth({
    anthropic: { type: "oauth", access: "t", refresh: "r", expires: Date.now() + 2 * 60_000 },
  });
  const findings = runKeyDoctor(auth);
  const oauthFinding = findings.find((f) => f.message.includes("expires in"));
  assert.ok(oauthFinding, "should find expiring OAuth info");
  assert.equal(oauthFinding?.severity, "info");
});

test("runKeyDoctor reports missing LLM provider", () => {
  const llmEnvVars = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY",
    "GEMINI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN",
    "OLLAMA_API_KEY", "CUSTOM_OPENAI_API_KEY", "CEREBRAS_API_KEY",
    "AZURE_OPENAI_API_KEY",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const v of llmEnvVars) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  try {
    const auth = makeAuth();
    const findings = runKeyDoctor(auth);
    const missingLlm = findings.find((f) => f.message.includes("No LLM provider"));
    assert.ok(missingLlm, "should find missing LLM error");
    assert.equal(missingLlm?.severity, "error");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
});

test("runKeyDoctor does not report missing LLM when one is configured", () => {
  const auth = makeAuth({ anthropic: { type: "api_key", key: "sk-ant-test" } });
  const findings = runKeyDoctor(auth);
  const missingLlm = findings.find((f) => f.message.includes("No LLM provider"));
  assert.equal(missingLlm, undefined);
});

test("runKeyDoctor reports duplicate keys across providers", () => {
  const auth = makeAuth({
    openai: { type: "api_key", key: "shared-key-123" },
    groq: { type: "api_key", key: "shared-key-123" },
  });
  const findings = runKeyDoctor(auth);
  const dupFinding = findings.find((f) => f.message.includes("Same key used"));
  assert.ok(dupFinding, "should find duplicate key warning");
  assert.equal(dupFinding?.severity, "warning");
});

test("runKeyDoctor reports env var conflicts", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "env-key";
  try {
    const auth = makeAuth({ openai: { type: "api_key", key: "different-key" } });
    const findings = runKeyDoctor(auth);
    const conflict = findings.find((f) => f.message.includes("differs from auth.json"));
    assert.ok(conflict, "should find env var conflict");
    assert.equal(conflict?.severity, "warning");
  } finally {
    if (original === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = original;
    }
  }
});

test("runKeyDoctor returns no issues when everything is healthy", () => {
  const auth = makeAuth({ anthropic: { type: "api_key", key: "sk-ant-healthy" } });
  const findings = runKeyDoctor(auth);
  const nonFileFindings = findings.filter((f) => !f.message.includes("auth.json permissions"));
  assert.equal(nonFileFindings.length, 0);
});

// ─── formatDoctorFindings ───────────────────────────────────────────────────────

test("formatDoctorFindings shows all-clear for no findings", () => {
  const output = formatDoctorFindings([]);
  assert.ok(output.includes("All checks passed"));
});

test("formatDoctorFindings shows findings with appropriate icons", () => {
  const output = formatDoctorFindings([
    { severity: "error", message: "No LLM provider configured" },
    { severity: "warning", provider: "groq", message: "Empty key" },
    { severity: "fixed", message: "Permissions fixed" },
  ]);
  assert.ok(output.includes("✗"));
  assert.ok(output.includes("⚠"));
  assert.ok(output.includes("✓"));
  assert.ok(output.includes("1 error"));
  assert.ok(output.includes("1 warning"));
  assert.ok(output.includes("1 fixed"));
});

// ─── Regression #3891 — alibaba-coding-plan missing from PROVIDER_REGISTRY ───────
//
// Before this fix, `alibaba-coding-plan` was not in PROVIDER_REGISTRY, causing
// `/gsd keys add alibaba-coding-plan` to silently fail (provider not found).
// alibaba-dashscope is the new standalone provider added in the same PR.

test("regression #3891 — alibaba-coding-plan is in PROVIDER_REGISTRY", () => {
  const provider = findProvider("alibaba-coding-plan");
  assert.ok(provider, "alibaba-coding-plan must be in PROVIDER_REGISTRY for /gsd keys add to work");
  assert.equal(provider.id, "alibaba-coding-plan");
  assert.equal(provider.category, "llm");
  assert.equal(provider.envVar, "ALIBABA_API_KEY");
});

test("alibaba-dashscope is in PROVIDER_REGISTRY", () => {
  const provider = findProvider("alibaba-dashscope");
  assert.ok(provider, "alibaba-dashscope must be in PROVIDER_REGISTRY for /gsd keys add to work");
  assert.equal(provider.id, "alibaba-dashscope");
  assert.equal(provider.category, "llm");
  assert.equal(provider.envVar, "DASHSCOPE_API_KEY");
});

test("alibaba-coding-plan and alibaba-dashscope are separate providers (different env vars)", () => {
  const codingPlan = findProvider("alibaba-coding-plan");
  const dashscope = findProvider("alibaba-dashscope");
  assert.ok(codingPlan, "alibaba-coding-plan must exist");
  assert.ok(dashscope, "alibaba-dashscope must exist");
  assert.notEqual(
    codingPlan.envVar,
    dashscope.envVar,
    "alibaba-coding-plan and alibaba-dashscope must use different env vars",
  );
});

test("getAllKeyStatuses includes alibaba-coding-plan", () => {
  const auth = makeAuth();
  const statuses = getAllKeyStatuses(auth);
  const found = statuses.find((s) => s.provider.id === "alibaba-coding-plan");
  assert.ok(found, "getAllKeyStatuses must include alibaba-coding-plan");
});

test("getAllKeyStatuses includes alibaba-dashscope", () => {
  const auth = makeAuth();
  const statuses = getAllKeyStatuses(auth);
  const found = statuses.find((s) => s.provider.id === "alibaba-dashscope");
  assert.ok(found, "getAllKeyStatuses must include alibaba-dashscope");
});

test("getAllKeyStatuses detects DASHSCOPE_API_KEY for alibaba-dashscope (failure path: missing key shows not configured)", () => {
  const saved = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  try {
    const auth = makeAuth();
    const statuses = getAllKeyStatuses(auth);
    const found = statuses.find((s) => s.provider.id === "alibaba-dashscope");
    assert.ok(found);
    assert.equal(found.configured, false);
    assert.equal(found.source, "none");
  } finally {
    if (saved !== undefined) process.env.DASHSCOPE_API_KEY = saved;
  }
});
