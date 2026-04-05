/**
 * MCP Server — registers 6 GSD orchestration tools on McpServer.
 *
 * Uses dynamic imports for @modelcontextprotocol/sdk because TS Node16
 * cannot resolve the SDK's subpath exports statically (same pattern as
 * src/mcp-server.ts in the main package).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { SessionManager } from './session-manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_PKG = '@modelcontextprotocol/sdk';
const SERVER_NAME = 'gsd';
const SERVER_VERSION = '2.51.0';

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
 * Create and configure an MCP server with 6 GSD orchestration tools.
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

  // ─── Read-only project state tools (#3515) ────────────────────────────
  // These parse .gsd/ directly — no session needed, no DB dependency.

  const { readProgress } = await import('./readers/progress.js');
  const { readRoadmap } = await import('./readers/roadmap.js');
  const { readHistory } = await import('./readers/history.js');
  const { readDoctor } = await import('./readers/doctor.js');
  const { readCaptures } = await import('./readers/captures.js');
  const { readKnowledge } = await import('./readers/knowledge.js');

  server.tool(
    'gsd_progress',
    'Get active milestone, slice, task, phase, completion counts, blockers, and next action. No session needed.',
    { projectDir: z.string().describe('Absolute path to the project directory') },
    async (args: Record<string, unknown>) => {
      try {
        return jsonContent(await readProgress(args.projectDir as string));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    'gsd_roadmap',
    'Get full project structure with milestones, slices, tasks, status, risk, and dependencies. No session needed.',
    { projectDir: z.string().describe('Absolute path to the project directory') },
    async (args: Record<string, unknown>) => {
      try {
        return jsonContent(await readRoadmap(args.projectDir as string));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    'gsd_history',
    'Get execution history — cost, tokens, model, duration per unit. No session needed.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      limit: z.number().optional().describe('Max entries to return (default: 50)'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return jsonContent(await readHistory(args.projectDir as string, (args.limit as number) ?? 50));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    'gsd_doctor',
    'Lightweight structural health check — verifies .gsd/ directory, milestones, roadmaps, and required files. No session needed.',
    { projectDir: z.string().describe('Absolute path to the project directory') },
    async (args: Record<string, unknown>) => {
      try {
        return jsonContent(await readDoctor(args.projectDir as string));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    'gsd_captures',
    'Get pending ideas and captures with filtering. No session needed.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      filter: z.enum(['all', 'pending', 'actionable']).optional().describe('Filter captures (default: all)'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return jsonContent(await readCaptures(args.projectDir as string, (args.filter as 'all' | 'pending' | 'actionable') ?? 'all'));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    'gsd_knowledge',
    'Get project knowledge base — rules, patterns, and lessons learned. No session needed.',
    { projectDir: z.string().describe('Absolute path to the project directory') },
    async (args: Record<string, unknown>) => {
      try {
        return jsonContent(await readKnowledge(args.projectDir as string));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return { server };
}
