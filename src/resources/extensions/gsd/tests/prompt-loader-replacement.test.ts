/**
 * Regression test for #2968: loadPrompt replaceAll expands $' in replacement strings.
 *
 * JavaScript's String.replaceAll interprets special replacement patterns ($', $`, $&)
 * in the replacement string. When a template variable value contains $' (common in
 * bash commands like `grep -q '^0$'`), the replacement injects the entire remainder
 * of the template, causing exponential prompt expansion.
 *
 * The fix: use split/join instead of replaceAll, which has no special pattern
 * interpretation.
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Replicate the OLD (buggy) substitution logic from prompt-loader.ts.
 * Uses replaceAll which interprets $' $` $& in the replacement string.
 */
function substituteBuggy(template: string, vars: Record<string, string>): string {
  let content = template;
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content.trim();
}

/**
 * Replicate the FIXED substitution logic from prompt-loader.ts.
 * Uses split/join which treats the replacement as a literal string.
 */
function substituteFixed(template: string, vars: Record<string, string>): string {
  let content = template;
  for (const [key, value] of Object.entries(vars)) {
    content = content.split(`{{${key}}}`).join(value);
  }
  return content.trim();
}

test("replaceAll $' expansion bug — demonstrates the problem", () => {
  // This test shows the bug: replaceAll interprets $' as "insert portion after match"
  const template = "Hello {{name}}, welcome to {{place}}!";
  const valueWithDollarQuote = "grep -q '^0$'";

  // Using replaceAll (buggy approach)
  const buggyResult = template.replaceAll("{{name}}", valueWithDollarQuote);

  // $' in the replacement string causes replaceAll to append the text after the match
  // So it should NOT equal the expected result
  const expected = "Hello grep -q '^0$', welcome to {{place}}!";

  // The buggy result will contain extra text injected by $' expansion
  assert.notEqual(buggyResult, expected,
    "replaceAll should have expanded $' — if this fails, the JS engine changed behavior");
  assert.ok(buggyResult.length > expected.length,
    `Buggy result should be longer due to $' expansion. Got length ${buggyResult.length} vs expected ${expected.length}`);
});

test("split/join replacement — safe from $' expansion", () => {
  const template = "Hello {{name}}, welcome to {{place}}!";
  const valueWithDollarQuote = "grep -q '^0$'";

  // Using split/join (safe approach)
  const safeResult = template.split("{{name}}").join(valueWithDollarQuote);
  const expected = "Hello grep -q '^0$', welcome to {{place}}!";

  assert.equal(safeResult, expected,
    "split/join should preserve $' literally without expansion");
});

test("fixed substitution preserves $' literally in replacement values", () => {
  const template =
    "Task: {{taskDescription}}\n\nVerification:\n```bash\n{{verificationCommand}}\n```\n\nEnd of prompt.";

  const vars: Record<string, string> = {
    taskDescription: "Run tests",
    verificationCommand: "grep -c 'foo' file.txt | grep -q '^0$' && echo 'PASS' || echo 'FAIL'",
  };

  const buggyResult = substituteBuggy(template, vars);
  const fixedResult = substituteFixed(template, vars);

  // The $' in the verification command value should appear literally in fixed result
  const expectedSnippet = "grep -q '^0$'";
  assert.ok(fixedResult.includes(expectedSnippet),
    `Fixed result should contain the literal string: ${expectedSnippet}`);

  // The fixed result should NOT have blown up in size
  const maxReasonableLength = 300;
  assert.ok(fixedResult.length < maxReasonableLength,
    `Fixed result length ${fixedResult.length} exceeds reasonable maximum ${maxReasonableLength} — prompt explosion detected!`);

  // The buggy result DOES blow up — it's larger than the fixed result
  assert.ok(buggyResult.length > fixedResult.length,
    `Buggy result (${buggyResult.length}) should be larger than fixed (${fixedResult.length}) due to $' expansion`);
});

test("multiple $-pattern values do not cause cascading expansion", () => {
  const template = "A: {{a}}\nB: {{b}}\nC: {{c}}\nEnd.";
  const vars: Record<string, string> = {
    a: "value with $' single quote pattern",
    b: "value with $` backtick pattern",
    c: "value with $& ampersand pattern",
  };

  const buggyResult = substituteBuggy(template, vars);
  const fixedResult = substituteFixed(template, vars);

  // The fixed version should preserve all values literally
  assert.ok(fixedResult.includes("$'"), "Fixed result should contain literal $'");
  assert.ok(fixedResult.includes("$`"), "Fixed result should contain literal $`");
  assert.ok(fixedResult.includes("$&"), "Fixed result should contain literal $&");

  // The fixed version should be a reasonable size
  assert.ok(fixedResult.length < 200,
    `Fixed result length ${fixedResult.length} should be under 200`);

  // The buggy version will be larger due to expansion
  assert.ok(buggyResult.length > fixedResult.length,
    `Buggy result (${buggyResult.length}) should be larger than fixed (${fixedResult.length}) due to $-pattern expansion`);
});

test("realistic execute-task prompt does not explode with $' in slice plan", () => {
  // Simulate a realistic execute-task template with multiple variables
  const template = [
    "# Execute Task",
    "",
    "## Context",
    "Working directory: {{workingDirectory}}",
    "Milestone: {{milestoneId}}",
    "Slice: {{sliceId}} — {{sliceTitle}}",
    "",
    "## Slice Plan Excerpt",
    "{{slicePlanExcerpt}}",
    "",
    "## Instructions",
    "Complete the task described above.",
    "{{skillActivation}}",
    "",
    "## Verification",
    "Run the verification commands to confirm success.",
  ].join("\n");

  const slicePlanWithDollarPatterns = [
    "### Step 1: Validate output",
    "```bash",
    "grep -c 'error' output.log | grep -q '^0$' && echo 'PASS' || echo 'FAIL'",
    "```",
    "",
    "### Step 2: Check format",
    "```bash",
    "diff <(cat expected.txt) <(cat actual.txt) | grep -q '^$' && echo 'MATCH'",
    "```",
  ].join("\n");

  const vars: Record<string, string> = {
    workingDirectory: "/home/user/project",
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Build pipeline",
    slicePlanExcerpt: slicePlanWithDollarPatterns,
    skillActivation: "Load relevant skills.",
  };

  const fixedResult = substituteFixed(template, vars);

  // Should contain the literal $' patterns
  assert.ok(fixedResult.includes("'^0$'"), "Should preserve '^0$' literally");
  assert.ok(fixedResult.includes("'^$'"), "Should preserve '^$' literally");

  // Result should be reasonable size (template ~300 chars + values ~400 chars)
  assert.ok(fixedResult.length < 1000,
    `Result length ${fixedResult.length} exceeds 1000 — prompt explosion detected!`);

  // Compare with buggy version to confirm it WOULD have exploded
  const buggyResult = substituteBuggy(template, vars);
  assert.ok(buggyResult.length > fixedResult.length * 1.5,
    `Buggy result (${buggyResult.length}) should be significantly larger than fixed (${fixedResult.length})`);
});
