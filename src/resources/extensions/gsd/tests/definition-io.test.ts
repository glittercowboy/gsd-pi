/**
 * definition-io.ts — unit tests for readFrozenDefinition.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readFrozenDefinition } from "../definition-io.ts";

function createTmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "gsd-defio-test-")));
}

describe("readFrozenDefinition", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  test("parses a valid DEFINITION.yaml", () => {
    const yaml = [
      "version: 1",
      "name: test-workflow",
      "description: A test workflow",
      "steps:",
      "  - id: step-1",
      "    prompt: do the thing",
    ].join("\n");
    writeFileSync(join(runDir, "DEFINITION.yaml"), yaml, "utf-8");

    const def = readFrozenDefinition(runDir);
    assert.equal(def.version, 1);
    assert.equal(def.name, "test-workflow");
    assert.equal(def.description, "A test workflow");
    assert.equal(def.steps.length, 1);
    assert.equal(def.steps[0].id, "step-1");
  });

  test("throws when DEFINITION.yaml is missing", () => {
    assert.throws(() => readFrozenDefinition(runDir), {
      code: "ENOENT",
    });
  });

  test("throws on malformed YAML", () => {
    writeFileSync(join(runDir, "DEFINITION.yaml"), ": : : not valid yaml [", "utf-8");
    assert.throws(() => readFrozenDefinition(runDir));
  });
});
