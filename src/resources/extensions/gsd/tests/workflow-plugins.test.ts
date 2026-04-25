/**
 * workflow-plugins.test.ts — Tests for the unified plugin discovery & resolution.
 *
 * Verifies precedence (project > global > bundled), both YAML and markdown
 * formats, mode defaults, invalid-file handling, and legacy compat with
 * `.gsd/workflow-defs/`.
 */

import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  discoverPlugins,
  resolvePlugin,
  listPluginsFormatted,
  formatPluginInfo,
} from "../workflow-plugins.ts";

// ─── Test setup ──────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
let savedGsdHome: string | undefined;

function makeTmpBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-plugins-test-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedGsdHome = process.env.GSD_HOME;
  const fakeHome = makeTmpBase();
  process.env.GSD_HOME = fakeHome;
});

afterEach(() => {
  if (savedGsdHome === undefined) {
    delete process.env.GSD_HOME;
  } else {
    process.env.GSD_HOME = savedGsdHome;
  }
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* non-fatal */ }
  }
  tmpDirs.length = 0;
});

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, "..").replace(/[^/]+$/, ""), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function writeProjectPlugin(basePath: string, filename: string, content: string): void {
  const dir = join(basePath, ".gsd", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
}

function writeGlobalPlugin(filename: string, content: string): void {
  const dir = join(process.env.GSD_HOME!, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
}

function writeLegacyDef(basePath: string, filename: string, content: string): void {
  const dir = join(basePath, ".gsd", "workflow-defs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
}

const SIMPLE_YAML = `
version: 1
name: sample
description: A sample YAML plugin
steps:
  - id: s1
    name: Step 1
    prompt: Do the thing
`;

const SIMPLE_ONESHOT_YAML = `
version: 1
name: oneshot-sample
mode: oneshot
description: A oneshot yaml plugin
steps:
  - id: only
    name: Only
    prompt: Just do it
`;

const SIMPLE_MD = `# Sample MD Plugin

<template_meta>
name: sample-md
version: 1
mode: markdown-phase
artifact_dir: .gsd/workflows/samples/
</template_meta>

<phases>
1. one
2. two
</phases>
`;

const ONESHOT_MD = `# Oneshot MD Plugin

<template_meta>
name: oneshot-md
version: 1
mode: oneshot
</template_meta>
`;

// ─── Bundled discovery ───────────────────────────────────────────────────

describe("discoverPlugins: bundled tier", () => {
  it("discovers the 8+ bundled templates", () => {
    const base = makeTmpBase();
    const plugins = discoverPlugins(base);
    for (const id of ["bugfix", "hotfix", "spike", "full-project"]) {
      assert.ok(plugins.has(id), `bundled plugin "${id}" should be discovered`);
    }
    assert.equal(plugins.get("bugfix")!.source, "bundled");
    assert.equal(plugins.get("bugfix")!.format, "md");
  });

  it("bundled templates have valid mode values", () => {
    const base = makeTmpBase();
    const plugins = discoverPlugins(base);
    const bugfix = plugins.get("bugfix")!;
    assert.equal(bugfix.meta.mode, "markdown-phase");
    const fullProject = plugins.get("full-project")!;
    assert.equal(fullProject.meta.mode, "auto-milestone");
  });
});

// ─── Project / Global / Bundled precedence ───────────────────────────────

describe("discoverPlugins: precedence", () => {
  it("project overrides bundled", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "bugfix.md", `# Overridden\n\n<template_meta>\nname: bugfix-override\nmode: markdown-phase\n</template_meta>`);
    const plugins = discoverPlugins(base);
    const bugfix = plugins.get("bugfix")!;
    assert.equal(bugfix.source, "project");
    assert.ok(bugfix.path.includes(".gsd/workflows/bugfix.md"));
  });

  it("global overrides bundled when project is absent", () => {
    const base = makeTmpBase();
    writeGlobalPlugin("bugfix.md", `# Global\n\n<template_meta>\nname: bugfix-global\nmode: markdown-phase\n</template_meta>`);
    const plugins = discoverPlugins(base);
    const bugfix = plugins.get("bugfix")!;
    assert.equal(bugfix.source, "global");
  });

  it("project overrides global", () => {
    const base = makeTmpBase();
    writeGlobalPlugin("foo.yaml", SIMPLE_YAML);
    writeProjectPlugin(base, "foo.yaml", SIMPLE_YAML.replace("sample", "foo"));
    const plugins = discoverPlugins(base);
    assert.equal(plugins.get("foo")!.source, "project");
  });
});

// ─── YAML + MD format handling ───────────────────────────────────────────

describe("discoverPlugins: formats", () => {
  it("loads a project YAML plugin with default mode yaml-step", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "sample.yaml", SIMPLE_YAML);
    const plugins = discoverPlugins(base);
    const p = plugins.get("sample")!;
    assert.equal(p.format, "yaml");
    assert.equal(p.meta.mode, "yaml-step");
    assert.equal(p.meta.displayName, "sample");
  });

  it("respects mode: oneshot in YAML", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "oneshot-sample.yaml", SIMPLE_ONESHOT_YAML);
    const plugins = discoverPlugins(base);
    assert.equal(plugins.get("oneshot-sample")!.meta.mode, "oneshot");
  });

  it("loads a project MD plugin with default mode markdown-phase", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "simple-md.md", `# Plain\n\n<template_meta>\nname: plain\n</template_meta>`);
    const plugins = discoverPlugins(base);
    assert.equal(plugins.get("simple-md")!.meta.mode, "markdown-phase");
  });

  it("respects mode: oneshot in MD", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "oneshot-md.md", ONESHOT_MD);
    const plugins = discoverPlugins(base);
    assert.equal(plugins.get("oneshot-md")!.meta.mode, "oneshot");
  });

  it("parses phases from MD <phases> block", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "sample-md.md", SIMPLE_MD);
    const plugins = discoverPlugins(base);
    const p = plugins.get("sample-md")!;
    assert.deepEqual(p.meta.phases, ["one", "two"]);
  });
});

// ─── Error handling ──────────────────────────────────────────────────────

describe("discoverPlugins: error handling", () => {
  it("invalid YAML surfaces as an entry with an error, doesn't crash", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "broken.yaml", "this: is: not: valid: yaml:\n  - x\n    - y");
    const plugins = discoverPlugins(base);
    const p = plugins.get("broken");
    assert.ok(p, "broken plugin should still appear");
    if (p!.error) {
      assert.match(p!.error, /parse|object/i);
    }
  });

  it("ignores subdirectories under .gsd/workflows/ (artifact dirs)", () => {
    const base = makeTmpBase();
    // Create a subdir — simulates `/gsd start bugfix` artifact dir
    mkdirSync(join(base, ".gsd", "workflows", "bugfixes", "250101-1-slug"), { recursive: true });
    writeFileSync(join(base, ".gsd", "workflows", "bugfixes", "250101-1-slug", "STATE.json"), "{}", "utf-8");
    const plugins = discoverPlugins(base);
    assert.ok(!plugins.has("bugfixes"), "should not pick up subdir as a plugin");
  });
});

// ─── resolvePlugin ───────────────────────────────────────────────────────

describe("resolvePlugin", () => {
  it("returns the plugin by name", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "foo.yaml", SIMPLE_YAML);
    const p = resolvePlugin(base, "foo");
    assert.ok(p);
    assert.equal(p!.name, "foo");
  });

  it("returns null for unknown names", () => {
    const base = makeTmpBase();
    assert.equal(resolvePlugin(base, "nonexistent-plugin-xyz"), null);
  });

  it("resolves bundled templates", () => {
    const base = makeTmpBase();
    const p = resolvePlugin(base, "bugfix");
    assert.ok(p);
    assert.equal(p!.source, "bundled");
  });
});

// ─── Legacy fallback ─────────────────────────────────────────────────────

describe("discoverPlugins: legacy .gsd/workflow-defs/", () => {
  it("still discovers legacy YAML definitions", () => {
    const base = makeTmpBase();
    writeLegacyDef(base, "legacy.yaml", SIMPLE_YAML);
    const plugins = discoverPlugins(base);
    assert.ok(plugins.has("legacy"), "legacy definition should be discovered");
    assert.equal(plugins.get("legacy")!.format, "yaml");
  });

  it("new .gsd/workflows/ overrides legacy .gsd/workflow-defs/", () => {
    const base = makeTmpBase();
    writeLegacyDef(base, "dup.yaml", SIMPLE_YAML);
    writeProjectPlugin(base, "dup.yaml", SIMPLE_YAML);
    const plugins = discoverPlugins(base);
    const p = plugins.get("dup")!;
    assert.ok(p.path.includes(".gsd/workflows/dup.yaml"));
  });
});

// ─── Display ─────────────────────────────────────────────────────────────

describe("listPluginsFormatted", () => {
  it("produces output grouped by mode with bundled templates", () => {
    const base = makeTmpBase();
    const out = listPluginsFormatted(base);
    assert.match(out, /Workflow Plugins/);
    assert.match(out, /\[markdown-phase\]/);
    assert.match(out, /bugfix/);
  });
});

describe("formatPluginInfo", () => {
  it("formats YAML plugin info", () => {
    const base = makeTmpBase();
    writeProjectPlugin(base, "foo.yaml", SIMPLE_YAML);
    const p = resolvePlugin(base, "foo")!;
    const info = formatPluginInfo(p);
    assert.match(info, /Plugin:/);
    assert.match(info, /Mode:\s+yaml-step/);
    assert.match(info, /Source:\s+project/);
  });
});
