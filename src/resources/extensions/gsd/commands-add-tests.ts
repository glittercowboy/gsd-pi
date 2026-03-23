/**
 * GSD Command — /gsd add-tests
 *
 * Generates tests for a completed slice by dispatching an LLM prompt
 * with implementation context (summaries, changed files, test patterns).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { deriveState } from "./state.js";
import { gsdRoot } from "./paths.js";
import { loadPrompt } from "./prompt-loader.js";

function findLastCompletedSlice(basePath: string, milestoneId: string): string | null {
  // Scan disk for slices that have a SUMMARY.md (indicating completion)
  const slicesDir = join(gsdRoot(basePath), "milestones", milestoneId, "slices");
  if (!existsSync(slicesDir)) return null;

  try {
    const entries = readdirSync(slicesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^S\d+$/.test(e.name))
      .sort((a, b) => b.name.localeCompare(a.name)); // reverse order — latest first

    for (const entry of entries) {
      const summaryPath = join(slicesDir, entry.name, `${entry.name}-SUMMARY.md`);
      if (existsSync(summaryPath)) return entry.name;
    }
  } catch {
    // non-fatal
  }
  return null;
}

function readSliceSummary(basePath: string, milestoneId: string, sliceId: string): { title: string; content: string } {
  const summaryPath = join(gsdRoot(basePath), "milestones", milestoneId, sliceId, "SUMMARY.md");
  if (existsSync(summaryPath)) {
    const content = readFileSync(summaryPath, "utf-8");
    const titleMatch = content.match(/^#\s+(.+)/m);
    return { title: titleMatch?.[1] ?? sliceId, content };
  }
  return { title: sliceId, content: "(no summary available)" };
}

function detectTestPatterns(basePath: string): string {
  const patterns: string[] = [];

  // Check for common test configs
  const checks = [
    { file: "jest.config.ts", name: "Jest" },
    { file: "jest.config.js", name: "Jest" },
    { file: "vitest.config.ts", name: "Vitest" },
    { file: "vitest.config.js", name: "Vitest" },
    { file: ".mocharc.yml", name: "Mocha" },
  ];

  for (const check of checks) {
    if (existsSync(join(basePath, check.file))) {
      patterns.push(`Framework: ${check.name} (${check.file})`);
    }
  }

  // Look for existing test files to infer patterns
  const testDirs = ["tests", "test", "src/__tests__", "__tests__"];
  for (const dir of testDirs) {
    const fullDir = join(basePath, dir);
    if (existsSync(fullDir)) {
      try {
        const files = readdirSync(fullDir).filter((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts") || f.endsWith(".test.js"));
        if (files.length > 0) {
          patterns.push(`Test directory: ${dir}/ (${files.length} test files)`);
          // Read first test file for patterns
          const samplePath = join(fullDir, files[0]);
          const sample = readFileSync(samplePath, "utf-8").slice(0, 500);
          patterns.push(`Sample pattern from ${files[0]}:\n${sample}`);
          break;
        }
      } catch {
        // non-fatal
      }
    }
  }

  return patterns.length > 0 ? patterns.join("\n") : "No test framework detected. Use Node.js built-in test runner.";
}

export async function handleAddTests(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const basePath = process.cwd();
  const state = await deriveState(basePath);

  if (!state.activeMilestone) {
    ctx.ui.notify("No active milestone.", "warning");
    return;
  }

  const milestoneId = state.activeMilestone.id;

  // Determine target
  const targetId = args.trim() || findLastCompletedSlice(basePath, milestoneId);
  if (!targetId) {
    ctx.ui.notify(
      "No completed slices found. Specify a slice ID: /gsd add-tests S03",
      "warning",
    );
    return;
  }

  // Gather context
  const summary = readSliceSummary(basePath, milestoneId, targetId);
  const testPatterns = detectTestPatterns(basePath);

  ctx.ui.notify(`Generating tests for ${targetId}: "${summary.title}"...`, "info");

  try {
    const prompt = loadPrompt("add-tests", {
      sliceId: targetId,
      sliceTitle: summary.title,
      sliceSummary: summary.content,
      existingTestPatterns: testPatterns,
      workingDirectory: basePath,
    });

    pi.sendMessage(
      { customType: "gsd-add-tests", content: prompt, display: false },
      { triggerTurn: true },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to dispatch test generation: ${msg}`, "error");
  }
}
