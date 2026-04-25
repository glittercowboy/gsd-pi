/**
 * Gate registry tests — enforce that every declared GateId has a registry
 * entry, that every owner-turn bucket is non-empty, and that coverage
 * assertions fail loudly instead of silently skipping unknown gates.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  GATE_REGISTRY,
  assertGateCoverage,
  getGateDefinition,
  getGateIdsForTurn,
  getGatesForTurn,
  getOwnerTurn,
  type OwnerTurn,
} from "../gate-registry.ts";
import type { GateId } from "../types.ts";

/** Authoritative list of GateIds as declared in types.ts. */
const ALL_GATE_IDS: readonly GateId[] = [
  "Q3", "Q4", "Q5", "Q6", "Q7", "Q8",
  "MV01", "MV02", "MV03", "MV04",
];

const ALL_OWNER_TURNS: readonly OwnerTurn[] = [
  "gate-evaluate",
  "execute-task",
  "complete-slice",
  "validate-milestone",
];

describe("gate-registry", () => {
  test("every declared GateId has a registry entry", () => {
    for (const id of ALL_GATE_IDS) {
      const def = GATE_REGISTRY[id];
      assert.ok(def, `missing registry entry for gate ${id}`);
      assert.equal(def.id, id);
      assert.ok(def.question.length > 0, `${id} missing question`);
      assert.ok(def.guidance.length > 0, `${id} missing guidance`);
      assert.ok(def.promptSection.length > 0, `${id} missing promptSection`);
    }
  });

  test("registry contains no extra gate entries", () => {
    const registryIds = new Set(Object.keys(GATE_REGISTRY));
    const declaredIds = new Set<string>(ALL_GATE_IDS);
    for (const id of registryIds) {
      assert.ok(declaredIds.has(id), `registry has unknown gate ${id}`);
    }
  });

  test("every owner turn owns at least one gate", () => {
    for (const turn of ALL_OWNER_TURNS) {
      const gates = getGatesForTurn(turn);
      assert.ok(
        gates.length > 0,
        `owner turn "${turn}" has no gates — likely a registry mistake`,
      );
    }
  });

  test("owner turn buckets are disjoint", () => {
    const seen = new Set<string>();
    for (const turn of ALL_OWNER_TURNS) {
      for (const def of getGatesForTurn(turn)) {
        assert.ok(!seen.has(def.id), `gate ${def.id} claimed by two turns`);
        seen.add(def.id);
      }
    }
    // Every gate should appear in exactly one bucket.
    assert.equal(seen.size, ALL_GATE_IDS.length);
  });

  test("getOwnerTurn round-trips against GATE_REGISTRY", () => {
    for (const id of ALL_GATE_IDS) {
      const turn = getOwnerTurn(id);
      const idsForTurn = getGateIdsForTurn(turn);
      assert.ok(idsForTurn.has(id), `${id} not in ${turn} bucket`);
    }
  });

  test("getGateDefinition returns undefined for unknown ids", () => {
    assert.equal(getGateDefinition("Q99"), undefined);
    assert.equal(getGateDefinition("not-a-gate"), undefined);
  });
});

describe("assertGateCoverage", () => {
  test("throws when a row is owned by a different turn", () => {
    // Q8 is owned by complete-slice, not gate-evaluate — this used to be
    // silently dropped by the old `if (!meta) continue;` filter, causing
    // the evaluating-gates phase to stall.
    assert.throws(
      () => assertGateCoverage([{ gate_id: "Q8" }], "gate-evaluate"),
      (err: Error) =>
        err.message.includes("Q8") && err.message.includes("gate-evaluate"),
    );
  });

  test("throws when a row has an unknown gate id", () => {
    assert.throws(
      () => assertGateCoverage([{ gate_id: "Q999" as GateId }], "gate-evaluate", { requireAll: false }),
      (err: Error) => err.message.includes("Q999"),
    );
  });

  test("throws when requireAll is true and an owned gate is missing", () => {
    // gate-evaluate owns Q3 and Q4. Passing only Q3 should fail.
    assert.throws(
      () => assertGateCoverage([{ gate_id: "Q3" }], "gate-evaluate", { requireAll: true }),
      (err: Error) => err.message.includes("Q4"),
    );
  });

  test("passes when requireAll is false and only a subset is pending", () => {
    // execute-task owns Q5/Q6/Q7, but a task with no external dependencies
    // may only have Q7 seeded. That's still valid coverage.
    assert.doesNotThrow(() =>
      assertGateCoverage([{ gate_id: "Q7" }], "execute-task", { requireAll: false }),
    );
  });

  test("passes when requireAll is true and every owned gate is pending", () => {
    assert.doesNotThrow(() =>
      assertGateCoverage(
        [{ gate_id: "Q3" }, { gate_id: "Q4" }],
        "gate-evaluate",
        { requireAll: true },
      ),
    );
  });

  test("empty pending list passes when requireAll is false", () => {
    assert.doesNotThrow(() =>
      assertGateCoverage([], "complete-slice", { requireAll: false }),
    );
  });
});
