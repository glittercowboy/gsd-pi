/**
 * MCP Server — registers GSD orchestration, project-state, and workflow tools.
 *
 * Session tools (6): gsd_execute, gsd_status, gsd_result, gsd_cancel, gsd_query, gsd_resolve_blocker
 * Interactive tools (1): ask_user_questions via MCP form elicitation
 * Read-only tools (6): gsd_progress, gsd_roadmap, gsd_history, gsd_doctor, gsd_captures, gsd_knowledge
 * Workflow tools (29): headless-safe planning, metadata persistence, replanning, completion, validation, reassessment, gate result, status, and journal tools
 *
 * Uses dynamic imports for @modelcontextprotocol/sdk because TS Node16
 * cannot resolve the SDK's subpath exports statically (same pattern as
 * src/mcp-server.ts in the main package).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { SessionManager } from './session-manager.js';
import { readProgress } from './readers/state.js';
import { readRoadmap } from './readers/roadmap.js';
import { readHistory } from './readers/metrics.js';
import { readCaptures } from './readers/captures.js';
import { readKnowledge } from './readers/knowledge.js';
import { runDoctorLite } from './readers/doctor-lite.js';
import { registerWorkflowTools } from './workflow-tools.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_PKG = '@modelcontextprotocol/sdk';
const SERVER_NAME = 'gsd';
const SERVER_VERSION = '2.53.0';

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

async function readProjectState(projectDir: string, _query: string): Promise<Record<string, unknown>> {
  const gsdDir = join(resolve(projectDir), '.gsd');
  const result: Record<string, unknown> = { projectDir: resolve(projectDir) };

  // STATE.md — current execution state
  try {
    result.state = await readFile(join(gsdDir, 'STATE.md'), 'utf-8');
  } catch {
    result.state = null;
  }

  // PROJECT.md — project description
  try {
    result.project = await readFile(join(gsdDir, 'PROJECT.md'), 'utf-8');
  } catch {
    result.project = null;
  }

  // REQUIREMENTS.md — requirement contract
  try {
    result.requirements = await readFile(join(gsdDir, 'REQUIREMENTS.md'), 'utf-8');
  } catch {
    result.requirements = null;
  }

  // List milestones with basic metadata
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

interface McpServerInstance {
  tool(name: string, description: string, params: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<unknown>): unknown;
  server: {
    elicitInput(
      params: AskUserQuestionsElicitRequest,
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
    { capabilities: { tools: {} } },
  );

  // -----------------------------------------------------------------------
  // gsd_execute — start a new GSD auto-mode session
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
    async (args: Record<string, unknown>) => {
      const { projectDir, command, model, bare } = args as {
        projectDir: string; command?: string; model?: string; bare?: boolean;
      };
      try {
        const sessionId = await sessionManager.startSession(projectDir, { command, model, bare });
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
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_cancel',
    'Cancel a running GSD session. Aborts the current operation and stops the process.',
    {
      sessionId: z.string().describe('Session ID returned from gsd_execute'),
    },
    async (args: Record<string, unknown>) => {
      const { sessionId } = args as { sessionId: string };
      try {
        await sessionManager.cancelSession(sessionId);
        return jsonContent({ cancelled: true });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // -----------------------------------------------------------------------
  // gsd_query — read project state from filesystem (no session needed)
  // -----------------------------------------------------------------------
  server.tool(
    'gsd_query',
    'Query GSD project state from the filesystem. Returns STATE.md, PROJECT.md, requirements, and milestone listing. Does not require an active session.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      query: z.string().describe('What to query (e.g. "status", "milestones", "requirements")'),
    },
    async (args: Record<string, unknown>) => {
      const { projectDir, query } = args as { projectDir: string; query: string };
      try {
        const state = await readProjectState(projectDir, query);
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
    async (args: Record<string, unknown>) => {
      const { questions } = args as unknown as AskUserQuestionsParams;
      try {
        const validationError = validateAskUserQuestionsPayload(questions);
        if (validationError) return errorContent(validationError);

        const elicitation = await server.server.elicitInput(buildAskUserQuestionsElicitRequest(questions));
        if (elicitation.action !== 'accept' || !elicitation.content) {
          return textContent('ask_user_questions was cancelled before receiving a response');
        }

        return textContent(formatAskUserQuestionsElicitResult(questions, elicitation));
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
        return jsonContent(readProgress(projectDir));
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
        return jsonContent(readRoadmap(projectDir, milestoneId));
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
        return jsonContent(readHistory(projectDir, limit));
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
        return jsonContent(runDoctorLite(projectDir, scope));
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
        return jsonContent(readCaptures(projectDir, filter ?? 'all'));
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
        return jsonContent(readKnowledge(projectDir));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  registerWorkflowTools(server);

  return { server };
}
