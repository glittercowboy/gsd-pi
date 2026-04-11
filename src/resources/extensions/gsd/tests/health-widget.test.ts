import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildHealthLines,
  detectHealthWidgetProjectState,
  formatRelativeTime,
  type HealthWidgetData,
} from "../health-widget-core.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";

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
    lastCommitEpoch: null,
    lastCommitMessage: null,
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

// ── Last commit display ──────────────────────────────────────────────────

test("buildHealthLines: shows last commit with relative time and message", (t) => {
  const epoch = Math.floor(Date.now() / 1000) - 300; // 5 minutes ago
  const lines = buildHealthLines(activeData({
    lastCommitEpoch: epoch,
    lastCommitMessage: "feat(widget): add health display",
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Last commit: 5m ago/);
  assert.match(lines[0]!, /feat\(widget\): add health display/);
});

test("buildHealthLines: truncates long commit messages", (t) => {
  const epoch = Math.floor(Date.now() / 1000) - 60;
  const longMsg = "a".repeat(80);
  const lines = buildHealthLines(activeData({
    lastCommitEpoch: epoch,
    lastCommitMessage: longMsg,
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /a{49}…/);
  assert.ok(!lines[0]!.includes("a".repeat(51)), "message is truncated");
});

test("buildHealthLines: no last commit section when epoch is null", (t) => {
  const lines = buildHealthLines(activeData({ lastCommitEpoch: null }));
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("Last commit"), "no last commit when null");
});

test("buildHealthLines: last commit without message shows only time", (t) => {
  const epoch = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
  const lines = buildHealthLines(activeData({
    lastCommitEpoch: epoch,
    lastCommitMessage: null,
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Last commit: 1h ago/);
  assert.ok(!lines[0]!.includes(" — "), "no dash separator when no message");
});

// ── formatRelativeTime ───────────────────────────────────────────────────

test("formatRelativeTime: just now for <60s", () => {
  const epoch = Math.floor(Date.now() / 1000) - 30;
  assert.equal(formatRelativeTime(epoch), "just now");
});

test("formatRelativeTime: minutes", () => {
  const epoch = Math.floor(Date.now() / 1000) - 300;
  assert.equal(formatRelativeTime(epoch), "5m ago");
});

test("formatRelativeTime: hours", () => {
  const epoch = Math.floor(Date.now() / 1000) - 7200;
  assert.equal(formatRelativeTime(epoch), "2h ago");
});

test("formatRelativeTime: days", () => {
  const epoch = Math.floor(Date.now() / 1000) - 172800;
  assert.equal(formatRelativeTime(epoch), "2d ago");
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

test("session_start bootstraps the health widget alongside notifications", async (t) => {
  const dir = makeTempDir("bootstrap");
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    cleanup(dir);
  });

  const widgets: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as any;

  registerHooks(pi);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler is registered");

  await sessionStart!({}, {
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: (key: string) => {
        widgets.push(key);
      },
    },
    sessionManager: {
      getSessionId: () => null,
    },
    model: null,
  } as any);

  assert.ok(widgets.includes("gsd-health"), "health widget is bootstrapped");
  assert.ok(widgets.includes("gsd-notifications"), "notification widget still boots");
});
