import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSourceRegion } from "./test-helpers.ts";

test("copyPlanningArtifacts skips when source and destination .gsd resolve to the same path", () => {
  const srcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const src = readFileSync(srcPath, "utf-8");

  const fnIdx = src.indexOf("function copyPlanningArtifacts");
  assert.ok(fnIdx !== -1, "copyPlanningArtifacts function exists");

  const fnBody = extractSourceRegion(src, "function copyPlanningArtifacts");

  const guardIdx = fnBody.indexOf("if (isSamePath(srcGsd, dstGsd)) return;");
  const copyIdx = fnBody.indexOf("safeCopyRecursive(join(srcGsd, \"milestones\")");

  assert.ok(guardIdx !== -1, "copyPlanningArtifacts should guard same-path .gsd copies");
  assert.ok(copyIdx !== -1, "copyPlanningArtifacts should still copy milestones when paths differ");
  assert.ok(guardIdx < copyIdx, "same-path guard should run before any copy attempt");
});
