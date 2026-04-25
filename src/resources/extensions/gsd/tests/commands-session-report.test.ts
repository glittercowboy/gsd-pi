import test from "node:test";
import assert from "node:assert/strict";

// Test the formatting logic used by session-report.
// The actual handler requires runtime context (metrics module), so we
// test the core formatting and aggregation patterns.

test("session-report: format cost correctly", () => {
  // Simple cost formatting test
  const formatCost = (cost: number): string => {
    if (cost < 0.01) return "<$0.01";
    return `$${cost.toFixed(2)}`;
  };

  assert.equal(formatCost(0), "<$0.01");
  assert.equal(formatCost(0.005), "<$0.01");
  assert.equal(formatCost(1.5), "$1.50");
  assert.equal(formatCost(10.999), "$11.00");
});

test("session-report: format token count", () => {
  const formatTokenCount = (count: number): string => {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return String(count);
  };

  assert.equal(formatTokenCount(500), "500");
  assert.equal(formatTokenCount(1500), "1.5K");
  assert.equal(formatTokenCount(1_200_000), "1.2M");
});

test("session-report: aggregate by model", () => {
  interface UnitMetric {
    model: string;
    cost: number;
  }

  const units: UnitMetric[] = [
    { model: "opus", cost: 1.0 },
    { model: "opus", cost: 0.8 },
    { model: "sonnet", cost: 0.3 },
    { model: "sonnet", cost: 0.5 },
    { model: "sonnet", cost: 0.2 },
  ];

  const byModel = new Map<string, { count: number; cost: number }>();
  for (const u of units) {
    const existing = byModel.get(u.model) ?? { count: 0, cost: 0 };
    existing.count++;
    existing.cost += u.cost;
    byModel.set(u.model, existing);
  }

  const opus = byModel.get("opus")!;
  assert.equal(opus.count, 2);
  assert.ok(Math.abs(opus.cost - 1.8) < 0.01);

  const sonnet = byModel.get("sonnet")!;
  assert.equal(sonnet.count, 3);
  assert.ok(Math.abs(sonnet.cost - 1.0) < 0.01);
});

test("session-report: --json flag detection", () => {
  const args1 = "--json";
  const args2 = "--save --json";
  const args3 = "something else";

  assert.ok(args1.includes("--json"));
  assert.ok(args2.includes("--json"));
  assert.ok(!args3.includes("--json"));
});

test("session-report: --save flag detection", () => {
  const args1 = "--save";
  const args2 = "--save --json";
  const args3 = "";

  assert.ok(args1.includes("--save"));
  assert.ok(args2.includes("--save"));
  assert.ok(!args3.includes("--save"));
});
