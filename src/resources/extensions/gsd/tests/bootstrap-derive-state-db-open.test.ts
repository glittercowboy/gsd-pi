import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSourceRegion } from "./test-helpers.ts";

const systemContextSrc = readFileSync(
  join(import.meta.dirname, "..", "bootstrap", "system-context.ts"),
  "utf-8",
);
const registerHooksSrc = readFileSync(
  join(import.meta.dirname, "..", "bootstrap", "register-hooks.ts"),
  "utf-8",
);

describe("bootstrap deriveState DB guards (#3844)", () => {
  test("system-context opens DB before deriveState in resume flows", () => {
    const helperIdx = systemContextSrc.indexOf("const ensureStateDbOpen = async () => {");
    const firstDeriveIdx = systemContextSrc.indexOf("const state = await deriveState(basePath);");
    assert.ok(helperIdx > -1, "system-context should define a DB-open helper for deriveState callers");
    assert.ok(firstDeriveIdx > -1, "system-context should still derive state for resume flows");
    assert.ok(helperIdx < firstDeriveIdx, "system-context should prepare DB opening before deriveState resume calls");
    assert.match(
      systemContextSrc,
      /await ensureStateDbOpen\(\);\s*\n\s*const state = await deriveState\(basePath\);/g,
      "system-context resume flows should open DB before deriveState",
    );
  });

  test("register-hooks opens DB before deriveState in session_before_compact", () => {
    const compactIdx = registerHooksSrc.indexOf('pi.on("session_before_compact"');
    assert.ok(compactIdx > -1, "register-hooks should define session_before_compact");
    const compactSection = extractSourceRegion(registerHooksSrc, 'pi.on("session_before_compact"');
    const ensureIdx = compactSection.indexOf("ensureDbOpen()");
    const deriveIdx = compactSection.indexOf("deriveGsdState(basePath)");
    assert.ok(ensureIdx > -1, "session_before_compact should call ensureDbOpen()");
    assert.ok(deriveIdx > -1, "session_before_compact should derive state");
    assert.ok(ensureIdx < deriveIdx, "session_before_compact should open DB before deriveState");
  });
});
