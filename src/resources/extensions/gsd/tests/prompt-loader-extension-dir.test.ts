import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveExtensionDirFromCandidates } from "../prompt-loader.ts";

function makeExists(paths: Set<string>): (path: string) => boolean {
  return (path: string) => paths.has(path);
}

test("resolveExtensionDirFromCandidates prefers user-local dir when both trees are valid", () => {
  const moduleDir = "/npm/global/gsd";
  const agentDir = "/home/user/.gsd/agent/extensions/gsd";
  const paths = new Set<string>([
    join(moduleDir, "prompts"),
    join(moduleDir, "templates", "task-summary.md"),
    join(agentDir, "prompts"),
    join(agentDir, "templates", "task-summary.md"),
  ]);

  const resolved = resolveExtensionDirFromCandidates(moduleDir, agentDir, makeExists(paths));
  assert.equal(resolved, agentDir);
});

test("resolveExtensionDirFromCandidates rejects module dir missing task-summary template", () => {
  const moduleDir = "/npm/global/gsd";
  const agentDir = "/home/user/.gsd/agent/extensions/gsd";
  const paths = new Set<string>([
    join(moduleDir, "prompts"),
    // Missing module templates/task-summary.md on purpose.
    join(agentDir, "prompts"),
    join(agentDir, "templates", "task-summary.md"),
  ]);

  const resolved = resolveExtensionDirFromCandidates(moduleDir, agentDir, makeExists(paths));
  assert.equal(resolved, agentDir);
});

test("resolveExtensionDirFromCandidates falls back to prompts-only dir when neither tree is fully valid", () => {
  const moduleDir = "/npm/global/gsd";
  const agentDir = "/home/user/.gsd/agent/extensions/gsd";
  const paths = new Set<string>([
    join(moduleDir, "prompts"),
    // Neither side has templates/task-summary.md.
  ]);

  const resolved = resolveExtensionDirFromCandidates(moduleDir, agentDir, makeExists(paths));
  assert.equal(resolved, moduleDir);
});
