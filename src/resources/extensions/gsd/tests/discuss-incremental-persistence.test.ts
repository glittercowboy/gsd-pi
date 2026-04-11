/**
 * Regression test for discuss phase incremental persistence (#2152).
 * Verifies both milestone and slice discuss prompts instruct agents to
 * save CONTEXT-DRAFT incrementally during question rounds.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");

describe("discuss incremental persistence (#2152)", () => {
  test("milestone discuss prompt includes CONTEXT-DRAFT save instruction", () => {
    const content = readFileSync(join(promptsDir, "guided-discuss-milestone.md"), "utf-8");
    assert.match(content, /CONTEXT-DRAFT/, "should mention CONTEXT-DRAFT");
    assert.match(content, /Incremental persistence/, "should have incremental persistence section");
    assert.match(content, /gsd_summary_save/, "should use gsd_summary_save tool");
  });

  test("slice discuss prompt includes CONTEXT-DRAFT save instruction", () => {
    const content = readFileSync(join(promptsDir, "guided-discuss-slice.md"), "utf-8");
    assert.match(content, /CONTEXT-DRAFT/, "should mention CONTEXT-DRAFT");
    assert.match(content, /Incremental persistence/, "should have incremental persistence section");
  });

  test("new-project discuss prompt includes CONTEXT-DRAFT save instruction", () => {
    const content = readFileSync(join(promptsDir, "discuss.md"), "utf-8");
    assert.match(content, /CONTEXT-DRAFT/, "should mention CONTEXT-DRAFT");
    assert.match(content, /Incremental persistence/, "should have incremental persistence section");
    assert.match(content, /gsd_summary_save/, "should use gsd_summary_save tool");
  });

  test("drafts are saved silently without user notification", () => {
    const milestone = readFileSync(join(promptsDir, "guided-discuss-milestone.md"), "utf-8");
    const slice = readFileSync(join(promptsDir, "guided-discuss-slice.md"), "utf-8");
    const discuss = readFileSync(join(promptsDir, "discuss.md"), "utf-8");
    assert.match(milestone, /Do NOT mention this save to the user/);
    assert.match(slice, /Do NOT mention this to the user/);
    assert.match(discuss, /Do NOT mention this save to the user/);
  });
});
