/**
 * Tests for Telegram command handling.
 *
 * Framework: node:test + node:assert/strict (CONTRIBUTING.md rules)
 *
 * Run:
 *   npm run test:unit
 *
 * Or directly after compiling:
 *   node scripts/compile-tests.mjs && \
 *   node --import ./scripts/dist-test-resolve.mjs \
 *        --experimental-test-isolation=process \
 *        --test "dist-test/src/resources/extensions/remote-questions/tests/*.test.js"
 *
 * Covers:
 *   - Command detection: messages starting with / are commands
 *   - /help returns a list of all commands
 *   - /status returns current GSD state
 *   - /pause writes a stop directive
 *   - Unknown commands return a helpful error + /help hint
 *   - Non-commands are NOT treated as commands (regression guard)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isCommand, handleCommand, type CommandSender } from "../commands.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-cmd-test-"));
  // Create minimal .gsd directory structure
  mkdirSync(join(dir, ".gsd", "activity"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true });
  return dir;
}

function makeCapturingSender(): { sender: CommandSender; messages: string[] } {
  const messages: string[] = [];
  const sender: CommandSender = {
    async send(text: string) {
      messages.push(text);
    },
  };
  return { sender, messages };
}

// ─── isCommand ────────────────────────────────────────────────────────────────

test("isCommand: messages starting with / are commands", () => {
  assert.equal(isCommand("/help"), true);
  assert.equal(isCommand("/status"), true);
  assert.equal(isCommand("/pause"), true);
  assert.equal(isCommand("/resume"), true);
  assert.equal(isCommand("/log 5"), true);
  assert.equal(isCommand("/unknown_cmd"), true);
});

test("isCommand: bare slash without word character is not a command", () => {
  assert.equal(isCommand("/ "), false);
  assert.equal(isCommand("/"), false);
});

test("isCommand (regression guard): regular messages are NOT commands", () => {
  assert.equal(isCommand("hello"), false);
  assert.equal(isCommand("yes"), false);
  assert.equal(isCommand("1"), false);
  assert.equal(isCommand("A"), false);
  assert.equal(isCommand(""), false);
  assert.equal(isCommand("http://example.com"), false);
});

// ─── /help ────────────────────────────────────────────────────────────────────

test("/help returns a reply listing all expected commands", async (t) => {
  const dir = makeBasePath();
  const { sender, messages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await handleCommand("/help", sender, dir);

  assert.equal(messages.length, 1);
  const reply = messages[0];
  // Project prefix must be present
  assert.ok(reply.startsWith("📁"), `Expected project prefix, got: ${reply}`);
  // All supported commands must be mentioned
  for (const cmd of ["/status", "/progress", "/budget", "/pause", "/resume", "/log", "/help"]) {
    assert.ok(reply.includes(cmd), `Expected /help to mention ${cmd}`);
  }
});

// ─── /status ─────────────────────────────────────────────────────────────────

test("/status returns GSD state text (idle when no active session)", async (t) => {
  const dir = makeBasePath();
  const { sender, messages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await handleCommand("/status", sender, dir);

  assert.equal(messages.length, 1);
  const reply = messages[0];
  assert.ok(reply.length > 0, "Expected non-empty status reply");
  // Project prefix must be present
  assert.ok(reply.startsWith("📁"), `Expected project prefix, got: ${reply}`);
  // Should contain some state indication
  assert.ok(
    reply.toLowerCase().includes("state") || reply.toLowerCase().includes("gsd"),
    `Expected status reply to mention state or GSD, got: ${reply}`,
  );
});

test("/status reads paused-session.json when present", async (t) => {
  const dir = makeBasePath();
  const { sender, messages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Write a fake paused-session.json
  const pausedMeta = {
    milestoneId: "M001",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    pausedAt: "2026-01-01T12:00:00.000Z",
  };
  writeFileSync(
    join(dir, ".gsd", "runtime", "paused-session.json"),
    JSON.stringify(pausedMeta),
    "utf-8",
  );

  await handleCommand("/status", sender, dir);

  assert.equal(messages.length, 1);
  const reply = messages[0];
  // Project prefix must be present
  assert.ok(reply.startsWith("📁"), `Expected project prefix, got: ${reply}`);
  assert.ok(reply.includes("M001"), `Expected milestone ID in status, got: ${reply}`);
});

// ─── /pause ──────────────────────────────────────────────────────────────────

test("/pause writes a stop capture to CAPTURES.md", async (t) => {
  const dir = makeBasePath();
  const { sender, messages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await handleCommand("/pause", sender, dir);

  assert.equal(messages.length, 1);
  const reply = messages[0];

  // Project prefix must be present
  assert.ok(reply.startsWith("📁"), `Expected project prefix, got: ${reply}`);
  // Reply should indicate success
  assert.ok(
    reply.toLowerCase().includes("pause") || reply.toLowerCase().includes("directive"),
    `Expected pause confirmation, got: ${reply}`,
  );

  // CAPTURES.md should exist
  const capturesPath = join(dir, ".gsd", "CAPTURES.md");
  assert.ok(existsSync(capturesPath), "Expected CAPTURES.md to be created by /pause");

  // The file should contain a stop classification
  const { readFileSync } = await import("node:fs");
  const content = readFileSync(capturesPath, "utf-8");
  assert.ok(
    content.includes("**Classification:** stop"),
    `Expected stop classification in CAPTURES.md, got:\n${content}`,
  );
});

// ─── /resume ─────────────────────────────────────────────────────────────────

test("/resume reports no pending directives when CAPTURES.md is empty", async (t) => {
  const dir = makeBasePath();
  const { sender, messages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await handleCommand("/resume", sender, dir);

  assert.equal(messages.length, 1);
  const reply = messages[0];
  // Project prefix must be present
  assert.ok(reply.startsWith("📁"), `Expected project prefix, got: ${reply}`);
  // Should report that there are no directives to clear
  assert.ok(
    reply.toLowerCase().includes("no pending") || reply.toLowerCase().includes("not paused"),
    `Expected "no pending directives" message, got: ${reply}`,
  );
});

// ─── Unknown command ──────────────────────────────────────────────────────────

test("unknown command returns helpful error message with /help hint", async (t) => {
  const dir = makeBasePath();
  const { sender, messages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await handleCommand("/invalid_command", sender, dir);

  assert.equal(messages.length, 1);
  const reply = messages[0];
  // Project prefix must be present
  assert.ok(reply.startsWith("📁"), `Expected project prefix, got: ${reply}`);
  assert.ok(reply.includes("/invalid_command"), "Expected unknown command name in reply");
  assert.ok(reply.includes("/help"), "Expected /help hint in unknown command reply");
});

test("unknown command reply differs from /help output", async (t) => {
  const dir = makeBasePath();
  const { sender: helpSender, messages: helpMessages } = makeCapturingSender();
  const { sender: unknownSender, messages: unknownMessages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await handleCommand("/help", helpSender, dir);
  await handleCommand("/notacommand", unknownSender, dir);

  assert.notEqual(
    helpMessages[0],
    unknownMessages[0],
    "Unknown command reply should differ from /help output",
  );
});

// ─── /log ─────────────────────────────────────────────────────────────────────

test("/log returns a message (empty or with entries)", async (t) => {
  const dir = makeBasePath();
  const { sender, messages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await handleCommand("/log", sender, dir);

  assert.equal(messages.length, 1);
  assert.ok(messages[0].length > 0, "Expected non-empty /log reply");
});

test("/log 3 limits output to last 3 entries", async (t) => {
  const dir = makeBasePath();
  const { sender, messages } = makeCapturingSender();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Write 5 fake activity log files
  const activityDir = join(dir, ".gsd", "activity");
  for (let i = 1; i <= 5; i++) {
    writeFileSync(
      join(activityDir, `00${i}-execute-task-M001-S01-T0${i}.jsonl`),
      '{"type":"toolCall","name":"bash"}\n',
      "utf-8",
    );
  }

  await handleCommand("/log 3", sender, dir);

  assert.equal(messages.length, 1);
  const reply = messages[0];
  // Should mention "3" entries (the requested count)
  assert.ok(reply.includes("3"), `Expected 3 entries in /log 3 reply, got: ${reply}`);
  // Should not list all 5
  const entryMatches = (reply.match(/#\d+/g) ?? []).length;
  assert.ok(entryMatches <= 3, `Expected at most 3 entries, found ${entryMatches}`);
});
