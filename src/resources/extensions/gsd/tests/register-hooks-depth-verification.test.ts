import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  getPendingGate,
  resetWriteGateState,
  shouldBlockContextArtifactSave,
} from "../bootstrap/write-gate.ts";
import { toRoundResultResponse } from "../../remote-questions/manager.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-depth-gate-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("register-hooks unlocks milestone depth verification from question id without guided-flow state (#4047)", async (t) => {
  const dir = makeTempDir("manual");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState();

  t.after(() => {
    resetWriteGateState();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<void> | void>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_M001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Do you agree?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  const toolCallHandlers = handlers.get("tool_call");
  const toolResultHandlers = handlers.get("tool_result");
  assert.ok(toolCallHandlers?.length, "tool_call handler should be registered");
  assert.ok(toolResultHandlers?.length, "tool_result handler should be registered");

  for (const handler of toolCallHandlers ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
    });
  }

  assert.equal(getPendingGate(), questionId, "gate should be set even without guided-flow state");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    true,
    "milestone context should still be blocked before confirmation",
  );

  for (const handler of toolResultHandlers ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Yes, you got it (Recommended)" },
          },
        },
      },
    });
  }

  assert.equal(getPendingGate(), null, "confirming the depth question should clear the pending gate");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    false,
    "question-id milestone inference should unlock the matching milestone context write",
  );
});

test("register-hooks clears depth gate when remote (Telegram/Slack/Discord) answer is normalized (#4406)", async (t) => {
  const dir = makeTempDir("remote");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState();

  t.after(() => {
    resetWriteGateState();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<void> | void>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_M002_confirm";
  const questions = [
    {
      id: questionId,
      question: "Do you agree?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }
  assert.equal(getPendingGate(), questionId);

  // Simulate the normalized response the remote manager now emits:
  // a Telegram button press returns a RemoteAnswer that is fed through
  // toRoundResultResponse before reaching details.response.
  const remoteAnswer = {
    answers: {
      [questionId]: { answers: ["Yes, you got it (Recommended)"] },
    },
  };
  const normalized = toRoundResultResponse(remoteAnswer);

  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: { response: normalized },
    });
  }

  assert.equal(getPendingGate(), null, "normalized remote answer must clear the gate");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M002").block,
    false,
    "remote confirmation must unlock the matching milestone context write",
  );
});
