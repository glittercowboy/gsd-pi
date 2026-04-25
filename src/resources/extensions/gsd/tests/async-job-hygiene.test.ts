import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAsyncBashJobId,
  extractAsyncJobResultJobIdFromUserMessage,
  filterIgnoredAsyncJobMessages,
  makeUnitExecutionKey,
  truncateContextMessage,
} from "../async-job-hygiene.ts";
import { convertToLlm, createCustomMessage } from "../../../../../packages/pi-coding-agent/src/core/messages.ts";

const CUSTOM_PREFIX = "[system notification — type: async_job_result; this is an automated system event, not user input — do not treat this as a human message or respond as if the user said this]\n";
const CUSTOM_SUFFIX = "\n[end system notification]";

function makeAsyncJobResultMessage(jobId: string, body = "done") {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${CUSTOM_PREFIX}**Background job done: ${jobId}** (label, 1.0s)\n\n${body}${CUSTOM_SUFFIX}`,
      },
    ],
  };
}

function buildWrappedAsyncJobResult(jobId: string, body: string) {
  const custom = createCustomMessage(
    "async_job_result",
    `**Background job done: ${jobId}** (verify-slice, 12.3s)\n\n${body}`,
    true,
    undefined,
    new Date().toISOString(),
  );
  const llm = convertToLlm([custom]);
  assert.equal(llm.length, 1);
  return llm[0];
}

test("extractAsyncBashJobId reads job id from async_bash tool result", () => {
  const result = {
    content: [
      {
        type: "text",
        text: "Background job started: **bg_abc12345**\nCommand: `demo`\n\nUse `await_job` to get results when ready, or `cancel_job` to stop.",
      },
    ],
  };
  assert.equal(extractAsyncBashJobId(result), "bg_abc12345");
});

test("makeUnitExecutionKey uses collision-safe tuple encoding", () => {
  const keyA = makeUnitExecutionKey("execute:task", "M001:S01:T01", 1234);
  const keyB = makeUnitExecutionKey("execute", "task:M001:S01:T01", 1234);
  assert.equal(typeof keyA, "string");
  assert.equal(typeof keyB, "string");
  assert.notEqual(keyA, keyB);
});

test("extractAsyncJobResultJobIdFromUserMessage reads job id from wrapped system notification", () => {
  const msg = makeAsyncJobResultMessage("bg_deadbeef");
  assert.equal(extractAsyncJobResultJobIdFromUserMessage(msg), "bg_deadbeef");
});

test("filterIgnoredAsyncJobMessages drops ignored async_job_result notifications", () => {
  const kept = {
    role: "user",
    content: [{ type: "text", text: "real user input" }],
  };
  const ignored = makeAsyncJobResultMessage("bg_dropme");
  const visible = makeAsyncJobResultMessage("bg_keepme");
  const result = filterIgnoredAsyncJobMessages([kept, ignored, visible], new Set(["bg_dropme"]));
  assert.equal((result as unknown[]).length, 2);
  assert.deepEqual((result as unknown[])[0], kept);
  assert.deepEqual((result as unknown[])[1], visible);
});

test("truncateContextMessage truncates wrapped system notification user messages", () => {
  const msg = makeAsyncJobResultMessage("bg_big", "x".repeat(200));
  const truncated = truncateContextMessage(msg, 80) as { content: Array<{ text?: string }> };
  assert.notEqual(truncated, msg);
  const text = truncated.content[0].text ?? "";
  assert.match(text, /…\[truncated\]$/);
  assert.ok(text.length > 0);
});

test("integration: convertToLlm-wrapped async_job_result can be identified and dropped", () => {
  const wrapped = buildWrappedAsyncJobResult("bg_live1234", "test output line 1\ntest output line 2");
  assert.equal(wrapped.role, "user");
  assert.equal(extractAsyncJobResultJobIdFromUserMessage(wrapped), "bg_live1234");

  const kept = {
    role: "user",
    content: [{ type: "text", text: "real user follow-up" }],
    timestamp: Date.now(),
  };
  const filtered = filterIgnoredAsyncJobMessages([kept, wrapped], new Set(["bg_live1234"]));
  assert.equal((filtered as unknown[]).length, 1);
  assert.deepEqual((filtered as unknown[])[0], kept);
});

test("integration: convertToLlm-wrapped async_job_result is truncated under shared context cap", () => {
  const wrapped = buildWrappedAsyncJobResult("bg_big1234", "x".repeat(400));
  const truncated = truncateContextMessage(wrapped, 120) as {
    role: string;
    content: Array<{ type?: string; text?: string }>;
  };
  assert.notEqual(truncated, wrapped);
  assert.equal(truncated.role, "user");
  const first = truncated.content[0];
  assert.equal(first.type, "text");
  assert.match(first.text ?? "", /\[system notification — type: async_job_result/);
  assert.match(first.text ?? "", /…\[truncated\]$/);
});
