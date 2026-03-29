// GSD-2 — Tests for validateExtensionPackage (EXTR-02, PKG-05)
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import will be available after Task 2 adds the function to commands-extensions.ts
// For now, inline a minimal version for test structure validation
// After Task 2: import { validateExtensionPackage } from "../commands-extensions.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `validate-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePackageJson(dir: string, content: Record<string, unknown>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(content, null, 2));
}

function writeIndexTs(dir: string, content = "export default function() {}"): void {
  writeFileSync(join(dir, "index.ts"), content);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("validateExtensionPackage: valid package returns { valid: true }", async (t) => {
  // EXTR-02: gsd.extension: true, peerDependencies, pi.extensions
  t.todo("Implement after validateExtensionPackage is added in Task 2");
});

test("validateExtensionPackage: missing gsd.extension marker returns error", async (t) => {
  t.todo("Implement after validateExtensionPackage is added in Task 2");
});

test("validateExtensionPackage: missing pi.extensions returns error", async (t) => {
  t.todo("Implement after validateExtensionPackage is added in Task 2");
});

test("validateExtensionPackage: pi.extensions entry path not found returns error", async (t) => {
  t.todo("Implement after validateExtensionPackage is added in Task 2");
});

test("validateExtensionPackage: @gsd/* in dependencies (not peerDependencies) returns error", async (t) => {
  t.todo("Implement after validateExtensionPackage is added in Task 2");
});

test("validateExtensionPackage: missing package.json returns error", async (t) => {
  t.todo("Implement after validateExtensionPackage is added in Task 2");
});

test("validateExtensionPackage: invalid JSON in package.json returns error", async (t) => {
  t.todo("Implement after validateExtensionPackage is added in Task 2");
});

test("validateExtensionPackage: extracted google-search package passes validation (PKG-05)", async (t) => {
  // This test runs against the actual extensions/google-search/ directory
  // created by Task 1 — validates the real extracted package
  t.todo("Implement after validateExtensionPackage is added in Task 2 and extensions/google-search/ exists from Task 1");
});
