/**
 * Unit tests for GSD Detection — project state and ecosystem detection.
 *
 * Exercises the pure detection functions in detection.ts:
 * - detectProjectState() with various folder layouts
 * - detectV1Planning() with real and fake .planning/ dirs
 * - detectProjectSignals() with different project types
 * - isFirstEverLaunch() / hasGlobalSetup()
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectProjectState,
  detectV1Planning,
  detectProjectSignals,
  scanProjectFiles,
} from "../detection.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-detection-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ─── detectProjectState ─────────────────────────────────────────────────────────

test("detectProjectState: empty directory returns state=none", (t) => {
  const dir = makeTempDir("empty");
  t.after(() => cleanup(dir));

  const result = detectProjectState(dir);
  assert.equal(result.state, "none");
  assert.equal(result.v1, undefined);
  assert.equal(result.v2, undefined);
});

test("detectProjectState: directory with .gsd/milestones/M001 returns v2-gsd", (t) => {
  const dir = makeTempDir("v2-gsd");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  const result = detectProjectState(dir);
  assert.equal(result.state, "v2-gsd");
  assert.ok(result.v2);
  assert.equal(result.v2!.milestoneCount, 1);
});

test("detectProjectState: directory with empty .gsd/milestones returns v2-gsd-empty", (t) => {
  const dir = makeTempDir("v2-empty");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  const result = detectProjectState(dir);
  assert.equal(result.state, "v2-gsd-empty");
  assert.ok(result.v2);
  assert.equal(result.v2!.milestoneCount, 0);
});

test("detectProjectState: directory with .planning/ returns v1-planning", (t) => {
  const dir = makeTempDir("v1-planning");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".planning", "phases", "01-setup"), { recursive: true });
  writeFileSync(join(dir, ".planning", "ROADMAP.md"), "# Roadmap\n", "utf-8");
  const result = detectProjectState(dir);
  assert.equal(result.state, "v1-planning");
  assert.ok(result.v1);
  assert.equal(result.v1!.hasRoadmap, true);
  assert.equal(result.v1!.hasPhasesDir, true);
  assert.equal(result.v1!.phaseCount, 1);
});

test("detectProjectState: v2 takes priority over v1 when both exist", (t) => {
  const dir = makeTempDir("both");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(dir, ".planning"), { recursive: true });
  const result = detectProjectState(dir);
  assert.equal(result.state, "v2-gsd");
});

test("detectProjectState: detects preferences in .gsd/", (t) => {
  const dir = makeTempDir("prefs");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "---\nversion: 1\n---\n", "utf-8");
  const result = detectProjectState(dir);
  assert.ok(result.v2);
  assert.equal(result.v2!.hasPreferences, true);
});

// ─── detectV1Planning ───────────────────────────────────────────────────────────

test("detectV1Planning: returns null for missing .planning/", (t) => {
  const dir = makeTempDir("no-v1");
  t.after(() => cleanup(dir));

  assert.equal(detectV1Planning(dir), null);
});

test("detectV1Planning: returns null when .planning is a file", (t) => {
  const dir = makeTempDir("v1-file");
  t.after(() => cleanup(dir));

  writeFileSync(join(dir, ".planning"), "not a directory", "utf-8");
  assert.equal(detectV1Planning(dir), null);
});

test("detectV1Planning: detects phases directory with multiple phases", (t) => {
  const dir = makeTempDir("v1-phases");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".planning", "phases", "01-setup"), { recursive: true });
  mkdirSync(join(dir, ".planning", "phases", "02-core"), { recursive: true });
  mkdirSync(join(dir, ".planning", "phases", "03-deploy"), { recursive: true });
  const result = detectV1Planning(dir);
  assert.ok(result);
  assert.equal(result!.phaseCount, 3);
  assert.equal(result!.hasPhasesDir, true);
});

test("detectV1Planning: detects ROADMAP.md", (t) => {
  const dir = makeTempDir("v1-roadmap");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".planning"), { recursive: true });
  writeFileSync(join(dir, ".planning", "ROADMAP.md"), "# Roadmap", "utf-8");
  const result = detectV1Planning(dir);
  assert.ok(result);
  assert.equal(result!.hasRoadmap, true);
  assert.equal(result!.hasPhasesDir, false);
  assert.equal(result!.phaseCount, 0);
});

// ─── detectProjectSignals ───────────────────────────────────────────────────────

test("detectProjectSignals: empty directory", (t) => {
  const dir = makeTempDir("signals-empty");
  t.after(() => cleanup(dir));

  const signals = detectProjectSignals(dir);
  assert.deepEqual(signals.detectedFiles, []);
  assert.equal(signals.isGitRepo, false);
  assert.equal(signals.isMonorepo, false);
  assert.equal(signals.primaryLanguage, undefined);
  assert.equal(signals.hasCI, false);
  assert.equal(signals.hasTests, false);
  assert.deepEqual(signals.verificationCommands, []);
});

test("detectProjectSignals: Node.js project", (t) => {
  const dir = makeTempDir("signals-node");
  t.after(() => cleanup(dir));

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-project",
      scripts: {
        test: "jest",
        build: "tsc",
        lint: "eslint .",
      },
    }),
    "utf-8",
  );
  writeFileSync(join(dir, "package-lock.json"), "{}", "utf-8");
  mkdirSync(join(dir, ".git"), { recursive: true });

  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("package.json"));
  assert.equal(signals.primaryLanguage, "javascript/typescript");
  assert.equal(signals.isGitRepo, true);
  assert.equal(signals.packageManager, "npm");
  assert.ok(signals.verificationCommands.includes("npm test"));
  assert.ok(signals.verificationCommands.some(c => c.includes("build")));
  assert.ok(signals.verificationCommands.some(c => c.includes("lint")));
});

test("detectProjectSignals: Rust project", (t) => {
  const dir = makeTempDir("signals-rust");
  t.after(() => cleanup(dir));

  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "test"\n', "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("Cargo.toml"));
  assert.equal(signals.primaryLanguage, "rust");
  assert.ok(signals.verificationCommands.includes("cargo test"));
  assert.ok(signals.verificationCommands.includes("cargo clippy"));
});

test("detectProjectSignals: Go project", (t) => {
  const dir = makeTempDir("signals-go");
  t.after(() => cleanup(dir));

  writeFileSync(join(dir, "go.mod"), "module example.com/test\n", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("go.mod"));
  assert.equal(signals.primaryLanguage, "go");
  assert.ok(signals.verificationCommands.includes("go test ./..."));
});

test("detectProjectSignals: Python project", (t) => {
  const dir = makeTempDir("signals-python");
  t.after(() => cleanup(dir));

  writeFileSync(join(dir, "pyproject.toml"), "[tool.poetry]\n", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("pyproject.toml"));
  assert.equal(signals.primaryLanguage, "python");
  assert.ok(signals.verificationCommands.includes("pytest"));
});

test("detectProjectSignals: monorepo detection via workspaces", (t) => {
  const dir = makeTempDir("signals-monorepo");
  t.after(() => cleanup(dir));

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
    "utf-8",
  );
  const signals = detectProjectSignals(dir);
  assert.equal(signals.isMonorepo, true);
});

test("detectProjectSignals: monorepo detection via turbo.json", (t) => {
  const dir = makeTempDir("signals-turbo");
  t.after(() => cleanup(dir));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
  writeFileSync(join(dir, "turbo.json"), "{}", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.equal(signals.isMonorepo, true);
});

test("detectProjectSignals: CI detection", (t) => {
  const dir = makeTempDir("signals-ci");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  const signals = detectProjectSignals(dir);
  assert.equal(signals.hasCI, true);
});

test("detectProjectSignals: test detection via jest config", (t) => {
  const dir = makeTempDir("signals-tests");
  t.after(() => cleanup(dir));

  writeFileSync(join(dir, "jest.config.ts"), "export default {}", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.equal(signals.hasTests, true);
});

test("detectProjectSignals: package manager detection", (t) => {
  const dir1 = makeTempDir("pm-pnpm");
  const dir2 = makeTempDir("pm-yarn");
  const dir3 = makeTempDir("pm-bun");
  t.after(() => {
    cleanup(dir1);
    cleanup(dir2);
    cleanup(dir3);
  });

  writeFileSync(join(dir1, "pnpm-lock.yaml"), "", "utf-8");
  writeFileSync(join(dir1, "package.json"), "{}", "utf-8");
  assert.equal(detectProjectSignals(dir1).packageManager, "pnpm");

  writeFileSync(join(dir2, "yarn.lock"), "", "utf-8");
  writeFileSync(join(dir2, "package.json"), "{}", "utf-8");
  assert.equal(detectProjectSignals(dir2).packageManager, "yarn");

  writeFileSync(join(dir3, "bun.lockb"), "", "utf-8");
  writeFileSync(join(dir3, "package.json"), "{}", "utf-8");
  assert.equal(detectProjectSignals(dir3).packageManager, "bun");
});

test("detectProjectSignals: skips default npm test script", (t) => {
  const dir = makeTempDir("signals-default-test");
  t.after(() => cleanup(dir));

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test",
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
    "utf-8",
  );
  const signals = detectProjectSignals(dir);
  // Should NOT include the default npm test script
  assert.equal(
    signals.verificationCommands.some(c => c.includes("test")),
    false,
  );
});

test("detectProjectSignals: pnpm uses pnpm commands", (t) => {
  const dir = makeTempDir("signals-pnpm-cmds");
  t.after(() => cleanup(dir));

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test",
      scripts: { test: "vitest", build: "tsc" },
    }),
    "utf-8",
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.verificationCommands.includes("pnpm test"));
  assert.ok(signals.verificationCommands.includes("pnpm run build"));
});

test("detectProjectSignals: Ruby project with rspec", (t) => {
  const dir = makeTempDir("signals-ruby");
  t.after(() => cleanup(dir));

  writeFileSync(join(dir, "Gemfile"), 'source "https://rubygems.org"\n', "utf-8");
  mkdirSync(join(dir, "spec"), { recursive: true });
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("Gemfile"));
  assert.equal(signals.primaryLanguage, "ruby");
  assert.ok(signals.verificationCommands.includes("bundle exec rspec"));
});

test("detectProjectSignals: Makefile with test target", (t) => {
  const dir = makeTempDir("signals-make");
  t.after(() => cleanup(dir));

  writeFileSync(join(dir, "Makefile"), "test:\n\tgo test ./...\n\nbuild:\n\tgo build\n", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("Makefile"));
  assert.ok(signals.verificationCommands.includes("make test"));
});

test("detectProjectSignals: SQLite file detection via extensions", () => {
  const dir = makeTempDir("signals-sqlite");
  try {
    writeFileSync(join(dir, "app.sqlite3"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sqlite"), "should add synthetic *.sqlite marker");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: SQL file detection", () => {
  const dir = makeTempDir("signals-sql");
  try {
    writeFileSync(join(dir, "migrations.sql"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sql"), "should add synthetic *.sql marker");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: nested SQL file detection", () => {
  const dir = makeTempDir("signals-sql-nested");
  try {
    mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    writeFileSync(join(dir, "db", "migrations", "001_init.sql"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sql"), "should detect nested SQL files");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: .db file triggers SQLite detection", () => {
  const dir = makeTempDir("signals-db");
  try {
    writeFileSync(join(dir, "data.db"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sqlite"), "should add synthetic *.sqlite marker for .db files");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: no SQLite markers without matching files", () => {
  const dir = makeTempDir("signals-no-sqlite");
  try {
    writeFileSync(join(dir, "package.json"), "{}", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("*.sqlite"), "should not have *.sqlite marker");
    assert.ok(!signals.detectedFiles.includes("*.sql"), "should not have *.sql marker");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: .NET project via .csproj extension", () => {
  const dir = makeTempDir("signals-dotnet");
  try {
    writeFileSync(join(dir, "MyApp.csproj"), "<Project></Project>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.csproj"), "should add synthetic *.csproj marker");
    assert.equal(signals.primaryLanguage, "csharp");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: nested .csproj detection", () => {
  const dir = makeTempDir("signals-dotnet-nested");
  try {
    mkdirSync(join(dir, "src", "App"), { recursive: true });
    writeFileSync(join(dir, "src", "App", "App.csproj"), "<Project></Project>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.csproj"), "should detect nested .csproj files");
    assert.equal(signals.primaryLanguage, "csharp");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: .NET project via .sln extension", () => {
  const dir = makeTempDir("signals-sln");
  try {
    writeFileSync(join(dir, "MyApp.sln"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sln"), "should add synthetic *.sln marker for .sln files");
    assert.equal(signals.primaryLanguage, "dotnet");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: F# project via .fsproj extension", () => {
  const dir = makeTempDir("signals-fsharp");
  try {
    writeFileSync(join(dir, "MyApp.fsproj"), "<Project></Project>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.fsproj"), "should add synthetic *.fsproj marker");
    assert.equal(signals.primaryLanguage, "fsharp");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Angular project via angular.json", () => {
  const dir = makeTempDir("signals-angular");
  try {
    writeFileSync(join(dir, "angular.json"), "{}", "utf-8");
    writeFileSync(join(dir, "package.json"), "{}", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("angular.json"));
    assert.equal(signals.primaryLanguage, "javascript/typescript");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Next.js project via next.config.ts", () => {
  const dir = makeTempDir("signals-nextjs");
  try {
    writeFileSync(join(dir, "next.config.ts"), "export default {}", "utf-8");
    writeFileSync(join(dir, "package.json"), "{}", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("next.config.ts"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: nested Next.js config via packages/web/next.config.ts", () => {
  const dir = makeTempDir("signals-nextjs-nested");
  try {
    mkdirSync(join(dir, "packages", "web"), { recursive: true });
    writeFileSync(join(dir, "packages", "web", "next.config.ts"), "export default {}", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("next.config.ts"), "should detect nested Next.js config");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Flutter project via pubspec.yaml", () => {
  const dir = makeTempDir("signals-flutter");
  try {
    writeFileSync(join(dir, "pubspec.yaml"), "name: my_app", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("pubspec.yaml"));
    assert.equal(signals.primaryLanguage, "dart/flutter");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Django project via manage.py", () => {
  const dir = makeTempDir("signals-django");
  try {
    writeFileSync(join(dir, "manage.py"), "#!/usr/bin/env python", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("manage.py"));
    assert.equal(signals.primaryLanguage, "python");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: nested Django manage.py", () => {
  const dir = makeTempDir("signals-django-nested");
  try {
    mkdirSync(join(dir, "services", "api"), { recursive: true });
    writeFileSync(join(dir, "services", "api", "manage.py"), "#!/usr/bin/env python", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("manage.py"), "should detect nested manage.py");
    assert.equal(signals.primaryLanguage, "python");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Docker project via Dockerfile", () => {
  const dir = makeTempDir("signals-docker");
  try {
    writeFileSync(join(dir, "Dockerfile"), "FROM node:18", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("Dockerfile"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Terraform project via main.tf", () => {
  const dir = makeTempDir("signals-terraform");
  try {
    writeFileSync(join(dir, "main.tf"), 'provider "aws" {}', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("main.tf"));
  } finally {
    cleanup(dir);
  }
});

// ── QA4/QA5 — new detection tests ──────────────────────────────────────────

test("detectProjectSignals: Vue.js via .vue files in src/", () => {
  const dir = makeTempDir("signals-vue");
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"vue-app"}', "utf-8");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "App.vue"), "<template></template>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.vue"), "should add *.vue synthetic marker");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Vue.js via nested .vue file in src/components/", () => {
  const dir = makeTempDir("signals-vue-nested");
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"vue-app"}', "utf-8");
    mkdirSync(join(dir, "src", "components"), { recursive: true });
    writeFileSync(join(dir, "src", "components", "Card.vue"), "<template></template>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.vue"), "should detect nested .vue files");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Vue CLI via vue.config.js", () => {
  const dir = makeTempDir("signals-vue-cli");
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"vue-cli-app"}', "utf-8");
    writeFileSync(join(dir, "vue.config.js"), "module.exports = {};", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("vue.config.js"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: requirements.txt sets Python language", () => {
  const dir = makeTempDir("signals-requirements");
  try {
    writeFileSync(join(dir, "requirements.txt"), "flask==3.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("requirements.txt"));
    assert.equal(signals.primaryLanguage, "python");
    assert.ok(signals.verificationCommands.includes("pytest"), "should suggest pytest for requirements.txt projects");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Android project via app/build.gradle", () => {
  const dir = makeTempDir("signals-android");
  try {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "build.gradle"), "apply plugin: 'com.android.application'", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("app/build.gradle"));
    assert.equal(signals.primaryLanguage, "java/kotlin");
    assert.ok(!signals.detectedFiles.includes("build.gradle"), "should not collapse Android app/build.gradle into generic build.gradle");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: nested app/build.gradle normalizes to Android marker", () => {
  const dir = makeTempDir("signals-android-nested");
  try {
    mkdirSync(join(dir, "apps", "mobile", "app"), { recursive: true });
    writeFileSync(join(dir, "apps", "mobile", "app", "build.gradle"), "apply plugin: 'com.android.application'", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("app/build.gradle"), "should detect nested Android app/build.gradle");
    assert.ok(!signals.detectedFiles.includes("build.gradle"), "should not emit generic build.gradle marker for nested Android modules");
    assert.equal(signals.primaryLanguage, "java/kotlin");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Unity project via ProjectSettings/ProjectVersion.txt", () => {
  const dir = makeTempDir("signals-unity");
  try {
    mkdirSync(join(dir, "ProjectSettings"), { recursive: true });
    writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("ProjectSettings/ProjectVersion.txt"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Godot project via project.godot", () => {
  const dir = makeTempDir("signals-godot");
  try {
    writeFileSync(join(dir, "project.godot"), "[application]", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("project.godot"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Airflow via airflow.cfg", () => {
  const dir = makeTempDir("signals-airflow");
  try {
    writeFileSync(join(dir, "airflow.cfg"), "[core]\ndags_folder = ./dags", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("airflow.cfg"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Kubernetes via Chart.yaml (Helm)", () => {
  const dir = makeTempDir("signals-k8s");
  try {
    writeFileSync(join(dir, "Chart.yaml"), "apiVersion: v2\nname: my-chart", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("Chart.yaml"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Blockchain via hardhat.config.ts", () => {
  const dir = makeTempDir("signals-blockchain");
  try {
    writeFileSync(join(dir, "hardhat.config.ts"), 'import "@nomiclabs/hardhat-ethers"', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("hardhat.config.ts"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: CI/CD via .github/workflows", () => {
  const dir = makeTempDir("signals-cicd");
  try {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes(".github/workflows"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Tailwind via tailwind.config.ts", () => {
  const dir = makeTempDir("signals-tailwind");
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"tw-app"}', "utf-8");
    writeFileSync(join(dir, "tailwind.config.ts"), "export default {};", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("tailwind.config.ts"));
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI detected via requirements.txt dependency", () => {
  const dir = makeTempDir("signals-fastapi-req");
  try {
    writeFileSync(join(dir, "requirements.txt"), "fastapi==0.115.0\nuvicorn[standard]\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "should add dep:fastapi marker");
    assert.equal(signals.primaryLanguage, "python");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI detected via pyproject.toml dependency", () => {
  const dir = makeTempDir("signals-fastapi-pyproject");
  try {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi>=0.100"]\n', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "should add dep:fastapi marker");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI detected with PEP 508 ~= operator", () => {
  const dir = makeTempDir("signals-fastapi-compatible-release");
  try {
    writeFileSync(join(dir, "requirements.txt"), "fastapi~=0.115\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "~= should count as a FastAPI dependency");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: pyproject metadata mention does not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-pyproject-metadata");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\nname = "example"\nkeywords = ["fastapi"]\ndependencies = ["flask>=3.0"]\n',
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "metadata-only mentions should not trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: pyproject dependency table extras do not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-pyproject-table-extra");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[tool.poetry.dependencies]\npython = "^3.12"\nmy-sdk = { version = "^1.0", extras = ["fastapi"] }\n',
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "dependency table extras should not imply FastAPI framework usage");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Poetry group FastAPI dependency does not imply app framework usage", () => {
  const dir = makeTempDir("signals-fastapi-poetry-group");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[tool.poetry.dependencies]\npython = "^3.12"\nflask = "^3.0"\n\n[tool.poetry.group.dev.dependencies]\nfastapi = "^0.115"\n',
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "Poetry dev-group dependencies should not imply FastAPI app usage");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: pyproject optional-dependency group name does not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-pyproject-extra-name");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\ndependencies = ["flask>=3.0"]\n\n[project.optional-dependencies]\nfastapi = ["orjson>=3"]\n',
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "optional-dependency extra names should not trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: pyproject multiline optional dependency emits dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-pyproject-optional-multiline");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\ndependencies = ["flask>=3.0"]\n\n[project.optional-dependencies]\napi = [\n  "fastapi>=0.115",\n  "uvicorn>=0.30",\n]\n',
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "multiline optional dependency arrays should trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI direct reference with @ emits dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-direct-reference");
  try {
    writeFileSync(join(dir, "requirements.txt"), "fastapi @ https://example.com/fastapi.whl\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "direct-reference dependencies should trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI detected via requirements.in", () => {
  const dir = makeTempDir("signals-fastapi-requirements-in");
  try {
    writeFileSync(join(dir, "requirements.in"), "fastapi>=0.115\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "requirements.in should trigger FastAPI detection");
    assert.ok(signals.detectedFiles.includes("requirements.txt"), "requirements.in should normalize to requirements.txt marker");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI detected via nested requirements/base.in", () => {
  const dir = makeTempDir("signals-fastapi-requirements-dir-in");
  try {
    mkdirSync(join(dir, "requirements"), { recursive: true });
    writeFileSync(join(dir, "requirements", "base.in"), "fastapi>=0.115\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "requirements/base.in should trigger FastAPI detection");
    assert.ok(signals.detectedFiles.includes("requirements.txt"), "requirements/base.in should normalize to requirements.txt marker");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI comments do not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-comment");
  try {
    writeFileSync(join(dir, "requirements.txt"), "# maybe evaluate fastapi later\nflask==3.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "comments should not trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI inline comments do not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-inline-comment");
  try {
    writeFileSync(join(dir, "requirements.txt"), "flask==3.0  # maybe fastapi later\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "inline comments should not trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: fastapi-* packages do not trigger dep:fastapi without fastapi itself", () => {
  const dir = makeTempDir("signals-fastapi-suffix-only");
  try {
    writeFileSync(join(dir, "requirements.txt"), "fastapi-users==13.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "fastapi-* packages alone should not imply FastAPI framework usage");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: dependency extras mentioning fastapi do not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-extra-only");
  try {
    writeFileSync(join(dir, "requirements.txt"), "my-sdk[fastapi]>=1.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "dependency extras should not imply FastAPI framework usage");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Django project does NOT get dep:fastapi marker", () => {
  const dir = makeTempDir("signals-django-no-fastapi");
  try {
    writeFileSync(join(dir, "requirements.txt"), "django==5.0\ncelery\n", "utf-8");
    writeFileSync(join(dir, "manage.py"), "#!/usr/bin/env python", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "should NOT add dep:fastapi for Django");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI detected case-insensitively (PyPI canonical name)", () => {
  const dir = makeTempDir("signals-fastapi-case");
  try {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["FastAPI>=0.100"]\n', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "should detect FastAPI (mixed case)");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: FastAPI detected via nested service requirements.txt", () => {
  const dir = makeTempDir("signals-fastapi-nested");
  try {
    mkdirSync(join(dir, "services", "api"), { recursive: true });
    writeFileSync(join(dir, "services", "api", "requirements.txt"), "fastapi==0.115.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "should detect FastAPI in nested service requirements.txt");
    assert.ok(signals.detectedFiles.includes("requirements.txt"), "should normalize nested requirements.txt marker");
    assert.equal(signals.primaryLanguage, "python");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: nested Prisma schema normalizes to prisma/schema.prisma", () => {
  const dir = makeTempDir("signals-prisma-nested");
  try {
    mkdirSync(join(dir, "services", "api", "prisma"), { recursive: true });
    writeFileSync(join(dir, "services", "api", "prisma", "schema.prisma"), "datasource db { provider = \"sqlite\" }", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("prisma/schema.prisma"), "should detect nested Prisma schema");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: nested Spring Boot Gradle service emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-gradle-nested");
  try {
    mkdirSync(join(dir, "services", "api"), { recursive: true });
    writeFileSync(
      join(dir, "services", "api", "build.gradle"),
      "plugins { id 'org.springframework.boot' version '3.2.0' }",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "should detect nested Spring Boot Gradle service");
    assert.equal(signals.primaryLanguage, "java/kotlin");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: legacy apply plugin syntax emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-apply-plugin");
  try {
    writeFileSync(join(dir, "build.gradle"), "apply plugin: 'org.springframework.boot'", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "apply plugin syntax should trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: nested Spring Boot Kotlin DSL service still uses neutral java/kotlin language hint", () => {
  const dir = makeTempDir("signals-spring-gradle-kts-nested");
  try {
    mkdirSync(join(dir, "services", "api"), { recursive: true });
    writeFileSync(
      join(dir, "services", "api", "build.gradle.kts"),
      "plugins { id(\"org.springframework.boot\") version \"3.2.0\" }",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"));
    assert.equal(signals.primaryLanguage, "java/kotlin");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Android Gradle project does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-android-no-spring");
  try {
    writeFileSync(join(dir, "build.gradle"), "plugins { id 'com.android.application' }", "utf-8");
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "build.gradle"), "plugins { id 'com.android.application' }", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "Android Gradle files should not trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Android inline comments do not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-android-inline-comment");
  try {
    writeFileSync(join(dir, "build.gradle"), "plugins { id 'com.android.application' } // spring-boot maybe later", "utf-8");
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "build.gradle"), "plugins { id 'com.android.application' }", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "inline comments should not trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: build metadata mentioning spring-boot does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-metadata-only");
  try {
    writeFileSync(join(dir, "build.gradle"), 'def notes = "spring-boot migration planned later"', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "arbitrary metadata text should not trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Maven artifactId alone does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-maven-artifact-only");
  try {
    writeFileSync(
      join(dir, "pom.xml"),
      '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>spring-boot-tools</artifactId></project>',
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "artifactId alone should not imply Spring Boot");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Spring Boot version-catalog alias emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(libs.plugins.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[plugins]\nbackend-web = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "should detect Spring Boot via version-catalog alias");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: commented Spring Boot alias in libs.versions.toml does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-comment");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(libs.plugins.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[plugins]\n# backend-web = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "commented aliases should not trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: unused Spring Boot alias in libs.versions.toml does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-unused");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(libs.plugins.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[plugins]\nother-plugin = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "unused Spring Boot aliases should not trigger detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: spring-like alias name without Spring Boot id does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-false-alias");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(libs.plugins.spring.boot.conventions) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[plugins]\nspring-boot-conventions = { id = 'com.example.conventions', version = '1.0.0' }\n",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "spring-looking alias names should not imply Spring Boot without matching id");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Spring Boot version-catalog library alias emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-library");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "dependencies { implementation(libs.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[libraries]\nbackend-web = { module = 'org.springframework.boot:spring-boot-starter-web', version = '3.2.0' }\n",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "Spring Boot library aliases should trigger detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Spring Boot version-catalog bundle alias emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-bundle");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "dependencies { implementation(libs.bundles.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[libraries]\nspring-boot-starter-web = { module = 'org.springframework.boot:spring-boot-starter-web', version = '3.2.0' }\n\n[bundles]\nbackend-web = ['spring-boot-starter-web']\n",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "Spring Boot bundle aliases should trigger detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Spring Boot custom version-catalog accessor emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-custom-accessor");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(backend.plugins.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "backend.versions.toml"),
      "[plugins]\nweb = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "custom version-catalog accessors should trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});

test("detectProjectSignals: Spring Boot settings-defined catalog accessor emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-settings-accessor");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(
      join(dir, "settings.gradle.kts"),
      'dependencyResolutionManagement { versionCatalogs { create("backendLibs") { from(files("./gradle/backend.versions.toml")) } } }',
      "utf-8",
    );
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(backendLibs.plugins.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "backend.versions.toml"),
      "[plugins]\nweb = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8",
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "settings-defined catalog accessors should trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});

// ─── scanProjectFiles: RECURSIVE_SCAN_IGNORED_DIRS ──────────────────────

test("scanProjectFiles: excludes .claude, .gsd, .planning, .plans, .cursor, .vscode directories", () => {
  const dir = makeTempDir("scan-ignore-dotdirs");
  try {
    // Create project files that should be included
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "// main\n", "utf-8");
    writeFileSync(join(dir, "README.md"), "# Project\n", "utf-8");

    // Create tool directories that should be excluded
    const excludedDirs = [".claude", ".gsd", ".planning", ".plans", ".cursor", ".vscode"];
    for (const d of excludedDirs) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, "config.json"), "{}\n", "utf-8");
    }
    // Nested .claude directory
    mkdirSync(join(dir, ".claude", "memory"), { recursive: true });
    writeFileSync(join(dir, ".claude", "memory", "user.md"), "# Memory\n", "utf-8");

    const files = scanProjectFiles(dir);

    // Should include project files
    assert.ok(files.includes("src/main.ts"), "should include src/main.ts");
    assert.ok(files.includes("README.md"), "should include README.md");

    // Should exclude all tool directories
    for (const d of excludedDirs) {
      const hasExcluded = files.some((f) => f.startsWith(`${d}/`));
      assert.ok(!hasExcluded, `should exclude ${d}/ directory but found: ${files.filter((f) => f.startsWith(`${d}/`)).join(", ")}`);
    }
  } finally {
    cleanup(dir);
  }
});
