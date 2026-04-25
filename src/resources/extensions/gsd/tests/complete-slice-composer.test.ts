// GSD-2 — #4782 phase 3 batch 3: complete-slice migrated through composer.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildCompleteSlicePrompt } from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  upsertMilestonePlanning,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-completeslice-composer-"));
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
  insertMilestone({ id: mid, title: "Composer Test", status: "active", depends_on: [] });
  upsertMilestonePlanning(mid, {
    title: "Composer Test",
    status: "active",
    vision: "Validate complete-slice migration",
    successCriteria: ["Prompt compiles"],
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
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: mid,
    title: "Task one",
    status: "complete",
  });
}

function writeArtifacts(base: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001 Roadmap\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n",
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01 Plan\n\nSlice plan body.\n",
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
    "---\nid: T01\n---\n# T01 Summary\n\nTask one did the thing.\n",
  );
}

test("#4782 phase 3: buildCompleteSlicePrompt composes roadmap → plan → task summaries → templates in declared order", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);

  const prompt = await buildCompleteSlicePrompt("M001", "Composer Test", "S01", "First", base);

  // Context wrapper present
  assert.match(prompt, /## Inlined Context \(preloaded — do not re-read these files\)/);

  // Manifest-declared artifacts present
  assert.match(prompt, /### Milestone Roadmap/);
  assert.match(prompt, /### Slice Plan/);
  assert.match(prompt, /### Task Summary: T01/);
  assert.match(prompt, /### Output Template: Slice Summary/);

  // Ordering: roadmap → slice plan → task summaries → slice summary template
  const roadmapIdx = prompt.indexOf("### Milestone Roadmap");
  const planIdx = prompt.indexOf("### Slice Plan");
  const taskSummaryIdx = prompt.indexOf("### Task Summary: T01");
  const sliceSummaryTemplateIdx = prompt.indexOf("### Output Template: Slice Summary");

  assert.ok(roadmapIdx > -1 && planIdx > roadmapIdx, "roadmap precedes slice plan");
  assert.ok(planIdx > -1 && taskSummaryIdx > planIdx, "slice plan precedes task summaries");
  assert.ok(
    taskSummaryIdx > -1 && sliceSummaryTemplateIdx > taskSummaryIdx,
    "task summaries precede slice-summary template",
  );

  // Task body inlined
  assert.match(prompt, /Task one did the thing/);
});

test("#4782 phase 3: buildCompleteSlicePrompt handles missing task summaries gracefully", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  // Write roadmap + plan but no task summaries
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001 Roadmap\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n",
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01 Plan\n",
  );

  const prompt = await buildCompleteSlicePrompt("M001", "Composer Test", "S01", "First", base);

  // Still succeeds — prior-task-summaries resolver returns null when dir is empty
  assert.match(prompt, /### Milestone Roadmap/);
  assert.match(prompt, /### Slice Plan/);
  // No task summary blocks — they'd have a "### Task Summary:" prefix
  assert.ok(!prompt.includes("### Task Summary:"));
  // Roadmap still precedes slice plan despite the missing block
  const roadmapIdx = prompt.indexOf("### Milestone Roadmap");
  const planIdx = prompt.indexOf("### Slice Plan");
  assert.ok(roadmapIdx > -1 && planIdx > roadmapIdx);
});

test("#4925 review: KNOWLEDGE splices BEFORE templates when no task summaries exist", async (t) => {
  // Regression for the bug fixed in fcf3bfbe: the templates fallback was
  // searching for "### Slice Summary" but inlineTemplate emits
  // "### Output Template: Slice Summary", so templatesIdx stayed -1 and
  // knowledge ended up appended after templates instead of before them.
  const base = makeBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  // Roadmap + plan only — no T*-SUMMARY.md, so taskIdx must be -1 and the
  // splice falls through to the templates anchor.
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001 Roadmap\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n",
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01 Plan\n",
  );
  // KNOWLEDGE.md with an H3 section whose header matches the slice title
  // keyword "first" — queryKnowledge will return the section, so
  // inlineKnowledgeBudgeted produces a non-null block and the splice
  // path executes.
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "KNOWLEDGE.md"),
    "## Topics\n\n### First-slice notes\n\nNotes that should be inlined.\n",
  );

  const prompt = await buildCompleteSlicePrompt("M001", "Composer Test", "S01", "First", base);

  // Sanity: the splice path actually fired.
  assert.ok(!prompt.includes("### Task Summary:"), "fixture must have no task summaries to exercise the fallback");
  const knowledgeIdx = prompt.indexOf("### Project Knowledge (scoped)");
  const templatesIdx = prompt.indexOf("### Output Template: Slice Summary");
  assert.ok(knowledgeIdx > -1, "knowledge block missing — fixture failed to populate KNOWLEDGE.md scope");
  assert.ok(templatesIdx > -1, "templates block missing");
  // The bug: knowledge appeared AFTER templates. The fix: knowledge before templates.
  assert.ok(
    knowledgeIdx < templatesIdx,
    `knowledge (${knowledgeIdx}) must splice before templates (${templatesIdx}) when no task summaries exist`,
  );
});
