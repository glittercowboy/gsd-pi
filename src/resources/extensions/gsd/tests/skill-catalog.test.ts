/**
 * Unit tests for GSD Skill Catalog — pack matching logic.
 *
 * Exercises matchPacksForProject() to verify that project signals
 * correctly map to skill packs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT_FILES } from "../detection.ts";
import { GREENFIELD_STACKS, SKILL_CATALOG, matchPacksForProject } from "../skill-catalog.ts";
import type { ProjectSignals } from "../detection.ts";

function makeSignals(overrides: Partial<ProjectSignals> = {}): ProjectSignals {
  return {
    detectedFiles: [],
    isGitRepo: false,
    isMonorepo: false,
    xcodePlatforms: [],
    hasCI: false,
    hasTests: false,
    verificationCommands: [],
    ...overrides,
  };
}

function packLabels(signals: ProjectSignals): string[] {
  return matchPacksForProject(signals).map((p) => p.label);
}

// ── matchAlways packs are always included ────────────────────────────────────

test("matchPacksForProject: always includes matchAlways packs", () => {
  const labels = packLabels(makeSignals());
  assert.ok(labels.includes("Skill Discovery"), "should include Skill Discovery");
  assert.ok(labels.includes("Skill Authoring"), "should include Skill Authoring");
  assert.ok(labels.includes("Browser Automation"), "should include Browser Automation");
  assert.ok(labels.includes("Document Handling"), "should include Document Handling");
  assert.ok(labels.includes("Code Review & Quality"), "should include Code Review & Quality");
  assert.ok(labels.includes("Git Advanced Workflows"), "should include Git Advanced Workflows");
});

// ── Language matching ────────────────────────────────────────────────────────

test("matchPacksForProject: Python language matches Python packs", () => {
  const labels = packLabels(makeSignals({ primaryLanguage: "python", detectedFiles: ["pyproject.toml"] }));
  assert.ok(labels.includes("Python"), "should include Python");
  assert.ok(labels.includes("Python Advanced"), "should include Python Advanced");
});

test("matchPacksForProject: Rust language matches Rust packs", () => {
  const labels = packLabels(makeSignals({ primaryLanguage: "rust", detectedFiles: ["Cargo.toml"] }));
  assert.ok(labels.includes("Rust"), "should include Rust");
  assert.ok(labels.includes("Rust Async Patterns"), "should include Rust Async Patterns");
});

test("matchPacksForProject: Go language matches Go packs", () => {
  const labels = packLabels(makeSignals({ primaryLanguage: "go", detectedFiles: ["go.mod"] }));
  assert.ok(labels.includes("Go"), "should include Go");
  assert.ok(labels.includes("Go Concurrency Patterns"), "should include Go Concurrency Patterns");
});

test("matchPacksForProject: JS/TS matches web frontend packs", () => {
  const labels = packLabels(makeSignals({ primaryLanguage: "javascript/typescript", detectedFiles: ["package.json"] }));
  assert.ok(labels.includes("React & Web Frontend"), "should include React");
  assert.ok(labels.includes("TypeScript & JS Development"), "should include TS/JS Dev");
  assert.ok(labels.includes("React State & Patterns"), "should include React State");
  assert.ok(labels.includes("shadcn/ui"), "should include shadcn");
  assert.ok(labels.includes("Frontend Design & UX"), "should include Frontend Design");
});

// ── File matching ────────────────────────────────────────────────────────────

test("matchPacksForProject: angular.json triggers Angular packs", () => {
  const labels = packLabels(makeSignals({ detectedFiles: ["angular.json"] }));
  assert.ok(labels.includes("Angular"), "should include Angular");
  assert.ok(labels.includes("Angular Migration"), "should include Angular Migration");
});

test("matchPacksForProject: next.config.ts triggers Next.js packs", () => {
  const labels = packLabels(makeSignals({ detectedFiles: ["next.config.ts"] }));
  assert.ok(labels.includes("Next.js"), "should include Next.js");
  assert.ok(labels.includes("Next.js App Router Patterns"), "should include Next.js App Router");
});

test("matchPacksForProject: *.vue triggers Vue.js", () => {
  const labels = packLabels(makeSignals({ detectedFiles: ["*.vue"] }));
  assert.ok(labels.includes("Vue.js"), "should include Vue.js");
});

test("matchPacksForProject: Chart.yaml triggers Kubernetes", () => {
  const labels = packLabels(makeSignals({ detectedFiles: ["Chart.yaml"] }));
  assert.ok(labels.includes("Kubernetes"), "should include Kubernetes");
});

test("matchPacksForProject: hardhat.config.ts triggers Blockchain", () => {
  const labels = packLabels(makeSignals({ detectedFiles: ["hardhat.config.ts"] }));
  assert.ok(labels.includes("Blockchain & Web3"), "should include Blockchain & Web3");
});

test("matchPacksForProject: tailwind.config.ts triggers Tailwind CSS", () => {
  const labels = packLabels(makeSignals({ detectedFiles: ["tailwind.config.ts"] }));
  assert.ok(labels.includes("Tailwind CSS"), "should include Tailwind CSS");
});

// ── Xcode platform matching ─────────────────────────────────────────────────

test("matchPacksForProject: iphoneos triggers iOS packs", () => {
  const labels = packLabels(makeSignals({ xcodePlatforms: ["iphoneos"] }));
  assert.ok(labels.includes("iOS App Frameworks"), "should include iOS App Frameworks");
  assert.ok(labels.includes("iOS Data Frameworks"), "should include iOS Data Frameworks");
  assert.ok(labels.includes("iOS AI & ML"), "should include iOS AI & ML");
  assert.ok(labels.includes("iOS Engineering"), "should include iOS Engineering");
  assert.ok(labels.includes("iOS Hardware"), "should include iOS Hardware");
  assert.ok(labels.includes("iOS Platform"), "should include iOS Platform");
});

// ── Isolation checks — packs that should NOT match ──────────────────────────

test("matchPacksForProject: FastAPI does not match generic Python", () => {
  const labels = packLabels(makeSignals({ primaryLanguage: "python", detectedFiles: ["pyproject.toml"] }));
  assert.ok(!labels.includes("FastAPI"), "FastAPI should NOT match generic Python projects");
});

test("matchPacksForProject: FastAPI matches when dep:fastapi detected", () => {
  const labels = packLabels(makeSignals({ primaryLanguage: "python", detectedFiles: ["pyproject.toml", "dep:fastapi"] }));
  assert.ok(labels.includes("FastAPI"), "FastAPI should match when dep:fastapi is in detectedFiles");
});

test("matchPacksForProject: Spring Boot does not match via language alone", () => {
  // Simulate Android project: has java/kotlin language but no root pom.xml/build.gradle
  const labels = packLabels(makeSignals({ primaryLanguage: "java/kotlin", detectedFiles: ["app/build.gradle"] }));
  assert.ok(!labels.includes("Java & Spring Boot"), "Spring Boot should NOT match via language alone");
});

test("matchPacksForProject: Spring Boot matches only dep:spring-boot", () => {
  const positive = packLabels(makeSignals({ detectedFiles: ["dep:spring-boot"] }));
  assert.ok(positive.includes("Java & Spring Boot"), "should include Spring Boot pack when dependency marker exists");

  const androidLike = packLabels(makeSignals({ detectedFiles: ["build.gradle", "app/build.gradle"], primaryLanguage: "java/kotlin" }));
  assert.ok(!androidLike.includes("Java & Spring Boot"), "generic Gradle + Android markers should not imply Spring Boot");
});

test("matchPacksForProject: Unity does not include Godot", () => {
  const labels = packLabels(makeSignals({ detectedFiles: ["ProjectSettings/ProjectVersion.txt"] }));
  assert.ok(labels.includes("Unity"), "should include Unity");
  assert.ok(!labels.includes("Godot"), "should NOT include Godot");
});

test("matchPacksForProject: Godot does not include Unity", () => {
  const labels = packLabels(makeSignals({ detectedFiles: ["project.godot"] }));
  assert.ok(labels.includes("Godot"), "should include Godot");
  assert.ok(!labels.includes("Unity"), "should NOT include Unity");
});

test("matchPacksForProject: .NET backend patterns match F# and solution markers", () => {
  const fsprojLabels = packLabels(makeSignals({ detectedFiles: ["*.fsproj"], primaryLanguage: "fsharp" }));
  assert.ok(fsprojLabels.includes(".NET Backend Patterns"), "should include generic .NET backend patterns for F# projects");
  assert.ok(!fsprojLabels.includes(".NET & C#"), "should not include C#-specific pack for F# projects");

  const slnLabels = packLabels(makeSignals({ detectedFiles: ["*.sln"], primaryLanguage: "dotnet" }));
  assert.ok(slnLabels.includes(".NET Backend Patterns"), "should include generic .NET backend patterns for solution files");
});

test("SKILL_CATALOG: every matchFiles entry is backed by detection", () => {
  const knownMarkers = new Set<string>([
    ...PROJECT_FILES,
    "*.sqlite",
    "*.sql",
    "*.csproj",
    "*.fsproj",
    "*.sln",
    "*.vue",
    "dep:fastapi",
    "dep:spring-boot",
  ]);

  for (const pack of SKILL_CATALOG) {
    for (const marker of pack.matchFiles ?? []) {
      assert.ok(knownMarkers.has(marker), `Unknown detection marker: ${marker} (pack: ${pack.label})`);
    }
  }
});

test("GREENFIELD_STACKS: every pack label resolves to SKILL_CATALOG", () => {
  const labels = new Set(SKILL_CATALOG.map((pack) => pack.label));

  for (const stack of GREENFIELD_STACKS) {
    for (const packLabel of stack.packs) {
      assert.ok(labels.has(packLabel), `Unknown pack label: ${packLabel} (stack: ${stack.id})`);
    }
  }
});
