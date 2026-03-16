/**
 * Remote Questions — orchestration manager
 */

import { randomUUID } from "node:crypto";
import type { ChannelAdapter, RemotePrompt, RemoteQuestion, RemoteAnswer } from "./types.js";
import { resolveRemoteConfig, type ResolvedConfig } from "./config.js";
import { SlackAdapter } from "./slack-adapter.js";
import { DiscordAdapter } from "./discord-adapter.js";
import { createPromptRecord, writePromptRecord, markPromptAnswered, markPromptDispatched, markPromptStatus, updatePromptRecord } from "./store.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

interface QuestionInput {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  allowMultiple?: boolean;
}

export async function tryRemoteQuestions(
  questions: QuestionInput[],
  signal?: AbortSignal,
): Promise<ToolResult | null> {
  const config = resolveRemoteConfig();
  if (!config) return null;

  const prompt = createPrompt(questions, config);
  writePromptRecord(createPromptRecord(prompt));

  const adapter = createAdapter(config);
  try {
    await adapter.validate();
  } catch (err) {
    markPromptStatus(prompt.id, "failed", sanitizeError(String((err as Error).message)));
    return errorResult(`Remote auth failed (${config.channel}): ${(err as Error).message}`, config.channel);
  }

  let dispatch;
  try {
    dispatch = await adapter.sendPrompt(prompt);
    markPromptDispatched(prompt.id, dispatch.ref);
  } catch (err) {
    markPromptStatus(prompt.id, "failed", sanitizeError(String((err as Error).message)));
    return errorResult(`Failed to send questions via ${config.channel}: ${(err as Error).message}`, config.channel);
  }

  const answer = await pollUntilDone(adapter, prompt, dispatch.ref, signal);
  if (!answer) {
    markPromptStatus(prompt.id, signal?.aborted ? "cancelled" : "timed_out");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          timed_out: true,
          channel: config.channel,
          prompt_id: prompt.id,
          timeout_minutes: config.timeoutMs / 60000,
          thread_url: dispatch.ref.threadUrl ?? null,
          message: `User did not respond within ${config.timeoutMs / 60000} minutes.`,
        }),
      }],
      details: {
        remote: true,
        channel: config.channel,
        timed_out: true,
        promptId: prompt.id,
        threadUrl: dispatch.ref.threadUrl,
        status: signal?.aborted ? "cancelled" : "timed_out",
      },
    };
  }

  markPromptAnswered(prompt.id, answer);

  // Acknowledge receipt with a ✅ on Discord (Slack threads are self-evident)
  if (config.channel === "discord" && dispatch.ref) {
    try {
      await (adapter as import("./discord-adapter.js").DiscordAdapter).acknowledgeAnswer(dispatch.ref);
    } catch { /* best-effort */ }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ answers: formatForTool(answer) }) }],
    details: {
      remote: true,
      channel: config.channel,
      timed_out: false,
      promptId: prompt.id,
      threadUrl: dispatch.ref.threadUrl,
      questions,
      response: answer,
      status: "answered",
    },
  };
}

function createPrompt(questions: QuestionInput[], config: ResolvedConfig): RemotePrompt {
  const createdAt = Date.now();
  return {
    id: randomUUID(),
    channel: config.channel,
    createdAt,
    timeoutAt: createdAt + config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    context: { source: "ask_user_questions" },
    questions: questions.map((q): RemoteQuestion => ({
      id: q.id,
      header: q.header,
      question: q.question,
      options: q.options,
      allowMultiple: q.allowMultiple ?? false,
    })),
  };
}

function createAdapter(config: ResolvedConfig): ChannelAdapter {
  return config.channel === "slack"
    ? new SlackAdapter(config.token, config.channelId)
    : new DiscordAdapter(config.token, config.channelId);
}

async function pollUntilDone(
  adapter: ChannelAdapter,
  prompt: RemotePrompt,
  ref: import("./types.js").RemotePromptRef,
  signal?: AbortSignal,
): Promise<RemoteAnswer | null> {
  let retryCount = 0;
  while (Date.now() < prompt.timeoutAt && !signal?.aborted) {
    try {
      const answer = await adapter.pollAnswer(prompt, ref);
      updatePromptRecord(prompt.id, { lastPollAt: Date.now() });
      retryCount = 0;
      if (answer) return answer;
    } catch (err) {
      retryCount++;
      if (retryCount > 1) {
        markPromptStatus(prompt.id, "failed", sanitizeError(String((err as Error).message)));
        return null;
      }
    }

    await sleep(prompt.pollIntervalMs, signal);
  }

  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatForTool(answer: RemoteAnswer): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = {};
  for (const [id, data] of Object.entries(answer.answers)) {
    const list = [...data.answers];
    if (data.user_note) list.push(`user_note: ${data.user_note}`);
    out[id] = { answers: list };
  }
  return out;
}

// Strip token-like strings from error messages before surfacing
const TOKEN_PATTERNS = [
  /xoxb-[A-Za-z0-9\-]+/g,    // Slack bot tokens
  /xoxp-[A-Za-z0-9\-]+/g,    // Slack user tokens
  /xoxa-[A-Za-z0-9\-]+/g,    // Slack app tokens
  /[A-Za-z0-9_\-.]{20,}/g,   // Long opaque secrets (Discord tokens, etc.)
];

export function sanitizeError(msg: string): string {
  let sanitized = msg;
  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

function errorResult(message: string, channel: string): ToolResult {
  return {
    content: [{ type: "text", text: sanitizeError(message) }],
    details: { remote: true, channel, error: true, status: "failed" },
  };
}
