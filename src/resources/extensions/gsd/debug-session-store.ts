import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync, type AtomicWriteSyncOps } from "./atomic-write.js";
import { gsdRoot } from "./paths.js";

export type DebugSessionStatus = "active" | "paused" | "resolved" | "failed";

export interface DebugCheckpoint {
  type: "human-verify" | "human-action" | "decision" | "root-cause-found" | "inconclusive";
  summary: string;
  awaitingResponse: boolean;
  userResponse?: string;
}

export interface DebugTddGate {
  enabled: boolean;
  phase: "pending" | "red" | "green";
  testFile?: string;
  testName?: string;
  failureOutput?: string;
}

export interface DebugSpecialistReview {
  hint: string;
  skill: string | null;
  verdict: string;
  detail: string;
  reviewedAt: number;
}

export interface DebugSessionArtifact {
  version: 1;
  mode: "debug" | "diagnose";
  slug: string;
  issue: string;
  status: DebugSessionStatus;
  phase: string;
  createdAt: number;
  updatedAt: number;
  logPath: string;
  lastError: string | null;
  checkpoint?: DebugCheckpoint | null;
  tddGate?: DebugTddGate | null;
  specialistReview?: DebugSpecialistReview | null;
}

export interface DebugSessionRecord {
  artifactPath: string;
  session: DebugSessionArtifact;
}

export interface DebugMalformedSessionArtifact {
  artifactPath: string;
  message: string;
}

export interface DebugSessionListResult {
  sessions: DebugSessionRecord[];
  malformed: DebugMalformedSessionArtifact[];
}

export interface CreateDebugSessionInput {
  issue: string;
  mode?: "debug" | "diagnose";
  status?: DebugSessionStatus;
  phase?: string;
  createdAt?: number;
}

export interface UpdateDebugSessionInput {
  status?: DebugSessionStatus;
  phase?: string;
  issue?: string;
  lastError?: string | null;
  updatedAt?: number;
  checkpoint?: DebugCheckpoint | null;
  tddGate?: DebugTddGate | null;
  specialistReview?: DebugSpecialistReview | null;
}

export interface DebugSessionStoreDeps {
  atomicWrite?: (filePath: string, content: string, encoding?: BufferEncoding) => void;
  readFile?: (filePath: string, encoding: BufferEncoding) => string;
  listDir?: (dirPath: string) => string[];
  exists?: (filePath: string) => boolean;
  now?: () => number;
}

const DEFAULT_PHASE = "queued";
const DEFAULT_STATUS: DebugSessionStatus = "active";
const SESSION_FILE_SUFFIX = ".json";
const MAX_SLUG_LENGTH = 64;
const MAX_COLLISION_ATTEMPTS = 10_000;

function debugRoot(basePath: string): string {
  return join(gsdRoot(basePath), "debug");
}

export function debugSessionsDir(basePath: string): string {
  return join(debugRoot(basePath), "sessions");
}

export function debugSessionArtifactPath(basePath: string, slug: string): string {
  assertValidDebugSessionSlug(slug);
  return join(debugSessionsDir(basePath), `${slug}${SESSION_FILE_SUFFIX}`);
}

export function debugSessionLogPath(basePath: string, slug: string): string {
  assertValidDebugSessionSlug(slug);
  return join(debugRoot(basePath), `${slug}.log`);
}

function ensureSessionsDir(basePath: string): string {
  const dir = debugSessionsDir(basePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function slugifyDebugSessionIssue(issue: string): string {
  const normalized = issue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  if (!normalized) {
    throw new Error("Issue text must contain at least one alphanumeric character.");
  }
  return normalized;
}

export function assertValidDebugSessionSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Invalid debug session slug: ${slug}`);
  }
}

function isDebugSessionStatus(value: unknown): value is DebugSessionStatus {
  return value === "active" || value === "paused" || value === "resolved" || value === "failed";
}

function isDebugCheckpointShape(value: unknown): value is DebugCheckpoint {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const validTypes = ["human-verify", "human-action", "decision", "root-cause-found", "inconclusive"];
  return (
    validTypes.includes(o.type as string)
    && typeof o.summary === "string"
    && typeof o.awaitingResponse === "boolean"
    && (o.userResponse === undefined || typeof o.userResponse === "string")
  );
}

function isDebugTddGateShape(value: unknown): value is DebugTddGate {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const validPhases = ["pending", "red", "green"];
  return (
    typeof o.enabled === "boolean"
    && validPhases.includes(o.phase as string)
    && (o.testFile === undefined || typeof o.testFile === "string")
    && (o.testName === undefined || typeof o.testName === "string")
    && (o.failureOutput === undefined || typeof o.failureOutput === "string")
  );
}

function isDebugSpecialistReviewShape(value: unknown): value is DebugSpecialistReview {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.hint === "string"
    && (typeof o.skill === "string" || o.skill === null)
    && typeof o.verdict === "string"
    && typeof o.detail === "string"
    && typeof o.reviewedAt === "number"
  );
}

function isDebugSessionArtifact(value: unknown): value is DebugSessionArtifact {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.version === 1
    && (o.mode === "debug" || o.mode === "diagnose")
    && typeof o.slug === "string"
    && typeof o.issue === "string"
    && isDebugSessionStatus(o.status)
    && typeof o.phase === "string"
    && typeof o.createdAt === "number"
    && typeof o.updatedAt === "number"
    && typeof o.logPath === "string"
    && (typeof o.lastError === "string" || o.lastError === null)
    && (o.checkpoint === undefined || o.checkpoint === null || isDebugCheckpointShape(o.checkpoint))
    && (o.tddGate === undefined || o.tddGate === null || isDebugTddGateShape(o.tddGate))
    && (o.specialistReview === undefined || o.specialistReview === null || isDebugSpecialistReviewShape(o.specialistReview))
  );
}

function parseDebugSessionArtifact(filePath: string, raw: string): DebugSessionArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse debug session artifact ${filePath}: ${message}`);
  }

  if (!isDebugSessionArtifact(parsed)) {
    throw new Error(`Malformed debug session artifact ${filePath}: schema validation failed`);
  }
  return parsed;
}

function defaultDeps(deps: DebugSessionStoreDeps) {
  return {
    atomicWrite: deps.atomicWrite ?? atomicWriteSync,
    readFile: deps.readFile ?? ((filePath: string, encoding: BufferEncoding) => readFileSync(filePath, encoding)),
    listDir: deps.listDir ?? ((dirPath: string) => readdirSync(dirPath)),
    exists: deps.exists ?? ((filePath: string) => existsSync(filePath)),
    now: deps.now ?? (() => Date.now()),
  };
}

function nextSlug(basePath: string, baseSlug: string, deps: ReturnType<typeof defaultDeps>): string {
  const baseArtifactPath = debugSessionArtifactPath(basePath, baseSlug);
  if (!deps.exists(baseArtifactPath)) return baseSlug;

  for (let n = 2; n < MAX_COLLISION_ATTEMPTS; n++) {
    const candidate = `${baseSlug}-${n}`;
    const candidatePath = debugSessionArtifactPath(basePath, candidate);
    if (!deps.exists(candidatePath)) return candidate;
  }

  throw new Error(`Unable to allocate unique debug session slug for '${baseSlug}'`);
}

function serializeArtifact(session: DebugSessionArtifact): string {
  return JSON.stringify(session, null, 2) + "\n";
}

export function createDebugSession(
  basePath: string,
  input: CreateDebugSessionInput,
  deps: DebugSessionStoreDeps = {},
): DebugSessionRecord {
  const d = defaultDeps(deps);
  const issue = input.issue?.trim() ?? "";
  if (!issue) {
    throw new Error("Issue text is required to create a debug session.");
  }

  ensureSessionsDir(basePath);

  const baseSlug = slugifyDebugSessionIssue(issue);
  const slug = nextSlug(basePath, baseSlug, d);
  const now = input.createdAt ?? d.now();
  const session: DebugSessionArtifact = {
    version: 1,
    mode: input.mode ?? "debug",
    slug,
    issue,
    status: input.status ?? DEFAULT_STATUS,
    phase: input.phase ?? DEFAULT_PHASE,
    createdAt: now,
    updatedAt: now,
    logPath: debugSessionLogPath(basePath, slug),
    lastError: null,
  };

  const artifactPath = debugSessionArtifactPath(basePath, slug);
  d.atomicWrite(artifactPath, serializeArtifact(session), "utf-8");

  return { artifactPath, session };
}

export function loadDebugSession(
  basePath: string,
  slug: string,
  deps: DebugSessionStoreDeps = {},
): DebugSessionRecord | null {
  assertValidDebugSessionSlug(slug);
  const d = defaultDeps(deps);

  const artifactPath = debugSessionArtifactPath(basePath, slug);
  if (!d.exists(artifactPath)) return null;

  const raw = d.readFile(artifactPath, "utf-8");
  const session = parseDebugSessionArtifact(artifactPath, raw);
  return { artifactPath, session };
}

export function listDebugSessions(
  basePath: string,
  deps: DebugSessionStoreDeps = {},
): DebugSessionListResult {
  const d = defaultDeps(deps);
  const dir = debugSessionsDir(basePath);
  if (!d.exists(dir)) return { sessions: [], malformed: [] };

  const entries = d.listDir(dir)
    .filter(entry => entry.endsWith(SESSION_FILE_SUFFIX))
    .sort((a, b) => a.localeCompare(b));

  const sessions: DebugSessionRecord[] = [];
  const malformed: DebugMalformedSessionArtifact[] = [];

  for (const entry of entries) {
    const artifactPath = join(dir, entry);
    try {
      const raw = d.readFile(artifactPath, "utf-8");
      const session = parseDebugSessionArtifact(artifactPath, raw);
      sessions.push({ artifactPath, session });
    } catch (error) {
      malformed.push({
        artifactPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  sessions.sort((a, b) => {
    if (a.session.updatedAt !== b.session.updatedAt) {
      return b.session.updatedAt - a.session.updatedAt;
    }
    if (a.session.createdAt !== b.session.createdAt) {
      return b.session.createdAt - a.session.createdAt;
    }
    return a.session.slug.localeCompare(b.session.slug);
  });

  return { sessions, malformed };
}

export function updateDebugSession(
  basePath: string,
  slug: string,
  update: UpdateDebugSessionInput,
  deps: DebugSessionStoreDeps = {},
): DebugSessionRecord {
  const d = defaultDeps(deps);
  const loaded = loadDebugSession(basePath, slug, d);
  if (!loaded) {
    throw new Error(`Debug session not found for slug: ${slug}`);
  }

  const nextIssue = update.issue?.trim() ?? loaded.session.issue;
  if (!nextIssue) {
    throw new Error("Issue text cannot be empty.");
  }

  const nextStatus = update.status ?? loaded.session.status;
  if (!isDebugSessionStatus(nextStatus)) {
    throw new Error(`Invalid debug session status: ${String(update.status)}`);
  }

  const nextUpdatedAt = update.updatedAt ?? d.now();
  const session: DebugSessionArtifact = {
    ...loaded.session,
    issue: nextIssue,
    status: nextStatus,
    phase: update.phase ?? loaded.session.phase,
    lastError: update.lastError === undefined ? loaded.session.lastError : update.lastError,
    checkpoint: update.checkpoint === undefined ? loaded.session.checkpoint : update.checkpoint,
    tddGate: update.tddGate === undefined ? loaded.session.tddGate : update.tddGate,
    specialistReview: update.specialistReview === undefined ? loaded.session.specialistReview : update.specialistReview,
    updatedAt: nextUpdatedAt,
  };

  d.atomicWrite(loaded.artifactPath, serializeArtifact(session), "utf-8");
  return { artifactPath: loaded.artifactPath, session };
}

// Keep this exported for focused fault-injection tests around rename retry behavior.
export type { AtomicWriteSyncOps };
