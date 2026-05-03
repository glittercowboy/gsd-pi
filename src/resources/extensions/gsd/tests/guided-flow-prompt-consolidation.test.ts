/**
 * GSD2 — regression test for #5183: prompt consolidation.
 *
 * The PR removed `guided-execute-task.md` and `guided-complete-slice.md` and
 * routed `guided-flow.ts` callers to `buildExecuteTaskPrompt` /
 * `buildCompleteSlicePrompt` from `auto-prompts.ts`. This test exercises the
 * consolidated builders against a real fixture and asserts they produce
 * prompts carrying the contract the deleted variants used to enforce:
 *   - the canonical `gsd_*_complete` tool reference,
 *   - the explicit working directory binding,
 *   - the unit identifiers (milestone/slice/task),
 *   - the quality-gate doctrine that was backported into the canonical files
 *     (Q8 Operational Readiness for complete-slice).
 *
 * Failure of this test means the manual `/gsd` flow no longer matches the
 * doctrine the auto-mode pipeline relies on — exactly the drift the PR is
 * supposed to prevent.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
} from "../auto-prompts.ts";

const MID = "M001";
const SID = "S01";
const TID = "T01";
const M_TITLE = "Test milestone";
const S_TITLE = "Test slice";
const T_TITLE = "Test task";

describe("guided-flow → auto-prompts consolidation (#5183)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-prompt-consolidation-"));
    const sliceDir = join(base, ".gsd", "milestones", MID, "slices", SID);
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeFileSync(
      join(base, ".gsd", "milestones", MID, `${MID}-ROADMAP.md`),
      "# Roadmap\n- [ ] **S01: Test slice**\n",
    );
    writeFileSync(
      join(sliceDir, `${SID}-PLAN.md`),
      [
        "# Slice plan",
        "",
        "## Tasks",
        "- T01: Test task",
        "",
        "## Verification",
        "- All tests pass",
      ].join("\n"),
    );
    writeFileSync(
      join(tasksDir, `${TID}-PLAN.md`),
      [
        "# Task plan",
        "",
        "## Steps",
        "1. Implement the thing",
        "",
        "## Must-haves",
        "- Working code",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("buildExecuteTaskPrompt carries the execute-task contract", async () => {
    const prompt = await buildExecuteTaskPrompt(MID, SID, S_TITLE, TID, T_TITLE, base);

    assert.ok(prompt.includes(MID), "must mention milestone id");
    assert.ok(prompt.includes(SID), "must mention slice id");
    assert.ok(prompt.includes(TID), "must mention task id");
    assert.ok(prompt.includes(T_TITLE), "must mention task title");
    assert.ok(
      prompt.includes("gsd_task_complete"),
      "must instruct calling the canonical gsd_task_complete tool",
    );
    assert.ok(
      prompt.includes(base),
      "must bind the explicit working directory absolute path",
    );
    assert.ok(
      prompt.includes("Inlined Task Plan"),
      "must inline the task plan as the authoritative execution contract",
    );
    assert.ok(
      prompt.includes("Implement the thing"),
      "must include task plan body content from disk",
    );
    assert.ok(prompt.includes("## Context Mode"), "execute-task should include standalone Context Mode guidance");
    assert.ok(prompt.includes("execution lane"), "execute-task should render the execution lane");
  });

  test("buildExecuteTaskPrompt omits Context Mode when disabled", async () => {
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      ["---", "context_mode:", "  enabled: false", "---", ""].join("\n"),
    );

    const prompt = await buildExecuteTaskPrompt(MID, SID, S_TITLE, TID, T_TITLE, base);

    assert.ok(!prompt.includes("## Context Mode"));
    assert.ok(!prompt.includes("Context Mode (execution lane)"));
  });

  test("buildCompleteSlicePrompt carries the complete-slice contract", async () => {
    const prompt = await buildCompleteSlicePrompt(MID, M_TITLE, SID, S_TITLE, base);

    assert.ok(prompt.includes(MID), "must mention milestone id");
    assert.ok(prompt.includes(SID), "must mention slice id");
    assert.ok(prompt.includes(S_TITLE), "must mention slice title");
    assert.ok(
      prompt.includes("gsd_slice_complete"),
      "must instruct calling gsd_slice_complete (was in guided-complete-slice.md)",
    );
    assert.ok(
      prompt.includes(base),
      "must bind the explicit working directory absolute path",
    );
    assert.ok(
      /Operational Readiness/i.test(prompt),
      "must reference Q8 Operational Readiness doctrine (backported from guided-complete-slice.md)",
    );
    assert.ok(
      /Slice Summary/i.test(prompt),
      "must reference the Slice Summary output template",
    );
    assert.ok(
      /UAT/.test(prompt),
      "must reference the UAT output template",
    );
  });
});
