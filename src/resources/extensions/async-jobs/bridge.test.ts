import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../../packages/pi-coding-agent/src/core/event-bus.ts";
import AsyncJobs from "./index.ts";

function createFakePi() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    events: createEventBus(),
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
    },
  };
  return { pi, handlers, tools, commands, sentMessages };
}

async function emit(handlers: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]) {
  for (const handler of handlers.get(name) ?? []) {
    await handler(...args);
  }
}

function extractJobId(text: string) {
  return text.match(/\*\*(bg_[a-z0-9]+)\*\*/i)?.[1] ?? null;
}

test("async-jobs bridge cancels running jobs and suppresses follow-up delivery", async () => {
  const { pi, handlers, tools, sentMessages } = createFakePi();
  AsyncJobs(pi as any);
  await emit(handlers, "session_start", {}, { cwd: process.cwd() });

  const asyncBash = tools.get("async_bash") as {
    execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
  } | undefined;
  const cancelJob = tools.get("cancel_job") as {
    execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
  } | undefined;
  assert.ok(asyncBash, "async_bash tool registered");
  assert.ok(cancelJob, "cancel_job tool registered");

  const start = await asyncBash.execute(
    "tc1",
    {
      command: 'node -e "setTimeout(() => {}, 5000)"',
      label: "bridge-test",
    },
    new AbortController().signal,
    () => {},
    undefined,
  );

  const jobId = extractJobId(start.content[0].text);
  assert.ok(jobId, "job id parsed from async_bash result");

  pi.events.emit("gsd:async-jobs-control", {
    action: "cancel_or_ignore",
    jobIds: [jobId],
  });

  // Give the cancel_or_ignore handler time to run and suppress any pending
  // setTimeout(0)-scheduled async_job_result delivery; 80ms is conservative
  // for event-loop jitter, not a semantic timeout.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sentMessages.length, 0, "cancel_or_ignore should suppress late async_job_result delivery");

  const cancelResult = await cancelJob.execute(
    "tc2",
    { job_id: jobId },
    new AbortController().signal,
    () => {},
    undefined,
  );

  assert.match(cancelResult.content[0].text, /already completed|cancelled/i);
  await emit(handlers, "session_shutdown", {});
});
