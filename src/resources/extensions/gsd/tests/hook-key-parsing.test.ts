import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression tests for #2826: hook/* completed-unit keys were parsed
 * incorrectly by forensics + doctor, causing false-positive missing-artifact
 * errors for all hook units.
 *
 * The root cause: `key.indexOf("/")` splits "hook/telegram-progress/M007/S01"
 * into unitType="hook" + unitId="telegram-progress/M007/S01" instead of
 * unitType="hook/telegram-progress" + unitId="M007/S01".
 *
 * These tests exercise the real `splitCompletedKey` helper — the previous
 * source-grep "does not use indexOf" blocks were dropped under #4825 as
 * they over-specified implementation shape.
 */

describe("splitCompletedKey (#2826)", () => {
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
