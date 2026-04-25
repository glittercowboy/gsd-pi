import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleDebug, parseDebugCommand } from "../commands-debug.ts";
import { createDebugSession, debugSessionArtifactPath, updateDebugSession } from "../debug-session-store.ts";
import { loadPrompt } from "../prompt-loader.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-debug-command-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function createMockCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
}

describe("parseDebugCommand", () => {
  test("supports strict subcommands and issue-start fallback", () => {
    assert.deepEqual(parseDebugCommand("list"), { type: "list" });
    assert.deepEqual(parseDebugCommand("status auth-flake"), { type: "status", slug: "auth-flake" });
    assert.deepEqual(parseDebugCommand("continue auth-flake"), { type: "continue", slug: "auth-flake" });
    assert.deepEqual(parseDebugCommand("--diagnose"), { type: "diagnose" });
  });

  test("treats ambiguous reserved-word phrases as issue text unless strict syntax matches", () => {
    assert.deepEqual(parseDebugCommand("status login fails on safari"), {
      type: "issue-start",
      issue: "status login fails on safari",
    });
    assert.deepEqual(parseDebugCommand("continue flaky checkout flow"), {
      type: "issue-start",
      issue: "continue flaky checkout flow",
    });
    assert.deepEqual(parseDebugCommand("list broken retry behavior"), {
      type: "issue-start",
      issue: "list broken retry behavior",
    });
  });

  test("returns actionable errors for malformed subcommand invocations", () => {
    assert.equal(parseDebugCommand("status").type, "error");
    assert.equal(parseDebugCommand("continue").type, "error");
    assert.equal(parseDebugCommand("--diagnose not/a-slug").type, "error");
    assert.equal(parseDebugCommand("--wat").type, "error");
  });

  test("routes multi-token --diagnose to diagnose-issue with root-cause-only intent", () => {
    assert.deepEqual(parseDebugCommand("--diagnose login fails on safari"), {
      type: "diagnose-issue",
      issue: "login fails on safari",
    });
    assert.deepEqual(parseDebugCommand("--diagnose flaky checkout flow"), {
      type: "diagnose-issue",
      issue: "flaky checkout flow",
    });
    assert.deepEqual(parseDebugCommand("--diagnose status is returning 500"), {
      type: "diagnose-issue",
      issue: "status is returning 500",
    });
  });

  test("--diagnose with valid slug remains slug-targeted diagnose", () => {
    assert.deepEqual(parseDebugCommand("--diagnose auth-flake"), {
      type: "diagnose",
      slug: "auth-flake",
    });
    assert.deepEqual(parseDebugCommand("--diagnose ci-flake-2"), {
      type: "diagnose",
      slug: "ci-flake-2",
    });
  });

  test("--diagnose with no args returns store-health diagnose", () => {
    assert.deepEqual(parseDebugCommand("--diagnose"), { type: "diagnose" });
  });

  test("single invalid slug token after --diagnose is an error not issue-start", () => {
    assert.equal(parseDebugCommand("--diagnose not/a-slug").type, "error");
    assert.equal(parseDebugCommand("--diagnose UPPERCASE").type, "error");
    assert.equal(parseDebugCommand("--diagnose has space").type, "diagnose-issue");
  });

  test("issue text starting with reserved words falls through to issue-start", () => {
    assert.deepEqual(parseDebugCommand("list broken retry behavior"), {
      type: "issue-start",
      issue: "list broken retry behavior",
    });
    assert.deepEqual(parseDebugCommand("status login is flaky"), {
      type: "issue-start",
      issue: "status login is flaky",
    });
    assert.deepEqual(parseDebugCommand("continue flaky checkout flow"), {
      type: "issue-start",
      issue: "continue flaky checkout flow",
    });
  });
});

describe("handleDebug lifecycle", () => {
  test("creates new session and persists mode/phase metadata", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const saved = process.cwd();
    process.chdir(base);

    try {
      await handleDebug("Login fails on Safari", ctx as any);
      assert.equal(ctx.notifications.length, 1);
      const note = ctx.notifications[0];
      assert.equal(note.level, "info");
      assert.match(note.message, /Debug session started: login-fails-on-safari/);
      assert.match(note.message, /mode=debug/);
      assert.match(note.message, /phase=queued/);

      const artifact = debugSessionArtifactPath(base, "login-fails-on-safari");
      const statusCtx = createMockCtx();
      await handleDebug("status login-fails-on-safari", statusCtx as any);
      assert.match(statusCtx.notifications[0].message, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(statusCtx.notifications[0].message, /status=active/);
      assert.match(statusCtx.notifications[0].message, /phase=queued/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("list shows persisted session summaries with lifecycle metadata", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Auth timeout", createdAt: 10 });
      createDebugSession(base, { issue: "Billing webhook", createdAt: 20 });

      await handleDebug("list", ctx as any);
      assert.equal(ctx.notifications.length, 1);
      const note = ctx.notifications[0].message;
      assert.match(note, /Debug sessions:/);
      assert.match(note, /mode=debug status=active phase=queued/);
      assert.match(note, /auth-timeout/);
      assert.match(note, /billing-webhook/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue updates session lifecycle state", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "CI flake", createdAt: 10, status: "paused", phase: "blocked" });

      await handleDebug("continue ci-flake", ctx as any);
      assert.equal(ctx.notifications.length, 1);
      const note = ctx.notifications[0].message;
      assert.match(note, /Resumed debug session: ci-flake/);
      assert.match(note, /status=active/);
      assert.match(note, /phase=continued/);

      const statusCtx = createMockCtx();
      await handleDebug("status ci-flake", statusCtx as any);
      assert.match(statusCtx.notifications[0].message, /status=active/);
      assert.match(statusCtx.notifications[0].message, /phase=continued/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("unknown slug and missing slug paths provide actionable warnings", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);

    try {
      const missingSlugCtx = createMockCtx();
      await handleDebug("status", missingSlugCtx as any);
      assert.equal(missingSlugCtx.notifications[0].level, "warning");
      assert.match(missingSlugCtx.notifications[0].message, /Missing slug/);

      const unknownSlugCtx = createMockCtx();
      await handleDebug("status no-such-session", unknownSlugCtx as any);
      assert.equal(unknownSlugCtx.notifications[0].level, "warning");
      assert.match(unknownSlugCtx.notifications[0].message, /Unknown debug session slug/);
      assert.match(unknownSlugCtx.notifications[0].message, /\/gsd debug list/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("detects malformed artifacts and surfaces remediation in list/diagnose", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Healthy issue", createdAt: 1 });
      writeFileSync(join(base, ".gsd", "debug", "sessions", "broken.json"), "{ nope", "utf-8");

      const listCtx = createMockCtx();
      await handleDebug("list", listCtx as any);
      assert.match(listCtx.notifications[0].message, /Malformed artifacts: 1/);
      assert.match(listCtx.notifications[0].message, /Run \/gsd debug --diagnose/);

      const diagnoseCtx = createMockCtx();
      await handleDebug("--diagnose", diagnoseCtx as any);
      assert.equal(diagnoseCtx.notifications[0].level, "warning");
      assert.match(diagnoseCtx.notifications[0].message, /Malformed artifacts/);
      assert.match(diagnoseCtx.notifications[0].message, /Remediation:/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("reserved-word boundary condition still creates session when syntax is not strict", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);

    try {
      const ctx = createMockCtx();
      await handleDebug("status login is flaky on prod", ctx as any);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Debug session started:/);

      const slug = "status-login-is-flaky-on-prod";
      const statusCtx = createMockCtx();
      await handleDebug(`status ${slug}`, statusCtx as any);
      assert.equal(statusCtx.notifications[0].level, "info");
      assert.match(statusCtx.notifications[0].message, /mode=debug/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("--diagnose <issue text> creates diagnose session with mode=diagnose and find_root_cause_only dispatch", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const saved = process.cwd();
    process.chdir(base);

    try {
      await handleDebug("--diagnose login fails on safari", ctx as any);
      assert.equal(ctx.notifications.length, 1);
      const note = ctx.notifications[0];
      assert.equal(note.level, "info");
      assert.match(note.message, /Diagnose session started: login-fails-on-safari/);
      assert.match(note.message, /mode=diagnose/);
      assert.match(note.message, /dispatchMode=find_root_cause_only/);
      assert.match(note.message, /phase=queued/);
      assert.match(note.message, /status=active/);

      const statusCtx = createMockCtx();
      await handleDebug("status login-fails-on-safari", statusCtx as any);
      assert.match(statusCtx.notifications[0].message, /mode=diagnose/);
      assert.match(statusCtx.notifications[0].message, /status=active/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("--diagnose <slug> targets existing session for targeted diagnose", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "CI flake on main", createdAt: 1 });

      const ctx = createMockCtx();
      await handleDebug("--diagnose ci-flake-on-main", ctx as any);
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Diagnose session: ci-flake-on-main/);
      assert.match(ctx.notifications[0].message, /status=active/);
      assert.match(ctx.notifications[0].message, /malformedArtifactsInStore=0/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("--diagnose with unknown slug emits actionable warning", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);

    try {
      const ctx = createMockCtx();
      await handleDebug("--diagnose no-such-session", ctx as any);
      assert.equal(ctx.notifications[0].level, "warning");
      assert.match(ctx.notifications[0].message, /not found/);
      assert.match(ctx.notifications[0].message, /\/gsd debug list/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("diagnose-issue tolerates malformed artifact in store and still creates session", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Healthy issue", createdAt: 1 });
      writeFileSync(join(base, ".gsd", "debug", "sessions", "broken.json"), "{ nope", "utf-8");

      const ctx = createMockCtx();
      await handleDebug("--diagnose billing webhook is dropping events", ctx as any);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Diagnose session started:/);
      assert.match(ctx.notifications[0].message, /mode=diagnose/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue blocks on resolved session with actionable warning", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Done issue", createdAt: 1, status: "resolved", phase: "complete" });

      const ctx = createMockCtx();
      await handleDebug("continue done-issue", ctx as any);
      assert.equal(ctx.notifications[0].level, "warning");
      assert.match(ctx.notifications[0].message, /resolved/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("unknown flag returns error without silently routing to wrong path", async () => {
    const base = makeBase();
    const saved = process.cwd();
    process.chdir(base);

    try {
      const ctx = createMockCtx();
      await handleDebug("--unknown-flag some text", ctx as any);
      assert.equal(ctx.notifications[0].level, "warning");
      assert.match(ctx.notifications[0].message, /Unknown debug flag/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("diagnose-issue dispatches find_root_cause_only goal with slug and issue in payload", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      await handleDebug("--diagnose memory leak in worker pool", ctx as any, mockPi as any);
      // Session creation notification still fires
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /dispatchMode=find_root_cause_only/);

      // Exactly one dispatch was emitted
      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.equal(dispatch.customType, "gsd-debug-diagnose");
      assert.equal(dispatch.display, false);
      // Goal line must carry root-cause-only value
      assert.match(dispatch.content, /`find_root_cause_only`/);
      // do-NOT-fix instruction must be present
      assert.match(dispatch.content, /do \*\*NOT\*\* apply code changes/);
      assert.match(dispatch.content, /memory-leak-in-worker-pool/);
      assert.match(dispatch.content, /memory leak in worker pool/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("diagnose-issue dispatch never advertises fix-application in payload", async () => {
    const base = makeBase();
    const dispatched: Array<{ content: string }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      await handleDebug("--diagnose flaky checkout flow after payment", createMockCtx() as any, mockPi as any);
      assert.equal(dispatched.length, 1);
      // Goal must be root-cause-only and include no-fix instruction
      assert.match(dispatched[0].content, /`find_root_cause_only`/);
      assert.match(dispatched[0].content, /do \*\*NOT\*\* apply code changes/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue dispatches find_and_fix goal scoped to the target slug only", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Auth timeout", createdAt: 10, status: "paused", phase: "blocked" });
      createDebugSession(base, { issue: "Billing webhook", createdAt: 20, status: "paused", phase: "blocked" });

      await handleDebug("continue auth-timeout", ctx as any, mockPi as any);
      // Notification shows dispatched mode
      assert.match(ctx.notifications[0].message, /dispatchMode=find_and_fix/);

      // Exactly one dispatch for the targeted slug
      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.equal(dispatch.customType, "gsd-debug-continue");
      assert.equal(dispatch.display, false);
      // Goal line must carry find-and-fix value
      assert.match(dispatch.content, /`find_and_fix`/);
      // Session slug is scoped correctly
      assert.match(dispatch.content, /auth-timeout/);
      // Must NOT mention the other session slug — no cross-session bleed
      assert.doesNotMatch(dispatch.content, /billing-webhook/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue dispatch failure surfaces warning without corrupting session state", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const mockPi = {
      sendMessage() {
        throw new Error("transport unavailable");
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "CI flake", createdAt: 10, status: "paused", phase: "blocked" });

      await handleDebug("continue ci-flake", ctx as any, mockPi as any);
      // Session update notification still fires first
      assert.match(ctx.notifications[0].message, /Resumed debug session/);

      // Dispatch error notification follows
      assert.equal(ctx.notifications.length, 2);
      assert.equal(ctx.notifications[1].level, "warning");
      assert.match(ctx.notifications[1].message, /Continue dispatch failed/);
      assert.match(ctx.notifications[1].message, /ci-flake/);

      // Session state was persisted despite dispatch failure
      const statusCtx = createMockCtx();
      await handleDebug("status ci-flake", statusCtx as any);
      assert.match(statusCtx.notifications[0].message, /status=active/);
      assert.match(statusCtx.notifications[0].message, /phase=continued/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("diagnose-issue dispatch failure surfaces warning without losing session", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const mockPi = {
      sendMessage() {
        throw new Error("dispatch error");
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      await handleDebug("--diagnose auth token expiry race condition", ctx as any, mockPi as any);
      // First notification: session created
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /Diagnose session started/);

      // Second notification: dispatch error
      assert.equal(ctx.notifications.length, 2);
      assert.equal(ctx.notifications[1].level, "warning");
      assert.match(ctx.notifications[1].message, /Diagnose dispatch failed/);
      assert.match(ctx.notifications[1].message, /auth-token-expiry-race-condition/);

      // Session artifact still exists
      const statusCtx = createMockCtx();
      await handleDebug("status auth-token-expiry-race-condition", statusCtx as any);
      assert.equal(statusCtx.notifications[0].level, "info");
      assert.match(statusCtx.notifications[0].message, /mode=diagnose/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue with unknown slug emits warning without dispatching", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<unknown> = [];
    const mockPi = {
      sendMessage(msg: unknown) { dispatched.push(msg); },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      await handleDebug("continue no-such-slug", ctx as any, mockPi as any);
      assert.equal(ctx.notifications[0].level, "warning");
      assert.match(ctx.notifications[0].message, /Unknown debug session slug/);
      assert.equal(dispatched.length, 0);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("diagnose-issue with issue text containing reserved command words dispatches correctly", async () => {
    const base = makeBase();
    const dispatched: Array<{ content: string }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      // 'status' and 'continue' are reserved words but in multi-token --diagnose context they become issue text
      await handleDebug("--diagnose status endpoint continues to return 500", createMockCtx() as any, mockPi as any);
      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].content, /find_root_cause_only/);
      assert.match(dispatched[0].content, /status-endpoint-continues-to-return-500/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue with checkpoint state dispatches debug-session-manager template with checkpoint context", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Auth timeout", createdAt: 10 });
      updateDebugSession(base, "auth-timeout", {
        checkpoint: {
          type: "human-verify",
          summary: "Confirm the network trace shows the right headers",
          awaitingResponse: true,
        },
      });

      await handleDebug("continue auth-timeout", ctx as any, mockPi as any);

      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.equal(dispatch.customType, "gsd-debug-continue");
      assert.equal(dispatch.display, false);
      // Uses debug-session-manager template (has structured return headers)
      assert.match(dispatch.content, /## CHECKPOINT REACHED/);
      // Checkpoint context is populated
      assert.match(dispatch.content, /## Active Checkpoint/);
      assert.match(dispatch.content, /type: human-verify/);
      assert.match(dispatch.content, /Confirm the network trace/);
      // Notification includes checkpoint hint
      assert.match(ctx.notifications[0].message, /checkpointType=human-verify/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue with TDD gate pending dispatches find_root_cause_only and does not dispatch find_and_fix", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Flaky auth", createdAt: 10 });
      updateDebugSession(base, "flaky-auth", {
        tddGate: { enabled: true, phase: "pending", testFile: "auth.test.ts" },
      });

      await handleDebug("continue flaky-auth", ctx as any, mockPi as any);

      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      // Active goal line must be find_root_cause_only — the template always lists both goal names in
      // its semantics section, so we check the specific "## Goal\n`…`" line, not the whole content.
      assert.match(dispatch.content, /## Goal\s+`find_root_cause_only`/);
      assert.doesNotMatch(dispatch.content, /## Goal\s+`find_and_fix`/);
      // TDD context appears
      assert.match(dispatch.content, /TDD Gate/);
      assert.match(dispatch.content, /phase: pending/);
      // Notification shows TDD hint
      assert.match(ctx.notifications[0].message, /tddPhase=pending/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue with TDD gate red dispatches find_and_fix and advances phase to green before dispatch", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Cache miss", createdAt: 10 });
      updateDebugSession(base, "cache-miss", {
        tddGate: {
          enabled: true,
          phase: "red",
          testFile: "cache.test.ts",
          testName: "returns stale entry",
          failureOutput: "Expected 'fresh' to equal 'stale'",
        },
      });

      await handleDebug("continue cache-miss", ctx as any, mockPi as any);

      // Dispatch uses find_and_fix
      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].content, /`find_and_fix`/);
      assert.match(dispatched[0].content, /TDD Gate/);
      assert.match(dispatched[0].content, /red → green/);
      // Session artifact must have tddGate.phase === "green" after dispatch
      const statusCtx = createMockCtx();
      await handleDebug("status cache-miss", statusCtx as any);
      // Load the artifact directly to verify phase was updated
      const { loadDebugSession: load } = await import("../debug-session-store.ts");
      const record = load(base, "cache-miss");
      assert.ok(record != null);
      assert.equal(record!.session.tddGate?.phase, "green");
      // Notification shows red→green transition
      assert.match(ctx.notifications[0].message, /tddPhase=red→green/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue without checkpoint or TDD gate uses debug-diagnose template with find_and_fix (regression guard)", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Login broken", createdAt: 10, status: "paused", phase: "blocked" });

      await handleDebug("continue login-broken", ctx as any, mockPi as any);

      assert.equal(dispatched.length, 1);
      const dispatch = dispatched[0];
      assert.equal(dispatch.customType, "gsd-debug-continue");
      // Plain continue uses debug-diagnose — no structured return headers like ## TDD CHECKPOINT
      assert.match(dispatch.content, /`find_and_fix`/);
      assert.doesNotMatch(dispatch.content, /## Active Checkpoint/);
      assert.doesNotMatch(dispatch.content, /## TDD Gate/);
      // Notification shows plain dispatchMode
      assert.match(ctx.notifications[0].message, /dispatchMode=find_and_fix/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("debug-session-manager prompt template", () => {
  test("loadPrompt('debug-session-manager') returns content with all structured return header keywords", () => {
    const content = loadPrompt("debug-session-manager", {
      slug: "auth-flake",
      mode: "debug",
      issue: "Login fails on Safari",
      workingDirectory: "/repo",
      goal: "find_root_cause_only",
      checkpointContext: "",
      tddContext: "",
      specialistContext: "",
    });

    assert.match(content, /## ROOT CAUSE FOUND/);
    assert.match(content, /## TDD CHECKPOINT/);
    assert.match(content, /## CHECKPOINT REACHED/);
    assert.match(content, /## DEBUG COMPLETE/);
    assert.match(content, /## INVESTIGATION INCONCLUSIVE/);
  });

  test("template contains specialist mapping table keywords", () => {
    const content = loadPrompt("debug-session-manager", {
      slug: "auth-flake",
      mode: "debug",
      issue: "Login fails on Safari",
      workingDirectory: "/repo",
      goal: "find_root_cause_only",
      checkpointContext: "",
      tddContext: "",
      specialistContext: "",
    });

    assert.match(content, /typescript-expert/);
    assert.match(content, /supabase-postgres-best-practices/);
    assert.match(content, /LOOKS_GOOD/);
    assert.match(content, /SUGGEST_CHANGE/);
  });
});

describe("continue handler — specialist review dispatch", () => {
  test("continue with specialistReview present — dispatch payload contains specialist hint and verdict", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Null pointer on login", createdAt: 10 });
      updateDebugSession(base, "null-pointer-on-login", {
        checkpoint: { type: "human-action", summary: "Check DB schema", awaitingResponse: true },
        specialistReview: {
          hint: "typescript",
          skill: "typescript-expert",
          verdict: "SUGGEST_CHANGE",
          detail: "Use optional chaining instead of null checks",
          reviewedAt: 1000,
        },
      });

      await handleDebug("continue null-pointer-on-login", ctx as any, mockPi as any);

      assert.equal(dispatched.length, 1);
      const content = dispatched[0].content;
      // specialistContext block appears in the dispatch
      assert.match(content, /Prior Specialist Review/);
      assert.match(content, /hint: typescript/);
      assert.match(content, /verdict: SUGGEST_CHANGE/);
      assert.match(content, /Use optional chaining/);
      // Notification includes specialistHint label
      assert.match(ctx.notifications[0].message, /specialistHint=typescript/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue with specialistReview absent — specialistContext is empty and notification has no specialistHint", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Slow query", createdAt: 10 });
      updateDebugSession(base, "slow-query", {
        checkpoint: { type: "human-action", summary: "Verify index exists", awaitingResponse: true },
      });

      await handleDebug("continue slow-query", ctx as any, mockPi as any);

      assert.equal(dispatched.length, 1);
      const content = dispatched[0].content;
      // No specialist content
      assert.doesNotMatch(content, /Prior Specialist Review/);
      assert.doesNotMatch(ctx.notifications[0].message, /specialistHint/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("continue with checkpoint + specialistReview — both contexts appear in dispatch", async () => {
    const base = makeBase();
    const ctx = createMockCtx();
    const dispatched: Array<{ customType: string; content: string; display: boolean }> = [];
    const mockPi = {
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        dispatched.push(msg);
      },
    };
    const saved = process.cwd();
    process.chdir(base);

    try {
      createDebugSession(base, { issue: "Memory leak in cache", createdAt: 10 });
      updateDebugSession(base, "memory-leak-in-cache", {
        checkpoint: {
          type: "human-verify",
          summary: "Verify heap snapshot shows leak",
          awaitingResponse: true,
          userResponse: "Yes, confirmed leak at line 42",
        },
        specialistReview: {
          hint: "database",
          skill: "supabase-postgres-best-practices",
          verdict: "LOOKS_GOOD",
          detail: "Query plan is optimal",
          reviewedAt: 2000,
        },
      });

      await handleDebug("continue memory-leak-in-cache", ctx as any, mockPi as any);

      assert.equal(dispatched.length, 1);
      const content = dispatched[0].content;
      // Checkpoint context present
      assert.match(content, /Active Checkpoint/);
      assert.match(content, /Verify heap snapshot/);
      // Specialist context present
      assert.match(content, /Prior Specialist Review/);
      assert.match(content, /hint: database/);
      assert.match(content, /verdict: LOOKS_GOOD/);
      // Notification includes both checkpoint type and specialist hint
      assert.match(ctx.notifications[0].message, /checkpointType=human-verify/);
      assert.match(ctx.notifications[0].message, /specialistHint=database/);
    } finally {
      process.chdir(saved);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
