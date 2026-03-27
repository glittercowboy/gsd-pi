import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  syncGsdStateToWorktree,
  syncWorktreeStateBack,
} from "../auto-worktree.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gsd-mcp-test-${prefix}-`));
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

const MCP_CONFIG = JSON.stringify(
  {
    mcpServers: {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    },
  },
  null,
  2,
);

test("#2791: ROOT_STATE_FILES includes mcp.json", () => {
  const srcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const src = readFileSync(srcPath, "utf-8");

  const constIdx = src.indexOf("ROOT_STATE_FILES");
  assert.ok(constIdx !== -1, "ROOT_STATE_FILES constant exists");

  const arrayStart = src.indexOf("[", constIdx);
  const arrayEnd = src.indexOf("] as const", arrayStart);
  const block = src.slice(arrayStart, arrayEnd);

  assert.ok(
    block.includes('"mcp.json"'),
    "mcp.json should be in ROOT_STATE_FILES so worktree sync includes MCP config",
  );
});

test("#2791: copyPlanningArtifacts file list includes mcp.json", () => {
  const srcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const src = readFileSync(srcPath, "utf-8");

  const fnIdx = src.indexOf("function copyPlanningArtifacts");
  assert.ok(fnIdx !== -1, "copyPlanningArtifacts function exists");

  const fnBody = src.slice(fnIdx, fnIdx + 1500);

  assert.ok(
    fnBody.includes('"mcp.json"'),
    "copyPlanningArtifacts should seed mcp.json into new worktrees",
  );
});

test("#2791: syncGsdStateToWorktree copies mcp.json when missing from worktree", (t) => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  t.after(() => cleanup(mainBase, wtBase));

  writeFile(mainBase, ".gsd/mcp.json", MCP_CONFIG);
  mkdirSync(join(wtBase, ".gsd"), { recursive: true });

  const result = syncGsdStateToWorktree(mainBase, wtBase);

  assert.ok(
    existsSync(join(wtBase, ".gsd", "mcp.json")),
    "mcp.json should be copied to worktree",
  );
  assert.equal(
    readFileSync(join(wtBase, ".gsd", "mcp.json"), "utf-8"),
    MCP_CONFIG,
    "copied mcp.json content should match project root",
  );
  assert.ok(
    result.synced.includes("mcp.json"),
    "mcp.json should appear in synced list",
  );
});

test("#2791: syncWorktreeStateBack syncs mcp.json changes from worktree to project root", (t) => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  const mid = "M001";
  t.after(() => cleanup(mainBase, wtBase));

  writeFile(mainBase, ".gsd/mcp.json", JSON.stringify({ mcpServers: {} }, null, 2));
  writeFile(wtBase, ".gsd/mcp.json", MCP_CONFIG);
  mkdirSync(join(wtBase, ".gsd", "milestones", mid), { recursive: true });
  mkdirSync(join(mainBase, ".gsd", "milestones"), { recursive: true });

  const result = syncWorktreeStateBack(mainBase, wtBase, mid);

  assert.equal(
    readFileSync(join(mainBase, ".gsd", "mcp.json"), "utf-8"),
    MCP_CONFIG,
    "project root should receive the updated worktree mcp.json",
  );
  assert.ok(
    result.synced.includes("mcp.json"),
    "mcp.json should appear in synced list during worktree teardown",
  );
});
