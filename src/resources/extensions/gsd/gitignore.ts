/**
 * GSD bootstrappers for .gitignore and preferences.md
 *
 * Ensures baseline .gitignore exists with universally-correct patterns.
 * Creates an empty preferences.md template if it doesn't exist.
 * Both idempotent — non-destructive if already present.
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Patterns that are always correct regardless of project type.
 * No one ever wants these tracked.
 */
const BASELINE_PATTERNS = [
  // ── GSD (branch-transparent — all .gsd/ lives untracked) ──
  ".gsd/",
  // DB sidecar files — explicit for envs where .gsd/ paths are force-added
  ".gsd/gsd.db",
  ".gsd/gsd.db-wal",
  ".gsd/gsd.db-shm",

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
 * Ensure basePath/.gitignore contains all baseline patterns.
 * Creates the file if missing; appends only missing lines if it exists.
 * Returns true if the file was created or modified, false if already complete.
 */
export function ensureGitignore(basePath: string): boolean {
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

  // Find patterns not yet present
  const missing = BASELINE_PATTERNS.filter((p) => !existingLines.has(p));

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
 * Remove .gsd/ files from the git index if they are currently tracked.
 * Since .gsd/ is now fully gitignored (branch-transparent), ALL .gsd/
 * files should be untracked. This fixes repos that started tracking
 * these files before the blanket .gitignore rule was added.
 *
 * Only removes from the index (`--cached`), never from disk. Idempotent.
 */
export function untrackRuntimeFiles(basePath: string): void {
  try {
    execSync("git rm -r --cached .gsd/", {
      cwd: basePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Nothing tracked under .gsd/ — expected, ignore
  }
}

/**
 * GSD durable planning artifact paths that must be force-added back to the
 * git index even though .gsd/ is gitignored. These are committed on the
 * integration branch (main) so they survive squash-merges.
 *
 * Mirrors GSD_DURABLE_PATHS in git-service.ts.
 */
const MIGRATION_DURABLE_PATHS: readonly string[] = [
  ".gsd/milestones/",
  ".gsd/DECISIONS.md",
  ".gsd/QUEUE.md",
  ".gsd/PROJECT.md",
  ".gsd/REQUIREMENTS.md",
];

/** Flag file path — presence means migration already ran. */
const MIGRATION_FLAG = ".gsd/runtime/.migrated-untracked";

/**
 * One-time migration: make .gsd/ branch-transparent by removing all .gsd/
 * files from the git index, then force-adding only durable planning paths.
 *
 * Steps:
 * 1. Check flag file — skip if already migrated
 * 2. Check if any .gsd/ files are in the git index
 * 3. `git rm -r --cached .gsd/` to untrack everything
 * 4. Force-add GSD_DURABLE_PATHS back (only existing files)
 * 5. Commit: "chore: make .gsd/ branch-transparent (untrack from git index)"
 * 6. Write flag file so migration doesn't run again
 *
 * Idempotent: no-ops if flag exists or nothing is tracked.
 */
export function migrateGsdToUntracked(basePath: string): boolean {
  const flagPath = join(basePath, MIGRATION_FLAG);

  // Already migrated — skip
  if (existsSync(flagPath)) return false;

  // Step 1: Check if any .gsd/ files are in the git index
  let trackedFiles = "";
  try {
    trackedFiles = execSync("git ls-files --cached .gsd/", {
      cwd: basePath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
  } catch {
    // Not a git repo or no tracked files — write flag and skip
    writeMigrationFlag(basePath, flagPath);
    return false;
  }

  if (!trackedFiles) {
    // Nothing tracked under .gsd/ — already clean
    writeMigrationFlag(basePath, flagPath);
    return false;
  }

  // Step 2: Untrack everything under .gsd/
  try {
    execSync("git rm -r --cached .gsd/", {
      cwd: basePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Failed to untrack — don't commit partial state
    return false;
  }

  // Step 3: Force-add only durable planning paths back
  for (const durablePath of MIGRATION_DURABLE_PATHS) {
    try {
      execSync(`git add --force -- ${durablePath}`, {
        cwd: basePath,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // Path doesn't exist or nothing to add — fine
    }
  }

  // Step 4: Commit
  try {
    execSync(
      'git commit --no-verify -m "chore: make .gsd/ branch-transparent (untrack from git index)"',
      {
        cwd: basePath,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch {
    // Nothing to commit (all durable paths were already the same) — fine
  }

  // Step 5: Write flag file
  writeMigrationFlag(basePath, flagPath);
  return true;
}

function writeMigrationFlag(basePath: string, flagPath: string): void {
  const flagDir = join(basePath, ".gsd", "runtime");
  mkdirSync(flagDir, { recursive: true });
  writeFileSync(flagPath, new Date().toISOString() + "\n", "utf-8");
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
  const preferencesPath = join(basePath, ".gsd", "preferences.md");
  const legacyPath = join(basePath, ".gsd", "PREFERENCES.md");

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
