/**
 * Remote Questions — durable prompt store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RemotePrompt, RemotePromptRecord, RemotePromptRef, RemoteAnswer, RemotePromptStatus } from "./types.js";

function runtimeDir(): string {
  return join(homedir(), ".gsd", "runtime", "remote-questions");
}

function recordPath(id: string): string {
  return join(runtimeDir(), `${id}.json`);
}

export function createPromptRecord(prompt: RemotePrompt): RemotePromptRecord {
  return {
    version: 1,
    id: prompt.id,
    createdAt: prompt.createdAt,
    updatedAt: Date.now(),
    status: "pending",
    channel: prompt.channel,
    timeoutAt: prompt.timeoutAt,
    pollIntervalMs: prompt.pollIntervalMs,
    questions: prompt.questions,
    context: prompt.context,
  };
}

export function writePromptRecord(record: RemotePromptRecord): void {
  mkdirSync(runtimeDir(), { recursive: true });
  writeFileSync(recordPath(record.id), JSON.stringify(record, null, 2) + "\n", "utf-8");
}

export function readPromptRecord(id: string): RemotePromptRecord | null {
  const path = recordPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RemotePromptRecord;
  } catch {
    return null;
  }
}

export function updatePromptRecord(
  id: string,
  updates: Partial<RemotePromptRecord>,
): RemotePromptRecord | null {
  const current = readPromptRecord(id);
  if (!current) return null;
  const merged = {
    ...current,
    ...updates,
    updatedAt: Date.now(),
  };
  // After spreading, the merged object satisfies one of the union members
  // but TypeScript can't prove it statically. The invariant is maintained
  // by callers: once `ref` is set via markPromptDispatched it is never removed.
  const next = merged as RemotePromptRecord;
  writePromptRecord(next);
  return next;
}

export function markPromptDispatched(id: string, ref: RemotePromptRef): RemotePromptRecord | null {
  return updatePromptRecord(id, { ref, status: "pending" });
}

export function markPromptAnswered(id: string, response: RemoteAnswer): RemotePromptRecord | null {
  return updatePromptRecord(id, { response, status: "answered", lastPollAt: Date.now() });
}

export function markPromptStatus(id: string, status: RemotePromptStatus, lastError?: string): RemotePromptRecord | null {
  return updatePromptRecord(id, {
    status,
    lastPollAt: Date.now(),
    ...(lastError ? { lastError } : {}),
  });
}
