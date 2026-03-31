/**
 * Slice context injection contract tests.
 *
 * Verifies that S-CONTEXT files from slice discussion are injected into the
 * correct prompt builders in auto-prompts.ts and that the plan-slice template
 * warns planners that executors don't see slice context.
 *
 * Uses source-code inspection (same pattern as triage-dispatch.test.ts) because
 * the prompt builders have deep runtime dependencies (DB, preferences, etc.)
 * that make direct invocation impractical in unit tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoPromptsSrc = readFileSync(join(__dirname, "..", "auto-prompts.ts"), "utf-8");
const promptsDir = join(__dirname, "..", "prompts");

function readPrompt(name: string): string {
  return readFileSync(join(promptsDir, `${name}.md`), "utf-8");
}

/**
 * Extract the body of a named function from auto-prompts.ts source.
 * Finds `function name(` and returns everything up to the next top-level
 * `export` or end of file.
 */
function extractFunctionBody(name: string): string {
  const fnStart = autoPromptsSrc.indexOf(`function ${name}(`);
  assert.ok(fnStart >= 0, `function ${name} should exist in auto-prompts.ts`);
  const nextExport = autoPromptsSrc.indexOf("\nexport ", fnStart + 1);
  return autoPromptsSrc.slice(fnStart, nextExport > 0 ? nextExport : undefined);
}

// ─── Slice context injection in prompt builders ─────────────────────────────

test("research-slice prompt builder inlines S-CONTEXT when available", () => {
  const body = extractFunctionBody("buildResearchSlicePrompt");
  assert.match(body, /resolveSliceFile\(base, mid, sid, "CONTEXT"\)/,
    "should resolve slice CONTEXT path");
  assert.match(body, /inlineFileOptional\(.*"Slice Context \(from discussion\)"\)/,
    "should inline slice context with descriptive label");
});

test("plan-slice prompt builder inlines S-CONTEXT when available", () => {
  const body = extractFunctionBody("buildPlanSlicePrompt");
  assert.match(body, /resolveSliceFile\(base, mid, sid, "CONTEXT"\)/,
    "should resolve slice CONTEXT path");
  assert.match(body, /inlineFileOptional\(.*"Slice Context \(from discussion\)"\)/,
    "should inline slice context with descriptive label");
});

test("complete-slice prompt builder inlines S-CONTEXT when available", () => {
  const body = extractFunctionBody("buildCompleteSlicePrompt");
  assert.match(body, /resolveSliceFile\(base, mid, sid, "CONTEXT"\)/,
    "should resolve slice CONTEXT path");
  assert.match(body, /inlineFileOptional\(.*"Slice Context \(from discussion\)"\)/,
    "should inline slice context with descriptive label");
});

test("replan-slice prompt builder inlines S-CONTEXT when available", () => {
  const body = extractFunctionBody("buildReplanSlicePrompt");
  assert.match(body, /resolveSliceFile\(base, mid, sid, "CONTEXT"\)/,
    "should resolve slice CONTEXT path");
  assert.match(body, /inlineFileOptional\(.*"Slice Context \(from discussion\)"\)/,
    "should inline slice context with descriptive label");
});

test("reassess-roadmap prompt builder inlines completed slice's S-CONTEXT", () => {
  const body = extractFunctionBody("buildReassessRoadmapPrompt");
  assert.match(body, /resolveSliceFile\(base, mid, completedSliceId, "CONTEXT"\)/,
    "should resolve completed slice CONTEXT path");
  assert.match(body, /inlineFileOptional\(.*Slice Context \(from discussion\)/,
    "should inline slice context with descriptive label");
});

// ─── Prompt template: executor visibility warning ───────────────────────────

test("plan-slice prompt warns that executors do not see slice context", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /slice context/i,
    "plan-slice template should mention slice context in executor visibility note");
  assert.match(prompt, /They do not see the research doc, the slice context, the roadmap/,
    "executor visibility note should list slice context alongside other excluded artifacts");
});

// ─── Negative: execute-task should NOT inject S-CONTEXT ─────────────────────

test("execute-task prompt builder does NOT inline S-CONTEXT", () => {
  const body = extractFunctionBody("buildExecuteTaskPrompt");
  assert.doesNotMatch(body, /resolveSliceFile\(base, mid, sid, "CONTEXT"\)/,
    "executors should not get slice context — planners distill it into task plans");
});
