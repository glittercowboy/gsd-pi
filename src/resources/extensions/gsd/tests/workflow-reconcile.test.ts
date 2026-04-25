import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendEvent, readEvents } from "../workflow-events.ts";
import { listConflicts, reconcileWorktreeLogs, resolveConflict } from "../workflow-reconcile.ts";
import { closeDatabase } from "../gsd-db.ts";

const tmpDirs: string[] = [];

function makeTmpRepo(): { main: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "workflow-reconcile-"));
  const main = join(root, "main");
  const worktree = join(root, "worktree");
  mkdirSync(main, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  tmpDirs.push(root);
  return { main, worktree };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on platforms that keep files open briefly.
    }
  }
  tmpDirs.length = 0;
});

test("resolveConflict(pick=main) rewrites the worktree log durably", () => {
  const { main, worktree } = makeTmpRepo();

  appendEvent(main, {
    cmd: "plan_milestone",
    params: { milestoneId: "M001", title: "Base Milestone" },
    ts: "2026-01-01T00:00:00.000Z",
    actor: "agent",
  });
  appendEvent(worktree, {
    cmd: "plan_milestone",
    params: { milestoneId: "M001", title: "Base Milestone" },
    ts: "2026-01-01T00:00:00.000Z",
    actor: "agent",
  });

  appendEvent(main, {
    cmd: "plan_milestone",
    params: { milestoneId: "M001", title: "Main Choice" },
    ts: "2026-01-01T00:01:00.000Z",
    actor: "agent",
  });

  appendEvent(worktree, {
    cmd: "plan_milestone",
    params: { milestoneId: "M001", title: "Worktree Choice" },
    ts: "2026-01-01T00:01:00.000Z",
    actor: "agent",
  });

  const initial = reconcileWorktreeLogs(main, worktree);
  assert.equal(initial.conflicts.length, 1, "expected one conflict before resolution");
  assert.ok(listConflicts(main).length === 1, "CONFLICTS.md should exist after detection");

  resolveConflict(main, worktree, "milestone:M001", "main");

  assert.equal(listConflicts(main).length, 0, "conflict file should be cleared after resolving main");
  const conflictsPath = join(main, ".gsd", "CONFLICTS.md");
  assert.equal(
    existsSync(conflictsPath),
    false,
    "CONFLICTS.md should be removed after the last conflict is resolved",
  );

  const wtEvents = readEvents(join(worktree, ".gsd", "event-log.jsonl"));
  assert.ok(
    wtEvents.some((e) => e.cmd === "plan_milestone" && e.params.title === "Main Choice"),
    "worktree log should be rewritten to the main-side resolution",
  );
  assert.ok(
    !wtEvents.some((e) => e.cmd === "plan_milestone" && e.params.title === "Worktree Choice"),
    "worktree log should no longer contain the discarded conflict event",
  );

  const second = reconcileWorktreeLogs(main, worktree);
  assert.equal(second.conflicts.length, 0, "reconcile should stay clean after choosing main");
});
