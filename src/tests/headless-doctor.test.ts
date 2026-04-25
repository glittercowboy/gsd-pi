// Project/App Name: gsd-pi · headless doctor wiring (#4929)
//
// Regression test for the live-regression assertion added in #4904
// ("gsd doctor surfaces actionable guidance about the stale lock").
//
// Before this fix, the headless dispatcher had no `doctor` case — the
// only path the live-regression test could reach (`gsd headless doctor`)
// fell through to RPC dispatch and tried to launch a TUI subprocess.
// Now the dispatcher invokes runGSDDoctor directly (mirrors the existing
// `query` shape), and the resulting report from a stale-lock fixture
// carries the "lock" keyword and stale PID the live-regression
// assertion checks for.
//
// This test exercises the runGSDDoctor + formatDoctorReport pipeline
// the headless case wires up — covering the behavior end-to-end without
// having to spawn a child process. The dispatch wiring itself is one
// branch in headless.ts (verified by `npm run build:core`); the
// behavior-level guarantee the live-regression test cares about is
// what's verified here.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGSDDoctor } from "../resources/extensions/gsd/doctor.ts";
import {
  formatDoctorReport,
  formatDoctorReportJson,
} from "../resources/extensions/gsd/doctor-format.ts";

function makeStaleLockFixture(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-headless-doctor-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  // PID 99999 is conventional in the live-regression suite for "dead PID
  // we just verified is not running" — we don't need to verify the dead-PID
  // capture here, just that the doctor surfaces the stale lock cleanly.
  writeFileSync(
    join(base, ".gsd", "auto.lock"),
    JSON.stringify({
      pid: 99999,
      startedAt: new Date().toISOString(),
      unitType: "execute-task",
      unitId: "M001/S01/T02",
      unitStartedAt: new Date().toISOString(),
      completedUnits: 5,
    }),
  );
  return base;
}

test("#4929: runGSDDoctor + formatDoctorReport surface 'lock' + stale PID for stale auto.lock", async (t) => {
  const base = makeStaleLockFixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const report = await runGSDDoctor(base);
  const out = formatDoctorReport(report);
  const lower = out.toLowerCase();

  assert.ok(
    lower.includes("lock"),
    `formatted report must mention "lock" — live-regression #4904 asserts this. Got: ${out.slice(0, 300)}`,
  );
  assert.ok(
    out.includes("99999"),
    `formatted report must mention the stale PID. Got: ${out.slice(0, 300)}`,
  );
  assert.ok(
    lower.includes("stale") || lower.includes("stale_crash_lock"),
    `formatted report must include mitigation guidance. Got: ${out.slice(0, 300)}`,
  );
  // Doctor should report this as an issue (not "ok") — exit code in the
  // headless wiring is derived from report.ok.
  assert.strictEqual(report.ok, false, "stale lock must mark report.ok = false so headless exits 1");
});

test("#4929: formatDoctorReportJson preserves the stale-lock issue + PID for --json callers", async (t) => {
  const base = makeStaleLockFixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const report = await runGSDDoctor(base);
  const json = formatDoctorReportJson(report);
  const parsed = JSON.parse(json);

  assert.strictEqual(parsed.ok, false);
  const codes = (parsed.issues as Array<{ code: string }>).map(i => i.code);
  assert.ok(
    codes.includes("stale_crash_lock"),
    `JSON output must include stale_crash_lock issue code. Got codes: ${codes.join(", ")}`,
  );
  const messages = (parsed.issues as Array<{ message: string }>).map(i => i.message).join("\n");
  assert.ok(
    messages.includes("99999"),
    `JSON output must include the stale PID in some issue message. Got: ${messages.slice(0, 300)}`,
  );
});
