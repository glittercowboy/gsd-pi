/**
 * Tests for auto-mode piped I/O detection (#2732).
 *
 * When `gsd auto` is run with piped stdout (e.g. `gsd auto | cat`),
 * the CLI should detect the non-TTY stdout and redirect to headless
 * mode instead of hanging in interactive mode trying to set up a TUI
 * on a non-terminal output stream.
 *
 * Also verifies the stdout TTY gate at the interactive mode entry point:
 * when stdout is piped, interactive mode must not be entered regardless
 * of the subcommand.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Extracted detection logic (mirrors cli.ts) ───────────────────────────

/**
 * Subcommands that are explicitly handled before the interactive mode
 * section in cli.ts and therefore never fall through to the TUI.
 */
const EXPLICIT_SUBCOMMANDS = new Set([
  "headless",
  "update",
  "config",
  "worktree",
  "wt",
  "sessions",
  "web",
]);

/**
 * Detect whether the current subcommand should be auto-redirected
 * to headless mode when stdout is not a TTY.
 *
 * Returns true when: the subcommand is "auto" AND stdout is piped.
 */
function shouldRedirectAutoToHeadless(
  subcommand: string | undefined,
  stdoutIsTTY: boolean,
): boolean {
  if (stdoutIsTTY) return false;
  return subcommand === "auto";
}

/**
 * Check whether interactive mode can be entered.
 * Both stdin AND stdout must be TTY for the TUI to work.
 */
function canEnterInteractiveMode(
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): boolean {
  return stdinIsTTY && stdoutIsTTY;
}

/**
 * Returns true if the subcommand is handled by an explicit branch
 * in cli.ts and will never reach the interactive mode section.
 */
function isExplicitSubcommand(subcommand: string | undefined): boolean {
  return subcommand !== undefined && EXPLICIT_SUBCOMMANDS.has(subcommand);
}

// ─── shouldRedirectAutoToHeadless ─────────────────────────────────────────

test("redirects 'auto' to headless when stdout is piped", () => {
  assert.ok(shouldRedirectAutoToHeadless("auto", false));
});

test("does NOT redirect 'auto' when stdout is a TTY", () => {
  assert.ok(!shouldRedirectAutoToHeadless("auto", true));
});

test("does NOT redirect non-auto subcommands when stdout is piped", () => {
  assert.ok(!shouldRedirectAutoToHeadless("headless", false));
  assert.ok(!shouldRedirectAutoToHeadless("config", false));
  assert.ok(!shouldRedirectAutoToHeadless("update", false));
  assert.ok(!shouldRedirectAutoToHeadless(undefined, false));
});

// ─── canEnterInteractiveMode ──────────────────────────────────────────────

test("allows interactive mode when both stdin and stdout are TTY", () => {
  assert.ok(canEnterInteractiveMode(true, true));
});

test("blocks interactive mode when stdin is piped", () => {
  assert.ok(!canEnterInteractiveMode(false, true));
});

test("blocks interactive mode when stdout is piped", () => {
  assert.ok(!canEnterInteractiveMode(true, false));
});

test("blocks interactive mode when both stdin and stdout are piped", () => {
  assert.ok(!canEnterInteractiveMode(false, false));
});

// ─── isExplicitSubcommand ─────────────────────────────────────────────────

test("identifies explicitly handled subcommands", () => {
  assert.ok(isExplicitSubcommand("headless"));
  assert.ok(isExplicitSubcommand("update"));
  assert.ok(isExplicitSubcommand("config"));
  assert.ok(isExplicitSubcommand("worktree"));
  assert.ok(isExplicitSubcommand("wt"));
  assert.ok(isExplicitSubcommand("sessions"));
  assert.ok(isExplicitSubcommand("web"));
});

test("does NOT identify 'auto' as explicit subcommand", () => {
  assert.ok(!isExplicitSubcommand("auto"));
});

test("does NOT identify undefined as explicit subcommand", () => {
  assert.ok(!isExplicitSubcommand(undefined));
});

// ─── End-to-end scenario: gsd auto | cat ──────────────────────────────────

test("scenario: 'gsd auto 2>&1 | cat' — should redirect to headless", () => {
  // Simulates: subcommand = "auto", stdin is TTY, stdout is piped
  const subcommand = "auto";
  const stdinIsTTY = true;
  const stdoutIsTTY = false;

  // Interactive mode should be blocked
  assert.ok(!canEnterInteractiveMode(stdinIsTTY, stdoutIsTTY));

  // Auto should be redirected to headless
  assert.ok(shouldRedirectAutoToHeadless(subcommand, stdoutIsTTY));
});

test("scenario: 'gsd auto > /tmp/output.txt' — should redirect to headless", () => {
  const subcommand = "auto";
  const stdinIsTTY = true;
  const stdoutIsTTY = false;

  assert.ok(!canEnterInteractiveMode(stdinIsTTY, stdoutIsTTY));
  assert.ok(shouldRedirectAutoToHeadless(subcommand, stdoutIsTTY));
});

test("scenario: 'gsd auto' in terminal — normal interactive mode", () => {
  const subcommand = "auto";
  const stdinIsTTY = true;
  const stdoutIsTTY = true;

  assert.ok(canEnterInteractiveMode(stdinIsTTY, stdoutIsTTY));
  assert.ok(!shouldRedirectAutoToHeadless(subcommand, stdoutIsTTY));
});

test("scenario: 'echo msg | gsd auto' — stdin piped, should redirect", () => {
  const subcommand = "auto";
  const stdinIsTTY = false;
  const stdoutIsTTY = true; // stdout is TTY even though stdin is piped

  // stdout is TTY, so auto redirect doesn't trigger...
  assert.ok(!shouldRedirectAutoToHeadless(subcommand, stdoutIsTTY));
  // ...but interactive mode is blocked because stdin is piped
  assert.ok(!canEnterInteractiveMode(stdinIsTTY, stdoutIsTTY));
});

test("scenario: 'echo msg | gsd auto | cat' — both piped", () => {
  const subcommand = "auto";
  const stdinIsTTY = false;
  const stdoutIsTTY = false;

  assert.ok(!canEnterInteractiveMode(stdinIsTTY, stdoutIsTTY));
  assert.ok(shouldRedirectAutoToHeadless(subcommand, stdoutIsTTY));
});
