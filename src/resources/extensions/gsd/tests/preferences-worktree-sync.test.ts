/**
 * Regression tests for #2684 plus uppercase-preference normalization:
 * preferences files are handled explicitly
 * outside ROOT_STATE_FILES and prefer canonical PREFERENCES.md over the
 * legacy lowercase fallback.
 *
 * Without this, post_unit_hooks and all preference-driven config silently
 * stop working inside auto-mode worktrees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractSourceRegion } from "./test-helpers.ts";

test("#2684: preferences files are NOT in ROOT_STATE_FILES (forward-only sync)", () => {
  const srcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const src = readFileSync(srcPath, "utf-8");

  const constIdx = src.indexOf("ROOT_STATE_FILES");
  assert.ok(constIdx !== -1, "ROOT_STATE_FILES constant exists");

  const arrayStart = src.indexOf("[", constIdx);
  const arrayEnd = src.indexOf("] as const", arrayStart);
  const block = src.slice(arrayStart, arrayEnd);

  // Project preferences must NOT be in ROOT_STATE_FILES — they are handled separately
  // in syncGsdStateToWorktree() (forward-only, additive). Including it in
  // ROOT_STATE_FILES would cause syncWorktreeStateBack() to overwrite the
  // authoritative project root copy (#2684).
  const entries = block.split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith('"') && l.includes(".md"));
  const hasPrefs = entries.some(
    l => l.includes("PREFERENCES.md") || l.includes("preferences.md"),
  );
  assert.ok(
    !hasPrefs,
    "preferences files must NOT be in ROOT_STATE_FILES (back-sync would overwrite root)",
  );
});

test("copyPlanningArtifacts prefers canonical PREFERENCES.md with lowercase fallback", () => {
  const srcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
  const src = readFileSync(srcPath, "utf-8");

  // Find the copyPlanningArtifacts function body
  const fnIdx = src.indexOf("function copyPlanningArtifacts");
  assert.ok(fnIdx !== -1, "copyPlanningArtifacts function exists");

  // Extract function body (up to the next top-level function)
  const fnBody = extractSourceRegion(src, "function copyPlanningArtifacts");

  assert.ok(
    fnBody.includes("PROJECT_PREFERENCES_FILE") && fnBody.includes("LEGACY_PROJECT_PREFERENCES_FILE"),
    "copyPlanningArtifacts should prefer canonical PREFERENCES.md and retain lowercase fallback via the shared constants",
  );
});

test("syncGsdStateToWorktree copies canonical PREFERENCES.md", async () => {
  // Functional test: create a mock source and destination, call the sync
  const srcBase = mkdtempSync(join(tmpdir(), "gsd-wt-prefs-src-"));
  const dstBase = mkdtempSync(join(tmpdir(), "gsd-wt-prefs-dst-"));
  const srcGsd = join(srcBase, ".gsd");
  const dstGsd = join(dstBase, ".gsd");
  mkdirSync(srcGsd, { recursive: true });
  mkdirSync(dstGsd, { recursive: true });

  try {
    // Write a canonical PREFERENCES.md in source
    writeFileSync(
      join(srcGsd, "PREFERENCES.md"),
      "---\nversion: 1\n---\n\npost_unit_hooks:\n  - name: notify\n    command: echo done\n",
    );

    // Import and call syncGsdStateToWorktree
    const { syncGsdStateToWorktree } = await import("../auto-worktree.ts");
    syncGsdStateToWorktree(srcBase, dstBase);

    // Verify PREFERENCES.md was copied
    assert.ok(
      existsSync(join(dstGsd, "PREFERENCES.md")),
      "PREFERENCES.md should be copied to worktree",
    );

    const content = readFileSync(join(dstGsd, "PREFERENCES.md"), "utf-8");
    assert.ok(
      content.includes("post_unit_hooks"),
      "copied PREFERENCES.md should contain the hooks config",
    );
  } finally {
    rmSync(srcBase, { recursive: true, force: true });
    rmSync(dstBase, { recursive: true, force: true });
  }
});

test("syncGsdStateToWorktree falls back to legacy lowercase preferences.md", async () => {
  const srcBase = mkdtempSync(join(tmpdir(), "gsd-wt-prefs-legacy-src-"));
  const dstBase = mkdtempSync(join(tmpdir(), "gsd-wt-prefs-legacy-dst-"));
  const srcGsd = join(srcBase, ".gsd");
  const dstGsd = join(dstBase, ".gsd");
  mkdirSync(srcGsd, { recursive: true });
  mkdirSync(dstGsd, { recursive: true });

  try {
    writeFileSync(
      join(srcGsd, "preferences.md"),
      "---\nversion: 1\n---\n\ngit:\n  auto_push: true\n",
    );

    const { syncGsdStateToWorktree } = await import("../auto-worktree.ts");
    const result = syncGsdStateToWorktree(srcBase, dstBase);

    const copiedEntries = readdirSync(dstGsd)
      .filter((name) => name === "PREFERENCES.md" || name === "preferences.md");

    assert.ok(
      copiedEntries.length === 1,
      `expected exactly one preferences file in worktree, got ${copiedEntries.join(", ") || "(none)"}`,
    );
    assert.ok(
      copiedEntries[0] === "PREFERENCES.md" || copiedEntries[0] === "preferences.md",
      "legacy fallback should still result in one readable preferences file",
    );
    assert.ok(
      result.synced.includes("preferences.md") || result.synced.includes("PREFERENCES.md"),
      "legacy fallback copy should be reported in synced list",
    );
  } finally {
    rmSync(srcBase, { recursive: true, force: true });
    rmSync(dstBase, { recursive: true, force: true });
  }
});
