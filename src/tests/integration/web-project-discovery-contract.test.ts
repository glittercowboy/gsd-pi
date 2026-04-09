import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";


import { discoverProjects } from "../../web/project-discovery-service.ts";
import { detectMonorepo } from "../../web/bridge-service.ts";

// ---------------------------------------------------------------------------
// Fixture setup — standard multi-project root
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), "gsd-project-discovery-"));

// project-a: brownfield (package.json + .git)
const projectA = join(tempRoot, "project-a");
mkdirSync(projectA);
mkdirSync(join(projectA, ".git"));
writeFileSync(join(projectA, "package.json"), "{}");

// project-b: empty-gsd (.gsd folder, no milestones)
const projectB = join(tempRoot, "project-b");
mkdirSync(projectB);
mkdirSync(join(projectB, ".gsd"));

// project-c: brownfield (Cargo.toml)
const projectC = join(tempRoot, "project-c");
mkdirSync(projectC);
writeFileSync(join(projectC, "Cargo.toml"), "");

// project-d: blank (empty)
const projectD = join(tempRoot, "project-d");
mkdirSync(projectD);

// .hidden: should be excluded
mkdirSync(join(tempRoot, ".hidden"));

// node_modules: should be excluded
mkdirSync(join(tempRoot, "node_modules"));

// ---------------------------------------------------------------------------
// Fixture setup — monorepo roots
// ---------------------------------------------------------------------------

// monorepo-pnpm: detected via pnpm-workspace.yaml
const monorepoPnpm = mkdtempSync(join(tmpdir(), "gsd-mono-pnpm-"));
mkdirSync(join(monorepoPnpm, ".git"));
writeFileSync(join(monorepoPnpm, "package.json"), '{"name":"my-monorepo"}');
writeFileSync(join(monorepoPnpm, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"');
mkdirSync(join(monorepoPnpm, "packages"));
mkdirSync(join(monorepoPnpm, "packages", "pkg-a"));
mkdirSync(join(monorepoPnpm, "packages", "pkg-b"));

// monorepo-lerna: detected via lerna.json
const monorepoLerna = mkdtempSync(join(tmpdir(), "gsd-mono-lerna-"));
mkdirSync(join(monorepoLerna, ".git"));
writeFileSync(join(monorepoLerna, "package.json"), '{"name":"lerna-mono"}');
writeFileSync(join(monorepoLerna, "lerna.json"), '{"version":"1.0.0"}');
mkdirSync(join(monorepoLerna, "backend"));
mkdirSync(join(monorepoLerna, "frontend"));

// monorepo-workspaces: detected via package.json workspaces field
const monorepoWorkspaces = mkdtempSync(join(tmpdir(), "gsd-mono-ws-"));
mkdirSync(join(monorepoWorkspaces, ".git"));
writeFileSync(join(monorepoWorkspaces, "package.json"), '{"name":"ws-mono","workspaces":["packages/*"]}');
mkdirSync(join(monorepoWorkspaces, "packages"));
mkdirSync(join(monorepoWorkspaces, "packages", "core"));
mkdirSync(join(monorepoWorkspaces, "packages", "ui"));

// monorepo-turbo: detected via turbo.json
const monorepoTurbo = mkdtempSync(join(tmpdir(), "gsd-mono-turbo-"));
mkdirSync(join(monorepoTurbo, ".git"));
writeFileSync(join(monorepoTurbo, "package.json"), '{"name":"turbo-mono"}');
writeFileSync(join(monorepoTurbo, "turbo.json"), '{"pipeline":{}}');
mkdirSync(join(monorepoTurbo, "apps"));
mkdirSync(join(monorepoTurbo, "packages"));

// monorepo-nx: detected via nx.json
const monorepoNx = mkdtempSync(join(tmpdir(), "gsd-mono-nx-"));
mkdirSync(join(monorepoNx, ".git"));
writeFileSync(join(monorepoNx, "package.json"), '{"name":"nx-mono"}');
writeFileSync(join(monorepoNx, "nx.json"), '{}');
mkdirSync(join(monorepoNx, "libs"));
mkdirSync(join(monorepoNx, "apps"));

// non-monorepo: plain project with package.json (no workspaces, no marker files)
const plainProject = mkdtempSync(join(tmpdir(), "gsd-plain-project-"));
mkdirSync(join(plainProject, ".git"));
writeFileSync(join(plainProject, "package.json"), '{"name":"plain","dependencies":{}}');
mkdirSync(join(plainProject, "src"));

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(monorepoPnpm, { recursive: true, force: true });
  rmSync(monorepoLerna, { recursive: true, force: true });
  rmSync(monorepoWorkspaces, { recursive: true, force: true });
  rmSync(monorepoTurbo, { recursive: true, force: true });
  rmSync(monorepoNx, { recursive: true, force: true });
  rmSync(plainProject, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests — standard multi-project root
// ---------------------------------------------------------------------------

describe("project-discovery", () => {
  test("discovers exactly 4 project directories (excludes hidden + node_modules)", () => {
    const results = discoverProjects(tempRoot);
    assert.equal(results.length, 4, `Expected 4 projects, got ${results.length}: ${results.map(r => r.name).join(", ")}`);
  });

  test("results are sorted alphabetically by name", () => {
    const results = discoverProjects(tempRoot);
    const names = results.map(r => r.name);
    assert.deepStrictEqual(names, ["project-a", "project-b", "project-c", "project-d"]);
  });

  test("project-a is detected as brownfield with correct signals", () => {
    const results = discoverProjects(tempRoot);
    const a = results.find(r => r.name === "project-a");
    assert.ok(a, "project-a not found");
    assert.equal(a.kind, "brownfield");
    assert.equal(a.signals.hasPackageJson, true);
    assert.equal(a.signals.hasGitRepo, true);
  });

  test("project-b is detected as empty-gsd", () => {
    const results = discoverProjects(tempRoot);
    const b = results.find(r => r.name === "project-b");
    assert.ok(b, "project-b not found");
    assert.equal(b.kind, "empty-gsd");
    assert.equal(b.signals.hasGsdFolder, true);
  });

  test("project-c is detected as brownfield with hasCargo signal", () => {
    const results = discoverProjects(tempRoot);
    const c = results.find(r => r.name === "project-c");
    assert.ok(c, "project-c not found");
    assert.equal(c.kind, "brownfield");
    assert.equal(c.signals.hasCargo, true);
  });

  test("project-d is detected as blank", () => {
    const results = discoverProjects(tempRoot);
    const d = results.find(r => r.name === "project-d");
    assert.ok(d, "project-d not found");
    assert.equal(d.kind, "blank");
  });

  test("excludes .hidden and node_modules directories", () => {
    const results = discoverProjects(tempRoot);
    const names = results.map(r => r.name);
    assert.ok(!names.includes(".hidden"), ".hidden should be excluded");
    assert.ok(!names.includes("node_modules"), "node_modules should be excluded");
  });

  test("all entries have lastModified as a number > 0", () => {
    const results = discoverProjects(tempRoot);
    for (const entry of results) {
      assert.equal(typeof entry.lastModified, "number");
      assert.ok(entry.lastModified > 0, `${entry.name} lastModified should be > 0`);
    }
  });

  test("all entries have valid path and name", () => {
    const results = discoverProjects(tempRoot);
    for (const entry of results) {
      assert.ok(entry.path.startsWith(tempRoot), `${entry.name} path should start with tempRoot`);
      assert.ok(entry.name.length > 0, "name should not be empty");
    }
  });

  test("nonexistent path returns empty array", () => {
    const results = discoverProjects("/nonexistent/path/that/does/not/exist");
    assert.deepStrictEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// Tests — monorepo detection
// ---------------------------------------------------------------------------

describe("detectMonorepo", () => {
  test("detects pnpm-workspace.yaml", () => {
    assert.ok(detectMonorepo(monorepoPnpm));
  });

  test("detects lerna.json", () => {
    assert.ok(detectMonorepo(monorepoLerna));
  });

  test("detects package.json with workspaces field", () => {
    assert.ok(detectMonorepo(monorepoWorkspaces));
  });

  test("detects turbo.json", () => {
    assert.ok(detectMonorepo(monorepoTurbo));
  });

  test("detects nx.json", () => {
    assert.ok(detectMonorepo(monorepoNx));
  });

  test("does not detect plain project as monorepo", () => {
    assert.ok(!detectMonorepo(plainProject));
  });

  test("does not detect empty directory as monorepo", () => {
    assert.ok(!detectMonorepo(tempRoot));
  });
});

// ---------------------------------------------------------------------------
// Tests — monorepo root as devRoot returns single entry
// ---------------------------------------------------------------------------

describe("project-discovery with monorepo root as devRoot", () => {
  test("pnpm monorepo root returns single project entry", () => {
    const results = discoverProjects(monorepoPnpm);
    assert.equal(results.length, 1, `Expected 1 project, got ${results.length}: ${results.map(r => r.name).join(", ")}`);
    assert.equal(results[0].path, monorepoPnpm);
    assert.equal(results[0].name, basename(monorepoPnpm));
    assert.equal(results[0].signals.isMonorepo, true);
  });

  test("lerna monorepo root returns single project entry", () => {
    const results = discoverProjects(monorepoLerna);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, monorepoLerna);
    assert.equal(results[0].signals.isMonorepo, true);
  });

  test("npm/yarn workspaces monorepo root returns single project entry", () => {
    const results = discoverProjects(monorepoWorkspaces);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, monorepoWorkspaces);
    assert.equal(results[0].signals.isMonorepo, true);
  });

  test("turbo monorepo root returns single project entry", () => {
    const results = discoverProjects(monorepoTurbo);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, monorepoTurbo);
  });

  test("nx monorepo root returns single project entry", () => {
    const results = discoverProjects(monorepoNx);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, monorepoNx);
  });

  test("plain project (not monorepo) scans children normally", () => {
    // plainProject has .git, package.json, src/ — not a monorepo
    // Should scan children: just "src"
    const results = discoverProjects(plainProject);
    assert.ok(results.length >= 1, "should scan children for non-monorepo");
    assert.ok(results.some(r => r.name === "src"), "should find src directory");
  });

  test("monorepo entry has correct kind (brownfield when no .gsd)", () => {
    const results = discoverProjects(monorepoPnpm);
    assert.equal(results[0].kind, "brownfield");
  });
});
