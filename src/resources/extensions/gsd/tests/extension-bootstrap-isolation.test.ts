// Structural contracts for GSD extension bootstrap isolation.
//
// The /gsd command must survive failures in the full extension bootstrap
// (register-extension.ts). This guards against the regression where a
// Windows-specific import failure in register-shortcuts.ts silently
// prevented /gsd from being registered at all (#4168, #4172).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, "../index.ts"), "utf-8");
const registerExtSrc = readFileSync(
  join(__dirname, "../bootstrap/register-extension.ts"),
  "utf-8",
);

// ─── index.ts: core /gsd command must be registered before full bootstrap ─────

describe("index.ts bootstrap isolation", () => {
  test("imports registerGSDCommand from commands/index.js separately", () => {
    assert.ok(
      indexSrc.includes('./commands/index.js"') || indexSrc.includes("./commands/index.js'"),
      "index.ts must import registerGSDCommand from ./commands/index.js",
    );
  });

  test("calls registerGSDCommand before importing register-extension.js", () => {
    const gsdCommandCallPos = indexSrc.indexOf("registerGSDCommand(pi)");
    const bootstrapImportPos = indexSrc.indexOf(
      './bootstrap/register-extension.js"',
    );

    assert.ok(gsdCommandCallPos >= 0, "must call registerGSDCommand(pi)");
    assert.ok(bootstrapImportPos >= 0, "must import register-extension.js");
    assert.ok(
      gsdCommandCallPos < bootstrapImportPos,
      "registerGSDCommand(pi) must be called BEFORE importing register-extension.js",
    );
  });

  test("wraps register-extension.js import in try-catch", () => {
    // The dynamic import of register-extension.js must be inside a try block
    const tryPos = indexSrc.indexOf("try {");
    const bootstrapImportPos = indexSrc.indexOf(
      './bootstrap/register-extension.js"',
    );
    const catchPos = indexSrc.indexOf("catch (err)");

    assert.ok(tryPos >= 0, "must have try block");
    assert.ok(catchPos >= 0, "must have catch block");
    assert.ok(
      tryPos < bootstrapImportPos && bootstrapImportPos < catchPos,
      "register-extension.js import must be wrapped in try-catch",
    );
  });

  test("logs warning on bootstrap failure via workflow-logger", () => {
    assert.ok(
      indexSrc.includes("logWarning"),
      "must use logWarning when bootstrap fails",
    );
    assert.ok(
      indexSrc.includes("Extension setup partially failed"),
      "warning message must indicate partial failure with /gsd still available",
    );
  });
});

// ─── register-extension.ts: no double-registration + defensive wrapping ───────

describe("register-extension.ts defensive registration", () => {
  test("does NOT import or call registerGSDCommand (avoids double-registration)", () => {
    // registerGSDCommand is now called by index.ts, not register-extension.ts
    assert.ok(
      !registerExtSrc.includes("import { registerGSDCommand }"),
      "register-extension.ts must NOT import registerGSDCommand",
    );

    // Check the function body of registerGsdExtension doesn't call it
    const funcBodyStart = registerExtSrc.indexOf(
      "export function registerGsdExtension",
    );
    const funcBody = registerExtSrc.slice(funcBodyStart);
    assert.ok(
      !funcBody.includes("registerGSDCommand(pi)"),
      "registerGsdExtension must NOT call registerGSDCommand(pi)",
    );
  });

  test("still registers worktree, exit, and kill commands", () => {
    const funcBodyStart = registerExtSrc.indexOf(
      "export function registerGsdExtension",
    );
    const funcBody = registerExtSrc.slice(funcBodyStart);

    assert.ok(
      funcBody.includes("registerWorktreeCommand(pi)"),
      "must register worktree command",
    );
    assert.ok(
      funcBody.includes("registerExitCommand(pi)"),
      "must register exit command",
    );
    assert.ok(
      funcBody.includes('"kill"'),
      "must register kill command",
    );
  });

  test("wraps non-critical registrations in individual try-catch blocks", () => {
    const funcBodyStart = registerExtSrc.indexOf(
      "export function registerGsdExtension",
    );
    const funcBody = registerExtSrc.slice(funcBodyStart);

    // Each non-critical registration should be wrapped with error handling
    const registrationNames = [
      "dynamic-tools",
      "db-tools",
      "journal-tools",
      "query-tools",
      "shortcuts",
      "hooks",
    ];

    for (const name of registrationNames) {
      assert.ok(
        funcBody.includes(`"${name}"`),
        `non-critical registration "${name}" must be present`,
      );
    }

    // Must have try-catch inside the registration loop
    assert.ok(
      funcBody.includes("try {") && funcBody.includes("catch (err)"),
      "must have try-catch for non-critical registrations",
    );
  });

  test("logs warning when a non-critical registration fails", () => {
    assert.ok(
      registerExtSrc.includes("Failed to register"),
      "must log descriptive warning for individual registration failures",
    );
    assert.ok(
      registerExtSrc.includes("logWarning"),
      "must use logWarning from workflow-logger",
    );
  });
});
