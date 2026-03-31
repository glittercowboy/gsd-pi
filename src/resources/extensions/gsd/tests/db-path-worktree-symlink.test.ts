/**
 * db-path-worktree-symlink.test.ts — #2517
 *
 * Regression test for the db_unavailable loop in worktree/symlink layouts.
 *
 * The path resolver must handle BOTH worktree path families:
 *   - /.gsd/worktrees/<MID>/...           (direct layout)
 *   - /.gsd/projects/<hash>/worktrees/<MID>/...  (symlink-resolved layout)
 *
 * When the second layout is not recognised, ensureDbOpen derives a wrong DB
 * path, the open fails silently, and every completion tool call returns
 * db_unavailable — triggering an artifact retry re-dispatch loop.
 *
 * Additionally, the post-unit artifact retry path must NOT retry when the
 * completion tool failed due to db_unavailable (infra failure), because
 * retrying can never succeed and causes cost spikes.
 */

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

// ── Part 1: resolveProjectRootDbPath handles symlink-resolved layout ─────

test("#2517: standard worktree layout resolves to project root DB path", async () => {
  const { resolveProjectRootDbPath } = await import("../bootstrap/dynamic-tools.js");

  const standardPath = `/home/user/myproject/.gsd/worktrees/M001/work`;
  const standardResult = resolveProjectRootDbPath(standardPath);
  assert.strictEqual(
    standardResult,
    join("/home/user/myproject", ".gsd", "gsd.db"),
    "Standard worktree layout resolves to project root DB path",
  );
});

test("#2517: symlink-resolved layout resolves to project root DB path", async () => {
  const { resolveProjectRootDbPath } = await import("../bootstrap/dynamic-tools.js");

  const symlinkPath = `/home/user/myproject/.gsd/projects/abc123def/worktrees/M001/work`;
  const symlinkResult = resolveProjectRootDbPath(symlinkPath);
  assert.strictEqual(
    symlinkResult,
    join("/home/user/myproject", ".gsd", "gsd.db"),
    "Symlink-resolved layout (/.gsd/projects/<hash>/worktrees/) resolves to project root DB path (#2517)",
  );
});

test("#2517: platform-specific symlink layout resolves correctly", async () => {
  const { resolveProjectRootDbPath } = await import("../bootstrap/dynamic-tools.js");

  if (sep === "\\") {
    const winSymlinkPath = `C:\\Users\\dev\\project\\.gsd\\projects\\abc123def\\worktrees\\M001\\work`;
    const winResult = resolveProjectRootDbPath(winSymlinkPath);
    assert.strictEqual(
      winResult,
      join("C:\\Users\\dev\\project", ".gsd", "gsd.db"),
      "Windows symlink layout resolves correctly",
    );
  } else {
    const fwdSymlinkPath = `/home/user/myproject/.gsd/projects/abc123def/worktrees/M001/work`;
    const fwdResult = resolveProjectRootDbPath(fwdSymlinkPath);
    assert.strictEqual(
      fwdResult,
      join("/home/user/myproject", ".gsd", "gsd.db"),
      "Forward-slash symlink layout resolves correctly on POSIX",
    );
  }
});

test("#2517: deep symlink worktree path still resolves to project root DB", async () => {
  const { resolveProjectRootDbPath } = await import("../bootstrap/dynamic-tools.js");

  const deepSymlinkPath = `/home/user/myproject/.gsd/projects/deadbeef42/worktrees/M003/sub/dir`;
  const deepResult = resolveProjectRootDbPath(deepSymlinkPath);
  assert.strictEqual(
    deepResult,
    join("/home/user/myproject", ".gsd", "gsd.db"),
    "Deep symlink worktree path still resolves to project root DB",
  );
});

test("#2517: non-worktree path resolves to project root DB path", async () => {
  const { resolveProjectRootDbPath } = await import("../bootstrap/dynamic-tools.js");

  const normalPath = `/home/user/myproject`;
  const normalResult = resolveProjectRootDbPath(normalPath);
  assert.strictEqual(
    normalResult,
    join("/home/user/myproject", ".gsd", "gsd.db"),
    "Non-worktree path is unchanged",
  );
});

// ── Part 2: ensureDbOpen returns structured failure context ──────────────

test("#2517: ensureDbOpen catch block surfaces diagnostic information", () => {
  const dynamicToolsSrc = readFileSync(
    join(import.meta.dirname, "..", "bootstrap", "dynamic-tools.ts"),
    "utf-8",
  );

  assert.ok(
    dynamicToolsSrc.includes("resolvedPath") || dynamicToolsSrc.includes("diagnostic"),
    "ensureDbOpen catch block surfaces diagnostic information (resolvedPath or diagnostic) instead of bare false (#2517)",
  );
});

// ── Part 3: post-unit does NOT artifact-retry on db_unavailable ──────────

test("#2517: post-unit artifact retry path checks DB availability to avoid retry loop", () => {
  const postUnitSrc = readFileSync(
    join(import.meta.dirname, "..", "auto-post-unit.ts"),
    "utf-8",
  );

  assert.ok(
    postUnitSrc.includes("db_unavailable") || postUnitSrc.includes("isDbAvailable"),
    "post-unit artifact retry path checks DB availability to avoid retry loop (#2517)",
  );
});

test("#2517: retry block explicitly guards against !isDbAvailable() before returning retry", () => {
  const postUnitSrc = readFileSync(
    join(import.meta.dirname, "..", "auto-post-unit.ts"),
    "utf-8",
  );

  const dbUnavailableGuard = postUnitSrc.match(
    /!triggerArtifactVerified\s*&&\s*!isDbAvailable\(\)/,
  );
  assert.ok(
    !!dbUnavailableGuard,
    "The retry block explicitly guards against !isDbAvailable() before returning 'retry' (#2517)",
  );
});
