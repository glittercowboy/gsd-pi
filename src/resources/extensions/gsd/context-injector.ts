/**
 * context-injector.ts — Inject prior step artifacts as context into step prompts.
 *
 * Reads the frozen DEFINITION.yaml from a run directory, finds the current step's
 * `contextFrom` references, locates each referenced step's `produces` artifacts
 * on disk, reads their content (truncated to 10k chars), and prepends formatted
 * context blocks to the step prompt.
 *
 * Observability:
 * - Truncation is logged via console.warn when it occurs, preventing silent overflow.
 * - Missing artifact files are skipped silently (the step may not have produced them yet).
 * - Unknown step IDs in contextFrom produce a console.warn for diagnosis.
 * - The frozen DEFINITION.yaml on disk is the single source of truth for contextFrom config.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { StepDefinition } from "./definition-loader.js";
import { readFrozenDefinition } from "./definition-io.js";

/** Maximum characters per artifact to prevent context window blowout. */
const MAX_CONTEXT_CHARS = 10_000;

/**
 * Inject context from prior step artifacts into a step's prompt.
 *
 * Reads the frozen DEFINITION.yaml from `runDir`, finds the step matching
 * `stepId`, and for each step ID in its `contextFrom` array, looks up that
 * step's `produces` paths, reads them from disk (relative to `runDir`),
 * truncates to MAX_CONTEXT_CHARS, and prepends as labeled context blocks.
 *
 * @param runDir — absolute path to the workflow run directory
 * @param stepId — the step ID whose prompt to enrich
 * @param prompt — the original step prompt
 * @returns The prompt with context blocks prepended, or unchanged if no context applies
 * @throws Error if DEFINITION.yaml is missing or unreadable
 */
export function injectContext(
  runDir: string,
  stepId: string,
  prompt: string,
): string {
  const def = readFrozenDefinition(runDir);

  const step = def.steps.find((s: StepDefinition) => s.id === stepId);
  if (!step || !step.contextFrom || step.contextFrom.length === 0) {
    return prompt;
  }

  const contextBlocks: string[] = [];

  for (const refStepId of step.contextFrom) {
    const refStep = def.steps.find((s: StepDefinition) => s.id === refStepId);
    if (!refStep) {
      console.warn(
        `context-injector: step "${stepId}" references unknown step "${refStepId}" in contextFrom — skipping`,
      );
      continue;
    }

    if (!refStep.produces || refStep.produces.length === 0) {
      continue;
    }

    for (const relPath of refStep.produces) {
      const absPath = resolve(runDir, relPath);
      // Path traversal guard: ensure resolved path stays within runDir
      if (!absPath.startsWith(resolve(runDir) + sep) && absPath !== resolve(runDir)) {
        console.warn(
          `context-injector: artifact path "${relPath}" resolves outside runDir — skipping`,
        );
        continue;
      }
      if (!existsSync(absPath)) {
        // Artifact not yet produced or optional — skip silently
        continue;
      }

      let content = readFileSync(absPath, "utf-8");

      if (content.length > MAX_CONTEXT_CHARS) {
        console.warn(
          `context-injector: truncating artifact "${relPath}" from step "${refStepId}" ` +
            `(${content.length} chars → ${MAX_CONTEXT_CHARS} chars)`,
        );
        content = content.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]";
      }

      contextBlocks.push(
        `--- Context from step "${refStepId}" (file: ${relPath}) ---\n${content}\n---`,
      );
    }
  }

  if (contextBlocks.length === 0) {
    return prompt;
  }

  return contextBlocks.join("\n\n") + "\n\n" + prompt;
}
