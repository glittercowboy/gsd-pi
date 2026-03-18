/**
 * Centralized configuration constants for the coding agent.
 *
 * Values grouped by subsystem. Each constant documents where it is consumed
 * so that changes can be audited in one place.
 */

// =============================================================================
// Timeouts
// =============================================================================

/** Shell command execution timeout used by resolve-config-value. */
export const COMMAND_EXECUTION_TIMEOUT_MS = 10_000;

/** LSP server liveness check timeout (lspmux). */
export const LSP_LIVENESS_TIMEOUT_MS = 1_000;

/** Staleness threshold for the async auth-storage file lock. */
export const AUTH_LOCK_STALE_MS = 30_000;

// =============================================================================
// Caches
// =============================================================================

/** TTL for the cached lspmux state detection result. */
export const LSP_STATE_CACHE_TTL_MS = 5 * 60 * 1_000;

// =============================================================================
// Compaction & Summarization
// =============================================================================

/** Tokens reserved for the LLM prompt + response during compaction and branch summarization. */
export const COMPACTION_RESERVE_TOKENS = 16_384;

/** Tokens from the tail of the conversation kept verbatim after compaction. */
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000;

/** Max characters kept per tool-result block when serializing for summarization. */
export const TOOL_RESULT_MAX_CHARS = 2_000;

// =============================================================================
// Retry
// =============================================================================

/** Base delay for exponential back-off retries (2 s, 4 s, 8 s ...). */
export const RETRY_BASE_DELAY_MS = 2_000;

/** Maximum server-requested delay before the retry loop gives up. */
export const RETRY_MAX_DELAY_MS = 300_000;

// =============================================================================
// Tool Defaults
// =============================================================================

/** Default result-count cap for the find/glob tool. */
export const FIND_DEFAULT_LIMIT = 1_000;

/** Default line-count cap for tool-output truncation. */
export const TRUNCATE_DEFAULT_MAX_LINES = 2_000;
