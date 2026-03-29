/**
 * Forensics journal scanning and anomaly detection — behavioral unit tests.
 *
 * Tests detectJournalAnomalies (pure function) and scanJournalForForensics
 * (file I/O) with controlled inputs. No source-regex assertions.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { detectJournalAnomalies, scanJournalForForensics } from "../forensics.js";
import type { JournalSummary, ForensicAnomaly } from "../forensics.js";
import { _clearGsdRootCache } from "../paths.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJournal(overrides: Partial<JournalSummary> = {}): JournalSummary {
  return {
    totalEntries: 0,
    flowCount: 0,
    eventCounts: {},
    recentEvents: [],
    oldestEntry: null,
    newestEntry: null,
    fileCount: 0,
    ...overrides,
  };
}

function makeEntry(opts: { ts: string; flowId: string; eventType: string }): string {
  return JSON.stringify({ ts: opts.ts, flowId: opts.flowId, eventType: opts.eventType }) + "\n";
}

/** Create a temp dir with .gsd/journal/ layout, return the basePath. */
function makeTempBase(): string {
  const base = join(tmpdir(), `forensics-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(join(base, ".gsd", "journal"), { recursive: true });
  return base;
}

// ─── detectJournalAnomalies ───────────────────────────────────────────────────

describe("detectJournalAnomalies", () => {
  it("null journal produces no anomalies", () => {
    const anomalies: ForensicAnomaly[] = [];
    detectJournalAnomalies(null, anomalies);
    assert.strictEqual(anomalies.length, 0);
  });

  it("clean journal (no bad event counts) produces no anomalies", () => {
    const anomalies: ForensicAnomaly[] = [];
    const journal = makeJournal({
      flowCount: 2,
      eventCounts: { "dispatch-start": 2, "dispatch-stop": 2 },
    });
    detectJournalAnomalies(journal, anomalies);
    assert.strictEqual(anomalies.length, 0);
  });

  it("stuck-detected count 1 produces journal-stuck anomaly with warning severity", () => {
    const anomalies: ForensicAnomaly[] = [];
    detectJournalAnomalies(makeJournal({ eventCounts: { "stuck-detected": 1 } }), anomalies);
    const stuck = anomalies.find(a => a.type === "journal-stuck");
    assert.ok(stuck, "journal-stuck anomaly must be present");
    assert.strictEqual(stuck.severity, "warning");
  });

  it("stuck-detected count >=3 escalates to error severity", () => {
    const anomalies: ForensicAnomaly[] = [];
    detectJournalAnomalies(makeJournal({ eventCounts: { "stuck-detected": 3 } }), anomalies);
    const stuck = anomalies.find(a => a.type === "journal-stuck");
    assert.ok(stuck, "journal-stuck anomaly must be present");
    assert.strictEqual(stuck.severity, "error");
  });

  it("guard-block events produce journal-guard-block anomaly", () => {
    const anomalies: ForensicAnomaly[] = [];
    detectJournalAnomalies(makeJournal({ eventCounts: { "guard-block": 2 } }), anomalies);
    const block = anomalies.find(a => a.type === "journal-guard-block");
    assert.ok(block, "journal-guard-block anomaly must be present");
  });

  it("rapid iterations (flowCount >10, avg <5000ms) produce journal-rapid-iterations anomaly", () => {
    const anomalies: ForensicAnomaly[] = [];
    // 11 flows over 44 seconds = avg 4000ms each (below 5000ms threshold)
    const oldestEntry = "2024-01-01T10:00:00.000Z";
    const newestEntry = "2024-01-01T10:00:44.000Z"; // 44s span
    detectJournalAnomalies(makeJournal({
      flowCount: 11,
      oldestEntry,
      newestEntry,
    }), anomalies);
    const rapid = anomalies.find(a => a.type === "journal-rapid-iterations");
    assert.ok(rapid, "journal-rapid-iterations anomaly must be present");
  });

  it("flowCount <=10 does not trigger rapid-iterations even with short timespan", () => {
    const anomalies: ForensicAnomaly[] = [];
    detectJournalAnomalies(makeJournal({
      flowCount: 10,
      oldestEntry: "2024-01-01T10:00:00.000Z",
      newestEntry: "2024-01-01T10:00:10.000Z",
    }), anomalies);
    const rapid = anomalies.find(a => a.type === "journal-rapid-iterations");
    assert.strictEqual(rapid, undefined, "should not trigger rapid-iterations with flowCount=10");
  });

  it("worktree-create-failed events produce journal-worktree-failure anomaly", () => {
    const anomalies: ForensicAnomaly[] = [];
    detectJournalAnomalies(makeJournal({ eventCounts: { "worktree-create-failed": 1 } }), anomalies);
    const wt = anomalies.find(a => a.type === "journal-worktree-failure");
    assert.ok(wt, "journal-worktree-failure anomaly must be present for create failures");
  });

  it("worktree-merge-failed events produce journal-worktree-failure anomaly", () => {
    const anomalies: ForensicAnomaly[] = [];
    detectJournalAnomalies(makeJournal({ eventCounts: { "worktree-merge-failed": 2 } }), anomalies);
    const wt = anomalies.find(a => a.type === "journal-worktree-failure");
    assert.ok(wt, "journal-worktree-failure anomaly must be present for merge failures");
  });

  it("multiple anomaly types can coexist in one journal", () => {
    const anomalies: ForensicAnomaly[] = [];
    detectJournalAnomalies(makeJournal({
      eventCounts: { "stuck-detected": 1, "guard-block": 1 },
    }), anomalies);
    assert.ok(anomalies.some(a => a.type === "journal-stuck"), "journal-stuck must be present");
    assert.ok(anomalies.some(a => a.type === "journal-guard-block"), "journal-guard-block must be present");
  });
});

// ─── scanJournalForForensics ──────────────────────────────────────────────────

describe("scanJournalForForensics", () => {
  let base: string;

  before(() => {
    base = makeTempBase();
    _clearGsdRootCache();
  });

  after(() => {
    rmSync(base, { recursive: true, force: true });
    _clearGsdRootCache();
  });

  it("returns null when journal dir does not exist", () => {
    const missingBase = join(tmpdir(), `no-gsd-${randomBytes(4).toString("hex")}`);
    mkdirSync(missingBase, { recursive: true });
    _clearGsdRootCache();
    try {
      const result = scanJournalForForensics(missingBase);
      assert.strictEqual(result, null);
    } finally {
      rmSync(missingBase, { recursive: true, force: true });
      _clearGsdRootCache();
    }
  });

  it("returns null when journal dir exists but is empty", () => {
    const emptyBase = join(tmpdir(), `empty-journal-${randomBytes(4).toString("hex")}`);
    mkdirSync(join(emptyBase, ".gsd", "journal"), { recursive: true });
    _clearGsdRootCache();
    try {
      const result = scanJournalForForensics(emptyBase);
      assert.strictEqual(result, null);
    } finally {
      rmSync(emptyBase, { recursive: true, force: true });
      _clearGsdRootCache();
    }
  });

  it("parses single journal file and returns correct counts", () => {
    const singleBase = join(tmpdir(), `single-${randomBytes(4).toString("hex")}`);
    const journalDir = join(singleBase, ".gsd", "journal");
    mkdirSync(journalDir, { recursive: true });
    _clearGsdRootCache();

    const content = [
      makeEntry({ ts: "2024-01-01T10:00:00.000Z", flowId: "flow-1", eventType: "dispatch-start" }),
      makeEntry({ ts: "2024-01-01T10:01:00.000Z", flowId: "flow-1", eventType: "dispatch-stop" }),
      makeEntry({ ts: "2024-01-01T10:02:00.000Z", flowId: "flow-2", eventType: "dispatch-start" }),
    ].join("");

    writeFileSync(join(journalDir, "2024-01-01.jsonl"), content);

    try {
      const result = scanJournalForForensics(singleBase);
      assert.ok(result, "result must not be null");
      assert.strictEqual(result.totalEntries, 3);
      assert.strictEqual(result.flowCount, 2);
      assert.strictEqual(result.eventCounts["dispatch-start"], 2);
      assert.strictEqual(result.eventCounts["dispatch-stop"], 1);
      assert.strictEqual(result.fileCount, 1);
    } finally {
      rmSync(singleBase, { recursive: true, force: true });
      _clearGsdRootCache();
    }
  });

  it("caps recentEvents at 20 (MAX_JOURNAL_RECENT_EVENTS)", () => {
    const capBase = join(tmpdir(), `cap-${randomBytes(4).toString("hex")}`);
    const journalDir = join(capBase, ".gsd", "journal");
    mkdirSync(journalDir, { recursive: true });
    _clearGsdRootCache();

    // Write 25 events to a single file
    let content = "";
    for (let i = 0; i < 25; i++) {
      const ts = new Date(Date.UTC(2024, 0, 1, 10, i)).toISOString();
      content += makeEntry({ ts, flowId: `flow-${i}`, eventType: "dispatch-start" });
    }
    writeFileSync(join(journalDir, "2024-01-01.jsonl"), content);

    try {
      const result = scanJournalForForensics(capBase);
      assert.ok(result, "result must not be null");
      assert.strictEqual(result.totalEntries, 25);
      assert.strictEqual(result.recentEvents.length, 20, "recentEvents must be capped at 20");
    } finally {
      rmSync(capBase, { recursive: true, force: true });
      _clearGsdRootCache();
    }
  });

  it("older files are line-counted but their events do not appear in eventCounts", () => {
    // Write 4 files — only the last 3 are fully parsed (MAX_JOURNAL_RECENT_FILES=3)
    const oldBase = join(tmpdir(), `older-${randomBytes(4).toString("hex")}`);
    const journalDir = join(oldBase, ".gsd", "journal");
    mkdirSync(journalDir, { recursive: true });
    _clearGsdRootCache();

    // Oldest file — event type "ancient-event" must NOT appear in eventCounts
    writeFileSync(join(journalDir, "2024-01-01.jsonl"),
      makeEntry({ ts: "2024-01-01T00:00:00.000Z", flowId: "old-flow", eventType: "ancient-event" }),
    );
    // Three recent files
    for (let i = 2; i <= 4; i++) {
      const date = `2024-01-0${i}`;
      writeFileSync(join(journalDir, `${date}.jsonl`),
        makeEntry({ ts: `${date}T00:00:00.000Z`, flowId: `flow-${i}`, eventType: "dispatch-start" }),
      );
    }

    try {
      const result = scanJournalForForensics(oldBase);
      assert.ok(result, "result must not be null");
      assert.strictEqual(result.fileCount, 4);
      // Total includes older line-counted entry
      assert.strictEqual(result.totalEntries, 4);
      // ancient-event from the oldest file must NOT be in eventCounts
      assert.strictEqual(result.eventCounts["ancient-event"], undefined,
        "events from older files must not appear in eventCounts");
      // dispatch-start from recent files must be counted
      assert.strictEqual(result.eventCounts["dispatch-start"], 3);
    } finally {
      rmSync(oldBase, { recursive: true, force: true });
      _clearGsdRootCache();
    }
  });

  it("reports correct fileCount across multiple files", () => {
    const multiBase = join(tmpdir(), `multi-${randomBytes(4).toString("hex")}`);
    const journalDir = join(multiBase, ".gsd", "journal");
    mkdirSync(journalDir, { recursive: true });
    _clearGsdRootCache();

    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(journalDir, `2024-01-0${i}.jsonl`),
        makeEntry({ ts: `2024-01-0${i}T00:00:00.000Z`, flowId: `f${i}`, eventType: "tick" }),
      );
    }

    try {
      const result = scanJournalForForensics(multiBase);
      assert.ok(result, "result must not be null");
      assert.strictEqual(result.fileCount, 5);
    } finally {
      rmSync(multiBase, { recursive: true, force: true });
      _clearGsdRootCache();
    }
  });
});
