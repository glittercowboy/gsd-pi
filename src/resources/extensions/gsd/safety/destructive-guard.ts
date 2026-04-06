/**
 * Destructive command classifier for auto-mode safety harness.
 * Classifies bash commands and warns on potentially destructive operations.
 * Does NOT block — only classifies for logging/notification.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

// ─── Pattern Definitions ────────────────────────────────────────────────────

interface DestructivePattern {
  pattern: RegExp;
  label: string;
}

const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  { pattern: /\brm\s+(-[^\s]*[rfRF][^\s]*\s+|.*\s+-[^\s]*[rfRF])/, label: "recursive delete" },
  { pattern: /\bgit\s+push\s+.*--force/, label: "force push" },
  { pattern: /\bgit\s+push\s+-f\b/, label: "force push" },
  { pattern: /\bgit\s+reset\s+--hard/, label: "hard reset" },
  { pattern: /\bgit\s+clean\s+-[^\s]*[fdxFDX]/, label: "git clean" },
  { pattern: /\bgit\s+checkout\s+--\s+\./, label: "discard all changes" },
  { pattern: /\bdrop\s+(database|table|index)\b/i, label: "SQL drop" },
  { pattern: /\btruncate\s+table\b/i, label: "SQL truncate" },
  { pattern: /\bchmod\s+777\b/, label: "world-writable permissions" },
  { pattern: /\bcurl\s.*\|\s*(bash|sh|zsh)\b/, label: "pipe to shell" },
];

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CommandClassification {
  destructive: boolean;
  labels: string[];
}

/**
 * Classify a bash command for destructive operations.
 * Returns the list of matched destructive pattern labels.
 */
export function classifyCommand(command: string): CommandClassification {
  const labels: string[] = [];
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      // Deduplicate labels (e.g., two force-push patterns)
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return { destructive: labels.length > 0, labels };
}
