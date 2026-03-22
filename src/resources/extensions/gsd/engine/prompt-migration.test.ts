// GSD-2 Single-Writer State Architecture — Prompt migration content assertions
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Resolve prompt paths relative to this test file's location
const promptsDir = join(import.meta.dirname, "..", "prompts");

describe("prompt-migration", () => {
  describe("execute-task.md (PMG-01)", () => {
    let content: string;
    it("loads prompt file", () => {
      content = readFileSync(join(promptsDir, "execute-task.md"), "utf-8");
    });
    it("contains gsd_complete_task tool instruction", () => {
      assert.ok(content.includes("gsd_complete_task"), "must reference gsd_complete_task tool");
    });
    it("does not contain checkbox edit instruction", () => {
      assert.ok(!content.includes("change `[ ]` to `[x]`"), "must not contain checkbox toggle instruction");
      assert.ok(!content.match(/Mark.*done.*PLAN/i), "must not contain 'Mark ... done in PLAN'");
    });
  });

  describe("complete-slice.md (PMG-02)", () => {
    let content: string;
    it("loads prompt file", () => {
      content = readFileSync(join(promptsDir, "complete-slice.md"), "utf-8");
    });
    it("contains gsd_complete_slice tool instruction", () => {
      assert.ok(content.includes("gsd_complete_slice"), "must reference gsd_complete_slice tool");
    });
    it("does not contain roadmap checkbox edit instruction", () => {
      assert.ok(!content.includes("change `[ ]` to `[x]`"), "must not contain checkbox toggle instruction");
      assert.ok(!content.match(/Mark.*done.*roadmap/i), "must not contain 'Mark ... done in roadmap'");
    });
  });

  describe("plan-slice.md (PMG-03)", () => {
    let content: string;
    it("loads prompt file", () => {
      content = readFileSync(join(promptsDir, "plan-slice.md"), "utf-8");
    });
    it("contains gsd_plan_slice tool instruction", () => {
      assert.ok(content.includes("gsd_plan_slice"), "must reference gsd_plan_slice tool");
    });
    it("still contains file-write steps (additive, not replacement)", () => {
      // plan-slice tool call is additive — files are still written, tool registers plan in DB
      assert.ok(content.includes("{{outputPath}}") || content.includes("Write"), "must still have file-write instructions");
    });
  });
});
