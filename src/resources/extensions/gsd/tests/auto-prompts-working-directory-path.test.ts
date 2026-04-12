import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";

import {
  buildPlanMilestonePrompt,
  buildPlanSlicePrompt,
  buildResearchMilestonePrompt,
  buildResearchSlicePrompt,
} from "../auto-prompts.ts";

function createWindowsStyleBase(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "gsd-auto-prompts-"));
  const windowsSegment = win32.join("C:\\Users\\runner", "project");
  const base = join(root, windowsSegment);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), {
    recursive: true,
  });
  return { root, base };
}

test("prompt builders normalize workingDirectory to POSIX paths at runtime", async () => {
  const { root, base } = createWindowsStyleBase();
  const normalizedBase = base.replaceAll("\\", "/");

  try {
    const prompts = await Promise.all([
      buildResearchMilestonePrompt("M001", "Test Milestone", base),
      buildPlanMilestonePrompt("M001", "Test Milestone", base),
      buildResearchSlicePrompt("M001", "Test Milestone", "S01", "Test Slice", base),
      buildPlanSlicePrompt("M001", "Test Milestone", "S01", "Test Slice", base),
    ]);

    for (const prompt of prompts) {
      assert.ok(
        prompt.includes(`Your working directory is \`${normalizedBase}\`.`),
        "workingDirectory should be normalized to POSIX separators in rendered prompts",
      );
      assert.ok(
        !prompt.includes(`Your working directory is \`${base}\`.`),
        "rendered prompts should not expose raw backslash paths",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
