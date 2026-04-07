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

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

describe("#2517: resolveProjectRootDbPath symlink layout", () => {
  // Import the resolver (dynamic because of .js extension)
  let resolveProjectRootDbPath: (p: string) => string;

  test("standard worktree layout resolves to project root DB path", async () => {
    const mod = await import("../bootstrap/dynamic-tools.js");
    resolveProjectRootDbPath = mod.resolveProjectRootDbPath;
    const standardPath = `/home/user/myproject/.gsd/worktrees/M001/work`;
    assert.deepStrictEqual(
      resolveProjectRootDbPath(standardPath),
      join("/home/user/myproject", ".gsd", "gsd.db"),
    );
  });

  test("symlink-resolved layout resolves to hash-level DB", async () => {
    const mod = await import("../bootstrap/dynamic-tools.js");
    resolveProjectRootDbPath = mod.resolveProjectRootDbPath;
    const symlinkPath = `/home/user/myproject/.gsd/projects/abc123def/worktrees/M001/work`;
    assert.deepStrictEqual(
      resolveProjectRootDbPath(symlinkPath),
      join("/home/user/myproject/.gsd/projects/abc123def", "gsd.db"),
    );
  });

  test("platform-specific separator variant resolves correctly", async () => {
    const mod = await import("../bootstrap/dynamic-tools.js");
    resolveProjectRootDbPath = mod.resolveProjectRootDbPath;
    if (sep === "\\") {
      const winPath = `C:\\Users\\dev\\project\\.gsd\\projects\\abc123def\\worktrees\\M001\\work`;
      assert.deepStrictEqual(
        resolveProjectRootDbPath(winPath),
        join("C:\\Users\\dev\\project\\.gsd\\projects\\abc123def", "gsd.db"),
      );
    } else {
      const fwdPath = `/home/user/myproject/.gsd/projects/abc123def/worktrees/M001/work`;
      assert.deepStrictEqual(
        resolveProjectRootDbPath(fwdPath),
        join("/home/user/myproject/.gsd/projects/abc123def", "gsd.db"),
      );
    }
  });

  test("deep symlink path resolves to hash-level DB", async () => {
    const mod = await import("../bootstrap/dynamic-tools.js");
    resolveProjectRootDbPath = mod.resolveProjectRootDbPath;
    const deepPath = `/home/user/myproject/.gsd/projects/deadbeef42/worktrees/M003/sub/dir`;
    assert.deepStrictEqual(
      resolveProjectRootDbPath(deepPath),
      join("/home/user/myproject/.gsd/projects/deadbeef42", "gsd.db"),
    );
  });

  test("non-worktree path resolves to standard .gsd/gsd.db", async () => {
    const mod = await import("../bootstrap/dynamic-tools.js");
    resolveProjectRootDbPath = mod.resolveProjectRootDbPath;
    assert.deepStrictEqual(
      resolveProjectRootDbPath(`/home/user/myproject`),
      join("/home/user/myproject", ".gsd", "gsd.db"),
    );
  });
});

describe("#2517: ensureDbOpen structured diagnostics", () => {
  test("ensureDbOpen catch block surfaces diagnostic info via logWarning", () => {
    const dynamicToolsSrc = readFileSync(
      join(import.meta.dirname, "..", "bootstrap", "dynamic-tools.ts"),
      "utf-8",
    );
    assert.ok(
      dynamicToolsSrc.includes("ensureDbOpen failed") && dynamicToolsSrc.includes("logWarning"),
    );
  });
});

describe("#2517: post-unit db_unavailable is infra-fatal", () => {
  const postUnitSrc = readFileSync(
    join(import.meta.dirname, "..", "auto-post-unit.ts"),
    "utf-8",
  );

  test("post-unit artifact retry path checks DB availability", () => {
    assert.ok(
      postUnitSrc.includes("db_unavailable") || postUnitSrc.includes("isDbAvailable"),
    );
  });

  test("retry block explicitly guards against !isDbAvailable()", () => {
    const dbUnavailableGuard = postUnitSrc.match(
      /!triggerArtifactVerified\s*&&\s*!isDbAvailable\(\)/,
    );
    assert.ok(dbUnavailableGuard);
  });
});
