/**
 * Safety Harness — central module for LLM damage control during auto-mode.
 * Provides types, preference resolution, and orchestration for all safety components.
 *
 * Components:
 * - evidence-collector.ts: Real-time tool call tracking
 * - destructive-guard.ts: Bash command classification
 * - file-change-validator.ts: Post-unit git diff vs plan
 * - evidence-cross-ref.ts: Claimed vs actual verification evidence
 * - git-checkpoint.ts: Pre-unit checkpoints + rollback
 * - content-validator.ts: Output quality validation
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SafetyHarnessConfig {
  enabled: boolean;
  evidence_collection: boolean;
  file_change_validation: boolean;
  evidence_cross_reference: boolean;
  destructive_command_warnings: boolean;
  content_validation: boolean;
  checkpoints: boolean;
  auto_rollback: boolean;
  timeout_scale_cap: number;
  /** Glob patterns for files excluded from unexpected-change warnings (#4385). */
  file_change_allowlist: string[];
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULTS: SafetyHarnessConfig = {
  enabled: true,
  evidence_collection: true,
  file_change_validation: true,
  evidence_cross_reference: true,
  destructive_command_warnings: true,
  content_validation: true,
  checkpoints: true,
  auto_rollback: false,
  timeout_scale_cap: 6,
  file_change_allowlist: [],
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve safety harness configuration from raw preferences.
 * Missing fields fall back to defaults.
 */
export function resolveSafetyHarnessConfig(
  raw: Record<string, unknown> | undefined,
): SafetyHarnessConfig {
  if (!raw) return { ...DEFAULTS };

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    evidence_collection: typeof raw.evidence_collection === "boolean" ? raw.evidence_collection : DEFAULTS.evidence_collection,
    file_change_validation: typeof raw.file_change_validation === "boolean" ? raw.file_change_validation : DEFAULTS.file_change_validation,
    evidence_cross_reference: typeof raw.evidence_cross_reference === "boolean" ? raw.evidence_cross_reference : DEFAULTS.evidence_cross_reference,
    destructive_command_warnings: typeof raw.destructive_command_warnings === "boolean" ? raw.destructive_command_warnings : DEFAULTS.destructive_command_warnings,
    content_validation: typeof raw.content_validation === "boolean" ? raw.content_validation : DEFAULTS.content_validation,
    checkpoints: typeof raw.checkpoints === "boolean" ? raw.checkpoints : DEFAULTS.checkpoints,
    auto_rollback: typeof raw.auto_rollback === "boolean" ? raw.auto_rollback : DEFAULTS.auto_rollback,
    timeout_scale_cap: typeof raw.timeout_scale_cap === "number" ? raw.timeout_scale_cap : DEFAULTS.timeout_scale_cap,
    file_change_allowlist: Array.isArray(raw.file_change_allowlist)
      ? (raw.file_change_allowlist as unknown[]).filter((p): p is string => typeof p === "string")
      : DEFAULTS.file_change_allowlist,
  };
}

/**
 * Check if the safety harness is enabled.
 * Used as a fast gate at hook registration and phase integration points.
 */
export function isHarnessEnabled(
  raw: Record<string, unknown> | undefined,
): boolean {
  if (!raw) return DEFAULTS.enabled;
  if (typeof raw.enabled === "boolean") return raw.enabled;
  return DEFAULTS.enabled;
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export {
  resetEvidence,
  getEvidence,
  getBashEvidence,
  getFilePaths,
  recordToolCall,
  recordToolResult,
  saveEvidenceToDisk,
  loadEvidenceFromDisk,
  clearEvidenceFromDisk,
} from "./evidence-collector.js";

export type { EvidenceEntry, BashEvidence, FileWriteEvidence, FileEditEvidence } from "./evidence-collector.js";

export { classifyCommand } from "./destructive-guard.js";
export type { CommandClassification } from "./destructive-guard.js";

export { validateFileChanges } from "./file-change-validator.js";
export type { FileChangeAudit, FileViolation } from "./file-change-validator.js";

export { crossReferenceEvidence } from "./evidence-cross-ref.js";
export type { ClaimedEvidence, EvidenceMismatch } from "./evidence-cross-ref.js";

export { createCheckpoint, rollbackToCheckpoint, cleanupCheckpoint } from "./git-checkpoint.js";

export { validateContent } from "./content-validator.js";
export type { ContentViolation } from "./content-validator.js";
