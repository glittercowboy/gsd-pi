import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

/**
 * Regression tests for #2826: hook/* completed-unit keys were parsed
 * incorrectly by forensics + doctor, causing false-positive missing-artifact
 * errors for all hook units.
 *
 * The root cause: `key.indexOf("/")` splits "hook/telegram-progress/M007/S01"
 * into unitType="hook" + unitId="telegram-progress/M007/S01" instead of
 * unitType="hook/telegram-progress" + unitId="M007/S01".
 */

describe("splitCompletedKey (#2826)", () => {
  it("is exported from forensics.ts", () => {
    const source = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
    assert.ok(
      source.includes("export function splitCompletedKey"),
      "forensics.ts must export splitCompletedKey helper",
    );
  });

  it("splits simple unit types correctly", async () => {
    const { splitCompletedKey } = await import("../forensics.ts");
    const result = splitCompletedKey("execute-task/M007/S01/T01");
    assert.deepStrictEqual(result, {
      unitType: "execute-task",
      unitId: "M007/S01/T01",
    });
  });

  it("splits hook unit types preserving the compound hook/<hookName> prefix", async () => {
    const { splitCompletedKey } = await import("../forensics.ts");
    const result = splitCompletedKey("hook/telegram-progress/M007/S01");
    assert.deepStrictEqual(result, {
      unitType: "hook/telegram-progress",
      unitId: "M007/S01",
    });
  });

  it("splits hook unit types with task-level unitId", async () => {
    const { splitCompletedKey } = await import("../forensics.ts");
    const result = splitCompletedKey("hook/telegram-progress/M007/S02/T01");
    assert.deepStrictEqual(result, {
      unitType: "hook/telegram-progress",
      unitId: "M007/S02/T01",
    });
  });

  it("returns null for malformed keys without a slash", async () => {
    const { splitCompletedKey } = await import("../forensics.ts");
    assert.strictEqual(splitCompletedKey("noslash"), null);
  });

  it("returns null for malformed hook keys with only 'hook/' and no more segments", async () => {
    const { splitCompletedKey } = await import("../forensics.ts");
    // "hook/someName" has no unitId segment after the hook name
    assert.strictEqual(splitCompletedKey("hook/someName"), null);
  });
});

describe("forensics detectMissingArtifacts uses splitCompletedKey (#2826)", () => {
  it("does not use indexOf for key splitting", () => {
    const source = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
    // Extract only the detectMissingArtifacts function body
    const fnStart = source.indexOf("function detectMissingArtifacts");
    assert.ok(fnStart !== -1, "detectMissingArtifacts must exist");
    const fnBody = source.slice(fnStart, source.indexOf("\n}\n", fnStart) + 3);

    assert.ok(
      !fnBody.includes('key.indexOf("/")'),
      "detectMissingArtifacts must not use key.indexOf('/') — use splitCompletedKey instead",
    );
    assert.ok(
      fnBody.includes("splitCompletedKey"),
      "detectMissingArtifacts must use splitCompletedKey helper",
    );
  });
});

describe("doctor-runtime-checks uses splitCompletedKey (#2826)", () => {
  it("does not use indexOf for key splitting in orphaned-key check", () => {
    const source = readFileSync(
      join(gsdDir, "doctor-runtime-checks.ts"),
      "utf-8",
    );
    // Find the orphaned completed-units section
    const sectionStart = source.indexOf("Orphaned completed-units");
    assert.ok(sectionStart !== -1, "orphaned completed-units section must exist");
    const sectionBody = source.slice(sectionStart, source.indexOf("} catch", sectionStart));

    assert.ok(
      !sectionBody.includes('key.indexOf("/")'),
      "doctor orphaned-key check must not use key.indexOf('/') — use splitCompletedKey instead",
    );
    assert.ok(
      sectionBody.includes("splitCompletedKey"),
      "doctor orphaned-key check must use splitCompletedKey helper",
    );
  });
});
