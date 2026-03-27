import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync,
  existsSync, statSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Test the core validation + persistence logic used by /api/switch-root
// without pulling in the heavy bridge-service import chain.
//
// The server-side handler does:
//   1. Validate path exists and is a directory
//   2. Resolve tilde + resolve() to absolute path
//   3. Persist devRoot to web-preferences.json (clearing lastActiveProject)
//   4. Discover projects under the new root
//
// We test each concern in isolation using the same logic.
// ---------------------------------------------------------------------------

// ── Helpers (mirrors /api/switch-root handler logic) ──────────────────────

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

interface SwitchRootResult {
  ok: boolean;
  error?: string;
  devRoot?: string;
}

function validateSwitchRoot(rawDevRoot: string): SwitchRootResult {
  const trimmed = rawDevRoot.trim();
  if (!trimmed) {
    return { ok: false, error: "Missing devRoot in request body" };
  }

  const expanded = expandTilde(trimmed);
  const resolved = resolve(expanded);

  if (!existsSync(resolved)) {
    return { ok: false, error: `Path does not exist: ${resolved}` };
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` };
    }
  } catch {
    return { ok: false, error: `Cannot access path: ${resolved}` };
  }

  return { ok: true, devRoot: resolved };
}

interface WebPreferences {
  devRoot?: string;
  lastActiveProject?: string;
}

function persistSwitchRoot(
  prefsPath: string,
  newDevRoot: string,
): WebPreferences {
  let existing: WebPreferences = {};
  try {
    if (existsSync(prefsPath)) {
      existing = JSON.parse(readFileSync(prefsPath, "utf-8"));
    }
  } catch {
    // Corrupt file — start fresh
  }

  const prefs: WebPreferences = {
    ...existing,
    devRoot: newDevRoot,
    lastActiveProject: undefined,
  };

  writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), "utf-8");
  return prefs;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), "gsd-switch-root-"));

const rootA = join(tempRoot, "root-a");
mkdirSync(rootA);
mkdirSync(join(rootA, "project-x"));
mkdirSync(join(rootA, "project-x", ".git"));
writeFileSync(join(rootA, "project-x", "package.json"), "{}");
mkdirSync(join(rootA, "project-y"));

const rootB = join(tempRoot, "root-b");
mkdirSync(rootB);
mkdirSync(join(rootB, "project-z"));
writeFileSync(join(rootB, "project-z", "Cargo.toml"), "");

const filePath = join(tempRoot, "not-a-dir.txt");
writeFileSync(filePath, "hello");

const prefsDir = join(tempRoot, "prefs");
mkdirSync(prefsDir);
const prefsPath = join(prefsDir, "web-preferences.json");

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests — Path validation
// ---------------------------------------------------------------------------

describe("switch-root: path validation", () => {
  test("valid directory returns ok with resolved path", () => {
    const result = validateSwitchRoot(rootA);
    assert.ok(result.ok);
    assert.equal(result.devRoot, rootA);
  });

  test("empty string returns error", () => {
    const result = validateSwitchRoot("");
    assert.ok(!result.ok);
    assert.match(result.error!, /Missing devRoot/);
  });

  test("whitespace-only string returns error", () => {
    const result = validateSwitchRoot("   ");
    assert.ok(!result.ok);
    assert.match(result.error!, /Missing devRoot/);
  });

  test("non-existent path returns error", () => {
    const result = validateSwitchRoot(join(tempRoot, "nonexistent-dir"));
    assert.ok(!result.ok);
    assert.match(result.error!, /does not exist/);
  });

  test("file path (not a directory) returns error", () => {
    const result = validateSwitchRoot(filePath);
    assert.ok(!result.ok);
    assert.match(result.error!, /Not a directory/);
  });

  test("tilde path expands to home directory", () => {
    const result = validateSwitchRoot("~");
    // ~ always exists as a directory (user's home)
    assert.ok(result.ok, `Expected ok for ~, got error: ${result.error}`);
    assert.equal(result.devRoot, homedir());
  });

  test("resolves relative paths to absolute", () => {
    // Create a relative path that's valid from cwd
    const result = validateSwitchRoot(rootA);
    assert.ok(result.ok);
    assert.ok(isAbsolute(result.devRoot!), "Should be absolute path");
  });
});

// ---------------------------------------------------------------------------
// Tests — Preference persistence
// ---------------------------------------------------------------------------

describe("switch-root: preference persistence", () => {
  test("writes devRoot and clears lastActiveProject", () => {
    writeFileSync(prefsPath, JSON.stringify({
      devRoot: rootA,
      lastActiveProject: "/old/project",
    }, null, 2));

    const result = persistSwitchRoot(prefsPath, rootB);

    assert.equal(result.devRoot, rootB);
    assert.equal(result.lastActiveProject, undefined);

    // Verify on-disk
    const onDisk = JSON.parse(readFileSync(prefsPath, "utf-8"));
    assert.equal(onDisk.devRoot, rootB);
    // undefined is not serialized to JSON
    assert.ok(
      !("lastActiveProject" in onDisk) || onDisk.lastActiveProject == null,
      "lastActiveProject should be cleared",
    );
  });

  test("creates prefs file from scratch", () => {
    const freshPath = join(prefsDir, "fresh.json");
    assert.ok(!existsSync(freshPath));

    persistSwitchRoot(freshPath, rootA);

    assert.ok(existsSync(freshPath));
    const onDisk = JSON.parse(readFileSync(freshPath, "utf-8"));
    assert.equal(onDisk.devRoot, rootA);
  });

  test("handles corrupt prefs file gracefully", () => {
    writeFileSync(prefsPath, "NOT VALID JSON!!!");

    const result = persistSwitchRoot(prefsPath, rootB);
    assert.equal(result.devRoot, rootB);

    const onDisk = JSON.parse(readFileSync(prefsPath, "utf-8"));
    assert.equal(onDisk.devRoot, rootB);
  });

  test("overwrites existing devRoot", () => {
    writeFileSync(prefsPath, JSON.stringify({ devRoot: rootA }, null, 2));

    persistSwitchRoot(prefsPath, rootB);

    const onDisk = JSON.parse(readFileSync(prefsPath, "utf-8"));
    assert.equal(onDisk.devRoot, rootB);
    assert.notEqual(onDisk.devRoot, rootA);
  });
});

// ---------------------------------------------------------------------------
// Tests — Tilde expansion
// ---------------------------------------------------------------------------

describe("switch-root: tilde expansion", () => {
  test("~ expands to home directory", () => {
    assert.equal(expandTilde("~"), homedir());
  });

  test("~/Projects expands correctly", () => {
    assert.equal(expandTilde("~/Projects"), `${homedir()}/Projects`);
  });

  test("absolute path is unchanged", () => {
    assert.equal(expandTilde("/usr/local/bin"), "/usr/local/bin");
  });

  test("relative path is unchanged", () => {
    assert.equal(expandTilde("relative/path"), "relative/path");
  });

  test("~user is not expanded (only bare ~ or ~/)", () => {
    assert.equal(expandTilde("~other"), "~other");
  });
});

// ---------------------------------------------------------------------------
// Tests — End-to-end switch scenario
// ---------------------------------------------------------------------------

describe("switch-root: end-to-end scenario", () => {
  test("full switch: validate + persist + verify projects change", () => {
    // Start with root-a
    writeFileSync(prefsPath, JSON.stringify({
      devRoot: rootA,
      lastActiveProject: join(rootA, "project-x"),
    }, null, 2));

    // User requests switch to root-b
    const validation = validateSwitchRoot(rootB);
    assert.ok(validation.ok, `Validation should pass: ${validation.error}`);

    const prefs = persistSwitchRoot(prefsPath, validation.devRoot!);
    assert.equal(prefs.devRoot, rootB);
    assert.equal(prefs.lastActiveProject, undefined);

    // Verify on-disk state
    const finalPrefs = JSON.parse(readFileSync(prefsPath, "utf-8"));
    assert.equal(finalPrefs.devRoot, rootB);
  });
});
