// GSD-2 — #4781 phase 2: dispatch-rule gates read pipeline variant from DB.
// Behavior tests (not source-grep) — construct a real tmpdir DB, insert a
// milestone whose planning fields classify to the target variant, exercise
// DISPATCH_RULES.match(), assert the gate result.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  upsertMilestonePlanning,
  insertSlice,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import type { GSDState } from "../types.ts";

const PARALLEL_RESEARCH_RULE = "planning (multiple slices need research) → parallel-research-slices";
const SINGLE_RESEARCH_RULE = "planning (no research, not S01) → research-slice";
const VALIDATE_RULE = "validating-milestone → validate-milestone";

// ─── Fixture helpers ──────────────────────────────────────────────────────

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-pipeline-variant-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}

interface SeedOpts {
  title: string;
  vision: string;
  successCriteria: string[];
}

function seedMilestone(base: string, mid: string, opts: SeedOpts): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: mid,
    title: opts.title,
    status: "active",
    depends_on: [],
  });
  upsertMilestonePlanning(mid, {
    title: opts.title,
    status: "active",
    vision: opts.vision,
    successCriteria: opts.successCriteria,
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
    status: "pending",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
  insertSlice({
    id: "S02",
    milestoneId: mid,
    title: "Second",
    status: "pending",
    risk: "low",
    depends: ["S01"],
    demo: "",
    sequence: 2,
  });
}

function findRule(name: string) {
  const rule = DISPATCH_RULES.find(r => r.name === name);
  assert.ok(rule, `rule "${name}" must exist`);
  return rule!;
}

function makeCtx(params: {
  base: string;
  mid: string;
  phase: GSDState["phase"];
  activeSlice?: { id: string; title: string };
}): DispatchContext {
  const state: GSDState = {
    phase: params.phase,
    activeMilestone: { id: params.mid, title: "Test" },
    activeSlice: params.activeSlice ?? null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: params.mid, title: "Test", status: "active" }],
  };
  return {
    basePath: params.base,
    mid: params.mid,
    midTitle: "Test",
    state,
    prefs: undefined,
  };
}

// Inputs that consistently classify.
const TRIVIAL_INPUT: SeedOpts = {
  title: "Static To-Do App",
  vision: "A minimal, clean browser-based to-do app. Pure HTML/CSS/JS, no build step, no backend. Tasks persist in localStorage.",
  successCriteria: [
    "Open index.html in any browser without a server",
    "Tasks survive a page reload via localStorage",
  ],
};

const STANDARD_INPUT: SeedOpts = {
  title: "Billing API extension",
  vision: "Extend the billing API to charge usage-tier overages. Touch the invoice service, the entitlements cache, and the webhook handler.",
  successCriteria: [
    "Overage charges generate correct invoices",
    "Integration tests cover tier rollovers",
    "API endpoint returns structured error on webhook failure",
  ],
};

// ─── Research-slice gate (single) ─────────────────────────────────────────

test("#4781 phase 2: single research-slice rule skips dispatch for trivial variant", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  seedMilestone(base, "M001", TRIVIAL_INPUT);
  const ctx = makeCtx({
    base,
    mid: "M001",
    phase: "planning",
    activeSlice: { id: "S02", title: "Second" },
  });

  const result = await findRule(SINGLE_RESEARCH_RULE).match(ctx);
  assert.strictEqual(result, null, "trivial variant must skip research-slice dispatch");
});

test("#4781 phase 2: single research-slice rule proceeds normally for standard variant", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  seedMilestone(base, "M001", STANDARD_INPUT);
  const ctx = makeCtx({
    base,
    mid: "M001",
    phase: "planning",
    activeSlice: { id: "S02", title: "Second" },
  });

  // No RESEARCH file exists → rule should reach the dispatch branch.
  // We don't assert "dispatch" because the prompt builder may error with
  // minimal fixture data; we assert "not null AND not a trivial-skip
  // shortcut" by checking that if null was returned, it's for a known
  // reason (research file exists). For this fixture none exists, so the
  // result should be an action object.
  const result = await findRule(SINGLE_RESEARCH_RULE).match(ctx);
  assert.notStrictEqual(result, null, "standard variant must not short-circuit the research-slice gate");
});

// ─── Parallel research-slice gate ─────────────────────────────────────────

test("#4781 phase 2: parallel-research-slices rule skips dispatch for trivial variant", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  seedMilestone(base, "M001", TRIVIAL_INPUT);
  // Roadmap needs to be readable for the parallel rule to enter its slice
  // analysis. Write a minimal one.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    [
      "# M001",
      "## Slices",
      "- [ ] **S01: First** `risk:low` `depends:[]`",
      "- [ ] **S02: Second** `risk:low` `depends:[]`",
    ].join("\n"),
  );

  const ctx = makeCtx({ base, mid: "M001", phase: "planning" });
  const result = await findRule(PARALLEL_RESEARCH_RULE).match(ctx);
  assert.strictEqual(result, null, "trivial variant must skip parallel-research dispatch");
});

// ─── Validate-milestone gate ──────────────────────────────────────────────

test("#4781 phase 2: validate-milestone rule writes pass-through VALIDATION for trivial variant", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  seedMilestone(base, "M001", TRIVIAL_INPUT);
  // findMissingSummaries checks slice SUMMARY files — write empty ones so
  // the safety guard doesn't stop first.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"), "# S01\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-SUMMARY.md"), "# S02\n");
  // Write a roadmap so findMissingSummaries can enumerate slice IDs.
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    [
      "# M001",
      "## Slices",
      "- [x] **S01: First** `risk:low` `depends:[]`",
      "- [x] **S02: Second** `risk:low` `depends:[]`",
    ].join("\n"),
  );

  const ctx = makeCtx({ base, mid: "M001", phase: "validating-milestone" });
  const result = await findRule(VALIDATE_RULE).match(ctx);

  assert.ok(result, "rule must return a result, not null");
  assert.strictEqual(result!.action, "skip", "trivial variant must return skip action");

  const validationPath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  assert.ok(existsSync(validationPath), "pass-through VALIDATION.md must be written");

  const { readFileSync } = await import("node:fs");
  const content = readFileSync(validationPath, "utf-8");
  assert.match(content, /verdict: pass/);
  assert.match(content, /trivial-scope pipeline variant \(#4781\)/);
});

test("#4781 phase 2: validate-milestone rule dispatches normally for standard variant", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  seedMilestone(base, "M001", STANDARD_INPUT);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"), "# S01\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-SUMMARY.md"), "# S02\n");
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    [
      "# M001",
      "## Slices",
      "- [x] **S01: First** `risk:low` `depends:[]`",
      "- [x] **S02: Second** `risk:low` `depends:[]`",
    ].join("\n"),
  );

  const ctx = makeCtx({ base, mid: "M001", phase: "validating-milestone" });
  const result = await findRule(VALIDATE_RULE).match(ctx);

  assert.ok(result, "standard variant must produce a result");
  assert.strictEqual(result!.action, "dispatch", "standard variant must dispatch validate-milestone");
  if (result!.action === "dispatch") {
    assert.strictEqual(result!.unitType, "validate-milestone");
  }
});

// ─── Fallback safety: no DB, missing milestone ────────────────────────────

test("#4781 phase 2: null variant (no milestone row) does NOT gate dispatch — safe fallback", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  // Open DB but do NOT seed any milestone — getMilestone returns null,
  // which makes getMilestonePipelineVariant return null. Rules must NOT
  // short-circuit on null (silent downshift is the hazard we're guarding
  // against).
  openDatabase(join(base, ".gsd", "gsd.db"));

  const ctx = makeCtx({
    base,
    mid: "M999",
    phase: "planning",
    activeSlice: { id: "S02", title: "Second" },
  });

  // Rule should NOT return null from the variant gate. It may still return
  // null for other reasons (e.g. missing active slice), but our assertion
  // is specifically about the variant-gate not short-circuiting.
  const result = await findRule(SINGLE_RESEARCH_RULE).match(ctx);
  // Rule reaches its normal logic; with an active slice and no RESEARCH file,
  // it should produce a dispatch action, not null from the variant gate.
  assert.notStrictEqual(result, null, "null variant must not cause the research-slice gate to short-circuit");
});
