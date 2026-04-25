import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyModelPolicyFilter,
  buildRequirementVector,
} from "../uok/model-policy.ts";
import {
  registerToolCompatibility,
  resetToolCompatibilityRegistry,
} from "@gsd/pi-coding-agent";

test.afterEach(() => {
  resetToolCompatibilityRegistry();
});

test("uok model policy builds requirement vectors from unit metadata", () => {
  const requirements = buildRequirementVector("execute-task", {
    tags: ["docs"],
    fileCount: 8,
    estimatedLines: 600,
  });

  assert.equal(requirements.instruction, 0.9);
  assert.equal(requirements.coding, 0.3);
  assert.equal(requirements.speed, 0.7);
});

test("uok model policy enforces provider/api/tool constraints and emits decision audit events", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-model-policy-"));
  try {
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    registerToolCompatibility("screenshot", { producesImages: true });

    const result = applyModelPolicyFilter(
      [
        { id: "openai-image", provider: "openai", api: "openai-responses" },
        { id: "anthropic-ok", provider: "anthropic", api: "anthropic-messages" },
        { id: "gemini-api-deny", provider: "google", api: "google-generative-ai" },
        { id: "blocked-provider", provider: "blocked", api: "anthropic-messages" },
      ],
      {
        basePath,
        traceId: "trace-model-policy-1",
        turnId: "turn-model-policy-1",
        unitType: "execute-task",
        taskMetadata: { tags: ["docs"] },
        allowCrossProvider: true,
        requiredTools: ["screenshot"],
        allowedApis: ["anthropic-messages", "openai-responses"],
        deniedProviders: ["blocked"],
      },
    );

    assert.deepEqual(
      result.eligible.map((m) => m.id),
      ["anthropic-ok"],
      "only the policy-compliant anthropic model should remain eligible",
    );
    assert.equal(result.decisions.length, 4);
    assert.equal(result.decisions[0]?.allowed, false);
    assert.match(result.decisions[0]?.reason ?? "", /tool policy denied/);
    assert.equal(result.decisions[1]?.allowed, true);
    assert.equal(result.decisions[2]?.allowed, false);
    assert.match(result.decisions[2]?.reason ?? "", /transport\/api denied by policy/);
    assert.equal(result.decisions[3]?.allowed, false);
    assert.match(result.decisions[3]?.reason ?? "", /provider denied by policy/);

    const auditLogPath = join(basePath, ".gsd", "audit", "events.jsonl");
    const auditLines = readFileSync(auditLogPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload?: { reason?: string } });
    const decisionTypes = auditLines.map((event) => event.type);

    assert.equal(auditLines.length, 4);
    assert.ok(decisionTypes.includes("model-policy-allow"));
    assert.ok(decisionTypes.includes("model-policy-deny"));
    assert.ok(
      auditLines.some((event) => (event.payload?.reason ?? "").includes("tool policy denied")),
      "audit stream should include explicit deny reasons",
    );
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});
