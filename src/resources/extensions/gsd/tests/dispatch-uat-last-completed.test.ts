// Regression test for #1693 — /gsd dispatch uat targets the last completed
// slice from the roadmap instead of state.activeSlice (which has already
// advanced to the next incomplete slice).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { dispatchDirectPhase } from "../auto-direct-dispatch.ts";
import { invalidateStateCache } from "../state.ts";

function createFixture(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-uat-"));

  // Milestone M001 with two slices: S01 done, S02 incomplete
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-CONTEXT.md"),
    "# M001: Test Milestone\n\nContext.\n",
  );

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: Completed slice** `risk:low` `depends:[]`",
      "- [ ] **S02: Active slice** `risk:low` `depends:[S01]`",
      "",
    ].join("\n"),
  );

  // S01 has a UAT file (this is the one dispatch should target)
  const s01Dir = join(milestoneDir, "slices", "S01");
  mkdirSync(s01Dir, { recursive: true });
  writeFileSync(
    join(s01Dir, "S01-UAT.md"),
    "# UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n\n## Scenarios\n\n- Check output\n",
  );
  // S01 needs a PLAN with completed tasks so deriveState considers it done
  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    "# S01 Plan\n\n## Tasks\n\n- [x] **T01: Task one** `effort:low`\n",
  );
  const t01Dir = join(s01Dir, "tasks", "T01");
  mkdirSync(t01Dir, { recursive: true });
  writeFileSync(join(t01Dir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.\n");

  // S02 has a plan but incomplete tasks — this is where activeSlice points
  const s02Dir = join(milestoneDir, "slices", "S02");
  mkdirSync(s02Dir, { recursive: true });
  writeFileSync(
    join(s02Dir, "S02-PLAN.md"),
    "# S02 Plan\n\n## Tasks\n\n- [ ] **T01: Task one** `effort:low`\n",
  );
  const s02t01Dir = join(s02Dir, "tasks", "T01");
  mkdirSync(s02t01Dir, { recursive: true });
  writeFileSync(join(s02t01Dir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.\n");

  return base;
}

test("dispatch uat targets last completed slice, not activeSlice (#1693)", async (t) => {
  const base = createFixture();
  invalidateStateCache();

  const notifications: { message: string; level: string }[] = [];
  let sentPrompt: string | undefined;

  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    newSession: async () => ({ cancelled: false }),
  } as any;

  const pi = {
    sendMessage: (msg: { content: string }, _opts: unknown) => {
      sentPrompt = msg.content;
    },
  } as any;

  t.after(() => rmSync(base, { recursive: true, force: true }));

  await dispatchDirectPhase(ctx, pi, "uat", base);

  // Should have dispatched (sendMessage called)
  assert.ok(sentPrompt, "sendMessage should have been called with a prompt");

  // The dispatch notification should reference M001/S01 (completed), not M001/S02 (active)
  const dispatchNotification = notifications.find(n => n.message.startsWith("Dispatching"));
  assert.ok(dispatchNotification, "dispatch notification should be present");
  assert.match(
    dispatchNotification.message,
    /M001\/S01/,
    "dispatch should target completed slice S01, not active slice S02",
  );
  assert.doesNotMatch(
    dispatchNotification.message,
    /M001\/S02/,
    "dispatch should NOT target active (next incomplete) slice S02",
  );
});

test("dispatch uat warns when no completed slices exist", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-uat-none-"));
  invalidateStateCache();

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-CONTEXT.md"),
    "# M001: Test Milestone\n\nContext.\n",
  );

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First** `risk:low` `depends:[]`",
      "",
    ].join("\n"),
  );

  // S01 needs a plan so state derivation doesn't stop at planning phase
  const s01Dir = join(milestoneDir, "slices", "S01");
  mkdirSync(s01Dir, { recursive: true });
  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: Task** `effort:low`\n",
  );
  const t01Dir = join(s01Dir, "tasks", "T01");
  mkdirSync(t01Dir, { recursive: true });
  writeFileSync(join(t01Dir, "T01-PLAN.md"), "# T01 Plan\n");

  const notifications: { message: string; level: string }[] = [];

  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    newSession: async () => ({ cancelled: false }),
  } as any;

  const pi = {
    sendMessage: () => {
      assert.fail("sendMessage should not be called when no completed slices");
    },
  } as any;

  t.after(() => rmSync(base, { recursive: true, force: true }));

  await dispatchDirectPhase(ctx, pi, "uat", base);

  const warning = notifications.find(n => n.level === "warning");
  assert.ok(warning, "should show a warning notification");
  assert.match(warning.message, /no completed slices/, "warning should mention no completed slices");
});
