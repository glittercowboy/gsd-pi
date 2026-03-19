/**
 * Tests for team signal protocol — NDJSON append-log channel.
 *
 * Validates:
 * - Round-trip: write → read returns correct fields
 * - Append semantics: multiple signals accumulate in order
 * - Each signal type round-trips correctly
 * - Corrupt NDJSON line recovery (skip bad lines, keep good ones)
 * - Empty/missing file returns []
 * - Clear deletes accumulated signals
 * - Non-interference: consumeSignal() is unaffected by team signal presence
 * - Broadcast signal (workerMid: "*") round-trips correctly
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  writeTeamSignal,
  readTeamSignals,
  clearTeamSignals,
  sendSignal,
  consumeSignal,
  TEAM_SIGNAL_SUFFIX,
  type TeamSignal,
  type TeamSignalType,
} from "../session-status-io.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-team-signal-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "parallel"), { recursive: true });
  return dir;
}

function makeSignal(overrides: Partial<TeamSignal> = {}): TeamSignal {
  return {
    type: "contract-change",
    source: "M001",
    workerMid: "M002",
    payload: { file: "api.ts" },
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Test 1: Round-trip — write one signal, read it back ──────────────────────
{
  const basePath = makeTempDir();
  try {
    const signal = makeSignal({
      type: "contract-change",
      source: "M001",
      workerMid: "M002",
      payload: { file: "api.ts", change: "added endpoint" },
      timestamp: 1700000000000,
    });

    writeTeamSignal(basePath, "M002", signal);
    const result = readTeamSignals(basePath, "M002");

    assertEq(result.length, 1, "round-trip: exactly 1 signal returned");
    assertEq(result[0].type, "contract-change", "round-trip: type preserved");
    assertEq(result[0].source, "M001", "round-trip: source preserved");
    assertEq(result[0].workerMid, "M002", "round-trip: workerMid preserved");
    assertEq(result[0].payload.file, "api.ts", "round-trip: payload.file preserved");
    assertEq(result[0].payload.change, "added endpoint", "round-trip: payload.change preserved");
    assertEq(result[0].timestamp, 1700000000000, "round-trip: timestamp preserved");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// ─── Test 2: Append semantics — 3 signals accumulate in order ─────────────────
{
  const basePath = makeTempDir();
  try {
    const s1 = makeSignal({ type: "contract-change", timestamp: 1 });
    const s2 = makeSignal({ type: "slice-complete", timestamp: 2 });
    const s3 = makeSignal({ type: "api-available", timestamp: 3 });

    writeTeamSignal(basePath, "M002", s1);
    writeTeamSignal(basePath, "M002", s2);
    writeTeamSignal(basePath, "M002", s3);

    const result = readTeamSignals(basePath, "M002");
    assertEq(result.length, 3, "append: 3 signals returned");
    assertEq(result[0].type, "contract-change", "append: first signal type correct");
    assertEq(result[1].type, "slice-complete", "append: second signal type correct");
    assertEq(result[2].type, "api-available", "append: third signal type correct");
    assertEq(result[0].timestamp, 1, "append: order preserved (timestamp 1 first)");
    assertEq(result[2].timestamp, 3, "append: order preserved (timestamp 3 last)");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// ─── Test 3: Each TeamSignalType round-trips ──────────────────────────────────
{
  const types: TeamSignalType[] = [
    "contract-change",
    "slice-complete",
    "api-available",
    "schema-update",
    "pattern-discovered",
  ];

  for (const signalType of types) {
    const basePath = makeTempDir();
    try {
      const signal = makeSignal({ type: signalType });
      writeTeamSignal(basePath, "M010", signal);
      const result = readTeamSignals(basePath, "M010");
      assertEq(result.length, 1, `signal type ${signalType}: one signal returned`);
      assertEq(result[0].type, signalType, `signal type ${signalType}: type round-trips`);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  }
}

// ─── Test 4: Corrupt line recovery ────────────────────────────────────────────
{
  const basePath = makeTempDir();
  try {
    const s1 = makeSignal({ type: "contract-change", timestamp: 100 });
    const s2 = makeSignal({ type: "api-available", timestamp: 300 });

    // Write first valid signal
    writeTeamSignal(basePath, "M002", s1);

    // Manually inject a corrupt line
    const filePath = join(basePath, ".gsd", "parallel", `M002${TEAM_SIGNAL_SUFFIX}`);
    appendFileSync(filePath, "this is not valid JSON\n", "utf-8");

    // Write second valid signal
    writeTeamSignal(basePath, "M002", s2);

    const result = readTeamSignals(basePath, "M002");
    assertEq(result.length, 2, "corrupt recovery: 2 valid signals returned (corrupt skipped)");
    assertEq(result[0].timestamp, 100, "corrupt recovery: first signal preserved");
    assertEq(result[1].timestamp, 300, "corrupt recovery: second signal preserved");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// ─── Test 5: Empty/missing file returns [] ────────────────────────────────────
{
  const basePath = makeTempDir();
  try {
    const result = readTeamSignals(basePath, "M999-nonexistent");
    assertEq(result.length, 0, "missing file: returns empty array");
    assertTrue(Array.isArray(result), "missing file: result is an array");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// ─── Test 6: Clear deletes accumulated signals ────────────────────────────────
{
  const basePath = makeTempDir();
  try {
    writeTeamSignal(basePath, "M002", makeSignal({ timestamp: 1 }));
    writeTeamSignal(basePath, "M002", makeSignal({ timestamp: 2 }));

    // Verify signals exist
    const before = readTeamSignals(basePath, "M002");
    assertEq(before.length, 2, "clear: 2 signals before clear");

    // Clear
    clearTeamSignals(basePath, "M002");

    // Verify file is gone
    const after = readTeamSignals(basePath, "M002");
    assertEq(after.length, 0, "clear: 0 signals after clear");

    const filePath = join(basePath, ".gsd", "parallel", `M002${TEAM_SIGNAL_SUFFIX}`);
    assertTrue(!existsSync(filePath), "clear: NDJSON file deleted from disk");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// ─── Test 7: Non-interference — consumeSignal() ignores team signals ──────────
{
  const basePath = makeTempDir();
  try {
    // Write a team signal for M002
    const teamSig = makeSignal({
      type: "schema-update",
      source: "M001",
      workerMid: "M002",
      payload: { schema: "users" },
      timestamp: 500,
    });
    writeTeamSignal(basePath, "M002", teamSig);

    // Write a regular pause signal for M002
    sendSignal(basePath, "M002", "pause");

    // Verify team signal file exists before consume
    const teamFilePath = join(basePath, ".gsd", "parallel", `M002${TEAM_SIGNAL_SUFFIX}`);
    assertTrue(existsSync(teamFilePath), "non-interference: team signal file exists before consumeSignal");

    // Consume the regular signal
    const regularSignal = consumeSignal(basePath, "M002");
    assertTrue(regularSignal !== null, "non-interference: consumeSignal returns the regular signal");
    assertEq(regularSignal!.signal, "pause", "non-interference: regular signal is 'pause'");

    // Verify team signal file is COMPLETELY untouched
    assertTrue(existsSync(teamFilePath), "non-interference: team signal file still exists after consumeSignal");
    const teamSignals = readTeamSignals(basePath, "M002");
    assertEq(teamSignals.length, 1, "non-interference: team signals unchanged after consumeSignal");
    assertEq(teamSignals[0].type, "schema-update", "non-interference: team signal type preserved");
    assertEq(teamSignals[0].payload.schema, "users", "non-interference: team signal payload preserved");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// ─── Test 8: Broadcast signal (workerMid: "*") ───────────────────────────────
{
  const basePath = makeTempDir();
  try {
    const broadcast = makeSignal({
      type: "pattern-discovered",
      source: "M001",
      workerMid: "*",
      payload: { pattern: "repository-pattern", files: ["src/repo.ts"] },
      timestamp: 999,
    });

    // Broadcast signals are still written to a specific target file
    // The coordinator routes them; this test validates the "*" value round-trips
    writeTeamSignal(basePath, "M003", broadcast);
    const result = readTeamSignals(basePath, "M003");

    assertEq(result.length, 1, "broadcast: one signal returned");
    assertEq(result[0].workerMid, "*", "broadcast: workerMid '*' preserved");
    assertEq(result[0].type, "pattern-discovered", "broadcast: type preserved");
    assertEq(result[0].source, "M001", "broadcast: source preserved");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// ─── Test 9: Clear on nonexistent file is non-fatal ──────────────────────────
{
  const basePath = makeTempDir();
  try {
    // Should not throw
    clearTeamSignals(basePath, "M999-does-not-exist");
    assertTrue(true, "clear nonexistent: no crash");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
}

// ─── Test 10: TEAM_SIGNAL_SUFFIX constant ─────────────────────────────────────
{
  assertEq(TEAM_SIGNAL_SUFFIX, ".team-signals.ndjson", "suffix constant is correct");
}

// ─── Report ───────────────────────────────────────────────────────────────────
report();
