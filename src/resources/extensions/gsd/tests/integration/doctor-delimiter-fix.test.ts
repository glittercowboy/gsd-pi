/**
 * Test: Doctor auto-fix for delimiter_in_title
 *
 * Verifies that `runGSDDoctor({ fix: true })` sanitizes em/en dashes
 * in milestone H1 titles by replacing them with ASCII hyphens.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGSDDoctor } from "../../doctor.js";

test("doctor fix=true sanitizes em-dash in milestone title", async (t) => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-doctor-delim-"));
  const gsd = join(tmpBase, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  const sDir = join(mDir, "slices", "S01");
  const tDir = join(sDir, "tasks");
  mkdirSync(tDir, { recursive: true });

  const roadmapWithEmDash = `# M001: Cockpit Foundation \u2014 Daemon + State Bridge

## Success Criteria
- HTTP server runs

## Slices
- [ ] **S01: Initial Setup** \`risk:low\` \`depends:[]\`
  > After this: setup works
`;

  writeFileSync(join(mDir, "M001-ROADMAP.md"), roadmapWithEmDash);
  writeFileSync(join(sDir, "S01-PLAN.md"), `# S01: Initial Setup\n\n## Tasks\n- [ ] **T01: Scaffold** \`est:15m\`\n`);
  writeFileSync(join(tDir, "T01-PLAN.md"), "# T01: Scaffold\n");

  t.after(() => rmSync(tmpBase, { recursive: true, force: true }));

  // Run doctor with fix=true
  const report = await runGSDDoctor(tmpBase, { fix: true });

  // The em-dash should have been replaced
  const fixed = readFileSync(join(mDir, "M001-ROADMAP.md"), "utf-8");
  const h1 = fixed.split("\n").find(l => l.startsWith("# "))!;
  assert.ok(h1, "H1 line should exist");
  assert.ok(!h1.includes("\u2014"), "em-dash should be replaced");
  assert.ok(!h1.includes("\u2013"), "en-dash should be replaced");
  assert.ok(h1.includes("-"), "should contain ASCII hyphen as replacement");

  // Should have recorded the fix
  assert.ok(
    report.fixesApplied.some(f => f.includes("sanitized")),
    `fixesApplied should mention sanitization, got: ${JSON.stringify(report.fixesApplied)}`,
  );

  // The issue should NOT appear in the report (it was fixed)
  const delimIssues = report.issues.filter(i => i.code === "delimiter_in_title" && i.unitId === "M001");
  assert.equal(delimIssues.length, 0, "fixed issue should not appear in issues list");
});

test("doctor fix=false still reports delimiter_in_title as warning", async (t) => {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-doctor-delim-nf-"));
  const gsd = join(tmpBase, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  const sDir = join(mDir, "slices", "S01");
  const tDir = join(sDir, "tasks");
  mkdirSync(tDir, { recursive: true });

  writeFileSync(join(mDir, "M001-ROADMAP.md"), `# M001: Foundation \u2014 Core\n\n## Slices\n- [ ] **S01: Setup** \`risk:low\` \`depends:[]\`\n  > After: done\n`);
  writeFileSync(join(sDir, "S01-PLAN.md"), `# S01: Setup\n\n## Tasks\n- [ ] **T01: Init** \`est:10m\`\n`);
  writeFileSync(join(tDir, "T01-PLAN.md"), "# T01: Init\n");

  t.after(() => rmSync(tmpBase, { recursive: true, force: true }));

  const report = await runGSDDoctor(tmpBase, { fix: false });
  const delimIssues = report.issues.filter(i => i.code === "delimiter_in_title");
  assert.ok(delimIssues.length > 0, "should report delimiter_in_title as issue when fix=false");
  assert.equal(delimIssues[0].severity, "warning");

  // File should be unchanged
  const content = readFileSync(join(mDir, "M001-ROADMAP.md"), "utf-8");
  assert.ok(content.includes("\u2014"), "file should not be modified when fix=false");
});
