import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

test("post-unit pre-verification selects turn git action from UOK gitops flags", () => {
  const source = readFileSync(join(gsdDir, "auto-post-unit.ts"), "utf-8");
  assert.ok(
    source.includes("const turnAction: TurnGitActionMode = uokFlags.gitops ? uokFlags.gitopsTurnAction : \"commit\""),
    "postUnitPreVerification should derive turn action from uok.gitops.turn_action when enabled",
  );
});

test("post-unit pre-verification routes git failures through closeout gate", () => {
  const source = readFileSync(join(gsdDir, "auto-post-unit.ts"), "utf-8");
  assert.ok(
    source.includes('id: "closeout-git-action"') &&
    source.includes('type: "closeout"') &&
    source.includes('failureClass: "git"'),
    "git failures should be persisted via a closeout gate with failureClass=git",
  );
});

test("auto snapshot opts carry trace/turn IDs for turn closeout records", () => {
  const source = readFileSync(join(gsdDir, "auto.ts"), "utf-8");
  assert.ok(
    source.includes("traceId: s.currentTraceId ?? undefined") &&
    source.includes("turnId: s.currentTurnId ?? undefined"),
    "buildSnapshotOpts should pass trace/turn IDs into closeout options",
  );
});
