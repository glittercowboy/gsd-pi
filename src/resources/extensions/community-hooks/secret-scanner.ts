// GSD Community Hooks — Secret Scanner
//
// Blocks writes that contain API keys, tokens, passwords, and other secrets
// before they reach the filesystem. Catches common secret patterns in file
// content written via the write and edit tools.

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { isToolCallEventType } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

/** Each pattern includes a human-readable label and regex. */
interface SecretPattern {
  label: string;
  pattern: RegExp;
}

/**
 * Common secret patterns. These are intentionally broad enough to catch real
 * leaks but specific enough to avoid false positives on code that merely
 * references secret names (e.g. `process.env.API_KEY`).
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // AWS
  { label: "AWS Access Key", pattern: /(?<![A-Za-z0-9/+=])AKIA[0-9A-Z]{16}(?![A-Za-z0-9/+=])/ },
  { label: "AWS Secret Key", pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/ },

  // GitHub / GitLab tokens
  { label: "GitHub Token", pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/ },
  { label: "GitLab Token", pattern: /glpat-[A-Za-z0-9\-_]{20,}/ },

  // Generic API keys (base64-ish strings assigned to key-like variables)
  { label: "Generic API Key", pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9/+=_\-]{20,}["']?/i },
  { label: "Generic Secret", pattern: /(?:secret|token|password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']/i },

  // Anthropic / OpenAI
  { label: "Anthropic API Key", pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/ },
  { label: "OpenAI API Key", pattern: /sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/ },

  // Slack
  { label: "Slack Token", pattern: /xox[bpors]-[0-9]{10,}-[A-Za-z0-9\-]+/ },

  // Stripe
  { label: "Stripe Key", pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/ },

  // Private keys
  { label: "Private Key", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },

  // JWT (full tokens, not references)
  { label: "JWT Token", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-+/=]{10,}/ },

  // Connection strings
  { label: "Database URL", pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']{10,}@[^\s"']+/ },
];

/** File extensions that are safe to skip (binary, images, etc.). */
const SAFE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2",
  ".pdf", ".doc", ".docx",
  ".mp3", ".mp4", ".wav", ".webm",
  ".lock",
]);

/** Paths that commonly contain secret-like patterns but are not real secrets. */
const IGNORED_PATH_SEGMENTS = [
  "node_modules",
  ".git/",
  "test",
  "__tests__",
  "__mocks__",
  "fixtures",
  "snapshots",
];

function isSafePath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  if (SAFE_EXTENSIONS.has(ext.toLowerCase())) return true;
  return IGNORED_PATH_SEGMENTS.some((seg) => filePath.includes(seg));
}

function scanForSecrets(content: string): SecretPattern[] {
  const findings: SecretPattern[] = [];
  for (const sp of SECRET_PATTERNS) {
    if (sp.pattern.test(content)) {
      findings.push(sp);
    }
  }
  return findings;
}

export function registerSecretScanner(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    let filePath = "";
    let content = "";

    if (isToolCallEventType("write", event)) {
      filePath = event.input.path;
      content = event.input.content;
    } else if (isToolCallEventType("edit", event)) {
      filePath = event.input.path;
      content = event.input.newText ?? "";
    } else {
      return;
    }

    if (!content || isSafePath(filePath)) return;

    recordFire("secretScanner");
    const findings = scanForSecrets(content);
    if (findings.length === 0) return;

    const labels = findings.map((f) => f.label).join(", ");
    recordAction("secretScanner", `Blocked ${filePath}: ${labels}`);
    return {
      block: true,
      reason: `Secret Scanner: Blocked write to ${filePath} — detected: ${labels}. Remove secrets and use environment variables instead.`,
    };
  });
}
