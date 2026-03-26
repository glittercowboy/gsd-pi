import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildHealthLines,
  detectHealthWidgetProjectState,
  type HealthWidgetData,
} from "../health-widget-core.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-health-widget-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function activeData(overrides: Partial<HealthWidgetData> = {}): HealthWidgetData {
  return {
    projectState: "active",
    budgetCeiling: undefined,
    budgetSpent: 0,
    providerIssue: null,
    environmentErrorCount: 0,
    environmentWarningCount: 0,
    lastRefreshed: Date.now(),
    ...overrides,
  };
}

test("detectHealthWidgetProjectState: no .gsd returns none", (t) => {
  const dir = makeTempDir("none");
  t.after(() => { cleanup(dir); });

  assert.equal(detectHealthWidgetProjectState(dir), "none");
});

test("detectHealthWidgetProjectState: bootstrapped .gsd without milestones returns initialized", (t) => {
  const dir = makeTempDir("initialized");
  t.after(() => { cleanup(dir); });

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(detectHealthWidgetProjectState(dir), "initialized");
});

test("detectHealthWidgetProjectState: milestone without metrics returns active", (t) => {
  const dir = makeTempDir("active");
  t.after(() => { cleanup(dir); });

  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  assert.equal(detectHealthWidgetProjectState(dir), "active");
});

test("buildHealthLines: none state shows onboarding copy", (t) => {
  assert.deepEqual(buildHealthLines(activeData({ projectState: "none" })), [
    "  GSD  No project loaded — run /gsd to start",
  ]);
});

test("buildHealthLines: initialized state shows continue setup copy", (t) => {
  assert.deepEqual(buildHealthLines(activeData({ projectState: "initialized" })), [
    "  GSD  Project initialized — run /gsd to continue setup",
  ]);
});

test("buildHealthLines: active state with ledger-driven spend shows spent summary", (t) => {
  const lines = buildHealthLines(activeData({ budgetSpent: 0.42 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /● System OK/);
  assert.match(lines[0]!, /Spent: 42\.0¢/);
});

test("buildHealthLines: active state with budget ceiling shows percent summary", (t) => {
  const lines = buildHealthLines(activeData({ budgetSpent: 2.5, budgetCeiling: 10 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Budget: \$2\.50\/\$10\.00 \(25%\)/);
});

test("buildHealthLines: active state with issues reports issue summary", (t) => {
  const lines = buildHealthLines(activeData({
    providerIssue: "✗ OpenAI key missing",
    environmentErrorCount: 1,
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /✗ 2 issues/);
  assert.match(lines[0]!, /✗ OpenAI key missing/);
  assert.match(lines[0]!, /Env: 1 error/);
});

test("detectHealthWidgetProjectState: metrics file alone does not imply project", (t) => {
  const dir = makeTempDir("metrics-only");
  t.after(() => { cleanup(dir); });

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "metrics.json"),
    JSON.stringify({ version: 1, projectStartedAt: Date.now(), units: [] }),
    "utf-8",
  );
  assert.equal(detectHealthWidgetProjectState(dir), "initialized");
});
