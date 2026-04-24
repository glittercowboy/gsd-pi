/**
 * Tests for ensureNodeModulesSymlink — covers symlink reconciliation for
 * source installs (#3529) and pnpm-style merged node_modules (#3564).
 *
 * The pnpm-layout tests invoke the real production helpers
 * (`reconcileMergedNodeModules`, `hasMissingWorkspaceScopes`,
 * `mergedFingerprint`) which are exported from `resource-loader.ts`
 * specifically for these tests. Previously the tests contained inline
 * replicas of each helper (#4839); the production copies could drift
 * and the tests would still pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  hasMissingWorkspaceScopes,
  mergedFingerprint,
  reconcileMergedNodeModules,
} from "../resource-loader.ts";

// The real module captures packageRoot at load time — the merged-node-modules
// logic skips entries named basename(packageRoot). We mirror that basename in
// the fixtures so the "don't link the package root into itself" contract
// remains observable.
const realPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const realPackageRootBasename = basename(realPackageRoot);

// --- Integration tests via initResources (source/monorepo path) ---

test("initResources creates node_modules symlink in agent dir", async (t) => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-symlink-"));
  const fakeAgentDir = join(tmp, "agent");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  initResources(fakeAgentDir);

  const nodeModulesPath = join(fakeAgentDir, "node_modules");
  // Use lstatSync instead of existsSync — existsSync follows the symlink and
  // returns false for dangling symlinks (e.g. in worktrees without node_modules)
  let stat;
  try {
    stat = lstatSync(nodeModulesPath);
  } catch {
    assert.fail("node_modules symlink should exist after initResources");
  }
  assert.equal(stat.isSymbolicLink(), true, "node_modules should be a symlink, not a real directory");
});

test("initResources replaces a real directory blocking node_modules with a symlink", async (t) => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-symlink-realdir-"));
  const fakeAgentDir = join(tmp, "agent");

  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  initResources(fakeAgentDir);

  const nodeModulesPath = join(fakeAgentDir, "node_modules");

  // Remove the symlink and replace with a real directory
  rmSync(nodeModulesPath, { recursive: true, force: true });
  mkdirSync(nodeModulesPath, { recursive: true });

  const statBefore = lstatSync(nodeModulesPath);
  assert.equal(statBefore.isSymbolicLink(), false, "should be a real directory before fix");
  assert.equal(statBefore.isDirectory(), true, "should be a real directory before fix");

  initResources(fakeAgentDir);

  const statAfter = lstatSync(nodeModulesPath);
  assert.equal(statAfter.isSymbolicLink(), true, "should be a symlink after re-init");
});

// --- Unit tests for pnpm-style merged node_modules (#3564) ---
// These exercise the real reconcileMergedNodeModules helper against
// test-controlled hoisted/internal directories.

test("pnpm layout: merged node_modules contains entries from both hoisted and internal", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-pnpm-merge-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const hoisted = join(tmp, "node_modules");
  // Name the fake package-root directory the same as the real packageRoot
  // basename so the production code's self-skip guard engages.
  const pkgRoot = join(hoisted, realPackageRootBasename);
  const internal = join(pkgRoot, "node_modules");
  const agentNodeModules = join(tmp, "agent", "node_modules");

  // Create hoisted entries (external deps)
  mkdirSync(join(hoisted, "yaml"), { recursive: true });
  mkdirSync(join(hoisted, "@sinclair", "typebox"), { recursive: true });
  mkdirSync(join(hoisted, "@anthropic-ai", "sdk"), { recursive: true });
  mkdirSync(pkgRoot, { recursive: true });

  // Create internal entries (workspace packages)
  mkdirSync(join(internal, "@gsd", "pi-ai"), { recursive: true });
  mkdirSync(join(internal, "@gsd", "pi-coding-agent"), { recursive: true });
  mkdirSync(join(internal, "@gsd-build", "core"), { recursive: true });

  reconcileMergedNodeModules(agentNodeModules, hoisted, internal);

  // External deps resolve through hoisted symlinks
  assert.ok(existsSync(join(agentNodeModules, "yaml")), "yaml should resolve");
  assert.ok(existsSync(join(agentNodeModules, "@sinclair")), "@sinclair should resolve");
  assert.ok(existsSync(join(agentNodeModules, "@anthropic-ai")), "@anthropic-ai should resolve");

  // Workspace packages resolve through internal symlinks
  assert.ok(existsSync(join(agentNodeModules, "@gsd")), "@gsd should resolve");
  assert.ok(existsSync(join(agentNodeModules, "@gsd", "pi-ai")), "@gsd/pi-ai should resolve");
  assert.ok(existsSync(join(agentNodeModules, "@gsd-build")), "@gsd-build should resolve");

  // Package root itself is not symlinked into its own merged dir
  assert.ok(
    !existsSync(join(agentNodeModules, realPackageRootBasename)),
    "package root should not be in merged dir (self-link guard)",
  );

  // @gsd points to internal, not hoisted (internal overlay precedence)
  const gsdTarget = readlinkSync(join(agentNodeModules, "@gsd"));
  assert.equal(gsdTarget, join(internal, "@gsd"), "@gsd should point to internal node_modules");
});

test("pnpm layout: non-@gsd internal deps (e.g. @anthropic-ai) are included in merged dir", (t) => {
  // Regression: PR #3564 narrowed the internal overlay to @gsd* only,
  // dropping optionalDependencies like @anthropic-ai/claude-agent-sdk
  // that npm installs internally rather than hoisting.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-pnpm-internal-optional-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const hoisted = join(tmp, "node_modules");
  const pkgRoot = join(hoisted, realPackageRootBasename);
  const internal = join(pkgRoot, "node_modules");
  const agentNodeModules = join(tmp, "agent", "node_modules");

  // Hoisted: only external deps (no @anthropic-ai — it's internal-only)
  mkdirSync(join(hoisted, "yaml"), { recursive: true });
  mkdirSync(pkgRoot, { recursive: true });

  // Internal: workspace packages + optional dep that wasn't hoisted
  mkdirSync(join(internal, "@gsd", "pi-ai"), { recursive: true });
  mkdirSync(join(internal, "@anthropic-ai", "claude-agent-sdk"), { recursive: true });

  reconcileMergedNodeModules(agentNodeModules, hoisted, internal);

  // @anthropic-ai must be present — this is what broke in #3564
  assert.ok(
    existsSync(join(agentNodeModules, "@anthropic-ai")),
    "@anthropic-ai should resolve from internal",
  );
  assert.ok(
    existsSync(join(agentNodeModules, "@anthropic-ai", "claude-agent-sdk")),
    "@anthropic-ai/claude-agent-sdk should resolve",
  );

  // @gsd still resolves
  assert.ok(existsSync(join(agentNodeModules, "@gsd")), "@gsd should resolve");

  // Hoisted deps still resolve
  assert.ok(existsSync(join(agentNodeModules, "yaml")), "yaml should resolve");
});

test("hasMissingWorkspaceScopes detects pnpm layout", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-pnpm-detect-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const hoisted = join(tmp, "hoisted");
  const internal = join(tmp, "internal");

  // npm-style: @gsd exists in both hoisted and internal
  mkdirSync(join(hoisted, "@gsd"), { recursive: true });
  mkdirSync(join(internal, "@gsd"), { recursive: true });

  assert.equal(
    hasMissingWorkspaceScopes(hoisted, internal),
    false,
    "npm-style: no missing workspace scopes",
  );

  // pnpm-style: @gsd-build only in internal
  mkdirSync(join(internal, "@gsd-build"), { recursive: true });
  assert.equal(
    hasMissingWorkspaceScopes(hoisted, internal),
    true,
    "pnpm-style: @gsd-build missing from hoisted should be detected",
  );

  // Non-@gsd scope missing from hoisted does NOT trigger detection —
  // only @gsd* scopes are the contract signal.
  const tmp2 = mkdtempSync(join(tmpdir(), "gsd-pnpm-detect-non-gsd-"));
  t.after(() => rmSync(tmp2, { recursive: true, force: true }));
  const hoisted2 = join(tmp2, "hoisted");
  const internal2 = join(tmp2, "internal");
  mkdirSync(join(internal2, "@anthropic-ai"), { recursive: true });
  mkdirSync(hoisted2, { recursive: true });
  assert.equal(
    hasMissingWorkspaceScopes(hoisted2, internal2),
    false,
    "non-@gsd scope should not trigger missing-workspace detection",
  );

  // Missing internal directory returns false (no layout to reason about)
  const tmp3 = mkdtempSync(join(tmpdir(), "gsd-pnpm-detect-missing-"));
  t.after(() => rmSync(tmp3, { recursive: true, force: true }));
  assert.equal(
    hasMissingWorkspaceScopes(join(tmp3, "hoisted"), join(tmp3, "internal")),
    false,
    "missing internal dir returns false",
  );
});

test("merged node_modules marker uses fingerprint including directory entries", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-pnpm-marker-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const hoisted = join(tmp, "hoisted");
  const internal = join(tmp, "internal");
  mkdirSync(join(hoisted, "yaml"), { recursive: true });
  mkdirSync(join(hoisted, "@sinclair"), { recursive: true });
  mkdirSync(join(internal, "@gsd"), { recursive: true });

  const fingerprint = mergedFingerprint(hoisted, internal);

  assert.ok(fingerprint.includes("@sinclair"), "fingerprint should include hoisted entries");
  assert.ok(fingerprint.includes("yaml"), "fingerprint should include every hoisted entry");
  assert.ok(fingerprint.includes("@gsd"), "fingerprint should include internal entries");

  // Fingerprint must change when dependency set changes
  mkdirSync(join(hoisted, "new-package"), { recursive: true });
  const fingerprintAfter = mergedFingerprint(hoisted, internal);
  assert.notEqual(fingerprint, fingerprintAfter, "fingerprint should change when a hoisted dep is added");

  // Fingerprint is also sensitive to internal changes
  mkdirSync(join(internal, "@gsd-build"), { recursive: true });
  const fingerprintAfterInternal = mergedFingerprint(hoisted, internal);
  assert.notEqual(fingerprintAfter, fingerprintAfterInternal, "fingerprint should change when an internal dep is added");

  // The marker is written with the same fingerprint — check via reconcile.
  const agentNodeModules = join(tmp, "agent", "node_modules");
  reconcileMergedNodeModules(agentNodeModules, hoisted, internal);
  const markerPath = join(agentNodeModules, ".gsd-merged");
  assert.ok(existsSync(markerPath), "marker file should be written");
  const storedFingerprint = readFileSync(markerPath, "utf-8").trim();
  assert.equal(
    storedFingerprint,
    mergedFingerprint(hoisted, internal),
    "marker should match the current fingerprint",
  );

  // Second reconcile is a no-op (fast path) while fingerprint matches — we
  // observe this by pre-filling a sentinel file that survives only if the
  // function hits the fast path (it wipes the dir otherwise).
  const sentinel = join(agentNodeModules, "sentinel-from-previous-reconcile");
  writeFileSync(sentinel, "x");
  reconcileMergedNodeModules(agentNodeModules, hoisted, internal);
  assert.ok(existsSync(sentinel), "fast path should skip rebuild when fingerprint is unchanged");

  // Mutating the tree invalidates the fingerprint → sentinel is removed.
  mkdirSync(join(hoisted, "brand-new"), { recursive: true });
  reconcileMergedNodeModules(agentNodeModules, hoisted, internal);
  assert.ok(!existsSync(sentinel), "fingerprint mismatch should force rebuild");
  assert.ok(existsSync(join(agentNodeModules, "brand-new")), "newly-added hoisted dep should appear after rebuild");
});

test("reconcileMergedNodeModules creates symlinks (OS-appropriate type) to the source entries", (t) => {
  // Previously this test asserted on the string "junction" in the source
  // of resource-loader.ts. That passed on comments or renamed identifiers.
  // Assert on the actual filesystem outcome instead.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-pnpm-symtype-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const hoisted = join(tmp, "node_modules");
  const internal = join(hoisted, realPackageRootBasename, "node_modules");
  const agentNodeModules = join(tmp, "agent", "node_modules");
  mkdirSync(join(hoisted, "yaml"), { recursive: true });
  mkdirSync(join(internal, "@gsd", "pi-ai"), { recursive: true });

  reconcileMergedNodeModules(agentNodeModules, hoisted, internal);

  const hoistedLink = join(agentNodeModules, "yaml");
  const internalLink = join(agentNodeModules, "@gsd");
  assert.ok(lstatSync(hoistedLink).isSymbolicLink(), "hoisted entry must be a symlink");
  assert.ok(lstatSync(internalLink).isSymbolicLink(), "internal entry must be a symlink");

  // The 'junction' mode is Windows-only; on POSIX it behaves like a directory
  // symlink. Either way the link target resolves to the source directory.
  assert.equal(
    readlinkSync(hoistedLink),
    join(hoisted, "yaml"),
    "hoisted symlink must point at the source entry",
  );
  assert.equal(
    readlinkSync(internalLink),
    join(internal, "@gsd"),
    "internal symlink must point at the source entry",
  );
});
