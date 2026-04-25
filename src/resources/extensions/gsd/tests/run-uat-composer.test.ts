// GSD-2 — #4782 phase 3: run-uat migrated to compose context via manifest.
// Regression test: prompt still carries the declared artifacts in the
// expected shape after the migration.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildRunUatPrompt } from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  upsertMilestonePlanning,
  insertSlice,
  insertArtifact,
} from "../gsd-db.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-runuat-composer-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}

function seed(base: string, mid: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: mid, title: "Test", status: "active", depends_on: [] });
  upsertMilestonePlanning(mid, {
    title: "Test Milestone",
    status: "active",
    vision: "Demo the composer migration",
    successCriteria: ["Prompt compiles", "UAT passes"],
    keyRisks: [],
    proofStrategy: [],
    verificationContract: "",
    verificationIntegration: "",
    verificationOperational: "",
    verificationUat: "",
    definitionOfDone: [],
    requirementCoverage: "",
    boundaryMapMarkdown: "",
  });
  insertSlice({
    id: "S01",
    milestoneId: mid,
    title: "First",
    status: "complete",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
  // Seed PROJECT.md so inlineProjectFromDb resolves — the run-uat manifest
  // declares "project" as the third inline artifact (#4925 review).
  insertArtifact({
    path: "PROJECT.md",
    artifact_type: "project",
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: "# Project\n\nRun-UAT composer fixture project.\n",
  });
}

test("#4782 phase 3: buildRunUatPrompt inlines slice UAT, slice summary, project via composer", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");

  // Write UAT + SUMMARY files. Deliberately diverge the on-disk UAT body
  // from the in-memory uatContent the caller passes — if the resolver
  // ever re-reads disk (the bug fixed in fcf3bfbe), this test fails
  // because the prompt would contain "stale on-disk body" instead of
  // "fresh in-memory snapshot" (#4925 follow-up review).
  const uatRel = ".gsd/milestones/M001/slices/S01/S01-UAT.md";
  writeFileSync(join(base, uatRel), "# S01 UAT\n\n- stale on-disk body\n");
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
    "---\nid: S01\nparent: M001\n---\n# S01 Summary\n**One-liner**\n\n## What Happened\nShip.\n",
  );

  const uatContent = "# S01 UAT\n\n- Check X\n- Check Y\n  (fresh in-memory snapshot)\n";
  const prompt = await buildRunUatPrompt("M001", "S01", uatRel, uatContent, base);

  // Context wrapper present
  assert.match(prompt, /## Inlined Context \(preloaded — do not re-read these files\)/);

  // Artifacts from the manifest inline list, in declared order:
  // slice-uat → slice-summary → project (#4925 review).
  const uatIdx = prompt.indexOf("### S01 UAT");
  const summaryIdx = prompt.indexOf("### S01 Summary");
  const projectIdx = prompt.indexOf("### Project");
  assert.ok(uatIdx > -1, "slice UAT block missing");
  assert.ok(summaryIdx > -1, "slice summary block missing");
  assert.ok(projectIdx > -1, "project block missing — manifest declares project as 3rd inline");
  assert.ok(
    uatIdx < summaryIdx && summaryIdx < projectIdx,
    `manifest order violated: uat (${uatIdx}) < summary (${summaryIdx}) < project (${projectIdx})`,
  );

  // In-memory uatContent inlined — drift assertion: stale disk content
  // must NOT appear, fresh snapshot MUST appear (#4925 follow-up review).
  assert.match(prompt, /fresh in-memory snapshot/);
  assert.ok(!prompt.includes("stale on-disk body"), "resolver re-read disk instead of using uatContent snapshot");

  // Summary body content inlined
  assert.match(prompt, /What Happened[\s\S]*Ship/);

  // Project body content inlined
  assert.match(prompt, /Run-UAT composer fixture project/);
});

test("#4782 phase 3: buildRunUatPrompt omits optional slice summary when file is missing", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");

  const uatRel = ".gsd/milestones/M001/slices/S01/S01-UAT.md";
  writeFileSync(join(base, uatRel), "# S01 UAT\n");
  // No SUMMARY.md written — composer should skip the slice-summary key.

  const prompt = await buildRunUatPrompt("M001", "S01", uatRel, "# S01 UAT\n", base);

  // UAT still present
  assert.match(prompt, /### S01 UAT/);
  // No empty "S01 Summary" section — section body would be blank without a file
  assert.ok(!prompt.includes("### S01 Summary"));
  // Project still present (third inline artifact, not optional) and follows
  // UAT directly with the skipped summary collapsed (#4925 review).
  const uatIdx = prompt.indexOf("### S01 UAT");
  const projectIdx = prompt.indexOf("### Project");
  assert.ok(projectIdx > uatIdx, `project must follow UAT when summary is omitted (uat=${uatIdx}, project=${projectIdx})`);
  // No double separator from a skipped block
  assert.ok(!prompt.includes("---\n\n---"));
});
