import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractCommitShas,
  findCommitsForUnit,
  handleUndo,
  uncheckTaskInPlan,
} from "../undo.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

test("handleUndo without --force only warns and leaves completed units intact", async () => {
  const base = makeTempDir("gsd-undo-confirm");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "completed-units.json"),
      JSON.stringify(["execute-task/M001/S01/T01"]),
      "utf-8",
    );

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };

    await handleUndo("", ctx as any, {} as any, base);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Run \/gsd undo --force to confirm\./);
    assert.deepEqual(
      JSON.parse(readFileSync(join(base, ".gsd", "completed-units.json"), "utf-8")),
      ["execute-task/M001/S01/T01"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("uncheckTaskInPlan flips a checked task back to unchecked", () => {
  const base = makeTempDir("gsd-undo-plan");
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    const planFile = join(sliceDir, "S01-PLAN.md");
    writeFileSync(
      planFile,
      [
        "# Slice Plan",
        "",
        "- [x] **T01**: Ship the feature",
        "- [ ] **T02**: Follow-up",
      ].join("\n"),
      "utf-8",
    );

    assert.equal(uncheckTaskInPlan(base, "M001", "S01", "T01"), true);
    assert.match(readFileSync(planFile, "utf-8"), /- \[ \] \*\*T01\*\*: Ship the feature/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("findCommitsForUnit reads the newest matching activity log and dedupes SHAs", () => {
  const base = makeTempDir("gsd-undo-activity");
  try {
    const activityDir = join(base, ".gsd", "activity");
    mkdirSync(activityDir, { recursive: true });

    writeFileSync(
      join(activityDir, "2026-03-14-execute-task-M001-S01-T01.jsonl"),
      `${JSON.stringify({
        message: {
          content: [
            { type: "tool_result", content: "[main abc1234] old commit" },
          ],
        },
      })}\n`,
      "utf-8",
    );

    writeFileSync(
      join(activityDir, "2026-03-15-execute-task-M001-S01-T01.jsonl"),
      [
        JSON.stringify({
          message: {
            content: [
              { type: "tool_result", content: "[main deadbee] new commit\n[main cafe123] another commit" },
              { type: "tool_result", content: "[main deadbee] duplicate commit" },
            ],
          },
        }),
        "{not-json}",
      ].join("\n"),
      "utf-8",
    );

    assert.deepEqual(
      findCommitsForUnit(activityDir, "execute-task", "M001/S01/T01"),
      ["deadbee", "cafe123"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("extractCommitShas returns unique commit hashes from git output blocks", () => {
  const content = [
    "[main abc1234] first commit",
    "[feature deadbeef] second commit",
    "[main abc1234] duplicate commit",
  ].join("\n");

  assert.deepEqual(extractCommitShas(content), ["abc1234", "deadbeef"]);
});

test("extractCommitShas ignores malformed commit tokens", () => {
  const content = [
    "[main abc1234; touch /tmp/pwned] not a real sha token",
    "[main not-a-sha] ignored",
    "[main 1234567] valid",
  ].join("\n");

  assert.deepEqual(extractCommitShas(content), ["1234567"]);
});
