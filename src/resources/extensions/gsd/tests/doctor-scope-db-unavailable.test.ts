import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase } from "../gsd-db.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { filterDoctorIssues } from "../doctor-format.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";

afterEach(() => {
  closeDatabase();
});

test("filterDoctorIssues keeps project and environment issues in scoped reports", () => {
  const issues = [
    { severity: "error", code: "env_dependencies", scope: "project", unitId: "environment", message: "node_modules missing", fixable: false },
    { severity: "warning", code: "db_unavailable", scope: "project", unitId: "project", message: "DB unavailable", fixable: false },
    { severity: "warning", code: "state_file_missing", scope: "slice", unitId: "M016/S01", message: "slice warning", fixable: false },
  ] as const;

  const filtered = filterDoctorIssues([...issues], { scope: "M016", includeWarnings: true });
  assert.deepEqual(
    filtered.map((issue) => issue.unitId),
    ["environment", "project", "M016/S01"],
  );
});

test("checkEngineHealth reports db_unavailable when gsd.db exists but the DB is closed", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-db-unavailable-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "gsd.db"), "");

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const dbIssue = issues.find((issue) => issue.code === "db_unavailable");
  assert.ok(dbIssue, "doctor should surface degraded DB mode when a DB file exists");
  assert.equal(dbIssue.unitId, "project");
  assert.equal(dbIssue.file, ".gsd/gsd.db");
});
