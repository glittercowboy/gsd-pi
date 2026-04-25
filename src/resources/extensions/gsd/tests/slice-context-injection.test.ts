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
import { extractSourceRegion } from "./test-helpers.ts";

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

      // Get a reasonable chunk after the function start
      const chunk = extractSourceRegion(source, `export async function ${builder}`);

      // ADR-011: buildPlanSlicePrompt / buildRefineSlicePrompt now delegate to
      // a shared helper (renderSlicePrompt) that performs the slice CONTEXT
      // resolve. When a builder delegates, scan the helper's body instead.
      const delegatesToHelper = chunk.includes("renderSlicePrompt(");
      const bodyToCheck = delegatesToHelper
        ? (() => {
            const helperStart = source.indexOf("async function renderSlicePrompt");
            assert.ok(helperStart !== -1, "renderSlicePrompt helper must exist");
            return extractSourceRegion(source, "async function renderSlicePrompt");
          })()
        : chunk;

      // Must resolve the slice CONTEXT path
      assert.ok(
        bodyToCheck.includes('resolveSliceFile(base, mid,') && bodyToCheck.includes('"CONTEXT"'),
        `${builder} should call resolveSliceFile with "CONTEXT" (directly or via renderSlicePrompt)`,
      );

      // Must inline it with inlineFileOptional
      assert.ok(
        bodyToCheck.includes("Slice Context"),
        `${builder} should inline slice CONTEXT with a "Slice Context" label`,
      );
    });
  }
});
