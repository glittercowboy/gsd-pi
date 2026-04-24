import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteSync } from "../atomic-write.js";
import { gsdRoot } from "../paths.js";
import type { WriteRecord, WriterToken } from "./contracts.js";

interface SequenceState {
  lastSequence: number;
  updatedAt: string;
}

const activeTokens = new Map<string, WriterToken>();

function tokenKey(basePath: string, turnId: string): string {
  return `${basePath}:${turnId}`;
}

function sequencePath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "uok-writer-sequence.json");
}

function readSequenceState(basePath: string): SequenceState {
  const path = sequencePath(basePath);
  if (!existsSync(path)) {
    return { lastSequence: 0, updatedAt: new Date(0).toISOString() };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SequenceState>;
    return {
      lastSequence: Number.isInteger(parsed.lastSequence) ? Number(parsed.lastSequence) : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return { lastSequence: 0, updatedAt: new Date(0).toISOString() };
  }
}

function writeSequenceState(basePath: string, state: SequenceState): void {
  atomicWriteSync(sequencePath(basePath), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function acquireWriterToken(args: {
  basePath: string;
  traceId: string;
  turnId: string;
  owner?: WriterToken["owner"];
}): WriterToken {
  const key = tokenKey(args.basePath, args.turnId);
  const existing = activeTokens.get(key);
  if (existing) {
    throw new Error(`Writer token already active for turn ${args.turnId}`);
  }

  const token: WriterToken = {
    tokenId: randomUUID(),
    traceId: args.traceId,
    turnId: args.turnId,
    acquiredAt: new Date().toISOString(),
    owner: args.owner ?? "uok",
  };
  activeTokens.set(key, token);
  return token;
}

export function releaseWriterToken(basePath: string, token: WriterToken): void {
  const key = tokenKey(basePath, token.turnId);
  const current = activeTokens.get(key);
  if (current?.tokenId === token.tokenId) {
    activeTokens.delete(key);
  }
}

export function hasActiveWriterToken(basePath: string, turnId: string): boolean {
  return activeTokens.has(tokenKey(basePath, turnId));
}

export function nextWriteRecord(args: {
  basePath: string;
  token: WriterToken;
  category: WriteRecord["category"];
  operation: WriteRecord["operation"];
  path?: string;
  metadata?: Record<string, unknown>;
}): WriteRecord {
  if (!hasActiveWriterToken(args.basePath, args.token.turnId)) {
    throw new Error(`Writer token is not active for turn ${args.token.turnId}`);
  }

  const state = readSequenceState(args.basePath);
  const sequence = state.lastSequence + 1;
  const updatedAt = new Date().toISOString();
  writeSequenceState(args.basePath, { lastSequence: sequence, updatedAt });

  return {
    writerToken: args.token,
    sequence: {
      traceId: args.token.traceId,
      turnId: args.token.turnId,
      sequence,
    },
    category: args.category,
    operation: args.operation,
    path: args.path,
    ts: updatedAt,
    metadata: args.metadata,
  };
}

export function resetWriterTokensForTests(): void {
  activeTokens.clear();
}
