/**
 * GSD bootstrappers for .gitignore and preferences.md
 *
 * Ensures baseline .gitignore exists with universally-correct patterns.
 * Creates an empty preferences.md template if it doesn't exist.
 * Both idempotent — non-destructive if already present.
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Patterns that are always correct regardless of project type.
 * No one ever wants these tracked.
 */
const GSD_RUNTIME_PATTERNS = [
  ".gsd/activity/",
  ".gsd/runtime/",
  ".gsd/worktrees/",
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
  // ── GSD runtime (not source artifacts — planning files are tracked) ──
  ...GSD_RUNTIME_PATTERNS,

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
 * Remove BASELINE_PATTERNS runtime paths from the git index if they are
 * currently tracked. This fixes repos that started tracking these files
 * before the .gitignore rule was added — git continues tracking files
 * already in the index even after .gitignore is updated.
 *
 * Only removes from the index (`--cached`), never from disk. Idempotent.
 */
export function untrackRuntimeFiles(basePath: string): void {
  const runtimePaths = GSD_RUNTIME_PATTERNS;

  for (const pattern of runtimePaths) {
    // Use -r for directory patterns (trailing slash), strip the slash for the command
    const target = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
    try {
      execSync(`git rm -r --cached ${target}`, {
        cwd: basePath,
        stdio: ["ignore", "ignore", "ignore"],
      });
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

