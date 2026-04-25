/**
 * GSD-2 / agent-end-recovery — regression tests for #4648
 *
 * Covers the stale `dirListCache` bug where `maybeHandleReadyPhraseWithoutFiles`
 * (and `checkAutoStartAfterDiscuss`) falsely reported milestone artifacts as
 * missing, because the directory-listing cache in `paths.ts` was populated
 * before the LLM wrote the files during the same turn.
 *
 * The fix invalidates the cache at the top of `handleAgentEnd`, before any
 * artifact-existence check runs.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { resolveMilestoneFile } from "../paths.ts";
import { clearPathCache } from "../paths.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_END_RECOVERY_PATH = join(
  __dirname,
  "..",
  "bootstrap",
  "agent-end-recovery.ts",
);

function mkBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-4648-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

describe("#4648 stale dirListCache — behavioral", () => {
  test("resolveMilestoneFile returns stale null until clearPathCache runs", () => {
    const base = mkBase();
    try {
      clearPathCache();

      // Prime the cache: directory exists but is empty at this point.
      assert.equal(
        resolveMilestoneFile(base, "M001", "CONTEXT"),
        null,
        "empty dir → null",
      );

      // Simulate the LLM writing CONTEXT.md during the turn.
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "# M001 Context\n",
      );

      // Without a cache flush the resolver still reports null — this is the bug.
      assert.equal(
        resolveMilestoneFile(base, "M001", "CONTEXT"),
        null,
        "stale cache returns null even though the file exists on disk",
      );

      // The fix: clearPathCache() — after which the resolver finds the file.
      clearPathCache();
      const resolved = resolveMilestoneFile(base, "M001", "CONTEXT");
      assert.ok(
        resolved && /M001-CONTEXT\.md$/.test(resolved),
        `after clearPathCache, resolver finds the file (got: ${resolved})`,
      );
    } finally {
      clearPathCache();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("#4648 agent-end-recovery wiring", () => {
  test("handleAgentEnd invalidates the path cache before the discuss guards", () => {
    const source = readFileSync(AGENT_END_RECOVERY_PATH, "utf-8");

    assert.ok(
      /import\s*\{\s*clearPathCache\s*\}\s*from\s*"\.\.\/paths\.js"/.test(source),
      "agent-end-recovery.ts must import clearPathCache from ../paths.js",
    );

    const fnStart = source.indexOf("export async function handleAgentEnd");
    assert.ok(fnStart > -1, "handleAgentEnd must exist");

    const checkIdx = source.indexOf("checkAutoStartAfterDiscuss(", fnStart);
    const clearIdx = source.indexOf("clearPathCache(", fnStart);
    const readyIdx = source.indexOf(
      "maybeHandleReadyPhraseWithoutFiles(",
      fnStart,
    );

    assert.ok(clearIdx > -1, "handleAgentEnd must call clearPathCache");
    assert.ok(
      clearIdx < checkIdx,
      "clearPathCache must run before checkAutoStartAfterDiscuss so the guard sees fresh disk state",
    );
    assert.ok(
      clearIdx < readyIdx,
      "clearPathCache must run before maybeHandleReadyPhraseWithoutFiles",
    );
  });
});
