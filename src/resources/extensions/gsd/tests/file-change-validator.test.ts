import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateFileChanges } from "../safety/file-change-validator.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

test("validateFileChanges works on repos with a single commit (no HEAD~1)", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  writeFileSync(join(base, "foo.ts"), "export const x = 1;\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  // With only one commit, HEAD~1 doesn't exist — this must not throw
  const audit = validateFileChanges(base, ["foo.ts"], []);

  assert.ok(audit, "audit should be produced for single-commit repo");
  assert.deepEqual(audit.unexpectedFiles, []);
  assert.deepEqual(audit.missingFiles, []);
});

test("validateFileChanges excludes allowlisted files from unexpected-change warnings", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  mkdirSync(join(base, "tracking", "history"), { recursive: true });
  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  writeFileSync(join(base, "src.ts"), "initial\n");
  writeFileSync(join(base, "tracking", "history", "2026-04-20-snapshot.md"), "initial\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  writeFileSync(join(base, "src.ts"), "updated\n");
  writeFileSync(join(base, "tracking", "history", "2026-04-20-snapshot.md"), "updated\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "update");

  // Without allowlist: tracking/history snapshot is unexpected
  const auditWithout = validateFileChanges(base, ["src.ts"], []);
  assert.ok(auditWithout, "audit should be produced");
  assert.ok(
    auditWithout.unexpectedFiles.includes("tracking/history/2026-04-20-snapshot.md"),
    "snapshot should be unexpected without allowlist",
  );

  // With glob allowlist: snapshot is excluded
  const auditWith = validateFileChanges(base, ["src.ts"], [], ["tracking/history/**"]);
  assert.ok(auditWith, "audit should be produced with allowlist");
  assert.deepEqual(auditWith.unexpectedFiles, [], "no unexpected files when snapshot is allowlisted");
  assert.equal(
    auditWith.violations.filter(v => v.severity === "warning").length,
    0,
    "no warnings when all unexpected files are allowlisted",
  );
});

test("validateFileChanges ignores inline descriptions in expected output paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  mkdirSync(join(base, "definitions"), { recursive: true });
  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  const target = join(base, "definitions", "ac-audit.md");
  writeFileSync(target, "initial\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  writeFileSync(target, "updated\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "update");

  const audit = validateFileChanges(
    base,
    ["definitions/ac-audit.md — current state of AC CRM, tags, pipelines, automations"],
    [],
  );

  assert.ok(audit, "audit should be produced when expected output exists");
  assert.deepEqual(audit.unexpectedFiles, []);
  assert.deepEqual(audit.missingFiles, []);
  assert.equal(
    audit.violations.some((v) => v.severity === "warning"),
    false,
    "described expected output should not trigger unexpected-file warnings",
  );
});
