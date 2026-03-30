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
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

// ── Part 1: resolveProjectRootDbPath handles symlink-resolved layout ─────

console.log("\n=== #2517 Part 1: resolveProjectRootDbPath symlink layout ===");

// Import the resolver directly
const { resolveProjectRootDbPath } = await import("../bootstrap/dynamic-tools.js");

// Standard worktree layout (already works)
const standardPath = `/home/user/myproject/.gsd/worktrees/M001/work`;
const standardResult = resolveProjectRootDbPath(standardPath);
assertEq(
  standardResult,
  join("/home/user/myproject", ".gsd", "gsd.db"),
  "Standard worktree layout resolves to project root DB path",
);

// Symlink-resolved layout (the regression — /.gsd/projects/<hash>/worktrees/...)
const symlinkPath = `/home/user/myproject/.gsd/projects/abc123def/worktrees/M001/work`;
const symlinkResult = resolveProjectRootDbPath(symlinkPath);
assertEq(
  symlinkResult,
  join("/home/user/myproject", ".gsd", "gsd.db"),
  "Symlink-resolved layout (/.gsd/projects/<hash>/worktrees/) resolves to project root DB path (#2517)",
);

// Windows-style separators for symlink layout
if (sep === "\\") {
  const winSymlinkPath = `C:\\Users\\dev\\project\\.gsd\\projects\\abc123def\\worktrees\\M001\\work`;
  const winResult = resolveProjectRootDbPath(winSymlinkPath);
  assertEq(
    winResult,
    join("C:\\Users\\dev\\project", ".gsd", "gsd.db"),
    "Windows symlink layout resolves correctly",
  );
} else {
  // On non-Windows, test forward-slash variant explicitly
  const fwdSymlinkPath = `/home/user/myproject/.gsd/projects/abc123def/worktrees/M001/work`;
  const fwdResult = resolveProjectRootDbPath(fwdSymlinkPath);
  assertEq(
    fwdResult,
    join("/home/user/myproject", ".gsd", "gsd.db"),
    "Forward-slash symlink layout resolves correctly on POSIX",
  );
}

// Edge: deeper nesting under projects/<hash>/worktrees
const deepSymlinkPath = `/home/user/myproject/.gsd/projects/deadbeef42/worktrees/M003/sub/dir`;
const deepResult = resolveProjectRootDbPath(deepSymlinkPath);
assertEq(
  deepResult,
  join("/home/user/myproject", ".gsd", "gsd.db"),
  "Deep symlink worktree path still resolves to project root DB",
);

// Non-worktree path should be unchanged
const normalPath = `/home/user/myproject`;
const normalResult = resolveProjectRootDbPath(normalPath);
assertEq(
  normalResult,
  join("/home/user/myproject", ".gsd", "gsd.db"),
  "Non-worktree path is unchanged",
);

// ── Part 2: ensureDbOpen returns structured failure context ──────────────

console.log("\n=== #2517 Part 2: ensureDbOpen structured diagnostics ===");

const dynamicToolsSrc = readFileSync(
  join(import.meta.dirname, "..", "bootstrap", "dynamic-tools.ts"),
  "utf-8",
);

// ensureDbOpen should return a structured result, not just boolean false
// Check that the catch block provides diagnostic information
assertTrue(
  dynamicToolsSrc.includes("resolvedPath") || dynamicToolsSrc.includes("diagnostic"),
  "ensureDbOpen catch block surfaces diagnostic information (resolvedPath or diagnostic) instead of bare false (#2517)",
);

// ── Part 3: post-unit does NOT artifact-retry on db_unavailable ──────────

console.log("\n=== #2517 Part 3: post-unit db_unavailable is infra-fatal ===");

const postUnitSrc = readFileSync(
  join(import.meta.dirname, "..", "auto-post-unit.ts"),
  "utf-8",
);

// The artifact retry block should check DB availability and skip retry
// when the DB is unavailable (infra failure, not a missing artifact).
assertTrue(
  postUnitSrc.includes("db_unavailable") || postUnitSrc.includes("isDbAvailable"),
  "post-unit artifact retry path checks DB availability to avoid retry loop (#2517)",
);

// Verify the retry block is guarded: when !isDbAvailable(), the code must
// NOT return "retry". The pattern should be: if (!verified && !isDbAvailable()) { skip }
// followed by else if (!verified) { ... return "retry" }
const dbUnavailableGuard = postUnitSrc.match(
  /!triggerArtifactVerified\s*&&\s*!isDbAvailable\(\)/,
);
assertTrue(
  !!dbUnavailableGuard,
  "The retry block explicitly guards against !isDbAvailable() before returning 'retry' (#2517)",
);

report();
