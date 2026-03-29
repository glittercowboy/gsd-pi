/**
 * Extended tests for M007 telemetry schema additions.
 * Proves intervention classification, fact-check extraction, wall-clock derivation,
 * ledger persistence, and aggregate totals using realistic fixture data.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  classifyIntervention,
  extractFactCheckMetrics,
  type InterventionType,
  type FactCheckMetrics,
  type UnitMetrics,
  initMetrics,
  resetMetrics,
  snapshotUnitMetrics,
  getLedger,
  getProjectTotals,
} from "../metrics.js";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function mockCtx(messages: any[] = []): any {
  const entries = messages.map((msg, i) => ({
    type: "message",
    id: `entry-${i}`,
    parentId: i > 0 ? `entry-${i - 1}` : null,
    timestamp: new Date().toISOString(),
    message: msg,
  }));

  return {
    sessionManager: {
      getEntries: () => entries,
    },
    model: { id: "claude-sonnet-4-20250514" },
  };
}

function makeUnit(overrides: Partial<UnitMetrics> = {}): UnitMetrics {
  return {
    type: "execute-task",
    id: "M007/S01/T99",
    model: "claude-sonnet-4-20250514",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
    cost: 0.01,
    toolCalls: 1,
    assistantMessages: 1,
    userMessages: 1,
    ...overrides,
  };
}

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "factcheck-runtime",
  "M999-PROOF",
  "slices",
  "S01",
);

console.log("\n=== classifyIntervention ===");

{
  const cases: Array<{
    entry: { role: string; content?: string | unknown[] };
    expected: InterventionType | null;
    message: string;
  }> = [
    {
      entry: { role: "user", content: "Stop, that's wrong" },
      expected: "blocker",
      message: "blocker keywords win when both blocker and correction appear",
    },
    {
      entry: { role: "user", content: "That's incorrect, the API is v5" },
      expected: "correction",
      message: "correction message classified correctly",
    },
    {
      entry: { role: "user", content: "Try a different approach instead" },
      expected: "redirect",
      message: "redirect message classified correctly",
    },
    {
      entry: { role: "user", content: "Looks good, continue" },
      expected: null,
      message: "neutral user message returns null",
    },
    {
      entry: { role: "assistant", content: "Stop everything" },
      expected: null,
      message: "assistant messages are ignored",
    },
    {
      entry: { role: "user", content: [{ type: "text", text: "Actually that's wrong" }] },
      expected: "correction",
      message: "array content blocks are flattened and classified",
    },
  ];

  for (const testCase of cases) {
    assertEq(classifyIntervention(testCase.entry), testCase.expected, testCase.message);
  }
}

console.log("\n=== extractFactCheckMetrics ===");

{
  const metrics = extractFactCheckMetrics(fixtureDir);
  const expected: FactCheckMetrics = {
    claimsChecked: 3,
    verified: 1,
    refuted: 1,
    inconclusive: 1,
    scoutTokens: 1200 + 800 + 950,
  };

  assertEq(metrics, expected, "fixture fact-check metrics include verdict counts and summed scoutTokens");
  assertEq(
    extractFactCheckMetrics(join(fixtureDir, "DOES-NOT-EXIST")),
    null,
    "missing factcheck directory returns null gracefully",
  );
}

console.log("\n=== snapshotUnitMetrics round-trip + wallClockMs + getProjectTotals ===");

{
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-metrics-extended-"));
  mkdirSync(join(tmpBase, ".gsd"), { recursive: true });

  try {
    resetMetrics();
    initMetrics(tmpBase);

    const factCheck: FactCheckMetrics = {
      claimsChecked: 3,
      verified: 1,
      refuted: 1,
      inconclusive: 1,
      scoutTokens: 2950,
    };

    const interventions = {
      blocker: 1,
      correction: 2,
      redirect: 1,
    };

    const firstStartedAt = Date.now() - 4_000;
    const first = snapshotUnitMetrics(
      mockCtx([
        { role: "user", content: "Please continue" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Working on it" },
            { type: "tool_call", id: "tc-1", name: "read", input: {} },
          ],
          usage: {
            input: 500,
            output: 200,
            cacheRead: 50,
            cacheWrite: 25,
            totalTokens: 775,
            cost: { total: 0.02 },
          },
        },
      ]),
      "execute-task",
      "M007/S01/T02",
      firstStartedAt,
      "claude-sonnet-4-20250514",
      { interventions, factCheck },
    );

    const second = snapshotUnitMetrics(
      mockCtx([
        { role: "user", content: "Thanks" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          usage: {
            input: 300,
            output: 100,
            cacheRead: 20,
            cacheWrite: 10,
            totalTokens: 430,
            cost: { total: 0.01 },
          },
        },
      ]),
      "execute-task",
      "M007/S01/T03",
      Date.now() - 2_000,
      "claude-sonnet-4-20250514",
    );

    assertTrue(first !== null, "first snapshot created a unit");
    assertTrue(second !== null, "second snapshot created a unit");
    assertTrue(first!.wallClockMs !== undefined, "wallClockMs is auto-derived when omitted");
    assertTrue(first!.wallClockMs! >= 3900, "wallClockMs reflects finishedAt - startedAt lower bound");
    assertTrue(first!.wallClockMs! <= 6000, "wallClockMs reflects finishedAt - startedAt upper bound");

    const ledger = getLedger();
    assertTrue(ledger !== null, "ledger remains available after snapshots");
    assertEq(ledger!.units.length, 2, "two units persisted to ledger");

    const stored = ledger!.units.find(unit => unit.id === "M007/S01/T02");
    assertTrue(!!stored, "extended unit persisted in ledger");
    assertEq(stored!.interventions, interventions, "interventions persisted round-trip to ledger");
    assertEq(stored!.factCheck, factCheck, "factCheck persisted round-trip to ledger");
    assertEq(stored!.wallClockMs, first!.wallClockMs, "derived wallClockMs persisted to ledger");

    const totals = getProjectTotals(ledger!.units);
    assertEq(
      totals.totalInterventions,
      interventions,
      "project totals aggregate interventions from unit with extended fields",
    );
    assertEq(
      totals.totalFactChecks,
      factCheck,
      "project totals aggregate fact-check metrics from unit with extended fields",
    );
    assertEq(totals.units, 2, "project totals count both units");

    const comparisonTotals = getProjectTotals([
      makeUnit({ interventions, factCheck }),
      makeUnit({ id: "M007/S01/T04" }),
    ]);
    assertEq(comparisonTotals.totalInterventions, interventions, "aggregation ignores units without interventions");
    assertEq(comparisonTotals.totalFactChecks, factCheck, "aggregation ignores units without factCheck");
  } finally {
    resetMetrics();
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

report();
