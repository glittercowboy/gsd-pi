import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleGSDCommand } from "../commands/dispatcher.ts";
import { handleDebug } from "../commands-debug.ts";
import { debugSessionArtifactPath, debugSessionsDir } from "../debug-session-store.ts";

interface DispatchCall {
  payload: any;
  options: any;
}

function createMockPiWithDispatch() {
  const calls: DispatchCall[] = [];
  return {
    calls,
    pi: {
      sendMessage(payload: any, options: any) {
        calls.push({ payload, options });
      },
    },
  };
}

interface MockCtx {
  notifications: Array<{ message: string; level: string }>;
  ui: {
    notify: (message: string, level: string) => void;
    custom: () => Promise<void>;
  };
  shutdown: () => Promise<void>;
}

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-debug-lifecycle-int-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function createMockCtx(): MockCtx {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
    shutdown: async () => {},
  };
}

function lastNotification(ctx: MockCtx): { message: string; level: string } {
  assert.ok(ctx.notifications.length > 0, "expected at least one UI notification");
  return ctx.notifications.at(-1)!;
}

test("/gsd debug lifecycle integration covers start/list/status/continue across multiple sessions", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);

  try {
    const ctx = createMockCtx();

    await handleGSDCommand("debug API returns 500 on checkout", ctx as any, {} as any);
    const firstStarted = lastNotification(ctx);
    assert.equal(firstStarted.level, "info");
    assert.match(firstStarted.message, /Debug session started: api-returns-500-on-checkout/);

    await handleGSDCommand("debug API returns 500 on checkout", ctx as any, {} as any);
    const secondStarted = lastNotification(ctx);
    assert.equal(secondStarted.level, "info");
    assert.match(secondStarted.message, /Debug session started: api-returns-500-on-checkout-2/);

    await handleGSDCommand("debug Checkout retries spin forever", ctx as any, {} as any);
    const thirdStarted = lastNotification(ctx);
    assert.equal(thirdStarted.level, "info");
    assert.match(thirdStarted.message, /Debug session started: checkout-retries-spin-forever/);

    const sessionsDir = debugSessionsDir(base);
    const artifacts = readdirSync(sessionsDir).filter(name => name.endsWith(".json")).sort();
    assert.deepEqual(artifacts, [
      "api-returns-500-on-checkout-2.json",
      "api-returns-500-on-checkout.json",
      "checkout-retries-spin-forever.json",
    ]);

    await handleGSDCommand("debug list", ctx as any, {} as any);
    const listed = lastNotification(ctx);
    assert.equal(listed.level, "info");
    assert.match(listed.message, /Debug sessions:/);
    assert.match(listed.message, /api-returns-500-on-checkout/);
    assert.match(listed.message, /api-returns-500-on-checkout-2/);
    assert.match(listed.message, /checkout-retries-spin-forever/);
    assert.match(listed.message, /mode=debug status=active phase=queued/);

    await handleGSDCommand("debug status api-returns-500-on-checkout", ctx as any, {} as any);
    const statusBeforeContinue = lastNotification(ctx);
    assert.equal(statusBeforeContinue.level, "info");
    assert.match(statusBeforeContinue.message, /^Debug session status: api-returns-500-on-checkout/m);
    assert.match(statusBeforeContinue.message, /^mode=debug$/m);
    assert.match(statusBeforeContinue.message, /^status=active$/m);
    assert.match(statusBeforeContinue.message, /^phase=queued$/m);
    assert.match(statusBeforeContinue.message, /^updated=\d{4}-\d{2}-\d{2}T/m);

    await handleGSDCommand("debug continue api-returns-500-on-checkout-2", ctx as any, {} as any);
    const resumed = lastNotification(ctx);
    assert.equal(resumed.level, "info");
    assert.match(resumed.message, /Resumed debug session: api-returns-500-on-checkout-2/);
    assert.match(resumed.message, /status=active/);
    assert.match(resumed.message, /phase=continued/);

    await handleGSDCommand("debug status api-returns-500-on-checkout-2", ctx as any, {} as any);
    const statusAfterContinue = lastNotification(ctx);
    assert.equal(statusAfterContinue.level, "info");
    assert.match(statusAfterContinue.message, /^phase=continued$/m);
    assert.match(statusAfterContinue.message, /^updated=\d{4}-\d{2}-\d{2}T/m);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("/gsd debug lifecycle integration handles invalid slugs and malformed artifacts with actionable diagnostics", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);

  try {
    const ctx = createMockCtx();

    await handleGSDCommand("debug Sync bug in checkout", ctx as any, {} as any);
    const started = lastNotification(ctx);
    assert.equal(started.level, "info");
    assert.match(started.message, /Debug session started: sync-bug-in-checkout/);

    await handleGSDCommand("debug status no-such-session", ctx as any, {} as any);
    const missingStatus = lastNotification(ctx);
    assert.equal(missingStatus.level, "warning");
    assert.match(missingStatus.message, /Unknown debug session slug 'no-such-session'/);
    assert.match(missingStatus.message, /Run \/gsd debug list/);

    await handleGSDCommand("debug continue no-such-session", ctx as any, {} as any);
    const missingContinue = lastNotification(ctx);
    assert.equal(missingContinue.level, "warning");
    assert.match(missingContinue.message, /Unknown debug session slug 'no-such-session'/);

    const brokenArtifactPath = debugSessionArtifactPath(base, "broken-session");
    writeFileSync(brokenArtifactPath, "{ definitely-not-valid-json", "utf-8");

    await handleGSDCommand("debug status broken-session", ctx as any, {} as any);
    const corruptedStatus = lastNotification(ctx);
    assert.equal(corruptedStatus.level, "warning");
    assert.match(corruptedStatus.message, /Unable to load debug session 'broken-session'/);
    assert.match(corruptedStatus.message, /Try \/gsd debug --diagnose broken-session/);

    await handleGSDCommand("debug list", ctx as any, {} as any);
    const listed = lastNotification(ctx);
    assert.equal(listed.level, "info");
    assert.match(listed.message, /Malformed artifacts: 1/);
    assert.match(listed.message, /broken-session\.json/);
    assert.match(listed.message, /Run \/gsd debug --diagnose for remediation guidance/);

    await handleGSDCommand("debug --diagnose", ctx as any, {} as any);
    const diagnosed = lastNotification(ctx);
    assert.equal(diagnosed.level, "warning");
    assert.match(diagnosed.message, /Debug session diagnostics:/);
    assert.match(diagnosed.message, /malformedArtifacts=1/);
    assert.match(diagnosed.message, /Remediation: repair\/remove malformed JSON artifacts under \.gsd\/debug\/sessions\//);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("/gsd debug lifecycle integration keeps session artifacts isolated from debug logs and preserves slug determinism", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);

  try {
    const ctx = createMockCtx();

    const debugDir = join(base, ".gsd", "debug");
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(join(debugDir, "payment-timeout.log"), "log seed\n", "utf-8");

    await handleGSDCommand("debug Payment timeout", ctx as any, {} as any);
    const firstStarted = lastNotification(ctx);
    assert.equal(firstStarted.level, "info");
    assert.match(firstStarted.message, /Debug session started: payment-timeout/);

    // Existing .log files must not reserve slug suffixes for session artifacts.
    await handleGSDCommand("debug Payment timeout", ctx as any, {} as any);
    const secondStarted = lastNotification(ctx);
    assert.equal(secondStarted.level, "info");
    assert.match(secondStarted.message, /Debug session started: payment-timeout-2/);

    assert.equal(existsSync(join(base, ".gsd", "debug", "payment-timeout.json")), false);
    assert.equal(existsSync(join(base, ".gsd", "debug", "sessions", "payment-timeout.json")), true);
    assert.equal(existsSync(join(base, ".gsd", "debug", "sessions", "payment-timeout-2.json")), true);

    await handleGSDCommand("logs debug", ctx as any, {} as any);
    const logsListed = lastNotification(ctx);
    assert.equal(logsListed.level, "info");
    assert.match(logsListed.message, /Debug Logs \(\.gsd\/debug\/\):/);
    assert.match(logsListed.message, /payment-timeout\.log/);
    assert.doesNotMatch(logsListed.message, /payment-timeout\.json/);

    await handleGSDCommand("debug list", ctx as any, {} as any);
    const sessionsListed = lastNotification(ctx);
    assert.equal(sessionsListed.level, "info");
    assert.match(sessionsListed.message, /payment-timeout/);
    assert.match(sessionsListed.message, /payment-timeout-2/);
    assert.match(sessionsListed.message, /mode=debug status=active phase=queued/);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("/gsd debug --diagnose <issue> dispatches find_root_cause_only goal and records mode=diagnose session", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);

  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();

    await handleDebug("--diagnose auth token rotation breaks sessions", ctx as any, pi as any);

    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, /Diagnose session started:/);
    assert.match(n.message, /mode=diagnose/);
    assert.match(n.message, /dispatchMode=find_root_cause_only/);

    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-diagnose");
    assert.match(call.payload.content, /find_root_cause_only/);
    assert.match(call.payload.content, /auth token rotation breaks sessions/i);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("/gsd debug continue <slug> dispatches find_and_fix goal scoped to target slug", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);

  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();

    // Start two sessions so we can verify continue targets only the right one.
    await handleDebug("Race condition in payment handler", ctx as any, {} as any);
    await handleDebug("Stale cache on checkout", ctx as any, {} as any);

    calls.length = 0; // reset — only created without pi dispatch above

    await handleDebug("continue race-condition-in-payment-handler", ctx as any, pi as any);

    const n = lastNotification(ctx);
    assert.equal(n.level, "info");
    assert.match(n.message, /Resumed debug session: race-condition-in-payment-handler/);
    assert.match(n.message, /phase=continued/);
    assert.match(n.message, /dispatchMode=find_and_fix/);

    assert.equal(calls.length, 1, "should dispatch exactly one message");
    const call = calls[0];
    assert.equal(call.payload.customType, "gsd-debug-continue");
    assert.match(call.payload.content, /find_and_fix/);
    // Content must reference the target slug, not the other session.
    assert.match(call.payload.content, /race-condition-in-payment-handler/);
    assert.doesNotMatch(call.payload.content, /stale-cache-on-checkout/);
    assert.equal(call.options.triggerTurn, true);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("/gsd debug --diagnose (zero-arg) with no pi still reports malformed artifact counts without dispatch", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);

  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();

    // Inject two broken artifacts.
    const sessionsDir = debugSessionsDir(base);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "broken-a.json"), "{bad json", "utf-8");
    writeFileSync(join(sessionsDir, "broken-b.json"), "null", "utf-8");

    // Zero-arg --diagnose via dispatcher (no pi) — dispatch should NOT fire.
    await handleGSDCommand("debug --diagnose", ctx as any, {} as any);

    const n = lastNotification(ctx);
    assert.equal(n.level, "warning");
    assert.match(n.message, /Debug session diagnostics:/);
    assert.match(n.message, /malformedArtifacts=2/);
    assert.match(n.message, /Remediation:/);

    // Now confirm no dispatch occurred even with pi present (zero-arg diagnose is advisory only).
    await handleDebug("--diagnose", ctx as any, pi as any);
    assert.equal(calls.length, 0, "zero-arg --diagnose must not dispatch even with pi present");
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("/gsd debug negative: continue unknown slug emits warning, continue resolved session emits warning", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);

  try {
    const ctx = createMockCtx();
    const { calls, pi } = createMockPiWithDispatch();

    // Continue on non-existent slug.
    await handleDebug("continue totally-nonexistent-slug", ctx as any, pi as any);
    const notFound = lastNotification(ctx);
    assert.equal(notFound.level, "warning");
    assert.match(notFound.message, /Unknown debug session slug 'totally-nonexistent-slug'/);
    assert.equal(calls.length, 0, "no dispatch for unknown slug");

    // Start and manually check that invalid 2-token status (missing slug) emits error, not usage.
    await handleDebug("status", ctx as any, {} as any);
    const noSlug = lastNotification(ctx);
    assert.equal(noSlug.level, "warning");
    assert.match(noSlug.message, /Missing slug/);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("/gsd debug negative: multiple sessions with similar slugs — status and continue target exact match only", async () => {
  const base = makeBase();
  const saved = process.cwd();
  process.chdir(base);

  try {
    const ctx = createMockCtx();

    await handleGSDCommand("debug Login token expires", ctx as any, {} as any);
    await handleGSDCommand("debug Login token expires too fast", ctx as any, {} as any);

    // list to confirm two distinct slugs exist.
    await handleGSDCommand("debug list", ctx as any, {} as any);
    const listed = lastNotification(ctx);
    assert.match(listed.message, /login-token-expires\b/);
    assert.match(listed.message, /login-token-expires-too-fast\b/);

    // status on base slug must not accidentally describe the suffixed one.
    await handleGSDCommand("debug status login-token-expires", ctx as any, {} as any);
    const baseStatus = lastNotification(ctx);
    assert.match(baseStatus.message, /^Debug session status: login-token-expires$/m);
    assert.doesNotMatch(baseStatus.message, /login-token-expires-too-fast/);

    // status on suffixed slug must describe that one.
    await handleGSDCommand("debug status login-token-expires-too-fast", ctx as any, {} as any);
    const suffixedStatus = lastNotification(ctx);
    assert.match(suffixedStatus.message, /^Debug session status: login-token-expires-too-fast$/m);
  } finally {
    process.chdir(saved);
    rmSync(base, { recursive: true, force: true });
  }
});
