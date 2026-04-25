import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStoredCredentialEnvKeys, resolveAuthPath } from "./tool-credentials.js";

describe("tool credentials", () => {
  it("hydrates supported model and tool keys from auth.json", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-auth-"));
    const authPath = join(tempRoot, "auth.json");
    const env: NodeJS.ProcessEnv = {};

    try {
      writeFileSync(authPath, JSON.stringify({
        anthropic: { type: "api_key", key: "sk-ant-secret" },
        openai: { type: "api_key", key: "sk-openai-secret" },
        tavily: { type: "api_key", key: "tvly-secret" },
        context7: [{ type: "api_key", key: "ctx7-secret" }],
      }));

      const loaded = loadStoredCredentialEnvKeys({ authPath, env });
      assert.deepEqual(loaded.sort(), [
        "ANTHROPIC_API_KEY",
        "CONTEXT7_API_KEY",
        "OPENAI_API_KEY",
        "TAVILY_API_KEY",
      ]);
      assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-secret");
      assert.equal(env.OPENAI_API_KEY, "sk-openai-secret");
      assert.equal(env.TAVILY_API_KEY, "tvly-secret");
      assert.equal(env.CONTEXT7_API_KEY, "ctx7-secret");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not overwrite explicit environment variables", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-auth-"));
    const authPath = join(tempRoot, "auth.json");
    const env: NodeJS.ProcessEnv = {
      BRAVE_API_KEY: "already-set",
    };

    try {
      writeFileSync(authPath, JSON.stringify({
        brave: { type: "api_key", key: "from-auth-json" },
        anthropic: { type: "api_key", key: "sk-ant-from-auth-json" },
      }));

      const loaded = loadStoredCredentialEnvKeys({ authPath, env });
      assert.deepEqual(loaded, ["ANTHROPIC_API_KEY"]);
      assert.equal(env.BRAVE_API_KEY, "already-set");
      assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-from-auth-json");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ignores oauth credentials because they are resolved through auth storage, not env hydration", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-auth-"));
    const authPath = join(tempRoot, "auth.json");
    const env: NodeJS.ProcessEnv = {};

    try {
      writeFileSync(authPath, JSON.stringify({
        openai: { type: "oauth", access: "oauth-access-token" },
        "google-gemini-cli": { type: "oauth", token: "ya29.oauth-token" },
      }));

      const loaded = loadStoredCredentialEnvKeys({ authPath, env });
      assert.deepEqual(loaded, []);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.GEMINI_API_KEY, undefined);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves auth.json from GSD_CODING_AGENT_DIR", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-agent-dir-"));
    const agentDir = join(tempRoot, "agent");
    mkdirSync(agentDir, { recursive: true });

    try {
      assert.equal(
        resolveAuthPath({ GSD_CODING_AGENT_DIR: agentDir }),
        join(agentDir, "auth.json"),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
