/**
 * Rule table tests for auto-dispatch.ts.
 *
 * Covers:
 *  1. rewrite-docs (override gate) — circuit breaker
 *  2. uat-verdict-gate — DB-backed non-PASS blocking
 *  3. summarizing → complete-slice
 *  4. run-uat (post-completion) — via checkNeedsRunUat
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDispatch, DISPATCH_RULES } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";
import { _clearGsdRootCache } from "../paths.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Test Milestone" },
    activeSlice: { id: "S01", title: "First Slice" },
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function makeCtx(
  basePath: string,
  stateOverrides: Partial<GSDState> = {},
  ctxOverrides: Partial<Omit<DispatchContext, "basePath" | "state">> = {},
): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState(stateOverrides),
    prefs: undefined,
    session: undefined,
    ...ctxOverrides,
  };
}

/** Write the OVERRIDES.md with a single active override block. */
function writeOverridesFile(basePath: string, scope: "active" | "resolved" = "active"): void {
  const gsdDir = join(basePath, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(
    join(gsdDir, "OVERRIDES.md"),
    [
      "## Override: 2024-01-01T00:00:00Z",
      "**Change:** Update the docs",
      `**Scope:** ${scope}`,
      "**Applied-at:** executing",
      "",
    ].join("\n"),
  );
}

/** Scaffold .gsd/milestones/M001/slices/S01/ directory with optional files. */
function scaffoldSlice(
  basePath: string,
  mid: string,
  sid: string,
  files: Record<string, string> = {},
): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

// ─── 1. rewrite-docs (override gate) ──────────────────────────────────────

test("rewrite-docs gate: no pending overrides → falls through (returns null)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-rewrite-"));
  t.after(() => { _clearGsdRootCache(); rmSync(tmp, { recursive: true, force: true }); });

  // No OVERRIDES.md at all — empty overrides
  mkdirSync(join(tmp, ".gsd"), { recursive: true });

  const rule = DISPATCH_RULES.find(r => r.name === "rewrite-docs (override gate)")!;
  assert.ok(rule, "rule must exist");

  const ctx = makeCtx(tmp, { phase: "summarizing", activeSlice: { id: "S01", title: "First Slice" } });
  const result = await rule.match(ctx);

  assert.equal(result, null, "should return null (fall through) when no overrides");
});

test("rewrite-docs gate: pending override, count=0 → dispatches rewrite-docs and increments counter", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-rewrite-"));
  t.after(() => { _clearGsdRootCache(); rmSync(tmp, { recursive: true, force: true }); });

  writeOverridesFile(tmp, "active");

  const session = { rewriteAttemptCount: 0 } as { rewriteAttemptCount: number };
  const ctx = makeCtx(tmp, { phase: "executing" }, { session: session as DispatchContext["session"] });

  const rule = DISPATCH_RULES.find(r => r.name === "rewrite-docs (override gate)")!;
  const result = await rule.match(ctx);

  assert.ok(result !== null, "should not return null");
  assert.equal(result!.action, "dispatch", "rewrite-docs override should produce a dispatch action");
  assert.equal(result.unitType, "rewrite-docs", "override gate should dispatch rewrite-docs unit type");
  assert.equal(session.rewriteAttemptCount, 1, "counter should be incremented to 1");
});

test("rewrite-docs gate: pending override, count=1 → dispatches rewrite-docs and increments counter to 2", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-rewrite-"));
  t.after(() => { _clearGsdRootCache(); rmSync(tmp, { recursive: true, force: true }); });

  writeOverridesFile(tmp, "active");

  const session = { rewriteAttemptCount: 1 } as { rewriteAttemptCount: number };
  const ctx = makeCtx(tmp, { phase: "executing" }, { session: session as DispatchContext["session"] });

  const rule = DISPATCH_RULES.find(r => r.name === "rewrite-docs (override gate)")!;
  const result = await rule.match(ctx);

  assert.ok(result !== null, "should dispatch");
  assert.equal(result!.action, "dispatch", "rewrite-docs override should produce a dispatch action");
  assert.equal(session.rewriteAttemptCount, 2, "counter should increment to 2");
});

test("rewrite-docs gate: pending overrides, count=3 → resolves all overrides, resets counter, falls through", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-rewrite-3-"));
  t.after(() => { _clearGsdRootCache(); rmSync(tmp, { recursive: true, force: true }); });

  writeOverridesFile(tmp, "active");

  const session = { rewriteAttemptCount: 3 } as { rewriteAttemptCount: number };
  const ctx = makeCtx(tmp, { phase: "executing" }, { session: session as DispatchContext["session"] });

  const rule = DISPATCH_RULES.find(r => r.name === "rewrite-docs (override gate)")!;
  const result = await rule.match(ctx);

  assert.equal(result, null, "should fall through (return null) at MAX_REWRITE_ATTEMPTS");
  assert.equal(session.rewriteAttemptCount, 0, "counter should be reset to 0");
});

// ─── 2. uat-verdict-gate ──────────────────────────────────────────────────

test("uat-verdict-gate: no DB open → falls through (returns null)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-uat-gate-"));
  t.after(() => { _clearGsdRootCache(); rmSync(tmp, { recursive: true, force: true }); });

  // Ensure DB is closed
  closeDatabase();

  const ctx = makeCtx(tmp, { phase: "executing" }, { prefs: { uat_dispatch: true } as DispatchContext["prefs"] });
  const rule = DISPATCH_RULES.find(r => r.name === "uat-verdict-gate (non-PASS blocks progression)")!;
  assert.ok(rule, "rule must exist");

  const result = await rule.match(ctx);
  assert.equal(result, null, "should fall through when DB unavailable");
});

test("uat-verdict-gate: DB available, completed slice has PASS verdict → falls through", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-uat-pass-"));
  t.after(() => {
    _clearGsdRootCache();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dbPath = join(tmp, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

  // Write UAT-RESULT file with PASS verdict
  scaffoldSlice(tmp, "M001", "S01", {
    "S01-UAT-RESULT.md": "verdict: PASS\n\nAll checks passed.\n",
  });

  const ctx = makeCtx(
    tmp,
    { phase: "executing" },
    { prefs: { uat_dispatch: true } as DispatchContext["prefs"] },
  );
  const rule = DISPATCH_RULES.find(r => r.name === "uat-verdict-gate (non-PASS blocks progression)")!;
  const result = await rule.match(ctx);

  assert.equal(result, null, "PASS verdict should fall through");
});

test("uat-verdict-gate: DB available, completed slice has FAIL verdict → stops with warning", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-uat-fail-"));
  t.after(() => {
    _clearGsdRootCache();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dbPath = join(tmp, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

  // Write UAT-RESULT file with FAIL verdict
  scaffoldSlice(tmp, "M001", "S01", {
    "S01-UAT-RESULT.md": "verdict: fail\n\nSome checks failed.\n",
  });

  const ctx = makeCtx(
    tmp,
    { phase: "executing" },
    { prefs: { uat_dispatch: true } as DispatchContext["prefs"] },
  );
  const rule = DISPATCH_RULES.find(r => r.name === "uat-verdict-gate (non-PASS blocks progression)")!;
  const result = await rule.match(ctx);

  assert.ok(result !== null, "should stop on fail verdict");
  assert.equal(result!.action, "stop", "non-PASS verdict should stop pipeline progression");
  assert.equal(result.level, "warning", "expected warning level");
  assert.ok(result.reason.includes("S01"), "stop reason should mention the slice ID");
});

test("uat-verdict-gate: DB available, completed slice missing UAT-RESULT → falls through (no file = no verdict)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-uat-missing-"));
  t.after(() => {
    _clearGsdRootCache();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dbPath = join(tmp, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

  // Create the slice directory but no UAT-RESULT file
  scaffoldSlice(tmp, "M001", "S01", {});

  const ctx = makeCtx(
    tmp,
    { phase: "executing" },
    { prefs: { uat_dispatch: true } as DispatchContext["prefs"] },
  );
  const rule = DISPATCH_RULES.find(r => r.name === "uat-verdict-gate (non-PASS blocks progression)")!;
  const result = await rule.match(ctx);

  // The gate reads the content; if the file doesn't exist, loadFile returns null → continue/falls through
  assert.equal(result, null, "missing UAT-RESULT with no content → falls through");
});

test("uat-verdict-gate: prefs.uat_dispatch false → falls through immediately", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-uat-nopref-"));
  t.after(() => {
    _clearGsdRootCache();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  const ctx = makeCtx(tmp, { phase: "executing" }, { prefs: undefined });
  const rule = DISPATCH_RULES.find(r => r.name === "uat-verdict-gate (non-PASS blocks progression)")!;
  const result = await rule.match(ctx);
  assert.equal(result, null, "no uat_dispatch pref → falls through");
});

// ─── 3. summarizing → complete-slice ─────────────────────────────────────

test("summarizing: phase=summarizing with active slice → dispatches complete-slice", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-summarizing-"));
  t.after(() => { _clearGsdRootCache(); rmSync(tmp, { recursive: true, force: true }); });

  scaffoldSlice(tmp, "M001", "S01", {});

  const ctx = makeCtx(tmp, {
    phase: "summarizing",
    activeSlice: { id: "S01", title: "First Slice" },
  });

  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch", "summarizing phase should produce dispatch action");
  assert.equal(result.unitType, "complete-slice", "summarizing phase should dispatch complete-slice unit type");
  assert.equal(result.unitId, "M001/S01", "dispatch unitId should be M001/S01");
});

test("summarizing: phase=summarizing with no active slice → stop error", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-summarizing-nosl-"));
  t.after(() => { _clearGsdRootCache(); rmSync(tmp, { recursive: true, force: true }); });

  const ctx = makeCtx(tmp, {
    phase: "summarizing",
    activeSlice: null,
  });

  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "stop", "missing active slice in summarizing phase should stop");
  assert.equal(result.level, "error", "should stop with error level when no active slice in summarizing phase");
  assert.ok(result.reason.includes("summarizing"), "error reason should mention the phase");
});

test("summarizing rule: other phase (planning) → falls through (rule returns null)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-summarizing-other-"));
  t.after(() => { _clearGsdRootCache(); rmSync(tmp, { recursive: true, force: true }); });

  const rule = DISPATCH_RULES.find(r => r.name === "summarizing → complete-slice")!;
  assert.ok(rule, "rule must exist");

  const ctx = makeCtx(tmp, { phase: "planning" });
  const result = await rule.match(ctx);

  assert.equal(result, null, "non-summarizing phase → rule should fall through");
});

// ─── 4. run-uat (post-completion) ────────────────────────────────────────

test("run-uat: phase not post-completion (no DB, uat_dispatch false) → falls through", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-runuat-nopref-"));
  t.after(() => {
    _clearGsdRootCache();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  // No prefs.uat_dispatch = true, so checkNeedsRunUat returns null immediately
  const ctx = makeCtx(tmp, { phase: "executing" }, { prefs: undefined });

  const rule = DISPATCH_RULES.find(r => r.name === "run-uat (post-completion)")!;
  assert.ok(rule, "rule must exist");

  const result = await rule.match(ctx);
  assert.equal(result, null, "no uat_dispatch pref → falls through");
});

test("run-uat: DB has completed and incomplete slices, UAT file exists, no result → dispatches run-uat", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-runuat-dispatch-"));
  t.after(() => {
    _clearGsdRootCache();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dbPath = join(tmp, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test" });
  // S01 complete, S02 pending — checkNeedsRunUat triggers on the last completed
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "pending" });

  // Write a UAT file for S01
  scaffoldSlice(tmp, "M001", "S01", {
    "S01-UAT.md": [
      "---",
      "uat_type: artifact-driven",
      "---",
      "",
      "# UAT: First Slice",
      "",
      "Check that artifacts were produced.",
    ].join("\n"),
  });
  // No UAT-RESULT file — so the UAT hasn't been run yet

  const ctx = makeCtx(
    tmp,
    { phase: "executing" },
    { prefs: { uat_dispatch: true } as DispatchContext["prefs"] },
  );

  const rule = DISPATCH_RULES.find(r => r.name === "run-uat (post-completion)")!;
  const result = await rule.match(ctx);

  assert.ok(result !== null, "should dispatch run-uat when UAT file exists and no result");
  assert.equal(result!.action, "dispatch", "pending UAT should produce a dispatch action");
  assert.equal(result.unitType, "run-uat", "dispatched unit type should be run-uat");
  assert.ok(result.unitId.includes("S01"), "unitId should reference the completed slice S01");
});

test("run-uat: all slices complete (no incomplete) → falls through", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-runuat-allcomplete-"));
  t.after(() => {
    _clearGsdRootCache();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dbPath = join(tmp, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test" });
  // All slices complete — checkNeedsRunUat returns null (incompleteSlices.length === 0)
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "complete" });

  const ctx = makeCtx(
    tmp,
    { phase: "executing" },
    { prefs: { uat_dispatch: true } as DispatchContext["prefs"] },
  );

  const rule = DISPATCH_RULES.find(r => r.name === "run-uat (post-completion)")!;
  const result = await rule.match(ctx);

  assert.equal(result, null, "all slices complete → falls through (no post-completion UAT needed)");
});

test("run-uat: UAT result already exists → falls through (already ran)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-runuat-hasresult-"));
  t.after(() => {
    _clearGsdRootCache();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dbPath = join(tmp, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "pending" });

  scaffoldSlice(tmp, "M001", "S01", {
    "S01-UAT.md": "---\nuat_type: artifact-driven\n---\n\n# UAT\n",
    "S01-UAT-RESULT.md": "verdict: PASS\n\nAll good.\n",
  });

  const ctx = makeCtx(
    tmp,
    { phase: "executing" },
    { prefs: { uat_dispatch: true } as DispatchContext["prefs"] },
  );

  const rule = DISPATCH_RULES.find(r => r.name === "run-uat (post-completion)")!;
  const result = await rule.match(ctx);

  assert.equal(result, null, "UAT result already exists → falls through");
});
