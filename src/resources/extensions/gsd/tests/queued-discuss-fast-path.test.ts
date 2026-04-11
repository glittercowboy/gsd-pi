import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function guidedFlowSrc(): string {
  return readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");
}

function promptSrc(): string {
  return readFileSync(join(__dirname, "..", "prompts", "guided-discuss-milestone.md"), "utf-8");
}

describe("queued-discuss-fast-path", () => {
  test("1. guided-discuss-milestone.md contains {{fastPathInstruction}}", () => {
    const prompt = promptSrc();
    assert.ok(
      prompt.includes("{{fastPathInstruction}}"),
      "guided-discuss-milestone.md must contain {{fastPathInstruction}} template variable",
    );
  });

  test("2. dispatchDiscussForMilestone computes fastPathInstruction and passes it to loadPrompt", () => {
    const source = guidedFlowSrc();
    const fnStart = source.indexOf("async function dispatchDiscussForMilestone(");
    assert.ok(fnStart > 0, "dispatchDiscussForMilestone must exist");
    const fnEnd = source.indexOf("\nasync function ", fnStart + 1);
    const fnBody = fnEnd > 0 ? source.slice(fnStart, fnEnd) : source.slice(fnStart, fnStart + 2000);
    assert.ok(
      fnBody.includes("fastPathInstruction"),
      "dispatchDiscussForMilestone must compute fastPathInstruction",
    );
    assert.ok(
      fnBody.includes("loadPrompt("),
      "dispatchDiscussForMilestone must call loadPrompt",
    );
    const loadPromptIdx = fnBody.indexOf("loadPrompt(");
    const fastPathIdx = fnBody.indexOf("fastPathInstruction", loadPromptIdx);
    assert.ok(
      fastPathIdx > loadPromptIdx,
      "fastPathInstruction must be passed to loadPrompt in dispatchDiscussForMilestone",
    );
  });

  test("3. fast path instruction mentions scouting and conflict checking", () => {
    const source = guidedFlowSrc();
    assert.ok(
      source.includes("scouting pass"),
      "fast path instruction must mention scouting pass",
    );
    assert.ok(
      source.includes("conflicts with existing work"),
      "fast path instruction must mention conflict checking",
    );
  });

  test("4. showDiscussQueuedMilestone shows a mode picker when no draft", () => {
    const source = guidedFlowSrc();
    const fnStart = source.indexOf("async function showDiscussQueuedMilestone(");
    assert.ok(fnStart > 0, "showDiscussQueuedMilestone must exist");
    const fnEnd = source.indexOf("\nasync function ", fnStart + 1);
    const fnBody = fnEnd > 0 ? source.slice(fnStart, fnEnd) : source.slice(fnStart, fnStart + 3000);
    assert.ok(
      fnBody.includes("hasDraft"),
      "showDiscussQueuedMilestone must check hasDraft",
    );
    assert.ok(
      fnBody.includes('"full"') || fnBody.includes("\"full\""),
      "showDiscussQueuedMilestone must offer a 'full' discussion mode",
    );
    assert.ok(
      fnBody.includes('"fast"') || fnBody.includes("\"fast\""),
      "showDiscussQueuedMilestone must offer a 'fast' path mode",
    );
  });

  test("5. showDiscussQueuedMilestone fast-paths automatically when draft exists", () => {
    const source = guidedFlowSrc();
    const fnStart = source.indexOf("async function showDiscussQueuedMilestone(");
    assert.ok(fnStart > 0, "showDiscussQueuedMilestone must exist");
    const fnEnd = source.indexOf("\nasync function ", fnStart + 1);
    const fnBody = fnEnd > 0 ? source.slice(fnStart, fnEnd) : source.slice(fnStart, fnStart + 3000);
    assert.ok(
      fnBody.includes("let fastPath = hasDraft"),
      "showDiscussQueuedMilestone must set fastPath = hasDraft so draft presence auto-enables fast path",
    );
    assert.ok(
      fnBody.includes("if (!hasDraft)"),
      "showDiscussQueuedMilestone must skip the mode picker when hasDraft is true",
    );
  });

  test("6. dispatchDiscussForMilestone accepts opts with fastPath parameter", () => {
    const source = guidedFlowSrc();
    const fnStart = source.indexOf("async function dispatchDiscussForMilestone(");
    assert.ok(fnStart > 0, "dispatchDiscussForMilestone must exist");
    const signatureEnd = source.indexOf("): Promise<void>", fnStart);
    const signature = source.slice(fnStart, signatureEnd + 16);
    assert.ok(
      signature.includes("opts") && signature.includes("fastPath"),
      "dispatchDiscussForMilestone must accept opts: { fastPath?: boolean } parameter",
    );
  });
});
