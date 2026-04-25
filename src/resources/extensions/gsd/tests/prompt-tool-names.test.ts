// prompt-tool-names — Ensures prompt files reference correct tool names.
//
// The registered GSD tool is `search-the-web`, not `web_search`.
// `web_search` is an Anthropic API implementation detail that should
// never appear in GSD prompts or agent frontmatter.
// See: https://github.com/gsd-build/gsd-2/issues/2920

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__dirname, "..", "prompts");
const agentsDir = join(__dirname, "..", "..", "..", "agents");

/** Collect all .md files in a directory (non-recursive). */
function mdFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f));
}

const WRONG_TOOL = "web_search";
const CORRECT_TOOL = "search-the-web";

test("prompt files must not reference `web_search` — use `search-the-web` instead", () => {
  const files = mdFiles(promptsDir);
  assert.ok(files.length > 0, "Expected at least one prompt file");

  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    if (content.includes(WRONG_TOOL)) {
      violations.push(file);
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `These prompt files reference "${WRONG_TOOL}" instead of "${CORRECT_TOOL}":\n${violations.join("\n")}`,
  );
});

test("agent frontmatter must not reference `web_search` — use `search-the-web` instead", () => {
  const files = mdFiles(agentsDir);
  assert.ok(files.length > 0, "Expected at least one agent file");

  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    // Check frontmatter tools line specifically
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      if (frontmatter.includes(WRONG_TOOL)) {
        violations.push(file);
      }
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `These agent files reference "${WRONG_TOOL}" in frontmatter instead of "${CORRECT_TOOL}":\n${violations.join("\n")}`,
  );
});
