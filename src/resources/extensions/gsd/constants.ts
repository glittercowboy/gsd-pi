/**
 * GSD Extension — Shared Constants
 *
 * Centralized timeout and cache-size constants used across the GSD extension.
 */

// ─── Timeouts ─────────────────────────────────────────────────────────────────

/** Default timeout for verification-gate commands (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Default timeout for the dynamic bash tool (seconds). */
export const DEFAULT_BASH_TIMEOUT_SECS = 120;

// ─── Cache Sizes ──────────────────────────────────────────────────────────────

/** Max directory-listing cache entries before eviction (#611). */
export const DIR_CACHE_MAX = 200;

/** Max parse-cache entries before eviction. */
export const CACHE_MAX = 50;

// ─── Tool Scoping ─────────────────────────────────────────────────────────────

/**
 * GSD tools allowed during discuss flows (#2949).
 *
 * xAI/Grok (and potentially other providers with grammar-based constrained
 * decoding) return "Grammar is too complex" (HTTP 400) when the combined
 * tool schemas exceed their internal grammar limit. The full GSD tool set
 * registers ~33 tools with deeply nested schemas; discuss flows only need
 * a small subset.
 *
 * By scoping tools to this allowlist during discuss dispatches, the grammar
 * sent to the provider stays well under provider limits.
 *
 * Included tools and why:
 *   - gsd_summary_save: writes CONTEXT.md artifacts (all discuss prompts)
 *   - gsd_save_summary: alias for above
 *   - gsd_decision_save: records decisions (discuss.md output phase)
 *   - gsd_save_decision: alias for above
 *   - gsd_plan_milestone: writes roadmap (discuss.md single/multi milestone)
 *   - gsd_milestone_plan: alias for above
 *   - gsd_milestone_generate_id: generates milestone IDs (discuss.md multi-milestone)
 *   - gsd_generate_milestone_id: alias for above
 *   - gsd_requirement_update: updates requirements during discuss
 *   - gsd_update_requirement: alias for above
 */
export const DISCUSS_TOOLS_ALLOWLIST: readonly string[] = [
  // Context / summary writing
  "gsd_summary_save",
  "gsd_save_summary",
  // Decision recording
  "gsd_decision_save",
  "gsd_save_decision",
  // Milestone planning (needed for discuss.md output phase)
  "gsd_plan_milestone",
  "gsd_milestone_plan",
  // Milestone ID generation (multi-milestone flow)
  "gsd_milestone_generate_id",
  "gsd_generate_milestone_id",
  // Requirement updates
  "gsd_requirement_update",
  "gsd_update_requirement",
];
