/**
 * Regression test: S##-CONTEXT.md from slice discussion must be
 * injected into all 5 downstream prompt builders (#3452).
 *
 * Scans auto-prompts.ts for the 5 builder functions and verifies
 * each one resolves and inlines the slice-level CONTEXT file.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoPromptsPath = join(__dirname, "..", "auto-prompts.ts");
const source = readFileSync(autoPromptsPath, "utf-8");

const BUILDERS = [
  "buildResearchSlicePrompt",
  "buildPlanSlicePrompt",
  "buildCompleteSlicePrompt",
  "buildReplanSlicePrompt",
  "buildReassessRoadmapPrompt",
];

describe("slice CONTEXT.md injection into prompt builders (#3452)", () => {
  for (const builder of BUILDERS) {
    test(`${builder} resolves slice CONTEXT file`, () => {
      // Find the function body
      const fnStart = source.indexOf(`export async function ${builder}`);
      assert.ok(fnStart !== -1, `${builder} should exist in auto-prompts.ts`);

      // Get a reasonable chunk after the function start (enough to cover the inlining section)
      const chunk = source.slice(fnStart, fnStart + 3000);

      // Must resolve the slice CONTEXT path
      assert.ok(
        chunk.includes('resolveSliceFile(base, mid,') && chunk.includes('"CONTEXT"'),
        `${builder} should call resolveSliceFile with "CONTEXT"`,
      );

      // Must inline it with inlineFileOptional
      assert.ok(
        chunk.includes('Slice Context'),
        `${builder} should inline slice CONTEXT with a "Slice Context" label`,
      );
    });
  }
});
