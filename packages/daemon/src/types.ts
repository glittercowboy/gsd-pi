import type { RpcClient, SdkAgentEvent, RpcExtensionUIRequest } from '@gsd-build/rpc-client';

/**
 * Log severity levels, ordered from most to least verbose.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Per-channel verbosity for Discord event streaming.
 * - 'default': tool calls, messages, transitions, blockers, errors, completions
 * - 'verbose': everything including cost_update and status events
 * - 'quiet': only blockers, errors, completions
 */
export type VerbosityLevel = 'default' | 'verbose' | 'quiet';

/**
 * A single structured log entry written as JSON-lines.
 */
export interface LogEntry {
  /** ISO-8601 timestamp */
  ts: string;
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Top-level daemon configuration, loaded from YAML.
 */
export interface DaemonConfig {
  discord?: {
    token: string;
    guild_id: string;
    owner_id: string;
    /** When true, DM the owner on blocker events in addition to channel messages */
    dm_on_blocker?: boolean;
    /** Discord channel ID where the orchestrator listens for natural language commands */
    control_channel_id?: string;
    /** LLM orchestrator settings */
    orchestrator?: {
      model?: string;
      max_tokens?: number;
    };
  };
  projects: {
    scan_roots: string[];
  };
  log: {
    file: string;
    level: LogLevel;
    max_size_mb: number;
  };
}

// ---------------------------------------------------------------------------
// Session Status
// ---------------------------------------------------------------------------

export type SessionStatus = 'starting' | 'running' | 'blocked' | 'completed' | 'error' | 'cancelled';

// ---------------------------------------------------------------------------
// Managed Session
// ---------------------------------------------------------------------------

/**
 * A daemon-managed GSD headless session.
 */
export interface ManagedSession {
  /** Unique session ID returned from RpcClient.init() */
  sessionId: string;

  /** Absolute path to the project directory */
  projectDir: string;

  /** Human-readable project name (basename of projectDir) */
  projectName: string;

  /** Current lifecycle status */
  status: SessionStatus;

  /** The RpcClient instance managing the agent process */
  client: RpcClient;

  /** Ring buffer of recent events (capped at MAX_EVENTS) */
  events: SdkAgentEvent[];

  /** Pending blocker requiring user response, if any */
  pendingBlocker: PendingBlocker | null;

  /** Cumulative cost tracking (max pattern per K004) */
  cost: CostAccumulator;

  /** Session start timestamp */
  startTime: number;

  /** Error message if status is 'error' */
  error?: string;

  /** Cleanup function to unsubscribe from events */
  unsubscribe?: () => void;
}

// ---------------------------------------------------------------------------
// Pending Blocker
// ---------------------------------------------------------------------------

export interface PendingBlocker {
  /** The extension_ui_request id */
  id: string;

  /** The request method (e.g. 'select', 'confirm', 'input') */
  method: string;

  /** Human-readable message or title */
  message: string;

  /** Full event payload for inspection */
  event: RpcExtensionUIRequest;
}

// ---------------------------------------------------------------------------
// Cost Accumulator (K004 — cumulative-max)
// ---------------------------------------------------------------------------

export interface CostAccumulator {
  totalCost: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// ---------------------------------------------------------------------------
// Project Info — scanner output
// ---------------------------------------------------------------------------

/** Marker types detectable by the project scanner */
export type ProjectMarker = 'git' | 'node' | 'gsd' | 'rust' | 'python' | 'go';

export interface ProjectInfo {
  /** Directory name (basename) */
  name: string;

  /** Absolute path to the project directory */
  path: string;

  /** Detected marker types */
  markers: ProjectMarker[];

  /** Most recent mtime of detected marker files/dirs (epoch ms) */
  lastModified: number;
}

// ---------------------------------------------------------------------------
// Start Session Options
// ---------------------------------------------------------------------------

export interface StartSessionOptions {
  /** Absolute path to the project directory */
  projectDir: string;

  /** Command to send after '/gsd auto' (default: none) */
  command?: string;

  /** Model ID override */
  model?: string;

  /** Run in bare mode (skip user config) */
  bare?: boolean;

  /** Path to CLI binary (overrides GSD_CLI_PATH and which resolution) */
  cliPath?: string;
}

// ---------------------------------------------------------------------------
// Formatted Event — output of event-formatter.ts
// ---------------------------------------------------------------------------

/**
 * Formatted Discord message payload for a GSD event.
 * content is the plain-text fallback; embeds and components are optional.
 */
export interface FormattedEvent {
  content: string;
  embed?: import('discord.js').EmbedBuilder;
  components?: import('discord.js').ActionRowBuilder<import('discord.js').ButtonBuilder>[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of events kept in the ring buffer (larger than mcp-server's 50 — daemon forwards events to Discord) */
export const MAX_EVENTS = 100;

/** Timeout for RpcClient initialization (ms) */
export const INIT_TIMEOUT_MS = 30_000;
