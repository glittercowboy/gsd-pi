/**
 * Regression test for #2826: detectMissingArtifacts must parse hook/
 * compound unit types correctly, not just the first slash segment.
 *
 * Keys like "hook/telegram-progress/M007/S01" must yield:
 *   unitType = "hook/telegram-progress"  (not "hook")
 *   unitId   = "M007/S01"               (not "telegram-progress/M007/S01")
 *
 * Without the fix, unitType="hook" does not satisfy
 * verifyExpectedArtifact()'s startsWith("hook/") guard, causing every
 * completed hook unit to be flagged as a false-positive missing-artifact.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

describe("forensics hook compound key parsing (#2826)", () => {
  const forensicsSrc = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");

  it("detectMissingArtifacts branches on hook/ prefix", () => {
    assert.ok(
      forensicsSrc.includes('key.startsWith("hook/")'),
      'detectMissingArtifacts must branch on key.startsWith("hook/") to parse compound type',
    );
  });

  it("detectMissingArtifacts uses indexOf with offset 5 to skip past 'hook/'", () => {
    assert.ok(
      forensicsSrc.includes('key.indexOf("/", 5)'),
      'must use indexOf("/", 5) to find the second slash when type is hook/<name>',
    );
  });

  it("detectMissingArtifacts function body contains compound-type branch", () => {
    const fnStart = forensicsSrc.indexOf("function detectMissingArtifacts(");
    assert.ok(fnStart !== -1, "detectMissingArtifacts must exist in forensics.ts");
    const fnBody = forensicsSrc.slice(fnStart, fnStart + 3000);
    assert.ok(
      fnBody.includes('startsWith("hook/")'),
      'detectMissingArtifacts body must contain startsWith("hook/") branch',
    );
  });

  it("doctor-runtime-checks orphaned-key check also handles hook/ compound prefix", () => {
    const doctorSrc = readFileSync(join(gsdDir, "doctor-runtime-checks.ts"), "utf-8");
    assert.ok(
      doctorSrc.includes('key.startsWith("hook/")'),
      'orphaned-key check in doctor-runtime-checks.ts must branch on startsWith("hook/")',
    );
    assert.ok(
      doctorSrc.includes('key.indexOf("/", 5)'),
      'doctor-runtime-checks.ts must use indexOf("/", 5) for the second-slash search',
    );
  });
});
