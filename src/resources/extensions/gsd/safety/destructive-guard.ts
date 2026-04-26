/**
 * Destructive command classifier for auto-mode safety harness.
 * Classifies bash commands and warns on potentially destructive operations.
 *
 * Two tiers:
 *   - classifyCommand    — broad heuristic set; warn-only (false positives OK).
 *   - classifyCatastrophic — tight denylist of unambiguously host-damaging
 *                             commands that must hard-block regardless of mode.
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

/**
 * Catastrophic patterns — a tight denylist of commands with no legitimate
 * agent use case that would cause irreversible host damage, data loss, or
 * rewritten shared history.
 *
 * Every entry here is a hard block. False positives would be worse than for
 * the broader destructive set, so patterns are deliberately narrow.
 *
 * Threat model: this guard is a defense-in-depth layer aimed at confused-agent
 * accidents (the LLM accidentally constructs a destructive command), not a
 * sandbox against an adversarial actor with shell-execution. Trivial bypasses
 * exist via `eval`, `bash -c`, command substitution, base64-decoded payloads,
 * tools spelled with whitespace expansion, or any language interpreter
 * (`python -c`, `node -e`). Treat this as a tripwire, not a perimeter.
 *
 * Defense-in-depth: the filesystem perimeter guard (`path-guard.ts`) catches
 * a different class — out-of-tree writes — and the two together close the
 * common-case slip-up. Neither is sufficient against a hostile model.
 */
interface CatastrophicPattern {
  pattern: RegExp;
  label: string;
}

const CATASTROPHIC_PATTERNS: readonly CatastrophicPattern[] = [
  // Filesystem wipes targeting well-known critical roots. We anchor on the
  // root path so that `rm -rf ./node_modules` etc. do not trigger.
  //
  // Flag forms accepted (any one is enough):
  //   short combined: -rf, -fr, -Rf, -r, -f
  //   long: --recursive, --force, --no-preserve-root
  //
  // Target alternatives:
  //   /*                                 — glob of root
  //   /etc, /usr, /var, ...  (word boundary) — system + pseudo-fs dirs
  //   /  followed by whitespace or EOL  — bare root
  //   ~  followed by /, whitespace, or EOL — home
  //   $HOME                              — literal var
  {
    pattern:
      /\brm\s+(?:(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--(?:recursive|force|no-preserve-root))\s+)+(?:--\s+)?(?:\/\*|\/(?:etc|usr|var|bin|sbin|lib|lib64|boot|root|home|proc|sys|dev|run|opt|srv|mnt|media|nix|data)\b|\/(?:\s|$)|~(?:\/|\s|$)|\$HOME\b)/,
    label: "rm -rf of critical filesystem root",
  },
  // Disk wipes via dd targeting block devices (Linux: /dev/sd*, /dev/nvme*,
  // /dev/hd*, /dev/dm-*, /dev/loop*; macOS: /dev/disk*, /dev/rdisk*).
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|dm-?\d+|loop\d+|r?disk\d)/i,
    label: "dd to raw block device",
  },
  // Filesystem creation on a block device (mkfs.ext4, mkfs.xfs, mke2fs, etc.).
  {
    pattern: /\bmk(?:fs(?:\.[a-z0-9]+)?|e2fs)\b[^\n]*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|dm-?\d+|loop\d+|r?disk\d)/i,
    label: "mkfs on raw block device",
  },
  // Fork bomb — the classic `:(){ :|:& };:` shape, with whitespace tolerance.
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    label: "fork bomb",
  },
  // Host shutdown / reboot. Only match when used as a command (start of line
  // or after `;`/`&&`/`||`/pipe) to avoid matching `git log --format=reboot`.
  {
    pattern: /(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|halt|poweroff)\b/,
    label: "host shutdown/reboot",
  },
  // Force push targeting the default integration branch. Blocks the common
  // shapes (`git push --force origin main`, `git push -f origin main`,
  // `git push --force-with-lease origin main`, and short `origin +main` syntax).
  {
    pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|\s-f\b)[^\n]*\b(?:origin|upstream)\s+\+?(?:main|master|trunk|develop)\b/,
    label: "force push to protected branch",
  },
  {
    pattern: /\bgit\s+push\b[^\n]*\b(?:origin|upstream)\s+\+(?:main|master|trunk|develop)\b/,
    label: "force push to protected branch",
  },
  // Recursive chmod on the filesystem root or system directories.
  {
    pattern:
      /\bchmod\s+(?:(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+)+(?:\d+|[a-zA-Z+=,-]+)\s+(?:\/\*|\/(?:etc|usr|var|bin|sbin|lib|lib64|boot|root|home|proc|sys|dev|run|opt|srv|mnt|media|nix|data)\b|\/(?:\s|$)|~(?:\/|\s|$)|\$HOME\b)/,
    label: "recursive chmod of critical root",
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CommandClassification {
  destructive: boolean;
  labels: string[];
}

/**
 * Result of a catastrophic-command check.
 *
 * Shaped to be directly returnable from a `tool_call` extension hook:
 *   if (result.block) return { block: true, reason: result.reason };
 */
export interface CatastrophicClassification {
  block: boolean;
  reason: string;
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

/**
 * Check a bash command against the catastrophic denylist.
 *
 * Unlike {@link classifyCommand}, this runs unconditionally (not gated on
 * auto-mode) and a positive match means the command MUST be blocked.
 * Patterns are intentionally tight to avoid false positives on normal work.
 */
export function classifyCatastrophic(command: string): CatastrophicClassification {
  const labels: string[] = [];
  for (const { pattern, label } of CATASTROPHIC_PATTERNS) {
    if (pattern.test(command)) {
      if (!labels.includes(label)) labels.push(label);
    }
  }
  if (labels.length === 0) {
    return { block: false, reason: "", labels };
  }
  const reason =
    `Blocked catastrophic command: ${labels.join(", ")}. ` +
    `This action is irreversible or would damage the host. ` +
    `If this is genuinely intentional, run it manually outside the agent.`;
  return { block: true, reason, labels };
}
