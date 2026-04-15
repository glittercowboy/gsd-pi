import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_LOOP_TS_PATH = join(__dirname, "..", "auto-loop.ts");
const AUTO_RESOLVE_TS_PATH = join(__dirname, "..", "auto", "resolve.ts");
const AUTO_PHASES_TS_PATH = join(__dirname, "..", "auto", "phases.ts");
const AGENT_END_RECOVERY_TS_PATH = join(__dirname, "..", "bootstrap", "agent-end-recovery.ts");
const AUTO_TIMERS_TS_PATH = join(__dirname, "..", "auto-timers.ts");

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

test("auto resolve exports cancelPendingUnit and barrel re-exports it", () => {
  const resolveSrc = read(AUTO_RESOLVE_TS_PATH);
  const barrelSrc = read(AUTO_LOOP_TS_PATH);

  assert.ok(
    resolveSrc.includes("export function cancelPendingUnit"),
    "auto/resolve.ts must export cancelPendingUnit so explicit pause paths can unwind the in-flight unit",
  );
  assert.ok(
    resolveSrc.includes('reason: "aborted" | "provider-error"'),
    "cancelPendingUnit should distinguish aborted vs provider-error pause paths",
  );
  assert.ok(
    barrelSrc.includes("cancelPendingUnit"),
    "auto-loop.ts barrel must re-export cancelPendingUnit",
  );
});

test("agent-end aborted path cancels the pending unit before pausing", () => {
  const src = read(AGENT_END_RECOVERY_TS_PATH);
  assert.ok(
    /stopReason === "aborted"[\s\S]{0,1200}cancelPendingUnit\("aborted"\)[\s\S]{0,400}pauseAuto\(ctx, pi/.test(src),
    "aborted agent_end path must cancelPendingUnit('aborted') before pauseAuto(ctx, pi, ...)",
  );
});

test("provider-error pause callbacks cancel the pending unit before pausing", () => {
  const src = read(AGENT_END_RECOVERY_TS_PATH);
  const matches = src.match(/cancelPendingUnit\("provider-error"\)/g) ?? [];

  assert.ok(
    matches.length >= 2,
    "agent-end-recovery.ts should cancelPendingUnit('provider-error') in both transient and permanent provider pause callbacks",
  );
  assert.ok(
    /cancelPendingUnit\("provider-error"\)[\s\S]{0,240}pauseAuto\(ctx, pi/.test(src),
    "provider pause callback must cancelPendingUnit('provider-error') before pauseAuto(ctx, pi, ...)",
  );
});

test("cancelled paused units unwind cleanly instead of being treated as session failure", () => {
  const src = read(AUTO_PHASES_TS_PATH);
  assert.ok(
    src.includes("if (!s.active && s.paused)"),
    "auto/phases.ts must detect paused cancelled units before session-failure handling",
  );
  assert.ok(
    src.includes('reason: "paused-unwind"'),
    "auto/phases.ts should log a paused-unwind exit for explicit pause paths",
  );
  assert.ok(
    /if \(!s\.active && s\.paused\)[\s\S]{0,260}emitCancelledUnitEnd\(/.test(src),
    "paused-unwind path must still emit unit-end so forensics do not lose cancelled-unit closure",
  );
});

test("auto timer delivery modes are explicit and intentional", () => {
  const src = read(AUTO_TIMERS_TS_PATH);
  assert.ok(
    /TIME BUDGET WARNING[\s\S]*?deliverAs: "followUp"/.test(src),
    "soft timeout wrap-up should be followUp so advisory nudges do not implicitly steer the current turn",
  );
  assert.ok(
    /CONTEXT BUDGET WARNING[\s\S]*?deliverAs: "steer"/.test(src),
    "context-pressure wrap-up should be explicit steer so interruption behavior is intentional",
  );
});
