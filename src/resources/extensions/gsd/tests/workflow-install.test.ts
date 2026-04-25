// gsd-2 — Regression tests for workflow-install path containment and ext fallback.

import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, sep as pathSep } from "node:path";
import { tmpdir } from "node:os";

import {
  installPlugin,
  uninstallPlugin,
  projectInstallDir,
  type FetchedContent,
  type InstallTarget,
} from "../workflow-install.ts";
import { parseWorkflowOverridesOnly } from "../commands/handlers/workflow.ts";

const tmpDirs: string[] = [];
let savedGsdHome: string | undefined;

function makeTmpBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-install-test-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = makeTmpBase();
});

afterEach(() => {
  if (savedGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = savedGsdHome;
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function fakeFetched(content: string, ext: ".yaml" | ".md" = ".yaml"): FetchedContent {
  return {
    url: `https://example.test/raw/foo${ext}`,
    filename: `foo${ext}`,
    ext,
    content,
    sha256: "deadbeef",
  };
}

describe("workflow-install path containment", () => {
  it("installPlugin rejects names with path separators", () => {
    const base = makeTmpBase();
    const target: InstallTarget = { dir: projectInstallDir(base), scope: "project" };
    const fetched = fakeFetched("name: ok\nsteps: []\n");
    assert.throws(() => installPlugin(target, fetched, "../evil"), /Invalid plugin name/);
    assert.throws(() => installPlugin(target, fetched, "evil/nested"), /Invalid plugin name/);
    assert.throws(() => installPlugin(target, fetched, ".."), /Invalid plugin name/);
  });

  it("uninstallPlugin rejects names with path separators", () => {
    const base = makeTmpBase();
    assert.throws(() => uninstallPlugin(base, "../evil"), /Invalid plugin name/);
    assert.throws(() => uninstallPlugin(base, "evil/nested"), /Invalid plugin name/);
  });

  it("installPlugin writes a safe name into the target dir", () => {
    const base = makeTmpBase();
    const target: InstallTarget = { dir: projectInstallDir(base), scope: "project" };
    const fetched = fakeFetched("name: ok\nsteps: []\n");
    const result = installPlugin(target, fetched, "safe-name");
    assert.ok(result.path.startsWith(target.dir + pathSep) || result.path === join(target.dir, "safe-name.yaml"));
    assert.ok(existsSync(result.path));
  });

  it("uninstallPlugin ignores provenance entries whose filename escapes the dir", () => {
    const base = makeTmpBase();
    const target: InstallTarget = { dir: projectInstallDir(base), scope: "project" };
    mkdirSync(target.dir, { recursive: true });
    // Seed a malicious provenance record.
    const bogus = {
      "hijack": {
        source: "https://example.test/x",
        installedAt: new Date().toISOString(),
        sha256: "0",
        filename: "../../etc/passwd",
      },
    };
    writeFileSync(join(target.dir, ".installed.json"), JSON.stringify(bogus), "utf-8");
    assert.throws(() => uninstallPlugin(base, "hijack"), /Invalid plugin name|Refusing to operate outside/);
  });
});

describe("parseWorkflowOverridesOnly", () => {
  it("keeps all k=v pairs when no name prefix is present", () => {
    const ov = parseWorkflowOverridesOnly("target=src/foo.ts newName=bar");
    assert.equal(ov.target, "src/foo.ts");
    assert.equal(ov.newName, "bar");
  });

  it("does not drop the first argument", () => {
    const ov = parseWorkflowOverridesOnly("a=1 b=2");
    assert.equal(ov.a, "1");
    assert.equal(ov.b, "2");
  });

  it("ignores tokens without `=`", () => {
    const ov = parseWorkflowOverridesOnly("a=1 bareword b=2");
    assert.equal(ov.a, "1");
    assert.equal(ov.b, "2");
    assert.equal(Object.keys(ov).length, 2);
  });
});
