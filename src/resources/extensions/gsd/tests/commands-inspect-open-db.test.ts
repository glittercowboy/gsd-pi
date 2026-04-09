import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { handleInspect } from "../commands-inspect.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";

test("/gsd inspect opens existing database when it was not yet opened in session", async (t) => {
  closeDatabase();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-inspect-db-"));
  const prevCwd = process.cwd();

  t.after(() => {
    process.chdir(prevCwd);
    closeDatabase();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const gsdDir = path.join(tmp, ".gsd");
  fs.mkdirSync(gsdDir, { recursive: true });
  const dbPath = path.join(gsdDir, "gsd.db");

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  process.chdir(tmp);

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as any;

  await handleInspect(ctx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /=== GSD Database Inspect ===/);
  assert.doesNotMatch(notifications[0].message, /No GSD database available/);
});
