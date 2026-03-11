import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync as realSpawnSync } from "node:child_process";

import * as ghApiModule from "../resources/extensions/github/gh-api.ts";

function makeSpawnResult(overrides: Partial<ReturnType<typeof realSpawnSync>>): ReturnType<typeof realSpawnSync> {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    output: [null, "", ""],
    pid: 1,
    signal: null,
    ...overrides,
  } as ReturnType<typeof realSpawnSync>;
}

test("hasGhCli treats zero-exit token output as authenticated", () => {
  ghApiModule.setGhSpawnForTests(() => makeSpawnResult({ stdout: "gho_test\n" }));

  try {
    assert.equal(ghApiModule.hasGhCli(), true);
    assert.equal(ghApiModule.authMethod(), "gh CLI");
  } finally {
    ghApiModule.resetGhCliDetectionForTests();
  }
});

test("hasGhCli rejects zero-exit responses with empty stdout", () => {
  ghApiModule.setGhSpawnForTests(() => makeSpawnResult({ stdout: "" }));

  try {
    assert.equal(ghApiModule.hasGhCli(), false);
  } finally {
    ghApiModule.resetGhCliDetectionForTests();
  }
});

test("hasGhCli rejects spawnSync error even with zero exit", () => {
  ghApiModule.setGhSpawnForTests(() => makeSpawnResult({
    stdout: "gho_test\n",
    stderr: "EPERM",
    error: new Error("spawnSync gh EPERM"),
  }));

  try {
    assert.equal(ghApiModule.hasGhCli(), false);
  } finally {
    ghApiModule.resetGhCliDetectionForTests();
  }
});
