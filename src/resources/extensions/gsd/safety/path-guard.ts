// GSD Extension — Filesystem perimeter guard
// Blocks Write/Edit/bash tool calls that target paths outside the current
// session's base directory. Purely-local escape hatches (tmp dir) remain
// writable so scratch files keep working.
//
// The guard is intentionally conservative: it only blocks ABSOLUTE paths
// that clearly resolve outside the perimeter. Relative paths are always
// allowed and interpreted as in-tree. Bash commands that would redirect to
// absolute out-of-tree paths (`> /etc/passwd`) are matched via the same
// pattern style used by write-intercept.ts.
//
// Threat model: this is a tripwire for confused-agent accidents (Write/Edit
// to /etc/* or a heredoc-ified system file), not a sandbox. The bash
// scanner is a regex over the command string and is best-effort: quoting,
// variable expansion, heredocs, command substitution, and language
// interpreters (`python -c open('/etc/x','w')`) all bypass the bash arm.
// In-tree absolute paths and Write/Edit calls hit the structured arm
// (classifyFilePath), which is precise.
//
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

// ─── Perimeter check ────────────────────────────────────────────────────────

/**
 * Resolve a path to an absolute form, preferring the realpath when it exists
 * so that in-tree symlinks resolve correctly.
 *
 * For paths that don't exist yet (e.g. a Write to a new file), we walk up to
 * the longest existing prefix, realpath that, and re-append the missing
 * suffix. This is required on macOS where tmpdir's `/var/...` resolves to
 * `/private/var/...` — without prefix-resolution, an in-tree new file would
 * appear to escape the perimeter.
 *
 * Falls back conservatively to plain `resolve()` if no ancestor resolves.
 */
function canonicalize(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Walk up to the longest existing ancestor.
    let cur = abs;
    const suffix: string[] = [];
    while (true) {
      const parent = dirname(cur);
      if (parent === cur) return abs; // hit filesystem root, give up
      const tail = cur.slice(parent.length);
      suffix.unshift(tail);
      cur = parent;
      try {
        const real = realpathSync(cur);
        return real + suffix.join("");
      } catch {
        /* keep walking */
      }
    }
  }
}

/**
 * True iff `child` is the same path as `parent` or nested inside it.
 * Both inputs are expected to be absolute. Uses path.relative to avoid
 * false positives from prefix-string comparison (`/fooBar` startsWith `/foo`).
 *
 * `relative()` always produces a leading ".." segment for any escape
 * (POSIX or Windows), so `startsWith("..")` is sufficient on both platforms.
 */
function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith("..");
}

const ALLOWED_ESCAPE_PATHS: readonly string[] = (() => {
  const allowed: string[] = [];
  for (const candidate of [tmpdir(), process.env.TMPDIR]) {
    if (!candidate) continue;
    try {
      const dir = canonicalize(candidate);
      if (!allowed.includes(dir)) allowed.push(dir);
    } catch {
      /* best effort */
    }
  }
  return allowed;
})();

/**
 * Returns true if `filePath` is within the session perimeter rooted at
 * `basePath`, OR within one of the always-allowed escape hatches (tmpdir,
 * $TMPDIR).
 *
 * Only absolute paths are perimeter-checked. Relative paths are assumed
 * to be interpreted relative to cwd by the caller and therefore in-tree.
 */
export function isWithinPerimeter(filePath: string, basePath: string): boolean {
  if (!filePath) return true;
  if (!isAbsolute(filePath)) return true;
  // Defensive: if no perimeter is supplied, fail closed (treat as out-of-tree)
  // so a misconfigured caller cannot silently disable the guard.
  if (!basePath) return false;

  const target = canonicalize(filePath);
  const base = canonicalize(basePath);

  if (isPathInside(target, base)) return true;

  for (const dir of ALLOWED_ESCAPE_PATHS) {
    if (isPathInside(target, dir)) return true;
  }

  return false;
}

// ─── Bash command perimeter check ───────────────────────────────────────────

/**
 * Regexes that capture absolute-path targets in bash commands that would
 * write outside the perimeter. Each pattern has a capture group containing
 * the absolute path.
 *
 * We only match absolute paths (leading `/` or `~/`) because relative paths
 * are, by definition, in-tree. This keeps the guard conservative.
 */
const BASH_ABS_WRITE_PATTERNS: readonly RegExp[] = [
  // Redirect: > /abs/path, >> /abs/path, >| /abs/path
  />+\|?\s*(~\/[^\s'"`]+|\/[^\s'"`]+)/,
  // tee target: tee [-a] /abs/path
  /\btee\b[^\n]*?\s(~\/[^\s'"`]+|\/[^\s'"`]+)/,
  // cp/mv destination: cp SRC /abs/path  — the destination is always the last arg
  /\b(?:cp|mv|install)\b[^\n]*?\s(~\/[^\s'"`]+|\/[^\s'"`]+)\s*$/,
  // sed -i operating on an absolute path
  /\bsed\b[^\n]*?-i[^\s]*[^\n]*?\s(~\/[^\s'"`]+|\/[^\s'"`]+)/,
  // dd of=/abs/path
  /\bdd\b[^\n]*?\bof=(~\/[^\s'"`]+|\/[^\s'"`]+)/,
  // rm targeting an absolute path (any flags)
  /\brm\b[^\n]*?\s(~\/[^\s'"`]+|\/[^\s'"`]+)/,
];

export interface BashPathGuardResult {
  block: boolean;
  reason: string;
  matchedPath?: string;
}

/**
 * Expand a leading `~` or `~/` to the user's home directory. Anything else
 * is returned unchanged.
 */
function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) return resolve(home, p.slice(2));
  }
  return p;
}

/**
 * Scan a bash command for absolute-path write targets that would land
 * outside the session perimeter. Conservative: only fires on clearly
 * out-of-tree absolute paths.
 */
export function classifyBashPath(command: string, basePath: string): BashPathGuardResult {
  for (const pattern of BASH_ABS_WRITE_PATTERNS) {
    const match = command.match(pattern);
    if (!match) continue;
    // The last capture group holds the path — find the first non-empty.
    const candidate = match.slice(1).find((g) => typeof g === "string" && g.length > 0);
    if (!candidate) continue;

    const expanded = expandHome(candidate);
    if (!isAbsolute(expanded)) continue;

    if (!isWithinPerimeter(expanded, basePath)) {
      return {
        block: true,
        reason: formatReason(expanded, basePath),
        matchedPath: expanded,
      };
    }
  }
  return { block: false, reason: "" };
}

/**
 * Check a Write or Edit tool's target path. Wraps {@link isWithinPerimeter}
 * so callers get a return value already shaped for the tool_call hook.
 */
export function classifyFilePath(filePath: string, basePath: string): BashPathGuardResult {
  if (isWithinPerimeter(filePath, basePath)) {
    return { block: false, reason: "" };
  }
  return {
    block: true,
    reason: formatReason(filePath, basePath),
    matchedPath: filePath,
  };
}

function formatReason(target: string, basePath: string): string {
  return (
    `Write to "${target}" denied: outside session perimeter (${basePath}). ` +
    `The agent is only allowed to write inside the project tree (and the ` +
    `system temp dir). If this is genuinely intentional, run the command ` +
    `manually outside the agent.`
  );
}
