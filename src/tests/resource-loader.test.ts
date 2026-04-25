import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";

function overrideHomeEnv(homeDir: string): () => void {
  const original = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  if (process.platform === "win32") {
    const parsedHome = parse(homeDir);
    process.env.HOMEDRIVE = parsedHome.root.replace(/[\\/]+$/, "");

    const homePath = homeDir.slice(parsedHome.root.length).replace(/\//g, "\\");
    process.env.HOMEPATH = homePath.startsWith("\\") ? homePath : `\\${homePath}`;
  }

  return () => {
    if (original.HOME === undefined) delete process.env.HOME; else process.env.HOME = original.HOME;
    if (original.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = original.USERPROFILE;
    if (original.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = original.HOMEDRIVE;
    if (original.HOMEPATH === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = original.HOMEPATH;
  };
}

test("getExtensionKey normalizes top-level .ts and .js entry names to the same key", async () => {
  const { getExtensionKey } = await import("../resource-loader.ts");
  const extensionsDir = "/tmp/extensions";

  assert.equal(
    getExtensionKey("/tmp/extensions/ask-user-questions.ts", extensionsDir),
    "ask-user-questions",
  );
  assert.equal(
    getExtensionKey("/tmp/extensions/ask-user-questions.js", extensionsDir),
    "ask-user-questions",
  );
  assert.equal(
    getExtensionKey("/tmp/extensions/gsd/index.js", extensionsDir),
    "gsd",
  );
});

test("hasStaleCompiledExtensionSiblings only flags top-level .ts/.js sibling pairs", async (t) => {
  const { hasStaleCompiledExtensionSiblings } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-"));
  const extensionsDir = join(tmp, "extensions");
  const bundledDir = join(tmp, "bundled");

  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  mkdirSync(bundledDir, { recursive: true });
  mkdirSync(join(extensionsDir, "gsd"), { recursive: true });
  writeFileSync(join(extensionsDir, "gsd", "index.ts"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir), false);

  writeFileSync(join(bundledDir, "ask-user-questions.js"), "export {};\n");
  writeFileSync(join(extensionsDir, "ask-user-questions.js"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir), false);

  writeFileSync(join(extensionsDir, "ask-user-questions.ts"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir), true);

  writeFileSync(join(bundledDir, "ask-user-questions.ts"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir, bundledDir), false);
});

test("buildResourceLoader excludes duplicate top-level pi extensions when bundled resources use .js", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-home-"));
  const piExtensionsDir = join(tmp, ".pi", "agent", "extensions");
  const fakeAgentDir = join(tmp, ".gsd", "agent");
  const restoreHomeEnv = overrideHomeEnv(tmp);

  t.after(() => {
    restoreHomeEnv();
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(piExtensionsDir, { recursive: true });
  writeFileSync(join(piExtensionsDir, "ask-user-questions.ts"), "export {};\n");
  writeFileSync(join(piExtensionsDir, "custom-extension.ts"), "export {};\n");

  const { buildResourceLoader } = await import("../resource-loader.ts");
  const loader = buildResourceLoader(fakeAgentDir) as { additionalExtensionPaths?: string[] };
  const additionalExtensionPaths = loader.additionalExtensionPaths ?? [];

  assert.equal(
    additionalExtensionPaths.some((entryPath) => entryPath.endsWith("ask-user-questions.ts")),
    false,
    "bundled compiled extensions should suppress duplicate pi top-level .ts siblings",
  );
  assert.equal(
    additionalExtensionPaths.some((entryPath) => entryPath.endsWith("custom-extension.ts")),
    true,
    "non-duplicate pi extensions should still load",
  );
});

test("initResources manifest tracks all bundled extension subdirectories including remote-questions (#2367)", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-manifest-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    initResources(fakeAgentDir, join(tmp, "skills"));

    const manifestPath = join(fakeAgentDir, "managed-resources.json");
    assert.equal(existsSync(manifestPath), true, "managed-resources.json should exist after initResources");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const installedDirs: string[] = manifest.installedExtensionDirs ?? [];

    // remote-questions uses mod.ts (not index.ts) as its entry point and has an
    // extension-manifest.json — it must still appear in the manifest so that
    // pruneRemovedBundledExtensions can track it across upgrades.
    assert.ok(
      installedDirs.includes("remote-questions"),
      `installedExtensionDirs should include remote-questions but got: [${installedDirs.join(", ")}]`,
    );

    // Also verify that the synced remote-questions directory actually exists in the agent dir
    assert.equal(
      existsSync(join(fakeAgentDir, "extensions", "remote-questions")),
      true,
      "remote-questions directory should be synced to agent extensions",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("initResources prunes stale top-level extension siblings next to bundled compiled extensions", async (t) => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-sync-"));
  const fakeAgentDir = join(tmp, "agent");
  const bundledTsPath = join(fakeAgentDir, "extensions", "ask-user-questions.ts");
  const bundledJsPath = join(fakeAgentDir, "extensions", "ask-user-questions.js");

  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  initResources(fakeAgentDir, join(tmp, "skills"));

  const bundledPath = existsSync(bundledJsPath)
    ? bundledJsPath
    : bundledTsPath;
  const staleSiblingPath = bundledPath.endsWith(".js")
    ? bundledTsPath
    : bundledJsPath;
  const siblingWasBundled = existsSync(staleSiblingPath);
  const staleContent = "export {};\n";

  assert.equal(existsSync(bundledPath), true, "bundled top-level extension should exist");

  // Simulate a stale opposite-format sibling left from a previous sync/build mismatch.
  writeFileSync(staleSiblingPath, staleContent);
  assert.equal(existsSync(staleSiblingPath), true);

  // Force a full resync so this test exercises the prune/copy path rather than
  // the early-return manifest fast path.
  const manifestPath = join(fakeAgentDir, "managed-resources.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.contentHash = "force-resync";
  writeFileSync(manifestPath, JSON.stringify(manifest));

  initResources(fakeAgentDir, join(tmp, "skills"));

  if (siblingWasBundled) {
    assert.equal(existsSync(staleSiblingPath), true, "bundled sibling should be restored during sync");
    assert.notEqual(readFileSync(staleSiblingPath, "utf-8"), staleContent, "bundled sibling should overwrite stale contents");
  } else {
    assert.equal(existsSync(staleSiblingPath), false, "stale top-level sibling should be removed during sync");
  }
  assert.equal(existsSync(bundledPath), true, "bundled extension should remain after cleanup");
});

test("pruneRemovedBundledExtensions removes stale subdirectory extensions not in current bundle", async () => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-prune-dirs-"));
  const fakeAgentDir = join(tmp, "agent");

  try {
    // First sync — seeds the agent dir and writes the manifest.
    initResources(fakeAgentDir, join(tmp, "skills"));

    // Simulate a stale subdirectory extension left from a previous GSD version.
    // This mirrors the mcporter scenario: it was bundled before, synced to
    // ~/.gsd/agent/extensions/, then removed from the bundle in a newer version.
    const staleExtDir = join(fakeAgentDir, "extensions", "mcporter");
    mkdirSync(staleExtDir, { recursive: true });
    writeFileSync(join(staleExtDir, "index.ts"), 'export default { name: "mcporter" };\n');
    assert.equal(existsSync(staleExtDir), true, "stale subdir extension should exist before prune");

    // Read the manifest to verify subdirectory extensions are tracked.
    const manifestPath = join(fakeAgentDir, "managed-resources.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    // The manifest must record installed extension directories so the pruner
    // can detect when one has been removed from the bundle.
    assert.ok(
      Array.isArray(manifest.installedExtensionDirs),
      "manifest should contain installedExtensionDirs array",
    );

    // Bump the manifest version to force a re-sync (simulates upgrading GSD).
    manifest.gsdVersion = "0.0.0-force-resync";
    manifest.contentHash = "0000000000000000";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    // Second sync — the bundle no longer contains mcporter/, so it must be pruned.
    initResources(fakeAgentDir, join(tmp, "skills"));

    assert.equal(
      existsSync(staleExtDir),
      false,
      "stale subdirectory extension (mcporter/) should be pruned after upgrade",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
