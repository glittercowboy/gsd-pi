// GSD2 — Verify autoStartTime is persisted in paused-session.json and restored on resume
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * auto-start-time-persistence.test.ts — Ensures autoStartTime survives
 * cross-session resume via paused-session.json (#3585).
 *
 * Source-code regression guards: verify auto.ts saves and restores
 * autoStartTime so the elapsed timer doesn't vanish after /exit + resume.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_TS_PATH = join(__dirname, "..", "auto.ts");

const source = readFileSync(AUTO_TS_PATH, "utf-8");

test("pauseAuto persists autoStartTime in paused-session.json (#3585)", () => {
  assert.ok(
    source.includes("autoStartTime: s.autoStartTime"),
    "pausedMeta must include autoStartTime so the timer survives /exit",
  );
});

test("cross-session resume restores autoStartTime from paused-session.json (#3585)", () => {
  const matches = source.match(/s\.autoStartTime\s*=\s*meta\.autoStartTime/g);
  assert.ok(
    matches && matches.length >= 2,
    "both resume paths (custom workflow + milestone) must restore autoStartTime from meta",
  );
});

test("resume path falls back to Date.now() when autoStartTime is missing (#3585)", () => {
  assert.ok(
    source.includes("meta.autoStartTime || Date.now()"),
    "restore should fall back to Date.now() for old paused-session files without autoStartTime",
  );
});

test("resume path guards against zero autoStartTime (#3585)", () => {
  assert.ok(
    source.includes("if (!s.autoStartTime || s.autoStartTime <= 0) s.autoStartTime = Date.now()"),
    "resume path must set autoStartTime to Date.now() if still zero after restore",
  );
});
