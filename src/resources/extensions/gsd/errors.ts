/**
 * GSD Error Types — Typed error hierarchy for diagnostics and crash recovery.
 *
 * All GSD-specific errors extend GSDError, which carries a stable `code`
 * string suitable for programmatic matching. Error codes are defined as
 * constants so callers can switch on them without string-matching.
 */

// ─── Error Codes ──────────────────────────────────────────────────────────────

export const GSD_STALE_STATE = "GSD_STALE_STATE";
export const GSD_LOCK_HELD = "GSD_LOCK_HELD";
export const GSD_DISPATCH_FAILED = "GSD_DISPATCH_FAILED";
export const GSD_TIMEOUT = "GSD_TIMEOUT";
export const GSD_ARTIFACT_MISSING = "GSD_ARTIFACT_MISSING";
export const GSD_GIT_ERROR = "GSD_GIT_ERROR";
export const GSD_MERGE_CONFLICT = "GSD_MERGE_CONFLICT";
export const GSD_PARSE_ERROR = "GSD_PARSE_ERROR";
export const GSD_IO_ERROR = "GSD_IO_ERROR";

// ─── Base Error ───────────────────────────────────────────────────────────────

export class GSDError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GSDError";
    this.code = code;
  }
}
