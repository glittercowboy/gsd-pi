// GSD Extension — Import Boundary Tests (CLN-07)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// Static analysis tests that verify hot-path files do not import parse functions
// from files.ts or legacy/parsers.ts. These enforce the architectural boundary
// established by Phase 4: markdown parsers belong in legacy/ only.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const srcDir = resolve(import.meta.dirname!, "..");

describe("import-boundary", () => {
  // ─── CLN-07: legacy/parsers.ts exports ───────────────────────────────────

  test("legacy/parsers.ts exports parseRoadmap, parsePlan, parseSummary", () => {
    // RED until Plan 4-01 Task 1 creates legacy/parsers.ts
    const parsersPath = resolve(srcDir, "legacy", "parsers.ts");
    assert.ok(
      existsSync(parsersPath),
      `legacy/parsers.ts should exist at ${parsersPath}`,
    );

    const content = readFileSync(parsersPath, "utf-8");
    assert.ok(
      content.includes("export function parseRoadmap(") || content.includes("export { parseRoadmap"),
      "legacy/parsers.ts should export parseRoadmap",
    );
    assert.ok(
      content.includes("export function parsePlan(") || content.includes("export { parsePlan"),
      "legacy/parsers.ts should export parsePlan",
    );
    assert.ok(
      content.includes("export function parseSummary(") || content.includes("export { parseSummary"),
      "legacy/parsers.ts should export parseSummary",
    );
  });

  // ─── CLN-07: files.ts no longer exports parse functions ──────────────────

  test("files.ts does not export parseRoadmap, parsePlan, or parseSummary", () => {
    // RED until Plan 4-01 Task 1 removes these exports from files.ts
    const filesPath = resolve(srcDir, "files.ts");
    assert.ok(existsSync(filesPath), `files.ts should exist at ${filesPath}`);

    const content = readFileSync(filesPath, "utf-8");
    assert.ok(
      !content.includes("export function parseRoadmap("),
      "files.ts should not export parseRoadmap (moved to legacy/parsers.ts)",
    );
    assert.ok(
      !content.includes("export function parsePlan("),
      "files.ts should not export parsePlan (moved to legacy/parsers.ts)",
    );
    assert.ok(
      !content.includes("export function parseSummary("),
      "files.ts should not export parseSummary (moved to legacy/parsers.ts)",
    );
  });

  // ─── CLN-07: hot-path files do not import from legacy/parsers ────────────

  test("doctor-checks.ts does not import from legacy/parsers", () => {
    // Passes immediately — doctor-checks.ts imports from files.ts, not legacy/parsers
    const filePath = resolve(srcDir, "doctor-checks.ts");
    assert.ok(existsSync(filePath), "doctor-checks.ts should exist");

    const content = readFileSync(filePath, "utf-8");
    assert.ok(
      !content.includes('from "./legacy/parsers') && !content.includes("from '../legacy/parsers"),
      "doctor-checks.ts must not import from legacy/parsers (hot-path boundary)",
    );
  });

  test("auto-recovery.ts does not import from legacy/parsers", () => {
    // Passes immediately — auto-recovery.ts imports from files.ts, not legacy/parsers
    const filePath = resolve(srcDir, "auto-recovery.ts");
    assert.ok(existsSync(filePath), "auto-recovery.ts should exist");

    const content = readFileSync(filePath, "utf-8");
    assert.ok(
      !content.includes('from "./legacy/parsers') && !content.includes("from '../legacy/parsers"),
      "auto-recovery.ts must not import from legacy/parsers (hot-path boundary)",
    );
  });

  // ─── CLN-07: state.ts does not import parse functions from files.ts ──────

  test("state.ts does not import parseRoadmap/parsePlan/parseSummary from files.ts", () => {
    // RED until Plans 4-01 and 4-03 clean up state.ts imports
    const filePath = resolve(srcDir, "state.ts");
    assert.ok(existsSync(filePath), "state.ts should exist");

    const content = readFileSync(filePath, "utf-8");

    // Extract all import blocks that reference files.js/files.ts.
    // Handles multi-line imports like:
    //   import {
    //     parseRoadmap,
    //     parsePlan,
    //   } from './files.js';
    const importBlockRe = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/files\.(?:js|ts)['"]/g;
    let match: RegExpExecArray | null;
    const importedNames: string[] = [];
    while ((match = importBlockRe.exec(content)) !== null) {
      // Split the import specifiers and trim whitespace
      const specifiers = match[1].split(",").map((s) => s.trim()).filter(Boolean);
      importedNames.push(...specifiers);
    }

    // None of the imported names should be parseRoadmap, parsePlan, or parseSummary
    assert.ok(
      !importedNames.includes("parseRoadmap"),
      `state.ts should not import parseRoadmap from files.ts (found imports: ${importedNames.join(", ")})`,
    );
    assert.ok(
      !importedNames.includes("parsePlan"),
      `state.ts should not import parsePlan from files.ts (found imports: ${importedNames.join(", ")})`,
    );
    assert.ok(
      !importedNames.includes("parseSummary"),
      `state.ts should not import parseSummary from files.ts (found imports: ${importedNames.join(", ")})`,
    );
  });
});
