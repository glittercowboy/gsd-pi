const ASYNC_BASH_START_RE = /Background job started:\s*\*\*(bg_[a-z0-9]+)\*\*/i;
const ASYNC_JOB_RESULT_RE = /Background job (?:done|error):\s*(?:\*\*)?(bg_[a-z0-9]+)(?:\*\*)?/i;
const SYSTEM_NOTIFICATION_PREFIX = "[system notification — type: ";
const ASYNC_JOB_RESULT_TYPE = "async_job_result";
const BASH_RESULT_PREFIX = "Ran `";
const TRUNCATION_SUFFIX = "\n…[truncated]";

function getTextBlocks(content: unknown): Array<Record<string, unknown> & { text: string }> {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> & { text: string } => typeof block?.text === "string");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  return getTextBlocks(content).map((block) => block.text).join("\n");
}

function payloadToText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as { content?: unknown }).content)) {
    return contentToText((payload as { content: unknown }).content);
  }
  return "";
}

function truncateTextBlocks(blocks: unknown, maxChars: number): unknown {
  if (!Array.isArray(blocks) || maxChars <= 0) return blocks;
  let remaining = maxChars;
  let changed = false;
  const truncated: Array<Record<string, unknown>> = [];

  for (const block of blocks as Array<Record<string, unknown>>) {
    if (typeof block?.text !== "string") {
      truncated.push(block);
      continue;
    }
    if (remaining <= 0) {
      changed = true;
      continue;
    }
    if (block.text.length <= remaining) {
      remaining -= block.text.length;
      truncated.push(block);
      continue;
    }
    changed = true;
    truncated.push({ ...block, text: block.text.slice(0, remaining) + TRUNCATION_SUFFIX });
    remaining = 0;
  }

  return changed ? truncated : blocks;
}

export function makeUnitExecutionKey(unitType: unknown, unitId: unknown, startedAt: unknown): string | null {
  if (typeof unitType !== "string" || !unitType) return null;
  if (typeof unitId !== "string" || !unitId) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  return JSON.stringify([unitType, unitId, startedAt]);
}

export function extractAsyncBashJobId(resultPayload: unknown): string | null {
  const text = payloadToText(resultPayload);
  return text.match(ASYNC_BASH_START_RE)?.[1] ?? null;
}

export function isBashResultUserMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  if ((msg as { role?: unknown }).role !== "user") return false;
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" && first.text.startsWith(BASH_RESULT_PREFIX);
}

export function isSystemNotificationUserMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  if ((msg as { role?: unknown }).role !== "user") return false;
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" && first.text.startsWith(SYSTEM_NOTIFICATION_PREFIX);
}

export function extractAsyncJobResultJobIdFromUserMessage(msg: unknown): string | null {
  if (!isSystemNotificationUserMessage(msg)) return null;
  const content = (msg as { content?: unknown }).content;
  const text = contentToText(content);
  if (!text.includes(ASYNC_JOB_RESULT_TYPE)) return null;
  return text.match(ASYNC_JOB_RESULT_RE)?.[1] ?? null;
}

export function filterIgnoredAsyncJobMessages(messages: unknown, ignoredAsyncJobIds: ReadonlySet<string>): unknown {
  if (!Array.isArray(messages) || !(ignoredAsyncJobIds instanceof Set) || ignoredAsyncJobIds.size === 0) {
    return messages;
  }

  let changed = false;
  const kept: unknown[] = [];
  for (const msg of messages) {
    const jobId = extractAsyncJobResultJobIdFromUserMessage(msg);
    if (jobId && ignoredAsyncJobIds.has(jobId)) {
      changed = true;
      continue;
    }
    kept.push(msg);
  }
  return changed ? kept : messages;
}

export function truncateContextMessage(msg: unknown, maxChars: number): unknown {
  if (!msg || typeof msg !== "object") return msg;
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content) || maxChars <= 0) return msg;
  const role = (msg as { role?: unknown }).role;
  if (role !== "toolResult" && !isBashResultUserMessage(msg) && !isSystemNotificationUserMessage(msg)) {
    return msg;
  }
  const truncatedContent = truncateTextBlocks(content, maxChars);
  return truncatedContent === content ? msg : { ...(msg as Record<string, unknown>), content: truncatedContent };
}
