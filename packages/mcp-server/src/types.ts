/**
 * MCP Server types — session lifecycle and orchestration.
 */

import type { RpcClient, SdkAgentEvent, RpcCostUpdateEvent, RpcExtensionUIRequest } from '@gsd-build/rpc-client';

// ---------------------------------------------------------------------------
// Session Status
// ---------------------------------------------------------------------------

export type SessionStatus = 'starting' | 'running' | 'blocked' | 'completed' | 'error' | 'cancelled';

// ---------------------------------------------------------------------------
// Managed Session
// ---------------------------------------------------------------------------

export interface ManagedSession {
  /** Unique session ID returned from RpcClient.init() */
  sessionId: string;

  /** Absolute path to the project directory */
  projectDir: string;

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
// Execute Options
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
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
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of events kept in the ring buffer */
export const MAX_EVENTS = 50;

/** Timeout for RpcClient initialization (ms) */
export const INIT_TIMEOUT_MS = 30_000;
