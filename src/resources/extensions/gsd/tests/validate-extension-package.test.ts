// GSD-2 — Tests for validateExtensionPackage (EXTR-02, PKG-05)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateExtensionPackage } from "../commands-extensions.ts";

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

test("validateExtensionPackage: valid package returns { valid: true }", (t) => {
  // EXTR-02: gsd.extension: true, peerDependencies, pi.extensions
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeIndexTs(dir);
  writePackageJson(dir, {
    name: "@gsd-extensions/test",
    version: "1.0.0",
    gsd: { extension: true },
    pi: { extensions: ["./index.ts"] },
    peerDependencies: { "@gsd/pi-coding-agent": "*" },
    dependencies: { "some-lib": "^1.0.0" },
  });

  const result = validateExtensionPackage(dir);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateExtensionPackage: missing gsd.extension marker returns error", (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeIndexTs(dir);
  writePackageJson(dir, {
    name: "@gsd-extensions/test",
    version: "1.0.0",
    pi: { extensions: ["./index.ts"] },
    peerDependencies: { "@gsd/pi-coding-agent": "*" },
  });

  const result = validateExtensionPackage(dir);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("gsd")), `Expected error about gsd, got: ${JSON.stringify(result.errors)}`);
});

test("validateExtensionPackage: missing pi.extensions returns error", (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeIndexTs(dir);
  writePackageJson(dir, {
    name: "@gsd-extensions/test",
    version: "1.0.0",
    gsd: { extension: true },
    peerDependencies: { "@gsd/pi-coding-agent": "*" },
  });

  const result = validateExtensionPackage(dir);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("pi")), `Expected error about pi.extensions, got: ${JSON.stringify(result.errors)}`);
});

test("validateExtensionPackage: pi.extensions entry path not found returns error", (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Do NOT create index.ts
  writePackageJson(dir, {
    name: "@gsd-extensions/test",
    version: "1.0.0",
    gsd: { extension: true },
    pi: { extensions: ["./index.ts"] },
    peerDependencies: { "@gsd/pi-coding-agent": "*" },
  });

  const result = validateExtensionPackage(dir);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("index.ts")), `Expected error about index.ts, got: ${JSON.stringify(result.errors)}`);
});

test("validateExtensionPackage: @gsd/* in dependencies (not peerDependencies) returns error", (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeIndexTs(dir);
  writePackageJson(dir, {
    name: "@gsd-extensions/test",
    version: "1.0.0",
    gsd: { extension: true },
    pi: { extensions: ["./index.ts"] },
    dependencies: { "@gsd/pi-coding-agent": "^2.0.0" },
  });

  const result = validateExtensionPackage(dir);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("@gsd/pi-coding-agent")), `Expected error about @gsd/ dep, got: ${JSON.stringify(result.errors)}`);
});

test("validateExtensionPackage: @gsd/* in devDependencies returns error", (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeIndexTs(dir);
  writePackageJson(dir, {
    name: "@gsd-extensions/test",
    version: "1.0.0",
    gsd: { extension: true },
    pi: { extensions: ["./index.ts"] },
    peerDependencies: { "@gsd/pi-coding-agent": "*" },
    devDependencies: { "@gsd/pi-tui": "^2.0.0" },
  });

  const result = validateExtensionPackage(dir);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(e => e.includes("@gsd/pi-tui") && e.includes("devDependencies")),
    `Expected error about @gsd/ in devDependencies, got: ${JSON.stringify(result.errors)}`,
  );
});

test("validateExtensionPackage: missing package.json returns error", (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // No package.json written
  const result = validateExtensionPackage(dir);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("package.json")), `Expected error about package.json, got: ${JSON.stringify(result.errors)}`);
});

test("validateExtensionPackage: invalid JSON in package.json returns error", (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, "package.json"), "{ invalid json :::}");

  const result = validateExtensionPackage(dir);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.toLowerCase().includes("json")), `Expected JSON error, got: ${JSON.stringify(result.errors)}`);
});

test("validateExtensionPackage: extracted google-search package passes validation (PKG-05)", (_t) => {
  // This test runs against the actual extensions/google-search/ directory.
  // Use process.cwd() (project root) since relative path from import.meta.url
  // breaks when tests run from dist-test/.
  const googleSearchDir = join(process.cwd(), "extensions", "google-search");

  const result = validateExtensionPackage(googleSearchDir);
  assert.equal(result.valid, true, `extensions/google-search/ should be valid, errors: ${JSON.stringify(result.errors)}`);
});
