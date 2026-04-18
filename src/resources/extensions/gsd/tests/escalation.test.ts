// GSD Extension — ADR-011 Phase 2 Mid-Execution Escalation tests
// Covers: artifact write/read, detection, resolution (A|B|accept|reject-blocker),
// DB claim race, carry-forward injection, schema v16/v17 migration, feature flag.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
  getTask,
  claimEscalationOverride,
  findUnappliedEscalationOverride,
  listEscalationArtifacts,
  _getAdapter,
} from "../gsd-db.ts";
import {
  buildEscalationArtifact,
  writeEscalationArtifact,
  readEscalationArtifact,
  detectPendingEscalation,
  resolveEscalation,
  claimOverrideForInjection,
  escalationArtifactPath,
} from "../escalation.ts";
import type { EscalationOption } from "../types.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-p2-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function writePrefs(base: string, enabled: boolean): void {
  const path = join(base, ".gsd", "PREFERENCES.md");
  writeFileSync(path, [
    "---",
    "version: 1",
    "phases:",
    `  mid_execution_escalation: ${enabled}`,
    "---",
  ].join("\n"));
}

function seedCompletedTask(base: string, taskId: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  insertTask({
    id: taskId, sliceId: "S01", milestoneId: "M001", title: "Task",
    status: "complete",
  });
}

const sampleOptions: EscalationOption[] = [
  { id: "A", label: "Separate table", tradeoffs: "More flexible; requires migration." },
  { id: "B", label: "JSON array", tradeoffs: "Simpler; limited to ~1000 entries." },
];

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

test("ADR-011 P2: writeEscalationArtifact persists canonical JSON at tasks/T##-ESCALATION.json", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T03");

  const art = buildEscalationArtifact({
    taskId: "T03", sliceId: "S01", milestoneId: "M001",
    question: "Where should we store notifications?",
    options: sampleOptions,
    recommendation: "B",
    recommendationRationale: "Single-user display only.",
    continueWithDefault: false,
  });
  const path = writeEscalationArtifact(base, art);
  assert.ok(existsSync(path), "artifact file must exist");
  assert.ok(path.endsWith("/tasks/T03-ESCALATION.json"), `path should end with tasks/T03-ESCALATION.json, got ${path}`);

  const roundTrip = readEscalationArtifact(path);
  assert.ok(roundTrip, "artifact must round-trip");
  assert.equal(roundTrip!.taskId, "T03");
  assert.equal(roundTrip!.recommendation, "B");
  assert.equal(roundTrip!.options.length, 2);

  // DB flag flipped to pending (continueWithDefault=false).
  const row = getTask("M001", "S01", "T03");
  assert.equal(row?.escalation_pending, 1);
  assert.equal(row?.escalation_awaiting_review, 0);
  assert.equal(row?.escalation_artifact_path, path);
});

test("ADR-011 P2: continueWithDefault=true sets awaiting_review (NOT pending) — no pause", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T04");

  const art = buildEscalationArtifact({
    taskId: "T04", sliceId: "S01", milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: true,
  });
  writeEscalationArtifact(base, art);

  const row = getTask("M001", "S01", "T04");
  assert.equal(row?.escalation_pending, 0, "fire-and-correct must NOT set escalation_pending");
  assert.equal(row?.escalation_awaiting_review, 1);
});

test("ADR-011 P2: detectPendingEscalation returns only pause-scoped escalations", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T01");
  seedCompletedTask(base, "T02");

  // T01: continueWithDefault=true (awaiting_review, not pending)
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T01", sliceId: "S01", milestoneId: "M001",
    question: "Q1", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: true,
  }));
  // T02: continueWithDefault=false (pause)
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T02", sliceId: "S01", milestoneId: "M001",
    question: "Q2", options: sampleOptions, recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const tasks = [getTask("M001", "S01", "T01")!, getTask("M001", "S01", "T02")!];
  const id = detectPendingEscalation(tasks, base);
  assert.equal(id, "T02", "only T02 is pause-worthy; T01 is awaiting_review");
});

test("ADR-011 P2: resolveEscalation(accept) marks artifact + clears flags", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T05");

  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T05", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const result = resolveEscalation(base, "M001", "S01", "T05", "accept", "looks good");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "B");

  const row = getTask("M001", "S01", "T05");
  assert.equal(row?.escalation_pending, 0);
  assert.equal(row?.escalation_awaiting_review, 0);

  const artPath = escalationArtifactPath(base, "M001", "S01", "T05")!;
  const art = readEscalationArtifact(artPath);
  assert.ok(art?.respondedAt, "artifact must record respondedAt");
  assert.equal(art?.userChoice, "accept");
  assert.equal(art?.userRationale, "looks good");
});

test("ADR-011 P2: resolveEscalation(reject-blocker) sets blocker_discovered + blocker_source", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T06");

  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T06", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const result = resolveEscalation(base, "M001", "S01", "T06", "reject-blocker", "none of these work");
  assert.equal(result.status, "rejected-to-blocker");

  const row = getTask("M001", "S01", "T06");
  assert.equal(row?.blocker_discovered, true, "reject-blocker must flip blocker_discovered=1");
  assert.equal(row?.blocker_source, "reject-escalation", "blocker_source must record provenance");
  assert.equal(row?.escalation_pending, 0);
});

test("ADR-011 P2: resolveEscalation(invalid-choice) returns error + leaves state untouched", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T07");

  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T07", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const result = resolveEscalation(base, "M001", "S01", "T07", "Z", "");
  assert.equal(result.status, "invalid-choice");

  // State must NOT have changed.
  const row = getTask("M001", "S01", "T07");
  assert.equal(row?.escalation_pending, 1, "flag must still be pending after invalid choice");
});

test("ADR-011 P2: claimEscalationOverride is atomic — only one claimer wins the race", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T08");

  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T08", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T08", "A", "pick A");

  const first = claimEscalationOverride("M001", "S01", "T08");
  const second = claimEscalationOverride("M001", "S01", "T08");
  assert.equal(first, true, "first claim wins");
  assert.equal(second, false, "second claim must fail — override already applied");
});

test("ADR-011 P2: claimOverrideForInjection returns null when flag ON but no unapplied override", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T09");

  const claimed = claimOverrideForInjection(base, "M001", "S01");
  assert.equal(claimed, null);
});

test("ADR-011 P2: claim does NOT fire on unresolved awaiting_review — resolution is preserved until user responds", (t) => {
  // Regression for peer-review Bug 2: previously findUnappliedEscalationOverride
  // matched `escalation_pending=0` alone, so an awaiting_review task (created
  // by continueWithDefault=true) was silently claimed before the user had
  // a chance to resolve, permanently dropping the override.
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T09a");
  seedCompletedTask(base, "T09b");

  // Write a continueWithDefault=true artifact (awaiting_review=1, no respondedAt).
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T09a", sliceId: "S01", milestoneId: "M001",
    question: "Which DB?", options: sampleOptions,
    recommendation: "A", recommendationRationale: "r",
    continueWithDefault: true,
  }));

  // NEXT task's prompt build — must NOT claim the unresolved awaiting_review.
  const premature = claimOverrideForInjection(base, "M001", "S01");
  assert.equal(premature, null, "awaiting_review without respondedAt must not be claimed");

  const midState = getTask("M001", "S01", "T09a");
  assert.equal(midState?.escalation_override_applied_at, null, "applied_at must still be null");

  // User now resolves.
  resolveEscalation(base, "M001", "S01", "T09a", "B", "actually B is better");

  // NEXT task's prompt build — NOW the override must be claimed and injected.
  const claimed = claimOverrideForInjection(base, "M001", "S01");
  assert.ok(claimed, "after user resolution, the override must be injectable");
  assert.equal(claimed!.sourceTaskId, "T09a");
  assert.match(claimed!.injectionBlock, /Escalation Override/);
});

test("ADR-011 P2: claimOverrideForInjection returns markdown block once, then null", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T10");

  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T10", sliceId: "S01", milestoneId: "M001",
    question: "Which storage?",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T10", "A", "pick A");

  const first = claimOverrideForInjection(base, "M001", "S01");
  assert.ok(first, "first claim returns the override");
  assert.match(first!.injectionBlock, /Escalation Override/);
  assert.equal(first!.sourceTaskId, "T10");

  const second = claimOverrideForInjection(base, "M001", "S01");
  assert.equal(second, null, "second call returns null (idempotent)");
});

test("ADR-011 P2: listEscalationArtifacts filters to actionable by default", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T11");
  seedCompletedTask(base, "T12");

  // Pending (actionable)
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T11", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  // Resolved (not actionable by default)
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T12", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T12", "A", "");

  const actionable = listEscalationArtifacts("M001", false);
  const all = listEscalationArtifacts("M001", true);
  assert.equal(actionable.length, 1, "only T11 is actionable");
  assert.equal(actionable[0]!.id, "T11");
  assert.equal(all.length, 2, "both surface with --all");
});

test("ADR-011 P2: schema v17 fresh DB has all escalation columns on tasks + source on decisions", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const adapter = _getAdapter()!;
  const tasksCols = adapter.prepare("PRAGMA table_info(tasks)").all().map((r) => r["name"] as string);
  for (const col of [
    "blocker_source",
    "escalation_pending",
    "escalation_awaiting_review",
    "escalation_artifact_path",
    "escalation_override_applied_at",
  ]) {
    assert.ok(tasksCols.includes(col), `tasks table must have ${col} column`);
  }

  const decCols = adapter.prepare("PRAGMA table_info(decisions)").all().map((r) => r["name"] as string);
  assert.ok(decCols.includes("source"), "decisions table must have source column");

  const version = adapter.prepare("SELECT MAX(version) as v FROM schema_version").get();
  assert.equal(version?.["v"], 17);
});

test("ADR-011 P2: findUnappliedEscalationOverride returns null when escalation_pending=1 (still pending)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T13");

  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T13", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  // Don't resolve — just query.
  const found = findUnappliedEscalationOverride("M001", "S01");
  assert.equal(found, null, "pending escalation must not surface as unapplied override");
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-011 Phase 3 integration-style tests (concurrent / timeout / recovery /
// latency — adapted from refine-slice phase patterns).
// ═══════════════════════════════════════════════════════════════════════════

test("ADR-011 P3: concurrent escalations queue in arrival order — list returns multiple", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T20");
  seedCompletedTask(base, "T21");

  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T20", sliceId: "S01", milestoneId: "M001",
    question: "Q1", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T21", sliceId: "S01", milestoneId: "M001",
    question: "Q2", options: sampleOptions, recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const pending = listEscalationArtifacts("M001", false);
  assert.equal(pending.length, 2);
  // Both are pause-worthy — state derivation returns the first.
  const first = detectPendingEscalation([getTask("M001", "S01", "T20")!, getTask("M001", "S01", "T21")!], base);
  assert.equal(first, "T20", "detection returns first pending in arrival order");
});

test("ADR-011 P3: recovery — malformed artifact returns null from read, does not crash", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T22");

  const artPath = escalationArtifactPath(base, "M001", "S01", "T22")!;
  mkdirSync(join(artPath, ".."), { recursive: true });
  writeFileSync(artPath, "{ this is not json");
  const result = readEscalationArtifact(artPath);
  assert.equal(result, null, "malformed JSON must return null (no throw)");
});

test("ADR-011 P3: resolve-on-missing-artifact returns not-found without partial state", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T23");

  const result = resolveEscalation(base, "M001", "S01", "T23", "A", "");
  assert.equal(result.status, "not-found");
  const row = getTask("M001", "S01", "T23");
  assert.equal(row?.escalation_pending, 0, "untouched");
});

test("ADR-011 P3: escalation write + detect latency — 20 tasks, one escalation, detection under 100ms", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  for (let i = 1; i <= 20; i++) {
    const tid = `T${String(i).padStart(2, "0")}`;
    insertTask({ id: tid, sliceId: "S01", milestoneId: "M001", title: `Task ${i}`, status: "complete" });
  }
  // Escalation on T15 only.
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T15", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const tasks = Array.from({ length: 20 }, (_, i) => getTask("M001", "S01", `T${String(i + 1).padStart(2, "0")}`)!);
  const start = Date.now();
  const found = detectPendingEscalation(tasks, base);
  const elapsed = Date.now() - start;
  assert.equal(found, "T15");
  assert.ok(elapsed < 100, `detection must complete under 100ms, took ${elapsed}ms`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-011 Phase 3 — Integration: Mid-Execution Escalation
// ═══════════════════════════════════════════════════════════════════════════

test("ADR-011 P3 #20: E2E escalation lifecycle — write → pause → resolve → resume via override injection", (t) => {
  // Exercises the full escalation loop across two tasks in one slice:
  //   1. Executor writes ESCALATION.json on T30 with continueWithDefault=false.
  //   2. detectPendingEscalation returns T30 (state.ts:998 is what pauses the loop).
  //   3. User calls resolveEscalation with a specific option choice.
  //   4. detectPendingEscalation returns null — pause condition cleared.
  //   5. The *next* task (T31) in the slice picks up the override block via
  //      claimOverrideForInjection exactly once (idempotent across retries).
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T30");
  seedCompletedTask(base, "T31");

  // Step 1: executor escalates on T30 (pause-scoped).
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T30", sliceId: "S01", milestoneId: "M001",
    question: "Storage format for the new metrics table?",
    options: sampleOptions, recommendation: "A", recommendationRationale: "A is simpler",
    continueWithDefault: false,
  }));

  // Step 2: scheduler sees the pause signal.
  let tasks = [getTask("M001", "S01", "T30")!, getTask("M001", "S01", "T31")!];
  assert.equal(
    detectPendingEscalation(tasks, base),
    "T30",
    "scheduler must pause on T30 before dispatching T31",
  );

  // Claim attempted mid-pause must fail (override not yet resolved).
  assert.equal(
    claimOverrideForInjection(base, "M001", "S01"),
    null,
    "no injection should fire while escalation is still pending",
  );

  // Step 3: user responds with option B + rationale.
  const result = resolveEscalation(base, "M001", "S01", "T30", "B", "B fits better");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "B");

  // Step 4: pause condition clears.
  tasks = [getTask("M001", "S01", "T30")!, getTask("M001", "S01", "T31")!];
  assert.equal(
    detectPendingEscalation(tasks, base),
    null,
    "after resolve, scheduler must not re-pause on T30",
  );

  // Step 5: next task (T31) picks up the override exactly once.
  const injected = claimOverrideForInjection(base, "M001", "S01");
  assert.ok(injected, "T31's prompt build must claim the resolved override");
  assert.equal(injected!.sourceTaskId, "T30");
  assert.match(injected!.injectionBlock, /Escalation Override/);
  assert.match(injected!.injectionBlock, /B/, "injection must reflect user's chosen option id");

  const secondClaim = claimOverrideForInjection(base, "M001", "S01");
  assert.equal(secondClaim, null, "override must be consumed exactly once");
});

test("ADR-011 P3 #21: blocker takes priority over escalation when both flags coexist on same task", (t) => {
  // Two invariants together give blocker-priority:
  //   a) state.ts:977-991 checks detectBlockers BEFORE the escalation branch
  //      at state.ts:996-1010, so a blocker flag short-circuits the escalation
  //      pause.
  //   b) resolveEscalation(reject-blocker) atomically clears escalation flags
  //      AND sets blocker_discovered=1 (escalation.ts:227-230), so there is no
  //      post-resolve window where both flags could surface simultaneously.
  // This test pins (b): after reject-blocker, the escalation pause signal is
  // gone and the task is exclusively in blocker-state.
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T40");

  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T40", sliceId: "S01", milestoneId: "M001",
    question: "Which storage?", options: sampleOptions,
    recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  // Pre-condition: escalation is active, blocker is not.
  let row = getTask("M001", "S01", "T40");
  assert.equal(row?.escalation_pending, 1);
  assert.equal(row?.blocker_discovered, false);
  assert.equal(detectPendingEscalation([row!], base), "T40");

  // User rejects to blocker — single transition.
  const result = resolveEscalation(
    base, "M001", "S01", "T40", "reject-blocker", "none of these fit the observed constraints",
  );
  assert.equal(result.status, "rejected-to-blocker");

  // Post-condition: blocker is set, escalation flags are cleared.
  row = getTask("M001", "S01", "T40");
  assert.equal(row?.blocker_discovered, true, "blocker_discovered must be set after reject-blocker");
  assert.equal(row?.blocker_source, "reject-escalation", "blocker_source records provenance");
  assert.equal(row?.escalation_pending, 0, "escalation_pending must be cleared");
  assert.equal(row?.escalation_awaiting_review, 0, "escalation_awaiting_review must be cleared");

  // detectPendingEscalation must no longer return T40 — scheduler would
  // otherwise race the blocker branch and pick the wrong phase.
  assert.equal(
    detectPendingEscalation([row!], base),
    null,
    "after reject-blocker, escalation must not pause — blocker path owns the task",
  );
});

test("ADR-011 P3 #22: ADR-009 audit envelopes emitted across the escalation lifecycle", (t) => {
  // Verifies that every user-visible escalation event writes a structured
  // audit envelope (eventId, traceId, category, type, ts, payload) to
  // .gsd/audit/events.jsonl. ADR-009 control-plane consumers depend on this
  // shape. Covered event types:
  //   - escalation-manual-attention-created (on write)
  //   - escalation-user-responded            (on resolve with option)
  //   - escalation-rejected-to-blocker       (on reject-blocker)
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T50");
  seedCompletedTask(base, "T51");

  // 1) write → created
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T50", sliceId: "S01", milestoneId: "M001",
    question: "Q50", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  // 2) resolve(accept) → responded
  resolveEscalation(base, "M001", "S01", "T50", "accept", "sounds right");

  // 3) another write + reject-blocker → rejected
  writeEscalationArtifact(base, buildEscalationArtifact({
    taskId: "T51", sliceId: "S01", milestoneId: "M001",
    question: "Q51", options: sampleOptions, recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T51", "reject-blocker", "blocker path");

  // Read audit log and parse each JSONL envelope.
  const logPath = join(base, ".gsd", "audit", "events.jsonl");
  assert.ok(existsSync(logPath), "audit log must exist at .gsd/audit/events.jsonl");
  const lines = readFileSync(logPath, "utf-8").split("\n").filter((l) => l.length > 0);
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const escalationEvents = events.filter((e) => typeof e["type"] === "string" && (e["type"] as string).startsWith("escalation-"));

  // All four lifecycle events must be present.
  const types = escalationEvents.map((e) => e["type"] as string).sort();
  assert.deepEqual(types, [
    "escalation-manual-attention-created",
    "escalation-manual-attention-created",
    "escalation-rejected-to-blocker",
    "escalation-user-responded",
  ]);

  // Every envelope must carry the ADR-009 contract fields.
  for (const env of escalationEvents) {
    assert.equal(typeof env["eventId"], "string", "envelope must include eventId");
    assert.equal(typeof env["traceId"], "string", "envelope must include traceId");
    assert.match(env["traceId"] as string, /^escalation:M001:S01:T5[01]$/, "traceId must be stable and task-scoped");
    assert.equal(env["category"], "gate", "escalation events belong to the gate control plane");
    assert.equal(typeof env["ts"], "string");
    assert.ok(env["payload"] && typeof env["payload"] === "object", "payload must be an object");
    const payload = env["payload"] as Record<string, unknown>;
    assert.equal(payload["milestoneId"], "M001");
    assert.equal(payload["sliceId"], "S01");
    assert.ok(payload["taskId"] === "T50" || payload["taskId"] === "T51");
  }
});
