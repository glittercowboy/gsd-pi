/**
 * MCP Server — registers GSD orchestration + read-only project state tools.
 *
 * Session tools (6): gsd_execute, gsd_status, gsd_result, gsd_cancel, gsd_query, gsd_resolve_blocker
 * Read-only tools (6): gsd_progress, gsd_roadmap, gsd_history, gsd_doctor, gsd_captures, gsd_knowledge
 *
 * Uses dynamic imports for @modelcontextprotocol/sdk because TS Node16
 * cannot resolve the SDK's subpath exports statically (same pattern as
 * src/mcp-server.ts in the main package).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { SessionManager } from './session-manager.js';
import { getErrorMessage } from './error-utils.js';
import { readProgress } from './readers/state.js';
import { readRoadmap } from './readers/roadmap.js';
import { readHistory } from './readers/metrics.js';
import { readCaptures } from './readers/captures.js';
import { readKnowledge } from './readers/knowledge.js';
import { runDoctorLite } from './readers/doctor-lite.js';

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
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// createMcpServer
// ---------------------------------------------------------------------------

/**
 * Create and configure an MCP server with 12 GSD tools (6 session + 6 read-only).
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
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
        return errorContent(getErrorMessage(err));
      }
    },
  );

  return { server };
}
