import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  mkdirSync(join(extensionsDir, "gsd"), { recursive: true });
  writeFileSync(join(extensionsDir, "gsd", "index.ts"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir), false);

  writeFileSync(join(extensionsDir, "ask-user-questions.js"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir), false);

  writeFileSync(join(extensionsDir, "ask-user-questions.ts"), "export {};\n");
  assert.equal(hasStaleCompiledExtensionSiblings(extensionsDir), true);
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

test("initResources prunes stale top-level extension siblings next to bundled compiled extensions", async (t) => {
  const { initResources } = await import("../resource-loader.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resource-loader-sync-"));
  const fakeAgentDir = join(tmp, "agent");
  const bundledTsPath = join(fakeAgentDir, "extensions", "ask-user-questions.ts");
  const bundledJsPath = join(fakeAgentDir, "extensions", "ask-user-questions.js");

  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  initResources(fakeAgentDir);

  const bundledPath = existsSync(bundledJsPath)
    ? bundledJsPath
    : bundledTsPath;
  const staleSiblingPath = bundledPath.endsWith(".js")
    ? bundledTsPath
    : bundledJsPath;

  assert.equal(existsSync(bundledPath), true, "bundled top-level extension should exist");

  // Simulate a stale opposite-format sibling left from a previous sync/build mismatch.
  writeFileSync(staleSiblingPath, "export {};\n");
  assert.equal(existsSync(staleSiblingPath), true);

  initResources(fakeAgentDir);

  assert.equal(existsSync(staleSiblingPath), false, "stale top-level sibling should be removed during sync");
  assert.equal(existsSync(bundledPath), true, "bundled extension should remain after cleanup");
});
