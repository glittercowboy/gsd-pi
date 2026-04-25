// GSD-2 — ADR-003 §4 behavior contract: reassess-roadmap is opt-in.
// Companion to (eventually replacing) the source-grep assertions in
// token-profile.test.ts. This file verifies the dispatch rule's guard
// behavior directly rather than inspecting source text.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DISPATCH_RULES,
  setReassessmentCheckerForTest,
  type DispatchAction,
  type DispatchContext,
} from "../auto-dispatch.ts";
import { resolveProfileDefaults } from "../preferences-models.ts";
import type { GSDState } from "../types.ts";
import type { GSDPreferences } from "../preferences.ts";

const REASSESS_RULE_NAME = "reassess-roadmap (post-completion)";

function makeIsolatedBase(): string {
  const base = join(tmpdir(), `gsd-reassess-default-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function makeCtx(prefs: GSDPreferences | undefined, basePath: string): DispatchContext {
  const state: GSDState = {
    phase: "executing",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: { id: "S01", title: "First" },
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Test", status: "active" }],
  };
  return { basePath, mid: "M001", midTitle: "Test", state, prefs };
}

function reassessRule() {
  const rule = DISPATCH_RULES.find(r => r.name === REASSESS_RULE_NAME);
  assert.ok(rule, `dispatch rule "${REASSESS_RULE_NAME}" must exist`);
  return rule!;
}

const guardCases: Array<{ name: string; prefs: GSDPreferences | undefined; message?: string }> = [
  {
    name: "prefs is undefined (new default)",
    prefs: undefined,
    message: "default behavior must be opt-in — no prefs means no reassess dispatch",
  },
  {
    name: "prefs.phases is undefined",
    prefs: {} as GSDPreferences,
  },
  {
    name: "phases.reassess_after_slice is explicitly false",
    prefs: { phases: { reassess_after_slice: false } } as unknown as GSDPreferences,
  },
  {
    name: "phases.skip_reassess is true (short-circuit guard preserved)",
    prefs: { phases: { skip_reassess: true, reassess_after_slice: true } } as unknown as GSDPreferences,
    message: "skip_reassess must win over reassess_after_slice",
  },
];

for (const { name, prefs, message } of guardCases) {
  test(`ADR-003 §4: reassess-roadmap does NOT dispatch when ${name}`, async (t) => {
    const base = makeIsolatedBase();
    t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

    let checkerCalls = 0;
    const restoreChecker = setReassessmentCheckerForTest(async () => {
      checkerCalls++;
      return { sliceId: "S01" };
    });
    t.after(restoreChecker);

    const result = await reassessRule().match(makeCtx(prefs, base));
    assert.strictEqual(result, null, message);
    assert.strictEqual(checkerCalls, 0, "preference guards must short-circuit before reassessment detection");
  });
}

test("ADR-003 §4: reassess-roadmap opt-in path dispatches after reassessment detection", async (t) => {
  const base = makeIsolatedBase();
  t.after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  const checkerCalls: Array<{ basePath: string; mid: string; activeSliceId: string | undefined }> = [];
  const restoreChecker = setReassessmentCheckerForTest(async (checkerBase, checkerMid, state) => {
    checkerCalls.push({ basePath: checkerBase, mid: checkerMid, activeSliceId: state.activeSlice?.id });
    return { sliceId: "S01" };
  });
  t.after(restoreChecker);

  const prefs = { phases: { reassess_after_slice: true } } as unknown as GSDPreferences;
  const result: DispatchAction | null = await reassessRule().match(makeCtx(prefs, base));

  assert.deepStrictEqual(checkerCalls, [{ basePath: base, mid: "M001", activeSliceId: "S01" }]);
  assert.ok(result, "opt-in path should return a dispatch action when reassessment is needed");
  assert.strictEqual(result.action, "dispatch");
  if (result.action !== "dispatch") assert.fail("expected dispatch action");
  assert.strictEqual(result.unitType, "reassess-roadmap");
  assert.strictEqual(result.unitId, "M001/S01");
  assert.match(result.prompt, /reassess/i);
});

test("ADR-003 §4: burn-max profile opts into dedicated reassess-roadmap dispatch", () => {
  const defaults = resolveProfileDefaults("burn-max");
  assert.strictEqual(defaults.phases?.reassess_after_slice, true);
  assert.strictEqual(defaults.phases?.skip_reassess, false);
});

test("ADR-003 §4: plan-slice prompt and MCP tool agree on reassess sliceChanges shape", () => {
  const planSlicePrompt = readFileSync(new URL("../prompts/plan-slice.md", import.meta.url), "utf8");
  assert.match(planSlicePrompt, /gsd_reassess_roadmap/);
  assert.match(planSlicePrompt, /sliceChanges\.modified/);
  assert.match(planSlicePrompt, /sliceChanges\.added/);
  assert.match(planSlicePrompt, /sliceChanges\.removed/);

  const dbToolsSource = readFileSync(new URL("../bootstrap/db-tools.ts", import.meta.url), "utf8");
  assert.match(dbToolsSource, /name:\s*"gsd_reassess_roadmap"/);
  assert.match(dbToolsSource, /sliceChanges:\s*Type\.Object/);
  assert.match(dbToolsSource, /modified:\s*Type\.Array/);
  assert.match(dbToolsSource, /added:\s*Type\.Array/);
  assert.match(dbToolsSource, /removed:\s*Type\.Array/);
});
