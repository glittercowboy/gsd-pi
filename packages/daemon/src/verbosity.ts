/**
 * verbosity.ts — Per-channel verbosity filter for Discord event streaming.
 *
 * Controls which RPC event types reach each Discord channel.
 * Three levels:
 *   - 'quiet':   blockers, errors, completions only
 *   - 'default': tool calls, messages, transitions, blockers, errors, completions
 *   - 'verbose': everything (adds cost_update, status, generic events)
 */

import type { VerbosityLevel } from './types.js';

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/** Event types that are always shown (even in quiet mode). */
const ALWAYS_SHOWN: ReadonlySet<string> = new Set([
  'extension_ui_request',  // blockers
  'execution_complete',
  'error',
  'session_error',
]);

/** Event types shown at default level and above. */
const DEFAULT_SHOWN: ReadonlySet<string> = new Set([
  'tool_execution_start',
  'tool_execution_end',
  'message_start',
  'message_end',
  'message',
  'task_transition',
  'session_started',
]);

/** Event types shown only at verbose level. */
const VERBOSE_ONLY: ReadonlySet<string> = new Set([
  'cost_update',
  'state_update',
  'status',
  'set_status',
  'set_widget',
  'set_title',
]);

// ---------------------------------------------------------------------------
// VerbosityManager
// ---------------------------------------------------------------------------

export class VerbosityManager {
  private levels: Map<string, VerbosityLevel> = new Map();

  /** Get the verbosity level for a channel. Defaults to 'default'. */
  getLevel(channelId: string): VerbosityLevel {
    return this.levels.get(channelId) ?? 'default';
  }

  /** Set the verbosity level for a channel. */
  setLevel(channelId: string, level: VerbosityLevel): void {
    this.levels.set(channelId, level);
  }

  /**
   * Determine whether an event of the given type should be shown
   * in the specified channel.
   */
  shouldShow(channelId: string, eventType: string): boolean {
    const level = this.getLevel(channelId);
    return shouldShowAtLevel(level, eventType);
  }
}

// ---------------------------------------------------------------------------
// Pure filter — exported for direct use and testability
// ---------------------------------------------------------------------------

/**
 * Pure predicate: should an event of this type be shown at the given verbosity level?
 */
export function shouldShowAtLevel(level: VerbosityLevel, eventType: string): boolean {
  // Always-shown events pass through regardless of level
  if (ALWAYS_SHOWN.has(eventType)) return true;

  switch (level) {
    case 'quiet':
      // Quiet only shows ALWAYS_SHOWN events
      return false;

    case 'default':
      // Default shows ALWAYS_SHOWN + DEFAULT_SHOWN
      return DEFAULT_SHOWN.has(eventType);

    case 'verbose':
      // Verbose shows everything
      return true;

    default:
      // Unknown level → treat as default
      return DEFAULT_SHOWN.has(eventType);
  }
}
