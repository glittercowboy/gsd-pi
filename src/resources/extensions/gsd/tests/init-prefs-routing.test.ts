// GSD — /gsd init → unified preferences-write routing tests.
//
// Verifies the refactor that routes init's preferences write through the same
// writePreferencesFile helper used by handlePrefsWizard, and that the typed
// ProjectPreferences shape maps correctly into the wizard's
// Record<string, unknown> shape.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mapInitPrefsToWizardShape } from "../init-wizard.ts";
import { writePreferencesFile } from "../commands-prefs-wizard.ts";

test("mapInitPrefsToWizardShape — full roundtrip with all fields", () => {
  const out = mapInitPrefsToWizardShape({
    mode: "team",
    gitIsolation: "branch",
    mainBranch: "develop",
    verificationCommands: ["npm test", "npm run lint"],
    customInstructions: ["Use TypeScript strict mode", "Always write tests"],
    tokenProfile: "quality",
    skipResearch: true,
    autoPush: false,
  });

  assert.equal(out.mode, "team");
  assert.deepEqual(out.git, { isolation: "branch", main_branch: "develop", auto_push: false });
  assert.deepEqual(out.verification_commands, ["npm test", "npm run lint"]);
  assert.deepEqual(out.custom_instructions, ["Use TypeScript strict mode", "Always write tests"]);
  assert.equal(out.token_profile, "quality");
  assert.deepEqual(out.phases, { skip_research: true });
});

test("mapInitPrefsToWizardShape — omits defaults to keep YAML clean", () => {
  const out = mapInitPrefsToWizardShape({
    mode: "solo",
    gitIsolation: "worktree",
    mainBranch: "main",
    verificationCommands: [],
    customInstructions: [],
    tokenProfile: "balanced",
    skipResearch: false,
    autoPush: true,
  });

  // tokenProfile=balanced is the default — should not be serialized.
  assert.equal(out.token_profile, undefined);
  // skipResearch=false is the default — phases should not appear.
  assert.equal(out.phases, undefined);
  // Empty arrays should not be serialized.
  assert.equal(out.verification_commands, undefined);
  assert.equal(out.custom_instructions, undefined);
});

test("writePreferencesFile — writes valid frontmatter from prefill", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-init-prefs-routing-"));
  const path = join(tmp, "PREFERENCES.md");

  try {
    const prefs = mapInitPrefsToWizardShape({
      mode: "solo",
      gitIsolation: "worktree",
      mainBranch: "main",
      verificationCommands: ["npm test"],
      customInstructions: [],
      tokenProfile: "balanced",
      skipResearch: false,
      autoPush: true,
    });

    await writePreferencesFile(path, prefs, null, { scope: "project" });

    const content = readFileSync(path, "utf-8");
    assert.match(content, /^---/);
    assert.match(content, /mode: solo/);
    assert.match(content, /git:/);
    assert.match(content, /isolation: worktree/);
    assert.match(content, /main_branch: main/);
    assert.match(content, /auto_push: true/);
    assert.match(content, /verification_commands:/);
    assert.match(content, /- npm test/);
    // version: 1 is added by writePreferencesFile if missing
    assert.match(content, /version: 1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writePreferencesFile — preserves existing markdown body", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-init-prefs-routing-"));
  const path = join(tmp, "PREFERENCES.md");
  const customBody = "\n# My Custom Notes\n\nUser-edited content here.\n";

  try {
    // Seed file with frontmatter + custom body
    writeFileSync(path, `---\nmode: solo\nversion: 1\n---${customBody}`, "utf-8");

    await writePreferencesFile(path, { mode: "team", version: 1 }, null);

    const content = readFileSync(path, "utf-8");
    assert.match(content, /mode: team/);
    assert.match(content, /My Custom Notes/);
    assert.match(content, /User-edited content here/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writePreferencesFile — falls back to default body for new files", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-init-prefs-routing-"));
  const path = join(tmp, "PREFERENCES.md");
  const initBody = "\n# Init body marker\n";

  try {
    await writePreferencesFile(path, { mode: "solo" }, null, { defaultBody: initBody });
    const content = readFileSync(path, "utf-8");
    assert.match(content, /Init body marker/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
