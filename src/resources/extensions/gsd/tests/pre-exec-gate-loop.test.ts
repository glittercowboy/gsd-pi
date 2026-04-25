/**
 * pre-exec-gate-loop.test.ts — Regression tests for #4551.
 *
 * Verifies that when a pre-execution gate fails on a plan-slice unit:
 *   1. `s.lastPreExecFailure` is populated on the AutoSession with the blocking
 *      findings and a verdict excerpt.
 *   2. The `planning → plan-slice` dispatch rule reads that field and injects a
 *      "Fix these specific issues" section into the prompt.
 *   3. The field is cleared (consumed) after the prompt is built so that stale
 *      context does not bleed into an unrelated future plan-slice run.
 *   4. When the failure belongs to a *different* unit ID, the dispatch rule
 *      does NOT inject the stale context into the prompt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AutoSession } from "../auto/session.ts";
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";
import { buildPlanSlicePrompt } from "../auto-prompts.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";
import { deriveStateFromDb } from "../state.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { invalidateAllCaches } from "../cache.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-4551-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function seedPlanningState(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Core Slice",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "demo",
    sequence: 1,
    isSketch: false,
  });
  // Write minimal ROADMAP so state derivation doesn't error
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# Roadmap\n",
  );
}

function cleanup(base: string, originalCwd: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { process.chdir(originalCwd); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("#4551: AutoSession.lastPreExecFailure defaults to null", () => {
  const s = new AutoSession();
  assert.equal(s.lastPreExecFailure, null, "lastPreExecFailure must start null");
});

test("#4551: AutoSession.reset() clears lastPreExecFailure", () => {
  const s = new AutoSession();
  s.lastPreExecFailure = {
    unitId: "M001/S01",
    blockingFindings: ["[file] src/foo.ts: file not found"],
    verdictExcerpt: "status=fail; 1 blocking issue detected",
  };
  s.reset();
  assert.equal(s.lastPreExecFailure, null, "reset() must clear lastPreExecFailure");
});

test("#4551: buildPlanSlicePrompt injects fix section when priorPreExecFailure provided", async (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));

  seedPlanningState(base);
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();

  const prompt = await buildPlanSlicePrompt(
    "M001", "Test Milestone", "S01", "Core Slice", base,
    undefined,
    {
      priorPreExecFailure: {
        blockingFindings: [
          "[file] src/utils/helper.ts: file not found",
          "[package] nonexistent-pkg: package not found on npm",
        ],
        verdictExcerpt: "status=fail; 2 blocking issues detected",
      },
    },
  );

  assert.ok(
    prompt.includes("Fix these specific issues from the prior pre-exec check"),
    "prompt must contain the fix section heading",
  );
  assert.ok(
    prompt.includes("src/utils/helper.ts: file not found"),
    "prompt must include the specific file finding",
  );
  assert.ok(
    prompt.includes("nonexistent-pkg: package not found on npm"),
    "prompt must include the specific package finding",
  );
  assert.ok(
    prompt.includes("status=fail; 2 blocking issues detected"),
    "prompt must include the verdict excerpt",
  );
});

test("#4551: buildPlanSlicePrompt with no priorPreExecFailure does NOT include fix section", async (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));

  seedPlanningState(base);
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();

  const prompt = await buildPlanSlicePrompt(
    "M001", "Test Milestone", "S01", "Core Slice", base,
    undefined,
    { /* no priorPreExecFailure */ },
  );

  assert.ok(
    !prompt.includes("Fix these specific issues from the prior pre-exec check"),
    "prompt must NOT include the fix section when no failure context is given",
  );
});

test("#4551: dispatch rule injects failure context and clears session field", async (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));

  seedPlanningState(base);
  // Write a RESEARCH file so the dispatch rule skips research-slice and reaches
  // plan-slice (which is the phase we're testing).
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-RESEARCH.md"),
    "# Research\n",
  );
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();

  const state = await deriveStateFromDb(base);
  assert.equal(state.phase, "planning", "state must be in planning phase");

  const session = new AutoSession();
  session.basePath = base;
  session.active = true;
  session.lastPreExecFailure = {
    unitId: "M001/S01",
    blockingFindings: ["[file] src/missing.ts: file not found"],
    verdictExcerpt: "status=fail; 1 blocking issue detected",
  };

  const ctx: DispatchContext = {
    basePath: base,
    mid: "M001",
    midTitle: "Test Milestone",
    state,
    prefs: { phases: { reassess_after_slice: false, skip_research: true } } as any,
    session,
  };

  const result = await resolveDispatch(ctx);
  assert.equal(result.action, "dispatch", "must dispatch a unit");
  if (result.action !== "dispatch") throw new Error("unreachable");
  assert.equal(result.unitType, "plan-slice", "must be a plan-slice unit");

  // The fix section must appear in the prompt
  assert.ok(
    result.prompt.includes("Fix these specific issues from the prior pre-exec check"),
    "dispatched prompt must include the fix section",
  );
  assert.ok(
    result.prompt.includes("src/missing.ts: file not found"),
    "dispatched prompt must include the specific blocking finding",
  );

  // Field must be cleared after consumption
  assert.equal(
    session.lastPreExecFailure,
    null,
    "lastPreExecFailure must be cleared after being consumed by the dispatch rule",
  );
});

test("#4551: dispatch rule does NOT inject stale failure for a different slice", async (t) => {
  const originalCwd = process.cwd();
  const base = makeTempBase();
  t.after(() => cleanup(base, originalCwd));

  seedPlanningState(base);
  // Write a RESEARCH file so dispatch reaches plan-slice, making the assertion
  // about the prompt meaningful (we can check it's a plan-slice prompt without
  // the fix section rather than a research-slice prompt without it).
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-RESEARCH.md"),
    "# Research\n",
  );
  process.chdir(base);
  _clearGsdRootCache();
  invalidateAllCaches();

  const state = await deriveStateFromDb(base);

  const session = new AutoSession();
  session.basePath = base;
  session.active = true;
  // Failure belongs to a different slice (S02), not the active one (S01)
  session.lastPreExecFailure = {
    unitId: "M001/S02",
    blockingFindings: ["[file] src/other.ts: file not found"],
    verdictExcerpt: "status=fail; 1 blocking issue detected",
  };

  const ctx: DispatchContext = {
    basePath: base,
    mid: "M001",
    midTitle: "Test Milestone",
    state,
    prefs: { phases: { reassess_after_slice: false, skip_research: true } } as any,
    session,
  };

  const result = await resolveDispatch(ctx);
  assert.equal(result.action, "dispatch");
  if (result.action !== "dispatch") throw new Error("unreachable");

  // The stale fix section must NOT appear
  assert.ok(
    !result.prompt.includes("Fix these specific issues from the prior pre-exec check"),
    "prompt must NOT include fix section for a mismatched unit ID",
  );
  assert.ok(
    !result.prompt.includes("src/other.ts"),
    "prompt must NOT include findings from a different slice",
  );

  // Field must remain untouched (not consumed)
  assert.notEqual(
    session.lastPreExecFailure,
    null,
    "lastPreExecFailure must NOT be cleared when unit IDs don't match",
  );
});
