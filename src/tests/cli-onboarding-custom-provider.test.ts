import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SettingsManager } from "../../packages/pi-coding-agent/src/core/settings-manager.ts";

test("SettingsManager reads defaultProvider/defaultModel from the explicit agentDir used by CLI (#3860)", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cli-settings-"));
  const cwd = join(root, "project");
  const agentDir = join(root, ".gsd", "agent");

  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "example-provider",
        defaultModel: "gpt-5.4",
      }),
      "utf-8",
    );

    const settingsManager = SettingsManager.create(cwd, agentDir);
    assert.equal(settingsManager.getDefaultProvider(), "example-provider");
    assert.equal(settingsManager.getDefaultModel(), "gpt-5.4");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli.ts wires SettingsManager.create with both cwd and agentDir (#3860)", () => {
  const cliSource = readFileSync(join(import.meta.dirname, "..", "cli.ts"), "utf-8");
  assert.match(cliSource, /SettingsManager\.create\(process\.cwd\(\),\s*agentDir\)/);
});
