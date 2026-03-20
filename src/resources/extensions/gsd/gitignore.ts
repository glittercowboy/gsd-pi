/**
 * GSD bootstrappers for .gitignore and preferences.md
 *
 * Ensures baseline .gitignore exists with universally-correct patterns.
 * Creates an empty preferences.md template if it doesn't exist.
 * Both idempotent — non-destructive if already present.
 */

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { nativeRmCached, nativeLsFiles } from "./native-git-bridge.js";
import { gsdRoot } from "./paths.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";

/**
 * GSD runtime patterns for git index cleanup.
 * With external state (symlink), these are a no-op in most cases,
 * but retained for backwards compatibility during migration.
 */
const GSD_RUNTIME_PATTERNS = [
  ".gsd/activity/",
  ".gsd/forensics/",
  ".gsd/runtime/",
  ".gsd/worktrees/",
  ".gsd/parallel/",
  ".gsd/auto.lock",
  ".gsd/metrics.json",
  ".gsd/completed-units.json",
  ".gsd/STATE.md",
  ".gsd/gsd.db",
  ".gsd/DISCUSSION-MANIFEST.json",
  ".gsd/milestones/**/*-CONTINUE.md",
  ".gsd/milestones/**/continue.md",
] as const;

const BASELINE_PATTERNS = [
  // ── GSD state directory (symlink to external storage) ──
  ".gsd",

  // ── OS junk ──
  ".DS_Store",
  "Thumbs.db",

  // ── Editor / IDE ──
  "*.swp",
  "*.swo",
  "*~",
  ".idea/",
  ".vscode/",
  "*.code-workspace",

  // ── Environment / secrets ──
  ".env",
  ".env.*",
  "!.env.example",

  // ── Node / JS / TS ──
  "node_modules/",
  ".next/",
  "dist/",
  "build/",

  // ── Python ──
  "__pycache__/",
  "*.pyc",
  ".venv/",
  "venv/",

  // ── Rust ──
  "target/",

  // ── Go ──
  "vendor/",

  // ── Misc build artifacts ──
  "*.log",
  "coverage/",
  ".cache/",
  "tmp/",
];

/**
 * Check whether `.gsd/` contains files tracked by git.
 * If so, the project intentionally keeps `.gsd/` in version control
 * and we must NOT add `.gsd` to `.gitignore` or attempt migration.
 *
 * Returns true if git tracks at least one file under `.gsd/`.
 * Returns false (safe to ignore) if:
 *   - Not a git repo
 *   - `.gsd/` is a symlink (external state, should be ignored)
 *   - `.gsd/` doesn't exist
 *   - No tracked files found under `.gsd/`
 */
export function hasGitTrackedGsdFiles(basePath: string): boolean {
  const localGsd = join(basePath, ".gsd");

  // If .gsd doesn't exist or is already a symlink, no tracked files concern
  if (!existsSync(localGsd)) return false;
  try {
    if (lstatSync(localGsd).isSymbolicLink()) return false;
  } catch {
    return false;
  }

  // Check if git tracks any files under .gsd/
  try {
    const tracked = nativeLsFiles(basePath, ".gsd");
    if (tracked.length > 0) return true;

    // nativeLsFiles swallows git failures and returns []. An empty result
    // could mean "nothing tracked" OR "git failed silently". Verify git is
    // reachable before trusting the empty result — if it isn't, fail safe
    // by assuming files ARE tracked to prevent data loss.
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: basePath,
      stdio: "pipe",
      env: GIT_NO_PROMPT_ENV,
    });

    return false;
  } catch {
    // git unavailable, index locked, or repo corrupt — fail safe
    return true;
  }
}

/**
 * Ensure basePath/.gitignore contains baseline ignore patterns.
 * Creates the file if missing; appends missing patterns.
 * Returns true if the file was created or modified, false if already complete.
 *
 * **Safety check:** If `.gsd/` contains git-tracked files (i.e., the project
 * intentionally keeps `.gsd/` in version control), the `.gsd` ignore pattern
 * is excluded to prevent data loss. Only the `.gsd` pattern is affected —
 * all other baseline patterns are still applied normally.
 */
export function ensureGitignore(
  basePath: string,
  options?: { manageGitignore?: boolean; commitDocs?: boolean },
): boolean {
  // If manage_gitignore is explicitly false, do not touch .gitignore at all
  if (options?.manageGitignore === false) return false;

  const gitignorePath = join(basePath, ".gitignore");

  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, "utf-8");
  }

  // Parse existing lines (trimmed, ignoring comments and blanks)
  const existingLines = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );

  // Determine which patterns to apply. If .gsd/ has tracked files,
  // exclude the ".gsd" pattern to prevent deleting tracked state.
  const gsdIsTracked = hasGitTrackedGsdFiles(basePath);
  const patternsToApply = gsdIsTracked
    ? BASELINE_PATTERNS.filter((p) => p !== ".gsd")
    : BASELINE_PATTERNS;

  // Find patterns not yet present
  const missing = patternsToApply.filter((p) => !existingLines.has(p));

  if (missing.length === 0) return false;

  // Build the block to append
  const block = [
    "",
    "# ── GSD baseline (auto-generated) ──",
    ...missing,
    "",
  ].join("\n");

  // Ensure existing content ends with a newline before appending
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, existing + prefix + block, "utf-8");

  return true;
}

/**
 * Remove BASELINE_PATTERNS runtime paths from the git index if they are
 * currently tracked. This fixes repos that started tracking these files
 * before the .gitignore rule was added — git continues tracking files
 * already in the index even after .gitignore is updated.
 *
 * Only removes from the index (`--cached`), never from disk. Idempotent.
 *
 * Note: These are strictly runtime/ephemeral paths (activity logs, lock files,
 * metrics, STATE.md). They are always safe to untrack, even when the project
 * intentionally keeps other `.gsd/` files (like PROJECT.md, milestones/) in
 * version control.
 */
export function untrackRuntimeFiles(basePath: string): void {
  const runtimePaths = GSD_RUNTIME_PATTERNS;

  for (const pattern of runtimePaths) {
    // Use -r for directory patterns (trailing slash), strip the slash for the command
    const target = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
    try {
      nativeRmCached(basePath, [target]);
    } catch {
      // File not tracked or doesn't exist — expected, ignore
    }
  }
}

/**
 * Ensure basePath/.gsd/preferences.md exists as an empty template.
 * Creates the file with frontmatter only if it doesn't exist.
 * Returns true if created, false if already exists.
 *
 * Checks both lowercase (canonical) and uppercase (legacy) to avoid
 * creating a duplicate when an uppercase file already exists.
 */
export function ensurePreferences(basePath: string): boolean {
  const preferencesPath = join(gsdRoot(basePath), "preferences.md");
  const legacyPath = join(gsdRoot(basePath), "PREFERENCES.md");

  if (existsSync(preferencesPath) || existsSync(legacyPath)) {
    return false;
  }

  const template = `---
version: 1
always_use_skills: []
prefer_skills: []
avoid_skills: []
skill_rules: []
custom_instructions: []
models: {}
skill_discovery: {}
auto_supervisor: {}
---

# GSD Skill Preferences

Project-specific guidance for skill selection and execution preferences.

See \`~/.gsd/agent/extensions/gsd/docs/preferences-reference.md\` for full field documentation and examples.

## Fields

- \`always_use_skills\`: Skills that must be available during all GSD operations
- \`prefer_skills\`: Skills to prioritize when multiple options exist
- \`avoid_skills\`: Skills to minimize or avoid (with lower priority than prefer)
- \`skill_rules\`: Context-specific rules (e.g., "use tool X for Y type of work")
- \`custom_instructions\`: Append-only project guidance (do not override system rules)
- \`models\`: Model preferences for specific task types
- \`skill_discovery\`: Automatic skill detection preferences
- \`auto_supervisor\`: Supervision and gating rules for autonomous modes
- \`git\`: Git preferences — \`main_branch\` (default branch name for new repos, e.g., "main", "master", "trunk"), \`auto_push\`, \`snapshots\`, etc.

## Examples

\`\`\`yaml
prefer_skills:
  - playwright
  - resolve_library
avoid_skills:
  - subagent  # prefer direct execution in this project

custom_instructions:
  - "Always verify with browser_assert before marking UI work done"
  - "Use Context7 for all library/framework decisions"
\`\`\`
`;

  writeFileSync(preferencesPath, template, "utf-8");
  return true;
}

