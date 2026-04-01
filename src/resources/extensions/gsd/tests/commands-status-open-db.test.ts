import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { handleStatus } from "../commands/handlers/core.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { closeDatabase, insertMilestone, isDbAvailable, openDatabase } from "../gsd-db.ts";

const M002_ROADMAP = `# M002: Legacy milestone

## Slices

- [ ] **S01: Legacy slice** \`risk:low\` \`depends:[]\`
`;

const M004_ROADMAP = `# M004: Current milestone

## Slices

- [ ] **S01: Current slice** \`risk:low\` \`depends:[]\`
`;

test("/gsd status opens the DB before deriving state in a cold session", async (t) => {
  closeDatabase();
  invalidateStateCache();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-status-open-db-"));
  const prevCwd = process.cwd();

  t.after(() => {
    process.chdir(prevCwd);
    invalidateStateCache();
    closeDatabase();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const gsdDir = path.join(tmp, ".gsd");
  const milestonesDir = path.join(gsdDir, "milestones");
  fs.mkdirSync(path.join(milestonesDir, "M002"), { recursive: true });
  fs.mkdirSync(path.join(milestonesDir, "M004"), { recursive: true });
  fs.writeFileSync(path.join(milestonesDir, "M002", "M002-ROADMAP.md"), M002_ROADMAP);
  fs.writeFileSync(path.join(milestonesDir, "M004", "M004-ROADMAP.md"), M004_ROADMAP);

  const dbPath = path.join(gsdDir, "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M002", title: "Legacy milestone", status: "complete" });
  insertMilestone({ id: "M004", title: "Current milestone", status: "active" });
  closeDatabase();

  process.chdir(tmp);

  assert.equal(isDbAvailable(), false, "test precondition: DB starts closed");

  const coldState = await deriveState(tmp);
  assert.equal(
    coldState.activeMilestone?.id,
    "M002",
    "filesystem fallback prefers the stale milestone when the DB is closed",
  );

  invalidateStateCache();

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      custom: async () => undefined,
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as any;

  await handleStatus(ctx);

  assert.equal(isDbAvailable(), true, "handleStatus should open the DB before deriveState");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /Active milestone: M004/);
  assert.doesNotMatch(notifications[0].message, /Active milestone: M002/);
});
