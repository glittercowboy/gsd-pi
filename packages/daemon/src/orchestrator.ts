/**
 * Orchestrator — LLM-powered agent for the #gsd-control Discord channel.
 *
 * Receives Discord messages, maintains conversation history, calls the
 * Anthropic messages API with 5 tool definitions (list_projects, start_session,
 * get_status, stop_session, get_session_detail), and sends the LLM's response
 * back to Discord.
 *
 * Uses the standard messages.create() tool-use loop (not betaZodTool helpers,
 * which don't exist in SDK v0.52). Zod schemas are used for input validation
 * at the tool execution layer.
 */

import { z } from 'zod';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { SessionManager } from './session-manager.js';
import type { ChannelManager } from './channel-manager.js';
import type { ProjectInfo, ManagedSession } from './types.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// OAuth token resolution — reads GSD's auth.json, refreshes if expired
// ---------------------------------------------------------------------------

interface OAuthCredentials {
  type: 'oauth';
  refresh: string;
  access: string;
  expires: number;
}

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl');

/**
 * Read the Anthropic OAuth access token from GSD's auth.json.
 * If expired, refresh it and write the new credentials back.
 * Falls back to ANTHROPIC_API_KEY env var if no OAuth credential exists.
 */
async function resolveAnthropicApiKey(logger?: Logger): Promise<string> {
  // Try env var first (explicit override)
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }

  const authPath = join(homedir(), '.gsd', 'agent', 'auth.json');
  let authData: Record<string, unknown>;
  try {
    authData = JSON.parse(readFileSync(authPath, 'utf-8'));
  } catch {
    throw new Error(
      'No Anthropic auth found. Run `gsd login` to authenticate, or set ANTHROPIC_API_KEY.',
    );
  }

  const cred = authData.anthropic as OAuthCredentials | undefined;
  if (!cred || cred.type !== 'oauth' || !cred.access) {
    throw new Error(
      'No Anthropic OAuth credential in auth.json. Run `gsd login` to authenticate.',
    );
  }

  // If token is still valid, use it
  if (Date.now() < cred.expires) {
    return cred.access;
  }

  // Token expired — refresh it
  logger?.info('orchestrator: refreshing Anthropic OAuth token');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: cred.refresh,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic token refresh failed: ${error}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newCred: OAuthCredentials = {
    type: 'oauth',
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };

  // Write back to auth.json
  authData.anthropic = newCred;
  writeFileSync(authPath, JSON.stringify(authData, null, 2), 'utf-8');
  chmodSync(authPath, 0o600);
  logger?.info('orchestrator: Anthropic OAuth token refreshed');

  return newCred.access;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  model: string;
  max_tokens: number;
  control_channel_id: string;
}

export interface OrchestratorDeps {
  sessionManager: SessionManager;
  channelManager: ChannelManager;
  scanProjects: () => Promise<ProjectInfo[]>;
  config: OrchestratorConfig;
  logger: Logger;
  ownerId: string;
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are GSD Control — a concise, capable orchestrator for managing GSD (Get Shit Done) coding agent sessions via Discord.

You have tools to list projects, start sessions, get status, stop sessions, and inspect session details. Use them to fulfill the user's requests.

Response guidelines:
- Be terse and direct. No filler, no performed enthusiasm.
- When reporting status, use bullet points with project name, status, duration, and cost.
- When starting a session, confirm with the project name and session ID.
- When stopping a session, confirm which session was stopped.
- If something fails, say what went wrong plainly.
- Use Discord markdown formatting (bold, code blocks) for readability.
- Never expose internal error stack traces to the user — summarize the issue.`;

// ---------------------------------------------------------------------------
// Tool Definitions (Anthropic API format)
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: 'list_projects',
    description: 'List all detected projects across configured scan roots. Returns project names, paths, and detected markers (git, node, gsd, etc.).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'start_session',
    description: 'Start a new GSD auto-mode session for a project. Provide the absolute project path. Optionally provide a command to run instead of the default "/gsd auto".',
    input_schema: {
      type: 'object' as const,
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the project directory' },
        command: { type: 'string', description: 'Optional command to send instead of "/gsd auto"' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'get_status',
    description: 'Get the current status of all active GSD sessions. Shows project name, status, duration, and cost for each.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'stop_session',
    description: 'Stop a running GSD session. Provide a session ID or project name — fuzzy matching is used to find the session.',
    input_schema: {
      type: 'object' as const,
      properties: {
        identifier: { type: 'string', description: 'Session ID or project name to match' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'get_session_detail',
    description: 'Get detailed information about a specific session including cost breakdown, recent events, pending blockers, and error state.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'The session ID to inspect' },
      },
      required: ['sessionId'],
    },
  },
];

// ---------------------------------------------------------------------------
// Zod schemas for tool input validation
// ---------------------------------------------------------------------------

const StartSessionInput = z.object({
  projectPath: z.string(),
  command: z.string().optional(),
});

const StopSessionInput = z.object({
  identifier: z.string(),
});

const GetSessionDetailInput = z.object({
  sessionId: z.string(),
});

// ---------------------------------------------------------------------------
// Conversation History Cap
// ---------------------------------------------------------------------------

const MAX_HISTORY = 30;

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private client: Anthropic | null;
  private history: MessageParam[] = [];

  /**
   * @param deps - orchestrator dependencies (session manager, channel manager, etc.)
   * @param client - optional Anthropic client for testability; if omitted, created from env
   */
  constructor(deps: OrchestratorDeps, client?: Anthropic) {
    this.deps = deps;
    this.client = client ?? null;
  }

  /**
   * Lazily initialise the Anthropic client. Dynamic import handles K007 module resolution.
   * Resolves auth from GSD's OAuth credentials (auth.json), refreshing if needed.
   */
  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const apiKey = await resolveAnthropicApiKey(this.deps.logger);
    const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
    this.client = new AnthropicSDK({ apiKey });
    return this.client;
  }

  /**
   * Handle an incoming Discord message. Entry point called by the bot's
   * message handler for every message in every channel.
   *
   * Guards: ignores bot messages, non-owner messages, and non-control-channel messages.
   */
  async handleMessage(message: DiscordMessageLike): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Ignore non-control-channel messages
    if (message.channelId !== this.deps.config.control_channel_id) return;

    // Auth guard — only the owner can use the orchestrator
    if (message.author.id !== this.deps.ownerId) {
      this.deps.logger.debug('orchestrator auth rejected', { userId: message.author.id });
      return;
    }

    const content = message.content?.trim();
    if (!content) return;

    this.deps.logger.info('orchestrator message received', {
      userId: message.author.id,
      channelId: message.channelId,
      contentLength: content.length,
    });

    // Append user message to history
    this.history.push({ role: 'user', content });

    try {
      // Show typing indicator while processing
      await message.channel.sendTyping().catch(() => {});

      const responseText = await this.runAgentLoop();

      // Send response to Discord
      await message.channel.send(responseText);

      this.deps.logger.info('orchestrator response sent', {
        channelId: message.channelId,
        responseLength: responseText.length,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Invalidate cached client on auth errors so next call re-resolves OAuth token
      if (errorMsg.includes('authentication') || errorMsg.includes('apiKey') || errorMsg.includes('authToken') || errorMsg.includes('401')) {
        this.client = null;
      }

      this.deps.logger.error('orchestrator error', {
        error: errorMsg,
        userId: message.author.id,
        channelId: message.channelId,
      });

      // Send error feedback to Discord
      try {
        await message.channel.send('⚠️ Something went wrong processing your request.');
      } catch (sendErr) {
        this.deps.logger.warn('orchestrator error reply failed', {
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }

      // Still append a synthetic assistant message so history stays paired
      this.history.push({ role: 'assistant', content: '[error — see logs]' });
    }

    this.trimHistory();
  }

  /**
   * Run the tool-use loop: call messages.create(), execute any tool calls,
   * feed results back, repeat until the model produces a final text response.
   */
  private async runAgentLoop(): Promise<string> {
    const client = await this.getClient();
    const { model, max_tokens } = this.deps.config;

    let loopMessages: MessageParam[] = [...this.history];
    const maxIterations = 10; // safety valve

    for (let i = 0; i < maxIterations; i++) {
      const response = await client.messages.create({
        model,
        max_tokens,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: loopMessages,
      });

      // If the model stopped for end_turn (no tool calls), extract text and return
      if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') {
        const textBlocks = response.content.filter(
          (b): b is TextBlock => b.type === 'text',
        );
        const finalText = textBlocks.map((b) => b.text).join('\n') || '(No response)';

        // Append assistant message to conversation history
        this.history.push({ role: 'assistant', content: finalText });

        return finalText;
      }

      // Model wants to use tools — execute them all
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );

      // Build tool results
      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const result = await this.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Append the assistant message (with tool_use blocks) and user tool_result message
      loopMessages = [
        ...loopMessages,
        { role: 'assistant', content: response.content as ContentBlockParam[] },
        { role: 'user', content: toolResults },
      ];
    }

    // If we hit max iterations, return a fallback
    return 'I hit the maximum number of tool iterations. Please try a simpler request.';
  }

  /**
   * Execute a single tool by name. Returns a string result for the LLM.
   * All errors are caught and returned as error strings (the LLM can reason about them).
   */
  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case 'list_projects':
          return await this.toolListProjects();
        case 'start_session':
          return await this.toolStartSession(input);
        case 'get_status':
          return this.toolGetStatus();
        case 'get_session_detail':
          return this.toolGetSessionDetail(input);
        case 'stop_session':
          return await this.toolStopSession(input);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('tool execution error', { tool: name, error: msg });
      return `Error: ${msg}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Tool implementations
  // ---------------------------------------------------------------------------

  private async toolListProjects(): Promise<string> {
    const projects = await this.deps.scanProjects();
    if (projects.length === 0) return 'No projects found.';
    return JSON.stringify(
      projects.map((p) => ({ name: p.name, path: p.path, markers: p.markers })),
      null,
      2,
    );
  }

  private async toolStartSession(input: Record<string, unknown>): Promise<string> {
    const parsed = StartSessionInput.parse(input);
    const sessionId = await this.deps.sessionManager.startSession({
      projectDir: parsed.projectPath,
      command: parsed.command,
    });
    return `Session started: ${sessionId} for ${parsed.projectPath}`;
  }

  private toolGetStatus(): string {
    const sessions = this.deps.sessionManager.getAllSessions();
    if (sessions.length === 0) return 'No active sessions.';

    return sessions
      .map((s: ManagedSession) => {
        const durationMin = Math.floor((Date.now() - s.startTime) / 60_000);
        const cost = s.cost.totalCost.toFixed(4);
        return `• ${s.projectName} — ${s.status} (${durationMin}m, $${cost})`;
      })
      .join('\n');
  }

  private async toolStopSession(input: Record<string, unknown>): Promise<string> {
    const parsed = StopSessionInput.parse(input);
    const { identifier } = parsed;

    // Try exact sessionId match first
    const byId = this.deps.sessionManager.getSession(identifier);
    if (byId) {
      await this.deps.sessionManager.cancelSession(identifier);
      return `Stopped session ${identifier} (${byId.projectName})`;
    }

    // Fuzzy match by project name
    const all = this.deps.sessionManager.getAllSessions();
    const match = all.find(
      (s: ManagedSession) =>
        s.projectName.toLowerCase().includes(identifier.toLowerCase()) ||
        s.projectDir.toLowerCase().includes(identifier.toLowerCase()),
    );
    if (match) {
      await this.deps.sessionManager.cancelSession(match.sessionId);
      return `Stopped session ${match.sessionId} (${match.projectName})`;
    }

    return `No session found matching "${identifier}"`;
  }

  private toolGetSessionDetail(input: Record<string, unknown>): string {
    const parsed = GetSessionDetailInput.parse(input);
    const result = this.deps.sessionManager.getResult(parsed.sessionId);
    return JSON.stringify(result, null, 2);
  }

  // ---------------------------------------------------------------------------
  // History management
  // ---------------------------------------------------------------------------

  /**
   * Trim conversation history to MAX_HISTORY entries.
   * Removes the oldest user+assistant pair from the front to keep pairs aligned.
   */
  private trimHistory(): void {
    while (this.history.length > MAX_HISTORY) {
      // Remove from front — two messages at a time to keep user/assistant pairs
      this.history.splice(0, 2);
    }
  }

  /**
   * Return a copy of the conversation history (for debugging / observability).
   */
  getHistory(): MessageParam[] {
    return [...this.history];
  }

  /**
   * Stop the orchestrator — clears history and nulls client reference.
   */
  stop(): void {
    this.history = [];
    this.client = null;
  }
}

// ---------------------------------------------------------------------------
// Discord message type (minimal interface for testability)
// ---------------------------------------------------------------------------

/**
 * Minimal Discord message interface — avoids importing discord.js directly,
 * making the orchestrator testable without full discord.js mocking.
 */
export interface DiscordMessageLike {
  author: { id: string; bot: boolean };
  channelId: string;
  content: string;
  channel: {
    send: (content: string) => Promise<unknown>;
    sendTyping: () => Promise<unknown>;
  };
}
