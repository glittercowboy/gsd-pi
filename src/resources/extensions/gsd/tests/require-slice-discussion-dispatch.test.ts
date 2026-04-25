/**
 * Regression tests for #3454: auto-dispatch must honour
 * require_slice_discussion and pause before plan-slice when:
 *   1. state.phase === "planning"
 *   2. require_slice_discussion is enabled in preferences
 *   3. state.activeSlice is non-null
 *   4. the slice has no CONTEXT file on disk
 *
 * Exercises the dispatch rule from DISPATCH_RULES directly with a
 * DispatchContext built against a real temp directory — no source-string
 * matching, no brittle rename dependencies.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import type { GSDPreferences } from "../preferences.ts";

// Use a stable token (the preference name) for rule lookup instead of the
// full human-readable title — copy edits to the rule name will not break
// these tests as long as the rule still references the preference it gates.
const RULE_NAME_TOKEN = "require_slice_discussion";

function findRule() {
  const matches = DISPATCH_RULES.filter(r => r.name.includes(RULE_NAME_TOKEN));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one dispatch rule containing "${RULE_NAME_TOKEN}", found ${matches.length}`);
  }
  return matches[0];
}

function buildState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Test milestone" },
    activeSlice: { id: "S01", title: "Test slice" },
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function makeBasePath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gsd-req-slice-${prefix}-`));
  mkdirSync(join(dir, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  return dir;
}

function buildCtx(
  basePath: string,
  prefs: GSDPreferences | undefined,
  state: GSDState = buildState(),
): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Test milestone",
    state,
    prefs,
  };
}

describe("require_slice_discussion dispatch rule (#3454)", () => {
  // ─── Positive case: rule fires ────────────────────────────────────────

  test("returns stop action when preference enabled and CONTEXT missing", async () => {
    const basePath = makeBasePath("fire");
    try {
      const prefs = { phases: { require_slice_discussion: true } } as unknown as GSDPreferences;
      const action = await findRule().match(buildCtx(basePath, prefs));
      assert.ok(action, "rule must return a non-null action when pausing is required");
      assert.strictEqual(action!.action, "stop");
      if (action!.action === "stop") {
        assert.match(action!.reason, /S01/);
        assert.match(action!.reason, /require_slice_discussion/);
        assert.match(action!.reason, /\/gsd discuss/);
        assert.strictEqual(action!.level, "info");
      }
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  // ─── Negative cases: rule falls through ───────────────────────────────

  test("falls through (null) when preference is disabled", async () => {
    const basePath = makeBasePath("pref-disabled");
    try {
      const prefs = { phases: { require_slice_discussion: false } } as unknown as GSDPreferences;
      const action = await findRule().match(buildCtx(basePath, prefs));
      assert.strictEqual(action, null);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("falls through (null) when preference is absent / undefined", async () => {
    const basePath = makeBasePath("pref-absent");
    try {
      const action = await findRule().match(buildCtx(basePath, undefined));
      assert.strictEqual(action, null);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("falls through (null) when phase is not 'planning'", async () => {
    const basePath = makeBasePath("wrong-phase");
    try {
      const prefs = { phases: { require_slice_discussion: true } } as unknown as GSDPreferences;
      const state = buildState({ phase: "executing" });
      const action = await findRule().match(buildCtx(basePath, prefs, state));
      assert.strictEqual(action, null);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("falls through (null) when no active slice", async () => {
    const basePath = makeBasePath("no-slice");
    try {
      const prefs = { phases: { require_slice_discussion: true } } as unknown as GSDPreferences;
      const state = buildState({ activeSlice: null });
      const action = await findRule().match(buildCtx(basePath, prefs, state));
      assert.strictEqual(action, null);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  // ─── Context-file present: should not pause ───────────────────────────

  test("falls through (null) when CONTEXT file already exists on disk", async () => {
    const basePath = makeBasePath("ctx-present");
    try {
      // Seed the CONTEXT file that /gsd discuss would have written.
      const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
      writeFileSync(join(sliceDir, "S01-CONTEXT.md"), "# Discussion notes\n", "utf-8");

      const prefs = { phases: { require_slice_discussion: true } } as unknown as GSDPreferences;
      const action = await findRule().match(buildCtx(basePath, prefs));
      assert.strictEqual(
        action,
        null,
        "once the slice has a CONTEXT file, the rule must fall through so planning proceeds",
      );
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  // ─── Rule ordering: must run before the plan-slice rule ──────────────

  test("rule is ordered before the 'planning → plan-slice' rule", () => {
    const discussIdx = DISPATCH_RULES.findIndex(r => r.name.includes(RULE_NAME_TOKEN));
    const planIdx = DISPATCH_RULES.findIndex(r => r.name.startsWith("planning → plan-slice"));
    assert.ok(discussIdx >= 0, "require_slice_discussion rule must be registered");
    assert.ok(planIdx >= 0, "plan-slice rule must be registered");
    assert.ok(
      discussIdx < planIdx,
      "require_slice_discussion rule must be ordered before plan-slice so it preempts dispatch",
    );
  });
});
