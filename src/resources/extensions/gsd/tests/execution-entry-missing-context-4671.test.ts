/**
 * Regression tests for #4671 — execution-entry phase + missing CONTEXT.md.
 *
 * When a milestone advances to an execution-entry phase (executing /
 * summarizing / validating-milestone / completing-milestone) without
 * `CONTEXT.md` on disk, the `pre-planning (no context) → discuss-milestone`
 * rule no longer fires and the plan-v2 gate only blocks. This rule provides
 * the recovery by redispatching to discuss-milestone.
 *
 * Exercises the dispatch rule from DISPATCH_RULES directly with a
 * DispatchContext built against a real temp directory.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import type { GSDState, Phase } from "../types.ts";

const RULE_NAME_TOKEN = "execution-entry phase (no context)";

function findRule() {
  const matches = DISPATCH_RULES.filter((r) => r.name.includes(RULE_NAME_TOKEN));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one dispatch rule containing "${RULE_NAME_TOKEN}", found ${matches.length}`,
    );
  }
  return matches[0];
}

function buildState(phase: Phase): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Test milestone" },
    activeSlice: null,
    activeTask: null,
    phase,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  };
}

function makeBasePath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gsd-4671-${prefix}-`));
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  return dir;
}

function buildCtx(basePath: string, state: GSDState): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Test milestone",
    state,
    prefs: undefined,
  };
}

describe("#4671 execution-entry phase missing-context recovery", () => {
  const executionEntryPhases: Phase[] = [
    "executing",
    "summarizing",
    "validating-milestone",
    "completing-milestone",
  ];

  for (const phase of executionEntryPhases) {
    test(`phase=${phase} with missing CONTEXT.md → dispatches discuss-milestone`, async () => {
      const basePath = makeBasePath(`missing-${phase}`);
      try {
        const action = await findRule().match(buildCtx(basePath, buildState(phase)));
        assert.ok(action, "rule must return an action when CONTEXT.md is missing");
        assert.strictEqual(action!.action, "dispatch");
        if (action!.action === "dispatch") {
          assert.strictEqual(action!.unitType, "discuss-milestone");
          assert.strictEqual(action!.unitId, "M001");
          assert.ok(typeof action!.prompt === "string" && action!.prompt.length > 0);
        }
      } finally {
        rmSync(basePath, { recursive: true, force: true });
      }
    });
  }

  test("phase=executing with CONTEXT.md present → falls through", async () => {
    const basePath = makeBasePath("has-context");
    try {
      writeFileSync(
        join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "# M001 Context\n\nSome real context.\n",
      );
      const action = await findRule().match(buildCtx(basePath, buildState("executing")));
      assert.strictEqual(action, null, "rule must fall through when CONTEXT.md exists");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("phase=executing accepts finalized CONTEXT.md from GSD_PROJECT_ROOT fallback", async () => {
    const projectRoot = makeBasePath("project-root-context");
    const worktreeBase = makeBasePath("worktree-context");
    const prevProjectRoot = process.env.GSD_PROJECT_ROOT;
    try {
      writeFileSync(
        join(projectRoot, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "# M001 Context\n\nFinalized context at project root.\n",
      );
      process.env.GSD_PROJECT_ROOT = projectRoot;

      const action = await findRule().match(buildCtx(worktreeBase, buildState("executing")));
      assert.strictEqual(
        action,
        null,
        "rule must align with plan-v2 project-root fallback before redispatching",
      );
    } finally {
      if (prevProjectRoot === undefined) {
        delete process.env.GSD_PROJECT_ROOT;
      } else {
        process.env.GSD_PROJECT_ROOT = prevProjectRoot;
      }
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktreeBase, { recursive: true, force: true });
    }
  });

  test("phase=pre-planning does not trigger this rule (handled by upstream rule)", async () => {
    const basePath = makeBasePath("pre-planning");
    try {
      const action = await findRule().match(buildCtx(basePath, buildState("pre-planning")));
      assert.strictEqual(
        action,
        null,
        "rule must only target execution-entry phases; pre-planning is handled elsewhere",
      );
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("empty CONTEXT.md (whitespace only) → rule still fires", async () => {
    const basePath = makeBasePath("empty-context");
    try {
      writeFileSync(
        join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "   \n\t\n",
      );
      const action = await findRule().match(buildCtx(basePath, buildState("summarizing")));
      assert.ok(action, "rule must fire when CONTEXT.md is empty/whitespace-only");
      if (action?.action === "dispatch") {
        assert.strictEqual(action.unitType, "discuss-milestone");
      }
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("rule ordering: fires BEFORE execution-entry phase handlers", () => {
    const recoveryIdx = DISPATCH_RULES.findIndex((r) => r.name.includes(RULE_NAME_TOKEN));
    const summarizingIdx = DISPATCH_RULES.findIndex((r) =>
      r.name.startsWith("summarizing → complete-slice"),
    );
    assert.ok(recoveryIdx > -1, "recovery rule must exist");
    assert.ok(summarizingIdx > -1, "summarizing rule must exist");
    assert.ok(
      recoveryIdx < summarizingIdx,
      `recovery rule (idx ${recoveryIdx}) must come before summarizing rule (idx ${summarizingIdx}) so it can redispatch before the plan-v2 gate blocks`,
    );
  });
});
