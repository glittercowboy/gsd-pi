import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ensureProjectWorkflowMcpConfig,
  GSD_WORKFLOW_MCP_SERVER_NAME,
} from "../mcp-project-config.ts";

test("ensureProjectWorkflowMcpConfig creates .mcp.json with the workflow server", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot);
    assert.equal(result.status, "created");
    assert.equal(existsSync(result.configPath), true);

    const parsed = JSON.parse(readFileSync(result.configPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    const server = parsed.mcpServers?.[GSD_WORKFLOW_MCP_SERVER_NAME];
    assert.ok(server, "workflow server should be written to mcpServers");
    assert.equal(typeof server?.command, "string");
    assert.equal(Array.isArray(server?.args), true);
    assert.equal(server?.env?.GSD_WORKFLOW_PROJECT_ROOT, projectRoot);
    assert.match(server?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "", /workflow-tool-executors\.(js|ts)$/);
    assert.match(server?.env?.GSD_WORKFLOW_WRITE_GATE_MODULE ?? "", /write-gate\.(js|ts)$/);
    if ((server?.env?.GSD_WORKFLOW_EXECUTORS_MODULE ?? "").endsWith(".ts")) {
      assert.match(server?.env?.NODE_OPTIONS ?? "", /--experimental-strip-types/);
      assert.match(server?.env?.NODE_OPTIONS ?? "", /resolve-ts\.mjs/);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensureProjectWorkflowMcpConfig preserves existing mcp servers", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  const configPath = join(projectRoot, ".mcp.json");

  writeFileSync(
    configPath,
    `${JSON.stringify({
      mcpServers: {
        railway: {
          command: "npx",
          args: ["railway-mcp"],
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );

  try {
    const result = ensureProjectWorkflowMcpConfig(projectRoot);
    assert.equal(result.status, "updated");

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    assert.deepEqual(parsed.mcpServers?.railway, {
      command: "npx",
      args: ["railway-mcp"],
    });
    assert.ok(parsed.mcpServers?.[GSD_WORKFLOW_MCP_SERVER_NAME]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensureProjectWorkflowMcpConfig is idempotent when config is already current", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-mcp-init-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });

  try {
    const first = ensureProjectWorkflowMcpConfig(projectRoot);
    const second = ensureProjectWorkflowMcpConfig(projectRoot);

    assert.equal(first.status, "created");
    assert.equal(second.status, "unchanged");
    assert.equal(first.configPath, second.configPath);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
