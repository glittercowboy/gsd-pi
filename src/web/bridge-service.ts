import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSessionEvent } from "../../packages/pi-coding-agent/src/core/agent-session.ts";
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
} from "../../packages/pi-coding-agent/src/modes/rpc/rpc-types.ts";
import {
  SESSION_BROWSER_SCOPE,
  normalizeSessionBrowserQuery,
  type RenameSessionRequest,
  type SessionBrowserQuery,
  type SessionBrowserResponse,
  type SessionBrowserSession,
  type SessionManageErrorCode,
  type SessionManageResponse,
} from "../../web/lib/session-browser-contract.ts";
import { authFilePath } from "../app-paths.ts";
import { getProjectSessionsDir } from "../project-sessions.ts";
import {
  collectOnboardingState,
  type OnboardingLockReason,
  type OnboardingState,
} from "./onboarding-service.ts";

const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RESPONSE_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 30_000;
const MAX_STDERR_BUFFER = 8_000;
const WORKSPACE_INDEX_CACHE_TTL_MS = 30_000;

type BridgeLifecyclePhase = "idle" | "starting" | "ready" | "failed";
type BridgeInput = RpcCommand | RpcExtensionUIResponse;

type BridgeCommandFailureResponse = RpcResponse & {
  code?: "onboarding_locked";
  details?: {
    reason: OnboardingLockReason;
    onboarding: Pick<
      OnboardingState,
      "locked" | "lockReason" | "required" | "lastValidation" | "bridgeAuthRefresh"
    >;
  };
};

const READ_ONLY_RPC_COMMAND_TYPES = new Set<RpcCommand["type"]>([
  "get_state",
  "get_available_models",
  "get_session_stats",
  "get_messages",
  "get_last_assistant_text",
  "get_fork_messages",
  "get_commands",
]);

type BridgeExtensionErrorEvent = {
  type: "extension_error";
  extensionPath?: string;
  event?: string;
  error: string;
};

type LocalSessionInfo = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
};

type SessionInfo = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
};

type SessionBrowserTreeNode = {
  session: SessionInfo;
  children: SessionBrowserTreeNode[];
};

type FlatSessionBrowserNode = {
  session: SessionInfo;
  depth: number;
  isLastInThread: boolean;
  ancestorHasNextSibling: boolean[];
};

type ParsedSessionSearchQuery = {
  mode: "tokens" | "regex";
  tokens: Array<{ kind: "fuzzy" | "phrase"; value: string }>;
  regex: RegExp | null;
  error?: string;
};

function fuzzyMatch(query: string, text: string): { matches: boolean; score: number } {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  const matchQuery = (normalizedQuery: string): { matches: boolean; score: number } => {
    if (normalizedQuery.length === 0) {
      return { matches: true, score: 0 };
    }

    if (normalizedQuery.length > textLower.length) {
      return { matches: false, score: 0 };
    }

    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;

    for (let index = 0; index < textLower.length && queryIndex < normalizedQuery.length; index++) {
      if (textLower[index] !== normalizedQuery[queryIndex]) continue;

      const isWordBoundary = index === 0 || /[\s\-_./:]/.test(textLower[index - 1]!);
      if (lastMatchIndex === index - 1) {
        consecutiveMatches++;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        if (lastMatchIndex >= 0) {
          score += (index - lastMatchIndex - 1) * 2;
        }
      }

      if (isWordBoundary) {
        score -= 10;
      }

      score += index * 0.1;
      lastMatchIndex = index;
      queryIndex++;
    }

    if (queryIndex < normalizedQuery.length) {
      return { matches: false, score: 0 };
    }

    return { matches: true, score };
  };

  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) {
    return primaryMatch;
  }

  const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch
    ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
    : numericAlphaMatch
      ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
      : "";

  if (!swappedQuery) {
    return primaryMatch;
  }

  const swappedMatch = matchQuery(swappedQuery);
  if (!swappedMatch.matches) {
    return primaryMatch;
  }

  return { matches: true, score: swappedMatch.score + 5 };
}

function normalizeWhitespaceLower(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function getSessionSearchText(session: SessionInfo): string {
  return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

function hasSessionName(session: SessionInfo): boolean {
  return Boolean(session.name?.trim());
}

function parseSessionSearchQuery(query: string): ParsedSessionSearchQuery {
  const trimmed = query.trim();
  if (!trimmed) {
    return { mode: "tokens", tokens: [], regex: null };
  }

  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) {
      return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    }

    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { mode: "regex", tokens: [], regex: null, error: message };
    }
  }

  const tokens: Array<{ kind: "fuzzy" | "phrase"; value: string }> = [];
  let buffer = "";
  let inQuote = false;
  let hadUnclosedQuote = false;

  const flush = (kind: "fuzzy" | "phrase") => {
    const value = buffer.trim();
    buffer = "";
    if (!value) return;
    tokens.push({ kind, value });
  };

  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index];
    if (!character) continue;

    if (character === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }

    if (!inQuote && /\s/.test(character)) {
      flush("fuzzy");
      continue;
    }

    buffer += character;
  }

  if (inQuote) {
    hadUnclosedQuote = true;
  }

  if (hadUnclosedQuote) {
    return {
      mode: "tokens",
      tokens: trimmed
        .split(/\s+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => ({ kind: "fuzzy" as const, value })),
      regex: null,
    };
  }

  flush(inQuote ? "phrase" : "fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

function matchSessionSearch(session: SessionInfo, parsed: ParsedSessionSearchQuery): { matches: boolean; score: number } {
  const text = getSessionSearchText(session);

  if (parsed.mode === "regex") {
    if (!parsed.regex) {
      return { matches: false, score: 0 };
    }

    const index = text.search(parsed.regex);
    if (index < 0) {
      return { matches: false, score: 0 };
    }

    return { matches: true, score: index * 0.1 };
  }

  if (parsed.tokens.length === 0) {
    return { matches: true, score: 0 };
  }

  let totalScore = 0;
  let normalizedText: string | null = null;

  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      if (normalizedText === null) {
        normalizedText = normalizeWhitespaceLower(text);
      }
      const phrase = normalizeWhitespaceLower(token.value);
      if (!phrase) continue;
      const index = normalizedText.indexOf(phrase);
      if (index < 0) {
        return { matches: false, score: 0 };
      }
      totalScore += index * 0.1;
      continue;
    }

    const fuzzy = fuzzyMatch(token.value, text);
    if (!fuzzy.matches) {
      return { matches: false, score: 0 };
    }
    totalScore += fuzzy.score;
  }

  return { matches: true, score: totalScore };
}

function filterAndSortSessions(
  sessions: SessionInfo[],
  query: string,
  sortMode: ReturnType<typeof normalizeSessionBrowserQuery>["sortMode"],
  nameFilter: ReturnType<typeof normalizeSessionBrowserQuery>["nameFilter"],
): SessionInfo[] {
  const nameFiltered = nameFilter === "all" ? sessions : sessions.filter((session) => hasSessionName(session));
  const trimmed = query.trim();
  if (!trimmed) {
    return nameFiltered;
  }

  const parsed = parseSessionSearchQuery(query);
  if (parsed.error) {
    return [];
  }

  if (sortMode === "recent") {
    const filtered: SessionInfo[] = [];
    for (const session of nameFiltered) {
      const result = matchSessionSearch(session, parsed);
      if (result.matches) {
        filtered.push(session);
      }
    }
    return filtered;
  }

  const scored: Array<{ session: SessionInfo; score: number }> = [];
  for (const session of nameFiltered) {
    const result = matchSessionSearch(session, parsed);
    if (!result.matches) continue;
    scored.push({ session, score: result.score });
  }

  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }
    return right.session.modified.getTime() - left.session.modified.getTime();
  });

  return scored.map((entry) => entry.session);
}

export interface AutoDashboardData {
  active: boolean;
  paused: boolean;
  stepMode: boolean;
  startTime: number;
  elapsed: number;
  currentUnit: { type: string; id: string; startedAt: number } | null;
  completedUnits: { type: string; id: string; startedAt: number; finishedAt: number }[];
  basePath: string;
  totalCost: number;
  totalTokens: number;
}

export interface BridgeLastError {
  message: string;
  at: string;
  phase: BridgeLifecyclePhase;
  afterSessionAttachment: boolean;
  commandType?: string;
}

export interface BridgeRuntimeSnapshot {
  phase: BridgeLifecyclePhase;
  projectCwd: string;
  projectSessionsDir: string;
  packageRoot: string;
  startedAt: string | null;
  updatedAt: string;
  connectionCount: number;
  lastCommandType: string | null;
  activeSessionId: string | null;
  activeSessionFile: string | null;
  sessionState: RpcSessionState | null;
  lastError: BridgeLastError | null;
}

export interface BridgeRuntimeConfig {
  projectCwd: string;
  projectSessionsDir: string;
  packageRoot: string;
}

export interface BootResumableSession {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  isActive: boolean;
}

export interface GSDWorkspaceTaskTarget {
  id: string;
  title: string;
  done: boolean;
  planPath?: string;
  summaryPath?: string;
}

export interface GSDWorkspaceSliceTarget {
  id: string;
  title: string;
  done: boolean;
  planPath?: string;
  summaryPath?: string;
  uatPath?: string;
  tasksDir?: string;
  branch?: string;
  tasks: GSDWorkspaceTaskTarget[];
}

export interface GSDWorkspaceMilestoneTarget {
  id: string;
  title: string;
  roadmapPath?: string;
  slices: GSDWorkspaceSliceTarget[];
}

export interface GSDWorkspaceScopeTarget {
  scope: string;
  label: string;
  kind: "project" | "milestone" | "slice" | "task";
}

export interface GSDWorkspaceIndex {
  milestones: GSDWorkspaceMilestoneTarget[];
  active: {
    milestoneId?: string;
    sliceId?: string;
    taskId?: string;
    phase: string;
  };
  scopes: GSDWorkspaceScopeTarget[];
  validationIssues: Array<Record<string, unknown>>;
}

export interface BridgeBootPayload {
  project: {
    cwd: string;
    sessionsDir: string;
    packageRoot: string;
  };
  workspace: GSDWorkspaceIndex;
  auto: AutoDashboardData;
  onboarding: OnboardingState;
  onboardingNeeded: boolean;
  resumableSessions: BootResumableSession[];
  bridge: BridgeRuntimeSnapshot;
}

export type BridgeStatusEvent = {
  type: "bridge_status";
  bridge: BridgeRuntimeSnapshot;
};

export type BridgeEvent = AgentSessionEvent | RpcExtensionUIRequest | BridgeExtensionErrorEvent | BridgeStatusEvent;

interface BridgeCliEntry {
  command: string;
  args: string[];
  cwd: string;
}

interface SpawnedRpcChild extends ChildProcess {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
}

interface PendingRpcRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface BridgeServiceDeps {
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  existsSync?: (path: string) => boolean;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  indexWorkspace?: (basePath: string) => Promise<GSDWorkspaceIndex>;
  getAutoDashboardData?: () => AutoDashboardData | Promise<AutoDashboardData>;
  listSessions?: (projectSessionsDir: string) => Promise<LocalSessionInfo[]>;
  getOnboardingState?: () => OnboardingState | Promise<OnboardingState>;
  getOnboardingNeeded?: (authPath: string, env: NodeJS.ProcessEnv) => boolean | Promise<boolean>;
}

type WorkspaceIndexCacheEntry = {
  value: GSDWorkspaceIndex | null;
  expiresAt: number;
  promise: Promise<GSDWorkspaceIndex> | null;
};

const defaultBridgeServiceDeps: BridgeServiceDeps = {
  spawn: (command, args, options) => spawn(command, args, options),
  existsSync,
  execPath: process.execPath,
  env: process.env,
  indexWorkspace: (basePath: string) => fallbackWorkspaceIndex(basePath),
  getAutoDashboardData: () => fallbackAutoDashboardData(),
  listSessions: async (projectSessionsDir: string) => listProjectSessions(projectSessionsDir),
};

let bridgeServiceOverrides: Partial<BridgeServiceDeps> | null = null;
let projectBridgeSingleton: { key: string; service: BridgeService } | null = null;
const workspaceIndexCache = new Map<string, WorkspaceIndexCacheEntry>();

async function loadSessionBrowserSessionsViaChildProcess(config: BridgeRuntimeConfig): Promise<SessionInfo[]> {
  const deps = getBridgeDeps();
  const sessionManagerModulePath = join(config.packageRoot, "packages", "pi-coding-agent", "dist", "core", "session-manager.js");
  const checkExists = deps.existsSync ?? existsSync;
  if (!checkExists(sessionManagerModulePath)) {
    throw new Error(`session manager module not found; checked=${sessionManagerModulePath}`);
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    'const mod = await import(pathToFileURL(process.env.GSD_SESSION_MANAGER_MODULE).href);',
    'const sessions = await mod.SessionManager.list(process.env.GSD_SESSION_BROWSER_CWD, process.env.GSD_SESSION_BROWSER_DIR);',
    'process.stdout.write(JSON.stringify(sessions.map((session) => ({ ...session, created: session.created.toISOString(), modified: session.modified.toISOString() }))));',
  ].join(" ");

  return await new Promise<SessionInfo[]>((resolveResult, reject) => {
    execFile(
      deps.execPath ?? process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: config.packageRoot,
        env: {
          ...(deps.env ?? process.env),
          GSD_SESSION_MANAGER_MODULE: sessionManagerModulePath,
          GSD_SESSION_BROWSER_CWD: config.projectCwd,
          GSD_SESSION_BROWSER_DIR: config.projectSessionsDir,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`session list subprocess failed: ${stderr || error.message}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as Array<Omit<SessionInfo, "created" | "modified"> & { created: string; modified: string }>;
          resolveResult(
            parsed.map((session) => ({
              ...session,
              created: new Date(session.created),
              modified: new Date(session.modified),
            })),
          );
        } catch (parseError) {
          reject(
            new Error(
              `session list subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          );
        }
      },
    );
  });
}

async function appendSessionInfoViaChildProcess(
  config: BridgeRuntimeConfig,
  sessionPath: string,
  name: string,
): Promise<void> {
  const deps = getBridgeDeps();
  const sessionManagerModulePath = join(config.packageRoot, "packages", "pi-coding-agent", "dist", "core", "session-manager.js");
  const checkExists = deps.existsSync ?? existsSync;
  if (!checkExists(sessionManagerModulePath)) {
    throw new Error(`session manager module not found; checked=${sessionManagerModulePath}`);
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    'const mod = await import(pathToFileURL(process.env.GSD_SESSION_MANAGER_MODULE).href);',
    'const manager = mod.SessionManager.open(process.env.GSD_TARGET_SESSION_PATH, process.env.GSD_SESSION_BROWSER_DIR);',
    'manager.appendSessionInfo(process.env.GSD_TARGET_SESSION_NAME);',
  ].join(" ");

  await new Promise<void>((resolveResult, reject) => {
    execFile(
      deps.execPath ?? process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: config.packageRoot,
        env: {
          ...(deps.env ?? process.env),
          GSD_SESSION_MANAGER_MODULE: sessionManagerModulePath,
          GSD_SESSION_BROWSER_DIR: config.projectSessionsDir,
          GSD_TARGET_SESSION_PATH: sessionPath,
          GSD_TARGET_SESSION_NAME: name,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`session rename subprocess failed: ${stderr || error.message}`));
          return;
        }
        resolveResult();
      },
    );
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function attachJsonLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emitLine = (line: string) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)["'=:\s]+)([^\s,;"']+)/gi, "$1[redacted]");
}

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(raw).replace(/\s+/g, " ").trim();
}

function captureStderr(buffer: string, chunk: string): string {
  const next = `${buffer}${chunk}`;
  return next.length <= MAX_STDERR_BUFFER ? next : next.slice(next.length - MAX_STDERR_BUFFER);
}

function buildExitMessage(code: number | null, signal: NodeJS.Signals | null, stderrBuffer: string): string {
  const base = `RPC bridge exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}`;
  const stderr = redactSensitiveText(stderrBuffer).trim();
  return stderr ? `${base}. stderr=${stderr}` : base;
}

function getBridgeDeps(): BridgeServiceDeps {
  return { ...defaultBridgeServiceDeps, ...(bridgeServiceOverrides ?? {}) };
}

function cloneWorkspaceIndex(index: GSDWorkspaceIndex): GSDWorkspaceIndex {
  return structuredClone(index);
}

function invalidateWorkspaceIndexCache(basePath?: string): void {
  if (basePath) {
    workspaceIndexCache.delete(basePath);
    return;
  }

  workspaceIndexCache.clear();
}

async function loadCachedWorkspaceIndex(
  basePath: string,
  loader: () => Promise<GSDWorkspaceIndex>,
): Promise<GSDWorkspaceIndex> {
  const cached = workspaceIndexCache.get(basePath);
  const now = Date.now();

  if (cached?.value && cached.expiresAt > now) {
    return cloneWorkspaceIndex(cached.value);
  }

  if (cached?.promise) {
    return cloneWorkspaceIndex(await cached.promise);
  }

  const promise = loader()
    .then((index) => {
      workspaceIndexCache.set(basePath, {
        value: cloneWorkspaceIndex(index),
        expiresAt: Date.now() + WORKSPACE_INDEX_CACHE_TTL_MS,
        promise: null,
      });
      return index;
    })
    .catch((error) => {
      workspaceIndexCache.delete(basePath);
      throw error;
    });

  workspaceIndexCache.set(basePath, {
    value: cached?.value ?? null,
    expiresAt: 0,
    promise,
  });

  return cloneWorkspaceIndex(await promise);
}

async function loadWorkspaceIndexViaChildProcess(basePath: string, packageRoot: string): Promise<GSDWorkspaceIndex> {
  const deps = getBridgeDeps();
  const resolveTsLoader = join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
  const workspaceModulePath = join(packageRoot, "src", "resources", "extensions", "gsd", "workspace-index.ts");
  const checkExists = deps.existsSync ?? existsSync;
  if (!checkExists(resolveTsLoader) || !checkExists(workspaceModulePath)) {
    throw new Error(`workspace index loader not found; checked=${resolveTsLoader},${workspaceModulePath}`);
  }

  const script = [
    'const { pathToFileURL } = await import("node:url");',
    'const mod = await import(pathToFileURL(process.env.GSD_WORKSPACE_MODULE).href);',
    'const result = await mod.indexWorkspace(process.env.GSD_WORKSPACE_BASE);',
    'process.stdout.write(JSON.stringify(result));',
  ].join(' ');

  return await new Promise<GSDWorkspaceIndex>((resolveResult, reject) => {
    execFile(
      deps.execPath ?? process.execPath,
      [
        "--import",
        resolveTsLoader,
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: packageRoot,
        env: {
          ...(deps.env ?? process.env),
          GSD_WORKSPACE_MODULE: workspaceModulePath,
          GSD_WORKSPACE_BASE: basePath,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`workspace index subprocess failed: ${stderr || error.message}`));
          return;
        }

        try {
          resolveResult(JSON.parse(stdout) as GSDWorkspaceIndex);
        } catch (parseError) {
          reject(new Error(`workspace index subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
        }
      },
    );
  });
}

function legacyOnboardingStateFromNeeded(onboardingNeeded: boolean): OnboardingState {
  return {
    status: onboardingNeeded ? "blocked" : "ready",
    locked: onboardingNeeded,
    lockReason: onboardingNeeded ? "required_setup" : null,
    required: {
      blocking: true,
      skippable: false,
      satisfied: !onboardingNeeded,
      satisfiedBy: onboardingNeeded ? null : { providerId: "legacy", source: "runtime" },
      providers: [],
    },
    optional: {
      blocking: false,
      skippable: true,
      sections: [],
    },
    lastValidation: null,
    activeFlow: null,
    bridgeAuthRefresh: {
      phase: "idle",
      strategy: null,
      startedAt: null,
      completedAt: null,
      error: null,
    },
  };
}

function parseSessionInfo(path: string): LocalSessionInfo | null {
  try {
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    let id = "";
    let cwd = "";
    let name: string | undefined;
    let created = statSync(path).birthtime;
    let messageCount = 0;

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "session") {
        id = typeof parsed.id === "string" ? parsed.id : id;
        cwd = typeof parsed.cwd === "string" ? parsed.cwd : cwd;
        if (typeof parsed.timestamp === "string") {
          created = new Date(parsed.timestamp);
        }
      } else if (parsed.type === "session_info" && typeof parsed.name === "string") {
        name = parsed.name;
      } else if (parsed.type === "message") {
        messageCount += 1;
      }
    }

    if (!id) return null;

    return {
      path,
      id,
      cwd,
      name,
      created,
      modified: statSync(path).mtime,
      messageCount,
    };
  } catch {
    return null;
  }
}

function listProjectSessions(projectSessionsDir: string): LocalSessionInfo[] {
  if (!existsSync(projectSessionsDir)) return [];
  const sessions = readdirSync(projectSessionsDir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => parseSessionInfo(join(projectSessionsDir, entry)))
    .filter((entry): entry is LocalSessionInfo => entry !== null);

  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

async function fallbackAutoDashboardData(): Promise<AutoDashboardData> {
  return {
    active: false,
    paused: false,
    stepMode: false,
    startTime: 0,
    elapsed: 0,
    currentUnit: null,
    completedUnits: [],
    basePath: "",
    totalCost: 0,
    totalTokens: 0,
  };
}

async function fallbackWorkspaceIndex(basePath: string): Promise<GSDWorkspaceIndex> {
  const packageRoot = resolveBridgeRuntimeConfig().packageRoot;
  return await loadWorkspaceIndexViaChildProcess(basePath, packageRoot);
}

export function resolveBridgeRuntimeConfig(env: NodeJS.ProcessEnv = getBridgeDeps().env ?? process.env): BridgeRuntimeConfig {
  const projectCwd = env.GSD_WEB_PROJECT_CWD || process.cwd();
  const projectSessionsDir = env.GSD_WEB_PROJECT_SESSIONS_DIR || getProjectSessionsDir(projectCwd);
  const packageRoot = env.GSD_WEB_PACKAGE_ROOT || DEFAULT_PACKAGE_ROOT;
  return { projectCwd, projectSessionsDir, packageRoot };
}

function resolveBridgeCliEntry(config: BridgeRuntimeConfig, deps: BridgeServiceDeps): BridgeCliEntry {
  const checkExists = deps.existsSync ?? existsSync;
  const execPath = deps.execPath ?? process.execPath;
  const sourceEntry = join(config.packageRoot, "src", "loader.ts");
  const resolveTsLoader = join(config.packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
  if (checkExists(sourceEntry) && checkExists(resolveTsLoader)) {
    return {
      command: execPath,
      args: [
        "--import",
        resolveTsLoader,
        "--experimental-strip-types",
        sourceEntry,
        "--mode",
        "rpc",
        "--continue",
        "--session-dir",
        config.projectSessionsDir,
      ],
      cwd: config.projectCwd,
    };
  }

  const builtEntry = join(config.packageRoot, "dist", "loader.js");
  if (checkExists(builtEntry)) {
    return {
      command: execPath,
      args: [builtEntry, "--mode", "rpc", "--continue", "--session-dir", config.projectSessionsDir],
      cwd: config.projectCwd,
    };
  }

  throw new Error(`RPC bridge entry not found; checked=${sourceEntry},${builtEntry}`);
}

function isRpcExtensionUiResponse(input: BridgeInput): input is RpcExtensionUIResponse {
  return input.type === "extension_ui_response";
}

function isReadOnlyBridgeInput(input: BridgeInput): boolean {
  if (isRpcExtensionUiResponse(input)) {
    return false;
  }
  return READ_ONLY_RPC_COMMAND_TYPES.has(input.type);
}

function buildBridgeLockedResponse(input: BridgeInput, onboarding: OnboardingState): BridgeCommandFailureResponse {
  const reason = onboarding.lockReason ?? "required_setup";
  const error =
    reason === "bridge_refresh_failed"
      ? "Workspace is locked because bridge auth refresh failed after setup"
      : reason === "bridge_refresh_pending"
        ? "Workspace is still locked while bridge auth refresh completes"
        : "Workspace is locked until required onboarding completes";

  return {
    type: "response",
    command: input.type,
    success: false,
    error,
    code: "onboarding_locked",
    details: {
      reason,
      onboarding: {
        locked: onboarding.locked,
        lockReason: onboarding.lockReason,
        required: onboarding.required,
        lastValidation: onboarding.lastValidation,
        bridgeAuthRefresh: onboarding.bridgeAuthRefresh,
      },
    },
  };
}

function sanitizeRpcResponse(response: RpcResponse): RpcResponse {
  if (response.success) return response;
  return { ...response, error: redactSensitiveText(response.error) } satisfies RpcResponse;
}

function sanitizeEventPayload(payload: unknown): BridgeEvent {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    (payload as { type?: string }).type === "extension_error"
  ) {
    const extensionError = payload as BridgeExtensionErrorEvent;
    return { ...extensionError, error: redactSensitiveText(extensionError.error) };
  }
  return payload as BridgeEvent;
}

export class BridgeService {
  private readonly subscribers = new Set<(event: BridgeEvent) => void>();
  private readonly pendingRequests = new Map<string, PendingRpcRequest>();
  private readonly config: BridgeRuntimeConfig;
  private readonly deps: BridgeServiceDeps;
  private process: SpawnedRpcChild | null = null;
  private detachStdoutReader: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private authRefreshPromise: Promise<void> | null = null;
  private requestCounter = 0;
  private stderrBuffer = "";
  private snapshot: BridgeRuntimeSnapshot;

  constructor(config: BridgeRuntimeConfig, deps: BridgeServiceDeps) {
    this.config = config;
    this.deps = deps;
    this.snapshot = {
      phase: "idle",
      projectCwd: config.projectCwd,
      projectSessionsDir: config.projectSessionsDir,
      packageRoot: config.packageRoot,
      startedAt: null,
      updatedAt: nowIso(),
      connectionCount: 0,
      lastCommandType: null,
      activeSessionId: null,
      activeSessionFile: null,
      sessionState: null,
      lastError: null,
    };
  }

  getSnapshot(): BridgeRuntimeSnapshot {
    return structuredClone(this.snapshot);
  }

  async ensureStarted(): Promise<void> {
    if (this.process && this.snapshot.phase === "ready") return;
    if (this.startPromise) return await this.startPromise;

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async sendInput(input: BridgeInput): Promise<RpcResponse | null> {
    await this.ensureStarted();
    if (!this.process?.stdin) {
      throw new Error(this.snapshot.lastError?.message || "RPC bridge is not connected");
    }

    if (isRpcExtensionUiResponse(input)) {
      this.process.stdin.write(serializeJsonLine(input));
      return null;
    }

    const response = sanitizeRpcResponse(await this.requestResponse(input));
    this.snapshot.lastCommandType = input.type;
    this.snapshot.updatedAt = nowIso();

    if (!response.success) {
      this.recordError(response.error, this.snapshot.phase, { commandType: input.type });
      this.broadcastStatus();
      return response;
    }

    if (input.type === "get_state") {
      this.applySessionState(response.data);
      this.broadcastStatus();
      return response;
    }

    void this.queueStateRefresh();
    this.broadcastStatus();
    return response;
  }

  async refreshAuth(): Promise<void> {
    if (this.authRefreshPromise) {
      return await this.authRefreshPromise;
    }

    this.authRefreshPromise = this.refreshAuthInternal().finally(() => {
      this.authRefreshPromise = null;
    });

    await this.authRefreshPromise;
  }

  private async refreshAuthInternal(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
    }

    if (this.process && this.snapshot.phase === "ready") {
      this.resetProcessForAuthRefresh();
    }

    await this.ensureStarted();
  }

  private resetProcessForAuthRefresh(): void {
    const child = this.process;
    this.process = null;
    this.detachStdoutReader?.();
    this.detachStdoutReader = null;
    this.stderrBuffer = "";

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("RPC bridge restarting to reload auth"));
    }
    this.pendingRequests.clear();

    if (child) {
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      child.kill("SIGTERM");
    }

    this.snapshot.phase = "idle";
    this.snapshot.updatedAt = nowIso();
    this.snapshot.lastError = null;
    this.broadcastStatus();
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.subscribers.add(listener);
    this.snapshot.connectionCount = this.subscribers.size;
    this.snapshot.updatedAt = nowIso();
    this.broadcastStatus();

    return () => {
      this.subscribers.delete(listener);
      this.snapshot.connectionCount = this.subscribers.size;
      this.snapshot.updatedAt = nowIso();
      if (this.subscribers.size > 0) {
        this.broadcastStatus();
      }
    };
  }

  async dispose(): Promise<void> {
    this.detachStdoutReader?.();
    this.detachStdoutReader = null;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("RPC bridge disposed"));
    }
    this.pendingRequests.clear();
    if (this.process) {
      this.process.removeAllListeners();
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.snapshot.phase = "idle";
    this.snapshot.connectionCount = 0;
    this.snapshot.updatedAt = nowIso();
  }

  private async startInternal(): Promise<void> {
    this.snapshot.phase = "starting";
    this.snapshot.startedAt = nowIso();
    this.snapshot.updatedAt = this.snapshot.startedAt;
    this.snapshot.lastError = null;
    this.broadcastStatus();

    let cliEntry: BridgeCliEntry;
    try {
      cliEntry = resolveBridgeCliEntry(this.config, this.deps);
    } catch (error) {
      this.snapshot.phase = "failed";
      this.recordError(error, "starting");
      throw error;
    }

    const spawnChild = this.deps.spawn ?? ((command, args, options) => spawn(command, args, options));
    const childEnv = { ...(this.deps.env ?? process.env) };
    delete childEnv.GSD_CODING_AGENT_DIR;

    const child = spawnChild(cliEntry.command, cliEntry.args, {
      cwd: cliEntry.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }) as SpawnedRpcChild;

    this.process = child;
    this.stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer = captureStderr(this.stderrBuffer, chunk.toString());
    });
    this.detachStdoutReader = attachJsonLineReader(child.stdout, (line) => this.handleStdoutLine(line));
    child.once("exit", (code, signal) => this.handleProcessExit(code, signal));
    child.once("error", (error) => this.handleProcessExit(null, null, error));

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`RPC bridge startup timed out after ${START_TIMEOUT_MS}ms`)), START_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.refreshState(true), timeout]);
      this.snapshot.phase = "ready";
      this.snapshot.updatedAt = nowIso();
      this.snapshot.lastError = null;
      this.broadcastStatus();
    } catch (error) {
      this.snapshot.phase = "failed";
      this.recordError(error, "starting");
      this.broadcastStatus();
      throw error;
    }
  }

  private async queueStateRefresh(): Promise<void> {
    if (this.refreshPromise) return await this.refreshPromise;
    this.refreshPromise = this.refreshState(false)
      .catch((error) => {
        this.recordError(error, this.snapshot.phase, { commandType: "get_state" });
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    await this.refreshPromise;
  }

  private async refreshState(strict: boolean): Promise<void> {
    const response = sanitizeRpcResponse(await this.requestResponse({ type: "get_state" }));
    if (!response.success) {
      throw new Error(response.error);
    }
    this.applySessionState(response.data);
    this.snapshot.updatedAt = nowIso();
    if (!strict) {
      this.broadcastStatus();
    }
  }

  private applySessionState(state: RpcSessionState): void {
    this.snapshot.sessionState = state;
    this.snapshot.activeSessionId = state.sessionId;
    this.snapshot.activeSessionFile = state.sessionFile ?? null;
  }

  private requestResponse(command: RpcCommand): Promise<RpcResponse> {
    if (!this.process?.stdin) {
      return Promise.reject(new Error("RPC bridge is not connected"));
    }

    const id = command.id ?? `web_${++this.requestCounter}`;
    const payload = { ...command, id } satisfies RpcCommand;

    return new Promise<RpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for RPC response to ${payload.type}`));
      }, RESPONSE_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });

      this.process!.stdin.write(serializeJsonLine(payload));
    });
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      (parsed as { type?: string }).type === "response"
    ) {
      const response = sanitizeRpcResponse(parsed as RpcResponse);
      if (response.id && this.pendingRequests.has(response.id)) {
        const pending = this.pendingRequests.get(response.id)!;
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
        return;
      }
    }

    const event = sanitizeEventPayload(parsed);
    this.emit(event);
    if (
      typeof event === "object" &&
      event !== null &&
      "type" in event
    ) {
      const eventType = (event as { type?: string }).type;
      if (
        eventType === "agent_end" ||
        eventType === "auto_retry_start" ||
        eventType === "auto_retry_end" ||
        eventType === "auto_compaction_start" ||
        eventType === "auto_compaction_end"
      ) {
        void this.queueStateRefresh();
      }
    }
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null, error?: unknown): void {
    this.detachStdoutReader?.();
    this.detachStdoutReader = null;
    this.process = null;

    const exitError = new Error(buildExitMessage(code, signal, this.stderrBuffer));
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(exitError);
    }
    this.pendingRequests.clear();

    this.snapshot.phase = "failed";
    this.snapshot.updatedAt = nowIso();
    this.recordError(error ?? exitError, this.snapshot.activeSessionId ? "ready" : "starting");
    this.broadcastStatus();
  }

  private recordError(error: unknown, phase: BridgeLifecyclePhase, options: { commandType?: string } = {}): void {
    this.snapshot.lastError = {
      message: sanitizeErrorMessage(error),
      at: nowIso(),
      phase,
      afterSessionAttachment: Boolean(this.snapshot.activeSessionId),
      commandType: options.commandType,
    };
    this.snapshot.updatedAt = this.snapshot.lastError.at;
  }

  private emit(event: BridgeEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // Subscriber failures should not break delivery.
      }
    }
  }

  private broadcastStatus(): void {
    if (this.subscribers.size === 0) return;
    this.emit({ type: "bridge_status", bridge: this.getSnapshot() });
  }
}

export function getProjectBridgeService(): BridgeService {
  const deps = getBridgeDeps();
  const config = resolveBridgeRuntimeConfig(deps.env ?? process.env);
  const key = `${config.projectCwd}::${config.projectSessionsDir}::${config.packageRoot}`;

  if (projectBridgeSingleton && projectBridgeSingleton.key === key) {
    return projectBridgeSingleton.service;
  }

  if (projectBridgeSingleton) {
    void projectBridgeSingleton.service.dispose();
  }

  const service = new BridgeService(config, deps);
  projectBridgeSingleton = { key, service };
  return service;
}

function toBootResumableSession(session: LocalSessionInfo, activeSessionFile: string | null): BootResumableSession {
  return {
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    name: session.name,
    createdAt: session.created.toISOString(),
    modifiedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    isActive: Boolean(activeSessionFile && session.path === activeSessionFile),
  };
}

function buildSessionBrowserTree(sessions: SessionInfo[]): SessionBrowserTreeNode[] {
  const byPath = new Map<string, SessionBrowserTreeNode>();

  for (const session of sessions) {
    byPath.set(session.path, { session, children: [] });
  }

  const roots: SessionBrowserTreeNode[] = [];

  for (const session of sessions) {
    const node = byPath.get(session.path);
    if (!node) continue;

    const parentPath = session.parentSessionPath;
    if (parentPath && byPath.has(parentPath)) {
      byPath.get(parentPath)!.children.push(node);
      continue;
    }

    roots.push(node);
  }

  const sortNodes = (nodes: SessionBrowserTreeNode[]): void => {
    nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };

  sortNodes(roots);
  return roots;
}

function flattenSessionBrowserTree(roots: SessionBrowserTreeNode[]): FlatSessionBrowserNode[] {
  const result: FlatSessionBrowserNode[] = [];

  const walk = (
    node: SessionBrowserTreeNode,
    depth: number,
    ancestorHasNextSibling: boolean[],
    isLastInThread: boolean,
  ): void => {
    result.push({
      session: node.session,
      depth,
      isLastInThread,
      ancestorHasNextSibling,
    });

    for (let index = 0; index < node.children.length; index++) {
      const child = node.children[index];
      if (!child) continue;
      const childIsLast = index === node.children.length - 1;
      const continues = depth > 0 ? !isLastInThread : false;
      walk(child, depth + 1, [...ancestorHasNextSibling, continues], childIsLast);
    }
  };

  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root) continue;
    walk(root, 0, [], index === roots.length - 1);
  }

  return result;
}

function toSessionBrowserSession(
  node: FlatSessionBrowserNode,
  activeSessionFile: string | null,
): SessionBrowserSession {
  const { session } = node;
  const isActive = Boolean(activeSessionFile && resolve(session.path) === resolve(activeSessionFile));
  return {
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    name: session.name,
    createdAt: session.created.toISOString(),
    modifiedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    parentSessionPath: session.parentSessionPath,
    firstMessage: session.firstMessage,
    isActive,
    depth: node.depth,
    isLastInThread: node.isLastInThread,
    ancestorHasNextSibling: [...node.ancestorHasNextSibling],
  };
}

function buildFlatSessionBrowserNodes(
  sessions: SessionInfo[],
  query: ReturnType<typeof normalizeSessionBrowserQuery>,
): FlatSessionBrowserNode[] {
  if (query.sortMode === "threaded" && !query.query) {
    const filteredSessions = query.nameFilter === "named" ? sessions.filter((session) => hasSessionName(session)) : sessions;
    return flattenSessionBrowserTree(buildSessionBrowserTree(filteredSessions));
  }

  return filterAndSortSessions(sessions, query.query, query.sortMode, query.nameFilter).map((session) => ({
    session,
    depth: 0,
    isLastInThread: true,
    ancestorHasNextSibling: [],
  }));
}

function findCurrentProjectSession(sessions: SessionInfo[], sessionPath: string): SessionInfo | undefined {
  const normalizedPath = resolve(sessionPath);
  return sessions.find((session) => resolve(session.path) === normalizedPath);
}

function buildSessionManageError(
  code: SessionManageErrorCode,
  error: string,
  details: Partial<SessionManageResponse> = {},
): SessionManageResponse {
  return {
    success: false,
    action: "rename",
    scope: SESSION_BROWSER_SCOPE,
    code,
    error,
    ...details,
  };
}

export async function collectSessionBrowserPayload(query: SessionBrowserQuery = {}): Promise<SessionBrowserResponse> {
  const deps = getBridgeDeps();
  const env = deps.env ?? process.env;
  const config = resolveBridgeRuntimeConfig(env);
  const bridge = getProjectBridgeService();

  try {
    await bridge.ensureStarted();
  } catch {
    // Session browsing can still fall back to the current project session directory.
  }

  const bridgeSnapshot = bridge.getSnapshot();
  const sessions = await loadSessionBrowserSessionsViaChildProcess(config);
  const normalizedQuery = normalizeSessionBrowserQuery(query);
  const browserSessions = buildFlatSessionBrowserNodes(sessions, normalizedQuery).map((node) =>
    toSessionBrowserSession(node, bridgeSnapshot.activeSessionFile),
  );

  return {
    project: {
      scope: SESSION_BROWSER_SCOPE,
      cwd: config.projectCwd,
      sessionsDir: config.projectSessionsDir,
      activeSessionPath: bridgeSnapshot.activeSessionFile,
    },
    query: normalizedQuery,
    totalSessions: sessions.length,
    returnedSessions: browserSessions.length,
    sessions: browserSessions,
  };
}

export async function renameSessionInCurrentProject(request: RenameSessionRequest): Promise<SessionManageResponse> {
  const deps = getBridgeDeps();
  const env = deps.env ?? process.env;
  const config = resolveBridgeRuntimeConfig(env);
  const nextName = request.name.trim();

  if (!nextName) {
    return buildSessionManageError("invalid_request", "Session name cannot be empty", {
      sessionPath: request.sessionPath,
      name: request.name,
    });
  }

  const sessions = await loadSessionBrowserSessionsViaChildProcess(config);
  const targetSession = findCurrentProjectSession(sessions, request.sessionPath);
  if (!targetSession) {
    return buildSessionManageError("not_found", "Session is not available in the current project browser", {
      sessionPath: request.sessionPath,
      name: nextName,
    });
  }

  const bridge = getProjectBridgeService();
  try {
    await bridge.ensureStarted();
  } catch (error) {
    return buildSessionManageError("rename_failed", sanitizeErrorMessage(error), {
      sessionPath: targetSession.path,
      name: nextName,
    });
  }

  const activeSessionFile = bridge.getSnapshot().activeSessionFile;
  const isActiveSession = Boolean(activeSessionFile && resolve(activeSessionFile) === resolve(targetSession.path));

  if (isActiveSession) {
    const response = await sendBridgeInput({ type: "set_session_name", name: nextName });
    if (response === null) {
      return buildSessionManageError("rename_failed", "Active session rename did not return a response", {
        sessionPath: targetSession.path,
        name: nextName,
        isActiveSession: true,
        mutation: "rpc",
      });
    }

    if (!response.success) {
      return buildSessionManageError(
        response.code === "onboarding_locked" ? "onboarding_locked" : "rename_failed",
        response.error,
        {
          sessionPath: targetSession.path,
          name: nextName,
          isActiveSession: true,
          mutation: "rpc",
        },
      );
    }

    return {
      success: true,
      action: "rename",
      scope: SESSION_BROWSER_SCOPE,
      sessionPath: targetSession.path,
      name: nextName,
      isActiveSession: true,
      mutation: "rpc",
    };
  }

  try {
    await appendSessionInfoViaChildProcess(config, targetSession.path, nextName);
    return {
      success: true,
      action: "rename",
      scope: SESSION_BROWSER_SCOPE,
      sessionPath: targetSession.path,
      name: nextName,
      isActiveSession: false,
      mutation: "session_file",
    };
  } catch (error) {
    return buildSessionManageError("rename_failed", sanitizeErrorMessage(error), {
      sessionPath: targetSession.path,
      name: nextName,
      isActiveSession: false,
      mutation: "session_file",
    });
  }
}

async function resolveBootOnboardingState(deps: BridgeServiceDeps, env: NodeJS.ProcessEnv): Promise<OnboardingState> {
  if (deps.getOnboardingState) {
    return await deps.getOnboardingState();
  }
  if (deps.getOnboardingNeeded) {
    return legacyOnboardingStateFromNeeded(await deps.getOnboardingNeeded(authFilePath, env));
  }
  return await collectOnboardingState();
}

export async function collectBootPayload(): Promise<BridgeBootPayload> {
  const deps = getBridgeDeps();
  const env = deps.env ?? process.env;
  const config = resolveBridgeRuntimeConfig(env);
  const bridge = getProjectBridgeService();

  const workspacePromise = loadCachedWorkspaceIndex(
    config.projectCwd,
    async () => await (deps.indexWorkspace ?? fallbackWorkspaceIndex)(config.projectCwd),
  );
  const auto = await (deps.getAutoDashboardData ?? fallbackAutoDashboardData)();
  const onboarding = await resolveBootOnboardingState(deps, env);

  try {
    await bridge.ensureStarted();
  } catch {
    // Boot still returns the bridge failure snapshot for inspection.
  }

  const bridgeSnapshot = bridge.getSnapshot();
  const sessions = await (deps.listSessions ?? (async (dir: string) => listProjectSessions(dir)))(config.projectSessionsDir);

  return {
    project: {
      cwd: config.projectCwd,
      sessionsDir: config.projectSessionsDir,
      packageRoot: config.packageRoot,
    },
    workspace: await workspacePromise,
    auto,
    onboarding,
    onboardingNeeded: onboarding.locked,
    resumableSessions: sessions.map((session) => toBootResumableSession(session, bridgeSnapshot.activeSessionFile)),
    bridge: bridgeSnapshot,
  };
}

export function buildBridgeFailureResponse(commandType: string, error: unknown): BridgeCommandFailureResponse {
  return {
    type: "response",
    command: commandType,
    success: false,
    error: sanitizeErrorMessage(error),
  };
}

export async function refreshProjectBridgeAuth(): Promise<void> {
  await getProjectBridgeService().refreshAuth();
}

export async function sendBridgeInput(input: BridgeInput): Promise<RpcResponse | null> {
  if (!isReadOnlyBridgeInput(input)) {
    const onboarding = await collectOnboardingState();
    if (onboarding.locked) {
      return buildBridgeLockedResponse(input, onboarding);
    }
  }

  return await getProjectBridgeService().sendInput(input);
}

export function configureBridgeServiceForTests(overrides: Partial<BridgeServiceDeps> | null): void {
  bridgeServiceOverrides = overrides;
  invalidateWorkspaceIndexCache();
}

export async function resetBridgeServiceForTests(): Promise<void> {
  if (projectBridgeSingleton) {
    await projectBridgeSingleton.service.dispose();
  }
  projectBridgeSingleton = null;
  bridgeServiceOverrides = null;
  invalidateWorkspaceIndexCache();
}
