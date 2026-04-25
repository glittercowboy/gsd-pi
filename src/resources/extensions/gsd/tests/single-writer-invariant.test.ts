// Structural invariant: gsd-db.ts is the single writer for .gsd/gsd.db.
//
// No file under src/resources/extensions/gsd/ may issue raw write SQL
// (INSERT/UPDATE/DELETE/REPLACE) or raw transaction control (BEGIN/COMMIT/
// ROLLBACK via `.exec(...)`) against the engine database. Every bypass must
// route through a typed wrapper exported from gsd-db.ts.
//
// Allowlist:
// - gsd-db.ts itself — the single writer
// - unit-ownership.ts — manages a separate .gsd/unit-claims.db for
//   cross-worktree claim races; intentionally outside this invariant
// - tests/** — fixtures and direct DB inspection are fair game
//
// When this test fails, do not add a new suppression. Instead:
// 1. Add a typed wrapper to gsd-db.ts that captures the SQL
// 2. Switch the flagged site to call the wrapper
//
// See `.claude/plans/joyful-doodling-pony.md` for the full rationale.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const gsdDir = join(process.cwd(), "src/resources/extensions/gsd");

const ALLOWLIST = new Set([
  "gsd-db.ts",
  "unit-ownership.ts",
]);

/** Walk the gsd extension dir and return all .ts files outside tests/. */
function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip tests/ — fixtures and direct DB inspection are expected there
        if (ent.name === "tests") continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".ts")) continue;
      // Skip dotfiles and backup/generated files
      if (ent.name.startsWith(".")) continue;
      out.push(full);
    }
  }

  return out;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
  kind: string;
}

// Match .prepare("... INSERT|UPDATE|DELETE|REPLACE ...") in any quoting style.
const PREPARE_WRITE_RE = /\.prepare\s*\(\s*[`'"][^`'"]*\b(INSERT|UPDATE|DELETE|REPLACE)\b/i;

// Match .exec("... INSERT|UPDATE|DELETE|REPLACE ...") or raw BEGIN/COMMIT/ROLLBACK.
const EXEC_WRITE_RE = /\.exec\s*\(\s*[`'"][^`'"]*\b(INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|ROLLBACK)\b/i;

test("no module outside gsd-db.ts issues raw write SQL against the engine DB", () => {
  const files = walkTsFiles(gsdDir);
  assert.ok(files.length >= 20, `Expected at least 20 .ts files under gsd/, found ${files.length}`);

  const violations: Violation[] = [];

  for (const abs of files) {
    const rel = relative(gsdDir, abs);
    const base = rel.split("/").pop()!;
    if (ALLOWLIST.has(base)) continue;

    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const prepareMatch = PREPARE_WRITE_RE.exec(line);
      if (prepareMatch) {
        violations.push({
          file: rel,
          line: i + 1,
          snippet: line.trim(),
          kind: `prepare(${prepareMatch[1].toUpperCase()})`,
        });
      }

      const execMatch = EXEC_WRITE_RE.exec(line);
      if (execMatch) {
        violations.push({
          file: rel,
          line: i + 1,
          snippet: line.trim(),
          kind: `exec(${execMatch[1].toUpperCase()})`,
        });
      }
    }
  }

  if (violations.length > 0) {
    const lines = violations.map(
      (v) => `  ${v.file}:${v.line} [${v.kind}] — ${v.snippet}`,
    );
    assert.fail(
      `Found ${violations.length} raw write SQL bypass(es) outside gsd-db.ts:\n` +
        lines.join("\n") +
        "\n\nEach of these must be replaced with a typed wrapper exported from gsd-db.ts.",
    );
  }
});

test("gsd-db.ts exports the expected single-writer wrappers", async () => {
  // Positive assertion — fail loudly if the module layout changes so this
  // structural test can't silently become a no-op.
  const db = await import("../gsd-db.js");

  const expected = [
    "deleteDecisionById",
    "deleteRequirementById",
    "deleteArtifactByPath",
    "clearEngineHierarchy",
    "insertOrIgnoreSlice",
    "insertOrIgnoreTask",
    "setSliceReplanTriggeredAt",
    "upsertQualityGate",
    "restoreManifest",
    "bulkInsertLegacyHierarchy",
    "readTransaction",
    "insertMemoryRow",
    "rewriteMemoryId",
    "updateMemoryContentRow",
    "incrementMemoryHitCount",
    "supersedeMemoryRow",
    "markMemoryUnitProcessed",
    "decayMemoriesBefore",
    "supersedeLowestRankedMemories",
  ];

  for (const name of expected) {
    assert.ok(
      typeof (db as Record<string, unknown>)[name] === "function",
      `gsd-db.ts must export ${name} as a function`,
    );
  }
});

test("the invariant test touches every .ts module under gsd/ (sanity check)", () => {
  const files = walkTsFiles(gsdDir);
  // Rough sanity: ensure we're not accidentally walking an empty tree
  assert.ok(files.length >= 30, `Expected to scan at least 30 .ts files, scanned ${files.length}`);

  // Spot-check a couple of known files that must be included
  const rels = files.map((f) => relative(gsdDir, f));
  assert.ok(rels.includes("gsd-db.ts"), "walker must include gsd-db.ts");
  assert.ok(rels.includes("memory-store.ts"), "walker must include memory-store.ts");
  assert.ok(rels.includes("workflow-manifest.ts"), "walker must include workflow-manifest.ts");
});

