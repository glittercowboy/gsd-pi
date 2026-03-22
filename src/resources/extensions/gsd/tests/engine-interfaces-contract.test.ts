/**
 * engine-interfaces-contract.test.ts — Source-level contract tests for the
 * engine abstraction layer (S01).
 *
 * TypeScript interfaces are erased by --experimental-strip-types, so these
 * tests use source-level regex assertions on the .ts files to verify shapes.
 * Runtime assertions cover AutoSession.activeEngineId and resolveEngine().
 *
 * Follows the same conventions as auto-session-encapsulation.test.ts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_TYPES_PATH = join(__dirname, "..", "engine-types.ts");
const WORKFLOW_ENGINE_PATH = join(__dirname, "..", "workflow-engine.ts");
const EXECUTION_POLICY_PATH = join(__dirname, "..", "execution-policy.ts");
const ENGINE_RESOLVER_PATH = join(__dirname, "..", "engine-resolver.ts");

function readSource(path: string): string {
  return readFileSync(path, "utf-8");
}

// ── Import smoke tests ──────────────────────────────────────────────────────

describe("Import smoke tests", () => {
  test("engine-types.ts can be dynamically imported", async () => {
    const mod = await import("../engine-types.ts");
    assert.ok(mod, "engine-types.ts should import without error");
  });

  test("workflow-engine.ts can be dynamically imported", async () => {
    const mod = await import("../workflow-engine.ts");
    assert.ok(mod, "workflow-engine.ts should import without error");
  });

  test("execution-policy.ts can be dynamically imported", async () => {
    const mod = await import("../execution-policy.ts");
    assert.ok(mod, "execution-policy.ts should import without error");
  });

  test("engine-resolver.ts can be dynamically imported", async () => {
    const mod = await import("../engine-resolver.ts");
    assert.ok(mod, "engine-resolver.ts should import without error");
    assert.ok(
      typeof mod.resolveEngine === "function",
      "engine-resolver.ts should export resolveEngine function",
    );
  });
});

// ── Leaf-node constraint ────────────────────────────────────────────────────

describe("Leaf-node constraint", () => {
  test("engine-types.ts has zero imports from GSD modules (only node: allowed)", () => {
    const source = readSource(ENGINE_TYPES_PATH);
    const lines = source.split("\n");
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Match import lines that reference relative paths (../ or ./)
      if (/^import\s/.test(line) && /['"]\.\.?\// .test(line)) {
        violations.push(`line ${i + 1}: ${line.trim()}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `engine-types.ts must be a leaf node with zero GSD imports. ` +
      `Only node: imports are allowed.\nViolations:\n${violations.join("\n")}`,
    );
  });
});

// ── EngineState shape ───────────────────────────────────────────────────────

describe("EngineState shape", () => {
  test("EngineState has all required fields with correct types", () => {
    const source = readSource(ENGINE_TYPES_PATH);

    const requiredFields = [
      "phase",
      "currentMilestoneId",
      "activeSliceId",
      "activeTaskId",
      "isComplete",
      "raw",
    ];

    for (const field of requiredFields) {
      assert.ok(
        source.includes(field),
        `EngineState must contain field: ${field}`,
      );
    }

    // raw must be typed unknown — not a GSD-specific type
    assert.ok(
      /raw:\s*unknown/.test(source),
      "EngineState.raw must be typed 'unknown', not a GSD-specific type",
    );
  });
});

// ── EngineDispatchAction shape ──────────────────────────────────────────────

describe("EngineDispatchAction shape", () => {
  test("EngineDispatchAction has dispatch, stop, and skip variants", () => {
    const source = readSource(ENGINE_TYPES_PATH);

    assert.ok(
      /action:\s*"dispatch"/.test(source),
      'EngineDispatchAction must have action: "dispatch" variant',
    );
    assert.ok(
      /action:\s*"stop"/.test(source),
      'EngineDispatchAction must have action: "stop" variant',
    );
    assert.ok(
      /action:\s*"skip"/.test(source),
      'EngineDispatchAction must have action: "skip" variant',
    );
  });
});

// ── WorkflowEngine interface shape ──────────────────────────────────────────

describe("WorkflowEngine interface shape", () => {
  test("WorkflowEngine has engineId and all required methods", () => {
    const source = readSource(WORKFLOW_ENGINE_PATH);

    const requiredMembers = [
      "engineId",
      "deriveState",
      "resolveDispatch",
      "reconcile",
      "getDisplayMetadata",
    ];

    for (const member of requiredMembers) {
      assert.ok(
        source.includes(member),
        `WorkflowEngine must contain member: ${member}`,
      );
    }
  });
});

// ── ExecutionPolicy interface shape ─────────────────────────────────────────

describe("ExecutionPolicy interface shape", () => {
  test("ExecutionPolicy has all required methods", () => {
    const source = readSource(EXECUTION_POLICY_PATH);

    const requiredMethods = [
      "prepareWorkspace",
      "selectModel",
      "verify",
      "recover",
      "closeout",
    ];

    for (const method of requiredMethods) {
      assert.ok(
        source.includes(method),
        `ExecutionPolicy must contain method: ${method}`,
      );
    }
  });
});

// ── Resolver stub behavior ──────────────────────────────────────────────────

describe("Resolver stub behavior", () => {
  test("resolveEngine returns dev engine for null activeEngineId", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    const result = resolveEngine({ activeEngineId: null });
    assert.ok(result.engine, "should return engine for null");
    assert.equal(
      result.engine.engineId,
      "dev",
      "engine.engineId should be 'dev' for null activeEngineId",
    );
  });

  test("resolveEngine returns dev engine for 'dev' activeEngineId", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    const result = resolveEngine({ activeEngineId: "dev" });
    assert.ok(result.engine, "should return engine for 'dev'");
    assert.equal(
      result.engine.engineId,
      "dev",
      "engine.engineId should be 'dev'",
    );
  });

  test("resolveEngine throws for unknown activeEngineId without activeRunDir", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    assert.throws(
      () => resolveEngine({ activeEngineId: "custom-xyz" }),
      /activeRunDir/,
      "resolveEngine should throw when custom engine has no activeRunDir",
    );
  });

  test("resolveEngine returns custom engine for non-dev activeEngineId with activeRunDir", async () => {
    const { resolveEngine } = await import("../engine-resolver.ts");
    const result = resolveEngine({ activeEngineId: "custom-xyz", activeRunDir: "/tmp/test-run" });
    assert.ok(result.engine, "should return engine for custom ID");
    assert.equal(
      result.engine.engineId,
      "custom",
      "engine.engineId should be 'custom' for non-dev activeEngineId",
    );
  });

  test("ResolvedEngine type is exported (source check)", () => {
    const source = readSource(ENGINE_RESOLVER_PATH);
    assert.ok(
      /export\s+(interface|type)\s+ResolvedEngine/.test(source),
      "engine-resolver.ts must export ResolvedEngine type",
    );
  });
});

// ── AutoSession.activeEngineId ──────────────────────────────────────────────

describe("AutoSession.activeEngineId", () => {
  test("defaults to null on a fresh AutoSession", async () => {
    const { AutoSession } = await import("../auto/session.ts");
    const session = new AutoSession();
    assert.equal(
      session.activeEngineId,
      null,
      "activeEngineId should default to null",
    );
  });

  test("is null after reset()", async () => {
    const { AutoSession } = await import("../auto/session.ts");
    const session = new AutoSession();
    session.activeEngineId = "dev";
    session.reset();
    assert.equal(
      session.activeEngineId,
      null,
      "activeEngineId should be null after reset()",
    );
  });

  test("appears in toJSON() output", async () => {
    const { AutoSession } = await import("../auto/session.ts");
    const session = new AutoSession();
    const json = session.toJSON();
    assert.ok(
      "activeEngineId" in json,
      "toJSON() must include activeEngineId",
    );
    assert.equal(
      json.activeEngineId,
      null,
      "toJSON().activeEngineId should be null by default",
    );
  });
});
