/**
 * MCP Server — registers GSD orchestration, project-state, and workflow tools.
 *
 * Session tools (6): gsd_execute, gsd_status, gsd_result, gsd_cancel, gsd_query, gsd_resolve_blocker
 * Interactive tools (2): ask_user_questions, secure_env_collect via MCP form elicitation
 * Read-only tools (6): gsd_progress, gsd_roadmap, gsd_history, gsd_doctor, gsd_captures, gsd_knowledge
 * Workflow tools (29): headless-safe planning, metadata persistence, replanning, completion, validation, reassessment, gate result, status, and journal tools
 *
 * Uses dynamic imports for @modelcontextprotocol/sdk because TS Node16
 * cannot resolve the SDK's subpath exports statically (same pattern as
 * src/mcp-server.ts in the main package).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { SessionManager } from './session-manager.js';
import { isRemoteConfigured, tryRemoteQuestions } from './remote-questions.js';
import { readProgress } from './readers/state.js';
import { readRoadmap } from './readers/roadmap.js';
import { readHistory } from './readers/metrics.js';
import { readCaptures } from './readers/captures.js';
import { readKnowledge } from './readers/knowledge.js';
import { buildGraph, writeGraph, writeSnapshot, graphStatus, graphQuery, graphDiff } from './readers/graph.js';
import { resolveGsdRoot } from './readers/paths.js';
import { runDoctorLite } from './readers/doctor-lite.js';
import { registerWorkflowTools, validateProjectDir } from './workflow-tools.js';
import { applySecrets, checkExistingEnvKeys, detectDestination, resolveProjectEnvFilePath } from './env-writer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_PKG = '@modelcontextprotocol/sdk';
const SERVER_NAME = 'gsd';
const SERVER_VERSION = '2.53.0';

/** User-interaction timeout — generous but bounded so elicitation can't hang indefinitely (#4586). */
const ELICIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Default child-process runner used by secure_env_collect to push secrets
 * into `vercel env add` / `npx convex env set`. Previously `applySecrets`
 * was called without an `execFn`, so vercel/convex destinations silently
 * dropped every collected key. This restores the write path.
 */
function defaultExecFn(
  cmd: string,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise((res) => {
    // stdin: ignore — avoids hanging if the child ever prompts interactively.
    // stdout: ignore — consumer only cares about stderr + exit code, and an
    //   un-drained pipe deadlocks once the kernel buffer (~64KB) fills.
    // stderr: pipe — captured below for error surfacing.
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => res({ code: 1, stderr: err.message }));
    child.on('close', (code) => res({ code: code ?? 1, stderr }));
  });
}

/**
 * Race a promise against a timeout. Rejects with a typed error on timeout so
 * callers can return a specific MCP error response rather than hanging.
 *
 * @param timeoutMs - override for testing; defaults to ELICIT_TIMEOUT_MS
 */
export async function withElicitTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = ELICIT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs / 60000} minutes — no user response received`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

/** Wrap a JSON-serializable value as MCP tool content. */
function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Return an MCP error response. */
function errorContent(message: string): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/** Return raw text content without JSON wrapping. */
function textContent(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text }] };
}

// ---------------------------------------------------------------------------
// gsd_query filesystem reader
// ---------------------------------------------------------------------------

/**
 * Normalized query categories for {@link readProjectState}.
 *
 * Maps user-supplied query strings (or empty) to the set of fields we return.
 * Accepts common synonyms so the MCP client can pass intuitive values.
 */
const QUERY_FIELDS = {
  all: ['state', 'project', 'requirements', 'milestones'] as const,
  state: ['state'] as const,
  status: ['state'] as const,
  project: ['project'] as const,
  requirements: ['requirements'] as const,
  milestones: ['milestones'] as const,
} as const;

type QueryCategory = keyof typeof QUERY_FIELDS;
type ProjectStateField = (typeof QUERY_FIELDS)[QueryCategory][number];

function normalizeQuery(query: string | undefined): QueryCategory {
  const key = (query ?? 'all').trim().toLowerCase();
  if (key in QUERY_FIELDS) return key as QueryCategory;
  return 'all';
}

async function readProjectState(projectDir: string, query: string | undefined): Promise<Record<string, unknown>> {
  const gsdDir = join(resolve(projectDir), '.gsd');
  const category = normalizeQuery(query);
  const wanted = new Set<ProjectStateField>(QUERY_FIELDS[category]);

  const result: Record<string, unknown> = {
    projectDir: resolve(projectDir),
    query: category,
  };

  if (wanted.has('state')) {
    try {
      result.state = await readFile(join(gsdDir, 'STATE.md'), 'utf-8');
    } catch {
      result.state = null;
    }
  }

  if (wanted.has('project')) {
    try {
      result.project = await readFile(join(gsdDir, 'PROJECT.md'), 'utf-8');
    } catch {
      result.project = null;
    }
  }

  if (wanted.has('requirements')) {
    try {
      result.requirements = await readFile(join(gsdDir, 'REQUIREMENTS.md'), 'utf-8');
    } catch {
      result.requirements = null;
    }
  }

  if (wanted.has('milestones')) {
    const milestonesDir = join(gsdDir, 'milestones');
    try {
      const entries = await readdir(milestonesDir, { withFileTypes: true });
      const milestones: Array<{ id: string; hasRoadmap: boolean; hasSummary: boolean }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const mDir = join(milestonesDir, entry.name);
        const hasRoadmap = await fileExists(join(mDir, `${entry.name}-ROADMAP.md`));
        const hasSummary = await fileExists(join(mDir, `${entry.name}-SUMMARY.md`));
        milestones.push({ id: entry.name, hasRoadmap, hasSummary });
      }
      result.milestones = milestones;
    } catch {
      result.milestones = [];
    }
  }

  return result;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MCP Server type — minimal interface for the dynamically-imported McpServer
// ---------------------------------------------------------------------------

interface ElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}

interface ElicitRequestFormParams {
  mode?: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

/**
 * Handler extra — the second argument passed by McpServer.tool handlers.
 * Contains an AbortSignal scoped to the JSON-RPC request (cancelled when
 * the client cancels the `tools/call`) plus other per-request metadata.
 * Tools that can actually be stopped mid-flight should honour `signal`.
 */
export interface McpToolExtra {
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: unknown) => void | Promise<void>;
}

interface McpServerInstance {
  tool(
    name: string,
    description: string,
    params: Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra?: McpToolExtra) => Promise<unknown>,
  ): unknown;
  server: {
    elicitInput(
      params: AskUserQuestionsElicitRequest | ElicitRequestFormParams,
      options?: unknown,
    ): Promise<AskUserQuestionsElicitResult>;
  };
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

interface AskUserQuestionOption {
  label: string;
  description: string;
}

interface AskUserQuestion {
  id: string;
  header: string;
  question: string;
  options: AskUserQuestionOption[];
  allowMultiple?: boolean;
}

interface AskUserQuestionsParams {
  questions: AskUserQuestion[];
}

type AskUserQuestionsContentValue = string | number | boolean | string[];

interface AskUserQuestionsElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, AskUserQuestionsContentValue>;
}

interface AskUserQuestionsElicitRequest {
  mode: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

const OTHER_OPTION_LABEL = 'None of the above';

function normalizeAskUserQuestionsNote(value: AskUserQuestionsContentValue | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAskUserQuestionsAnswers(
  value: AskUserQuestionsContentValue | undefined,
  allowMultiple: boolean,
): string[] {
  if (allowMultiple) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function validateAskUserQuestionsPayload(questions: AskUserQuestion[]): string | null {
  if (questions.length === 0 || questions.length > 3) {
    return 'Error: questions must contain 1-3 items';
  }

  for (const question of questions) {
    if (!question.options || question.options.length === 0) {
      return `Error: ask_user_questions requires non-empty options for every question (question "${question.id}" has none)`;
    }
  }

  return null;
}

export function buildAskUserQuestionsElicitRequest(questions: AskUserQuestion[]): AskUserQuestionsElicitRequest {
  const properties: Record<string, Record<string, unknown>> = {};
  const required = questions.map((question) => question.id);

  for (const question of questions) {
    if (question.allowMultiple) {
      properties[question.id] = {
        type: 'array',
        title: question.header,
        description: question.question,
        minItems: 1,
        maxItems: question.options.length,
        items: {
          anyOf: question.options.map((option) => ({
            const: option.label,
            title: option.label,
          })),
        },
      };
      continue;
    }

    properties[question.id] = {
      type: 'string',
      title: question.header,
      description: question.question,
      oneOf: [...question.options, { label: OTHER_OPTION_LABEL, description: 'Choose this when the listed options do not fit.' }].map((option) => ({
        const: option.label,
        title: option.label,
      })),
    };

    properties[`${question.id}__note`] = {
      type: 'string',
      title: `${question.header} Note`,
      description: `Optional note for "${OTHER_OPTION_LABEL}".`,
      maxLength: 500,
    };
  }

  return {
    mode: 'form',
    message: 'Please answer the following question(s). For single-select questions, choose "None of the above" and add a note if the provided options do not fit.',
    requestedSchema: {
      type: 'object',
      properties,
      required,
    },
  };
}

export function formatAskUserQuestionsElicitResult(
  questions: AskUserQuestion[],
  result: AskUserQuestionsElicitResult,
): string {
  const answers: Record<string, { answers: string[] }> = {};
  const content = result.content ?? {};

  for (const question of questions) {
    const answerList = normalizeAskUserQuestionsAnswers(content[question.id], !!question.allowMultiple);

    if (!question.allowMultiple && answerList[0] === OTHER_OPTION_LABEL) {
      const note = normalizeAskUserQuestionsNote(content[`${question.id}__note`]);
      if (note) {
        answerList.push(`user_note: ${note}`);
      }
    }

    answers[question.id] = { answers: answerList };
  }

  return JSON.stringify({ answers });
}

// ---------------------------------------------------------------------------
// createMcpServer
// ---------------------------------------------------------------------------

/**
 * Create and configure an MCP server with session, read-only, and workflow tools.
 *
 * Returns the McpServer instance — call `connect(transport)` to start serving.
 * Uses dynamic imports for the MCP SDK to avoid TS subpath resolution issues.
 */
export async function createMcpServer(sessionManager: SessionManager): Promise<{
  server: McpServerInstance;
}> {
  // Dynamic import — same workaround as src/mcp-server.ts
  const mcpMod = await import(`${MCP_PKG}/server/mcp.js`);
  const McpServer = mcpMod.McpServer;

  const server: McpServerInstance = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, elicitation: {} } },
  );

  // -----------------------------------------------------------------------
  // gsd_execute — start a new GSD auto-mode session.
  //
  // If the JSON-RPC request is aborted while the session is starting (or
  // immediately after), we cancel the session so we don't leak a background
  // RpcClient process. Once the session is running the caller should use
  // `gsd_cancel` to stop it via sessionId.
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_execute',
    'Start a GSD auto-mode session for a project directory. Returns a sessionId for tracking.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      command: z.string().optional().describe('Command to send (default: "/gsd auto")'),
      model: z.string().optional().describe('Model ID override'),
      bare: z.boolean().optional().describe('Run in bare mode (skip user config)'),
    },
    async (args: Record<string, unknown>, extra?: McpToolExtra) => {
      const { projectDir, command, model, bare } = args as {
        projectDir: string; command?: string; model?: string; bare?: boolean;
      };
      try {
        const sessionId = await sessionManager.startSession(projectDir, { command, model, bare });

        // If the client aborted while startSession was running, cancel the
        // newly-created session rather than leaving an orphaned process.
        if (extra?.signal?.aborted) {
          await sessionManager.cancelSession(sessionId).catch(() => { /* swallow */ });
          return errorContent('gsd_execute aborted by client before returning');
        }

        return jsonContent({ sessionId, status: 'started' });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_status — poll session status
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_status',
    'Get the current status of a GSD session including progress, recent events, and pending blockers.',
    {
      sessionId: z.string().describe('Session ID returned from gsd_execute'),
    },
    async (args: Record<string, unknown>) => {
      const { sessionId } = args as { sessionId: string };
      try {
        const session = sessionManager.getSession(sessionId);
        if (!session) return errorContent(`Session not found: ${sessionId}`);

        const durationMs = Date.now() - session.startTime;
        const toolCallCount = session.events.filter(
          (e) => (e as Record<string, unknown>).type === 'tool_use' ||
                 (e as Record<string, unknown>).type === 'tool_execution_start'
        ).length;

        return jsonContent({
          status: session.status,
          progress: {
            eventCount: session.events.length,
            toolCalls: toolCallCount,
          },
          recentEvents: session.events.slice(-10),
          pendingBlocker: session.pendingBlocker
            ? {
                id: session.pendingBlocker.id,
                method: session.pendingBlocker.method,
                message: session.pendingBlocker.message,
              }
            : null,
          cost: session.cost,
          durationMs,
        });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_result — get accumulated session result
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_result',
    'Get the result of a GSD session. Returns partial results if the session is still running.',
    {
      sessionId: z.string().describe('Session ID returned from gsd_execute'),
    },
    async (args: Record<string, unknown>) => {
      const { sessionId } = args as { sessionId: string };
      try {
        const result = sessionManager.getResult(sessionId);
        return jsonContent(result);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_cancel — cancel a running session
  //
  // Supports two lookup strategies:
  //   1. sessionId  — the ID returned from gsd_execute (primary)
  //   2. projectDir — absolute path to the project directory (fallback)
  //
  // The projectDir fallback handles interactive sessions (started via
  // `/gsd auto` in the terminal) and post-restart MCP sessions that were
  // never registered with a sessionId in this server instance.
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_cancel',
    'Cancel a running GSD session. Aborts the current operation and stops the process. Provide sessionId (from gsd_execute) or projectDir as a fallback for interactive/restarted sessions.',
    {
      sessionId: z.string().optional().describe('Session ID returned from gsd_execute'),
      projectDir: z.string().optional().describe('Absolute path to the project directory (fallback when sessionId is unavailable)'),
    },
    async (args: Record<string, unknown>) => {
      const { sessionId, projectDir } = args as { sessionId?: string; projectDir?: string };
      try {
        if (!sessionId && !projectDir) {
          return errorContent('Either sessionId or projectDir must be provided');
        }
        if (sessionId) {
          try {
            await sessionManager.cancelSession(sessionId);
          } catch (err) {
            if (!projectDir || !(err instanceof Error) || !err.message.includes('Session not found')) {
              throw err;
            }
            await sessionManager.cancelSessionByDir(projectDir);
          }
        } else if (projectDir) {
          await sessionManager.cancelSessionByDir(projectDir);
        }
        return jsonContent({ cancelled: true });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_query — read project state from filesystem (no session needed).
  //
  // `query` is optional: when omitted the tool returns all fields (STATE.md,
  // PROJECT.md, requirements, milestone listing). Accepted narrow values:
  // "state" / "status", "project", "requirements", "milestones", "all".
  // Unknown values fall back to "all" for forward-compatibility.
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_query',
    'Query GSD project state from the filesystem. By default returns STATE.md, PROJECT.md, requirements, and milestone listing. Pass `query` to narrow the response (accepted: "state"/"status", "project", "requirements", "milestones", "all"). Does not require an active session.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      query: z
        .enum(['all', 'state', 'status', 'project', 'requirements', 'milestones'])
        .optional()
        .describe('Narrow the response to a single field (default: "all")'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, query } = args as { projectDir: string; query?: string };
      try {
        const validated = validateProjectDir(projectDir);
        const state = await readProjectState(validated, query);
        return jsonContent(state);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_resolve_blocker — resolve a pending blocker
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_resolve_blocker',
    'Resolve a pending blocker in a GSD session by sending a response to the UI request.',
    {
      sessionId: z.string().describe('Session ID returned from gsd_execute'),
      response: z.string().describe('Response to send for the pending blocker'),
    },
    async (args: Record<string, unknown>) => {
      const { sessionId, response } = args as { sessionId: string; response: string };
      try {
        await sessionManager.resolveBlocker(sessionId, response);
        return jsonContent({ resolved: true });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // ask_user_questions — structured user input via MCP form elicitation
  // -----------------------------------------------------------------------
  server.tool(
    'ask_user_questions',
    'Request user input for one to three short questions and wait for the response. Single-select questions include a free-form "None of the above" path. Multi-select questions allow multiple choices.',
    {
      questions: z.array(z.object({
        id: z.string().describe('Stable identifier for mapping answers (snake_case)'),
        header: z.string().describe('Short header label shown in the UI (12 or fewer chars)'),
        question: z.string().describe('Single-sentence prompt shown to the user'),
        options: z.array(z.object({
          label: z.string().describe('User-facing label (1-5 words)'),
          description: z.string().describe('One short sentence explaining impact/tradeoff if selected'),
        })).describe('Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option for single-select questions.'),
        allowMultiple: z.boolean().optional().describe('If true, the user can select multiple options. No "None of the above" option is added.'),
      })).describe('Questions to show the user. Prefer 1 and do not exceed 3.'),
    },
    async (args: Record<string, unknown>, extra?: McpToolExtra) => {
      const { questions } = args as unknown as AskUserQuestionsParams;
      try {
        const validationError = validateAskUserQuestionsPayload(questions);
        if (validationError) return errorContent(validationError);

        // Delegate to remote-questions manager when a remote channel is configured
        // (Discord, Slack, Telegram). This path is the only one reachable for
        // Claude Code-under-gsd sessions, which have no local TUI.
        if (isRemoteConfigured()) {
          const remoteResult = await tryRemoteQuestions(questions, extra?.signal);
          if (remoteResult) {
            const details = remoteResult.details as Record<string, unknown> | undefined;
            if (details?.['timed_out'] || details?.['error']) {
              // Surface timeout/error as plain text so the LLM knows to retry
              return textContent(remoteResult.content[0]?.text ?? 'Remote questions timed out or failed');
            }
            return textContent(remoteResult.content[0]?.text ?? '');
          }
          // resolveRemoteConfig() returned null between isRemoteConfigured() and
          // tryRemoteQuestions() (e.g. env var was cleared) — fall through to local.
        }

        const elicitation = await withElicitTimeout(
          server.server.elicitInput(buildAskUserQuestionsElicitRequest(questions)),
          'ask_user_questions',
        );
        if (elicitation.action !== 'accept' || !elicitation.content) {
          return textContent('ask_user_questions was cancelled before receiving a response');
        }

        return textContent(formatAskUserQuestionsElicitResult(questions, elicitation));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // secure_env_collect — collect secrets via MCP form elicitation
  // -----------------------------------------------------------------------
  server.tool(
    'secure_env_collect',
    'Collect environment variables securely via form input. Values are written directly to .env (or Vercel/Convex) and NEVER appear in tool output — only key names and applied/skipped status are returned. Use this instead of asking users to manually edit .env files or paste secrets into chat.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      keys: z.array(z.object({
        key: z.string().describe('Env var name, e.g. OPENAI_API_KEY'),
        hint: z.string().optional().describe('Format hint shown to user, e.g. "starts with sk-"'),
        guidance: z.array(z.string()).optional().describe('Step-by-step instructions for obtaining this key'),
      })).min(1).describe('Environment variables to collect'),
      destination: z.enum(['dotenv', 'vercel', 'convex']).optional().describe('Where to write secrets. Auto-detected from project files if omitted.'),
      envFilePath: z.string().optional().describe('Path to .env file (dotenv only). Defaults to .env in projectDir.'),
      environment: z.enum(['development', 'preview', 'production']).optional().describe('Target environment (vercel/convex only)'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, keys, destination, envFilePath, environment } = args as {
        projectDir: string;
        keys: Array<{ key: string; hint?: string; guidance?: string[] }>;
        destination?: 'dotenv' | 'vercel' | 'convex';
        envFilePath?: string;
        environment?: 'development' | 'preview' | 'production';
      };

      try {
        const resolvedProjectDir = validateProjectDir(projectDir);
        const resolvedEnvPath = resolveProjectEnvFilePath(resolvedProjectDir, envFilePath ?? '.env');

        // (1) Check which keys already exist
        const allKeyNames = keys.map((k) => k.key);
        const existingKeys = await checkExistingEnvKeys(allKeyNames, resolvedEnvPath);
        const existingSet = new Set(existingKeys);
        const pendingKeys = keys.filter((k) => !existingSet.has(k.key));

        // If all keys already exist, return immediately
        if (pendingKeys.length === 0) {
          const lines = existingKeys.map((k) => `• ${k}: already set`);
          return textContent(`All ${existingKeys.length} key(s) already set.\n${lines.join('\n')}`);
        }

        // (2) Build elicitation form — one string field per pending key
        const properties: Record<string, Record<string, unknown>> = {};
        const required: string[] = [];

        for (const item of pendingKeys) {
          const descParts: string[] = [];
          if (item.hint) descParts.push(`Format: ${item.hint}`);
          if (item.guidance && item.guidance.length > 0) {
            descParts.push('How to get this:');
            item.guidance.forEach((step, i) => descParts.push(`${i + 1}. ${step}`));
          }
          descParts.push('Leave empty to skip.');

          properties[item.key] = {
            type: 'string',
            title: item.key,
            description: descParts.join('\n'),
          };
          // Don't mark as required — empty string = skip
        }

        // (3) Elicit input from the MCP client
        const elicitation = await withElicitTimeout(
          server.server.elicitInput({
            message: `Enter values for ${pendingKeys.length} environment variable(s). Values are written directly to the project and never shown to the AI.`,
            requestedSchema: {
              type: 'object',
              properties,
              required,
            },
          }),
          'secure_env_collect',
        );

        if (elicitation.action !== 'accept' || !elicitation.content) {
          return textContent('secure_env_collect was cancelled by user.');
        }

        // (4) Separate provided vs skipped from form response
        const provided: Array<{ key: string; value: string }> = [];
        const skipped: string[] = [];

        for (const item of pendingKeys) {
          const raw = elicitation.content[item.key];
          const value = typeof raw === 'string' ? raw.trim() : '';
          if (value.length > 0) {
            provided.push({ key: item.key, value });
          } else {
            skipped.push(item.key);
          }
        }

        // (5) Auto-detect destination if not specified
        const resolvedDestination = destination ?? detectDestination(resolvedProjectDir);

        // (6) Write secrets to destination
        const { applied, errors } = await applySecrets(provided, resolvedDestination, {
          envFilePath: resolvedEnvPath,
          environment,
          execFn: defaultExecFn,
        });

        // (7) Build result — NEVER include secret values
        const lines: string[] = [
          `destination: ${resolvedDestination}${!destination ? ' (auto-detected)' : ''}${environment ? ` (${environment})` : ''}`,
        ];
        for (const k of applied) lines.push(`✓ ${k}: applied`);
        for (const k of skipped) lines.push(`• ${k}: skipped`);
        for (const k of existingKeys) lines.push(`• ${k}: already set`);
        for (const e of errors) lines.push(`✗ ${e}`);

        return errors.length > 0 && applied.length === 0
          ? errorContent(lines.join('\n'))
          : textContent(lines.join('\n'));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // =======================================================================
  // READ-ONLY TOOLS — no session required, pure filesystem reads
  // =======================================================================

  // -----------------------------------------------------------------------
  // gsd_progress — structured project progress metrics
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_progress',
    'Get structured project progress: active milestone/slice/task, phase, completion counts, blockers, and next action. No session required — reads directly from .gsd/ on disk.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir } = args as { projectDir: string };
      try {
        return jsonContent(readProgress(validateProjectDir(projectDir)));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_roadmap — milestone/slice/task structure with status
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_roadmap',
    'Get the full project roadmap structure: milestones with their slices, tasks, status, risk, and dependencies. Optionally filter to a single milestone. No session required.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      milestoneId: z.string().optional().describe('Filter to a specific milestone (e.g. "M001")'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, milestoneId } = args as { projectDir: string; milestoneId?: string };
      try {
        return jsonContent(readRoadmap(validateProjectDir(projectDir), milestoneId));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_history — execution history with cost/token metrics
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_history',
    'Get execution history with cost, token usage, model, and duration per unit. Returns totals across all units. No session required.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      limit: z.number().optional().describe('Max entries to return (most recent first). Default: all.'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, limit } = args as { projectDir: string; limit?: number };
      try {
        return jsonContent(readHistory(validateProjectDir(projectDir), limit));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_doctor — lightweight structural health check
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_doctor',
    'Run a lightweight structural health check on the .gsd/ directory. Checks for missing files, status inconsistencies, and orphaned state. No session required.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      scope: z.string().optional().describe('Limit checks to a specific milestone (e.g. "M001")'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, scope } = args as { projectDir: string; scope?: string };
      try {
        return jsonContent(runDoctorLite(validateProjectDir(projectDir), scope));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_captures — pending captures and ideas
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_captures',
    'Get captured ideas and thoughts from CAPTURES.md with triage status. Filter by pending, actionable, or all. No session required.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      filter: z.enum(['all', 'pending', 'actionable']).optional().describe('Filter captures (default: "all")'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, filter } = args as { projectDir: string; filter?: 'all' | 'pending' | 'actionable' };
      try {
        return jsonContent(readCaptures(validateProjectDir(projectDir), filter ?? 'all'));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_knowledge — project knowledge base
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_knowledge',
    'Get the project knowledge base: rules, patterns, and lessons learned accumulated during development. No session required.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir } = args as { projectDir: string };
      try {
        return jsonContent(readKnowledge(validateProjectDir(projectDir)));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_graph — knowledge graph for GSD projects
  //
  // Modes:
  //   build   Parse .gsd/ artifacts and write graph.json atomically.
  //   query   Search the graph for nodes matching a term (BFS, budget-trimmed).
  //   status  Check whether graph.json exists and whether it is stale (>24h).
  //   diff    Compare graph.json with the last build snapshot.
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_graph',
    [
      'Manage the GSD project knowledge graph. No session required.',
      '',
      'Modes:',
      '  build   Parse .gsd/ artifacts (STATE.md, milestone ROADMAPs, slice PLANs,',
      '          KNOWLEDGE.md) and write .gsd/graphs/graph.json atomically.',
      '  query   Search graph nodes by term (BFS from seed matches, budget-trimmed).',
      '          Returns matching nodes and reachable edges within the token budget.',
      '  status  Show whether graph.json exists, its age, node/edge counts, and',
      '          whether it is stale (built more than 24 hours ago).',
      '  diff    Compare current graph.json with .last-build-snapshot.json.',
      '          Returns added, removed, and changed nodes and edges.',
    ].join('\n'),
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      mode: z.enum(['build', 'query', 'status', 'diff']).describe(
        'Operation: build | query | status | diff',
      ),
      term: z.string().optional().describe('Search term for query mode (case-insensitive)'),
      budget: z.number().optional().describe('Token budget for query mode (default: 4000)'),
      snapshot: z.boolean().optional().describe('Write snapshot before build (for future diff)'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir: rawProjectDir, mode, term, budget, snapshot } = args as {
        projectDir: string;
        mode: 'build' | 'query' | 'status' | 'diff';
        term?: string;
        budget?: number;
        snapshot?: boolean;
      };

      try {
        const projectDir = validateProjectDir(rawProjectDir);
        const gsdRoot = resolveGsdRoot(projectDir);

        switch (mode) {
          case 'build': {
            if (snapshot) {
              await writeSnapshot(gsdRoot).catch(() => { /* best-effort */ });
            }
            const graph = await buildGraph(projectDir);
            await writeGraph(gsdRoot, graph);
            return jsonContent({
              built: true,
              nodeCount: graph.nodes.length,
              edgeCount: graph.edges.length,
              builtAt: graph.builtAt,
            });
          }

          case 'query': {
            const result = await graphQuery(projectDir, term ?? '', budget);
            return jsonContent(result);
          }

          case 'status': {
            const result = await graphStatus(projectDir);
            return jsonContent(result);
          }

          case 'diff': {
            const result = await graphDiff(projectDir);
            return jsonContent(result);
          }
        }
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  registerWorkflowTools(server);

  return { server };
}
