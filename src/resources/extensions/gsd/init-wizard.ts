/**
 * GSD Init Wizard — Per-project onboarding.
 *
 * Guides users through project setup when entering a directory without .gsd/.
 * Detects project ecosystem, offers v1 migration, configures project preferences,
 * bootstraps .gsd/ structure, and transitions to the first milestone discussion.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { showNextAction } from "../shared/tui.js";
import { nativeIsRepo, nativeInit } from "./native-git-bridge.js";
import { ensureGitignore, untrackRuntimeFiles } from "./gitignore.js";
import { gsdRoot } from "./paths.js";
import { assertSafeDirectory } from "./validate-directory.js";
import type { ProjectDetection, ProjectSignals } from "./detection.js";
import { runSkillInstallStep } from "./skill-catalog.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface InitWizardResult {
  /** Whether the wizard completed (vs cancelled) */
  completed: boolean;
  /** Whether .gsd/ was created */
  bootstrapped: boolean;
}

interface ProjectPreferences {
  mode: "solo" | "team";
  gitIsolation: "worktree" | "branch" | "none";
  mainBranch: string;
  verificationCommands: string[];
  customInstructions: string[];
  tokenProfile: "budget" | "balanced" | "quality";
  skipResearch: boolean;
  autoPush: boolean;
}

// ─── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_PREFS: ProjectPreferences = {
  mode: "solo",
  gitIsolation: "worktree",
  mainBranch: "main",
  verificationCommands: [],
  customInstructions: [],
  tokenProfile: "balanced",
  skipResearch: false,
  autoPush: true,
};

// ─── Main Wizard ────────────────────────────────────────────────────────────────

/**
 * Run the project init wizard.
 * Called when entering a directory without .gsd/ (or via /gsd init).
 */
export async function showProjectInit(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  detection: ProjectDetection,
): Promise<InitWizardResult> {
  const signals = detection.projectSignals;
  const prefs = { ...DEFAULT_PREFS };

  // ── Step 1: Show what we detected ──────────────────────────────────────────
  const detectionSummary = buildDetectionSummary(signals);
  if (detectionSummary.length > 0) {
    ctx.ui.notify(`Project detected:\n${detectionSummary.join("\n")}`, "info");
  }

  // ── Step 2: Git setup ──────────────────────────────────────────────────────
  if (!signals.isGitRepo) {
    const gitChoice = await showNextAction(ctx, {
      title: "GSD — Project Setup",
      summary: ["This folder is not a git repository. GSD uses git for version control and isolation."],
      actions: [
        { id: "init_git", label: "Initialize git", description: "Create a git repo in this folder", recommended: true },
        { id: "skip_git", label: "Skip", description: "Continue without git (limited functionality)" },
      ],
      notYetMessage: "Run /gsd init when ready.",
    });

    if (gitChoice === "not_yet") return { completed: false, bootstrapped: false };

    if (gitChoice === "init_git") {
      nativeInit(basePath, prefs.mainBranch);
    }
  } else {
    // Auto-detect main branch from existing repo
    const detectedBranch = detectMainBranch(basePath);
    if (detectedBranch) prefs.mainBranch = detectedBranch;
  }

  // ── Step 3: Mode selection ─────────────────────────────────────────────────
  const modeChoice = await showNextAction(ctx, {
    title: "GSD — Workflow Mode",
    summary: ["How are you working on this project?"],
    actions: [
      {
        id: "solo",
        label: "Solo",
        description: "Just me — auto-push, squash merge, worktree isolation",
        recommended: true,
      },
      {
        id: "team",
        label: "Team",
        description: "Multiple contributors — branch-based, PR-friendly workflow",
      },
    ],
    notYetMessage: "Run /gsd init when ready.",
  });

  if (modeChoice === "not_yet") return { completed: false, bootstrapped: false };
  prefs.mode = modeChoice as "solo" | "team";

  // Apply mode-driven defaults
  if (prefs.mode === "team") {
    prefs.autoPush = false;
  }

  // ── Step 4: Verification commands ──────────────────────────────────────────
  prefs.verificationCommands = signals.verificationCommands;

  if (signals.verificationCommands.length > 0) {
    const verifyLines = signals.verificationCommands.map((cmd, i) => `  ${i + 1}. ${cmd}`);
    const verifyChoice = await showNextAction(ctx, {
      title: "GSD — Verification Commands",
      summary: [
        "Auto-detected verification commands:",
        ...verifyLines,
        "",
        "GSD runs these after each code change to verify nothing is broken.",
      ],
      actions: [
        { id: "accept", label: "Use these commands", description: "Accept auto-detected commands", recommended: true },
        { id: "skip", label: "Skip verification", description: "Don't verify after changes" },
      ],
      notYetMessage: "Run /gsd init when ready.",
    });

    if (verifyChoice === "not_yet") return { completed: false, bootstrapped: false };
    if (verifyChoice === "skip") prefs.verificationCommands = [];
  }

  // ── Step 5: Git preferences ────────────────────────────────────────────────
  const gitSummary: string[] = [];
  gitSummary.push(`Git isolation: worktree`);
  gitSummary.push(`Main branch: ${prefs.mainBranch}`);

  const gitChoice = await showNextAction(ctx, {
    title: "GSD — Git Settings",
    summary: ["Default git settings for this project:", ...gitSummary],
    actions: [
      { id: "accept", label: "Accept defaults", description: "Use standard git settings", recommended: true },
      { id: "customize", label: "Customize", description: "Change git settings" },
    ],
    notYetMessage: "Run /gsd init when ready.",
  });

  if (gitChoice === "not_yet") return { completed: false, bootstrapped: false };

  if (gitChoice === "customize") {
    await customizeGitPrefs(ctx, prefs, signals);
  }

  // ── Step 6: Custom instructions ────────────────────────────────────────────
  const instructionChoice = await showNextAction(ctx, {
    title: "GSD — Project Instructions",
    summary: [
      "Any rules GSD should follow for this project?",
      "",
      "Examples:",
      '  - "Use TypeScript strict mode"',
      '  - "Always write tests for new code"',
      '  - "This is a monorepo, only touch packages/api"',
      "",
      "You can always add more later via /gsd prefs project.",
    ],
    actions: [
      { id: "skip", label: "Skip for now", description: "No special instructions", recommended: true },
      { id: "add", label: "Add instructions", description: "Enter project-specific rules" },
    ],
    notYetMessage: "Run /gsd init when ready.",
  });

  if (instructionChoice === "not_yet") return { completed: false, bootstrapped: false };

  if (instructionChoice === "add") {
    const input = await ctx.ui.input(
      "Enter instructions (one per line, or comma-separated):",
      "e.g., Use Tailwind CSS, Always write tests",
    );
    if (input && input.trim()) {
      // Split on newlines or commas
      prefs.customInstructions = input
        .split(/[,\n]/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    }
  }

  // ── Step 7: Advanced (optional) ────────────────────────────────────────────
  const advancedChoice = await showNextAction(ctx, {
    title: "GSD — Advanced Settings",
    summary: [
      `Token profile: ${prefs.tokenProfile}`,
      `Skip research phase: ${prefs.skipResearch ? "yes" : "no"}`,
      `Auto-push on merge: ${prefs.autoPush ? "yes" : "no"}`,
    ],
    actions: [
      { id: "accept", label: "Accept defaults", description: "Use standard settings", recommended: true },
      { id: "customize", label: "Customize", description: "Change advanced settings" },
    ],
    notYetMessage: "Run /gsd init when ready.",
  });

  if (advancedChoice === "not_yet") return { completed: false, bootstrapped: false };

  if (advancedChoice === "customize") {
    await customizeAdvancedPrefs(ctx, prefs);
  }

  // ── Step 8: Skill Installation ─────────────────────────────────────────────
  try {
    await runSkillInstallStep(ctx, signals);
  } catch {
    // Non-fatal — skill installation failure should never block project init
  }

  // ── Step 9: Bootstrap .gsd/ ────────────────────────────────────────────────
  bootstrapGsdDirectory(basePath, prefs, signals);

  // Ensure .gitignore
  ensureGitignore(basePath);
  untrackRuntimeFiles(basePath);

  ctx.ui.notify("GSD initialized. Starting your first milestone...", "info");

  return { completed: true, bootstrapped: true };
}

// ─── V1 Migration Offer ─────────────────────────────────────────────────────────

/**
 * Show migration offer when .planning/ is detected.
 * Returns 'migrate', 'fresh', or 'cancel'.
 */
export async function offerMigration(
  ctx: ExtensionCommandContext,
  v1: NonNullable<ProjectDetection["v1"]>,
): Promise<"migrate" | "fresh" | "cancel"> {
  const summary = [
    "Found .planning/ directory (GSD v1 format)",
  ];
  if (v1.phaseCount > 0) {
    summary.push(`${v1.phaseCount} phase${v1.phaseCount > 1 ? "s" : ""} detected`);
  }
  if (v1.hasRoadmap) {
    summary.push("Has ROADMAP.md");
  }

  const choice = await showNextAction(ctx, {
    title: "GSD — Legacy Project Detected",
    summary,
    actions: [
      {
        id: "migrate",
        label: "Migrate to GSD v2",
        description: "Convert .planning/ to .gsd/ format",
        recommended: true,
      },
      {
        id: "fresh",
        label: "Start fresh",
        description: "Ignore .planning/ and create new .gsd/",
      },
    ],
    notYetMessage: "Run /gsd init when ready.",
  });

  if (choice === "not_yet") return "cancel";
  return choice as "migrate" | "fresh";
}

// ─── Re-init Handler ────────────────────────────────────────────────────────────

/**
 * Handle /gsd init when .gsd/ already exists.
 * Offers preference reset without destructive milestone deletion.
 */
export async function handleReinit(
  ctx: ExtensionCommandContext,
  detection: ProjectDetection,
): Promise<void> {
  const summary = ["GSD is already initialized in this project."];
  if (detection.v2) {
    summary.push(`${detection.v2.milestoneCount} milestone(s) found`);
    summary.push(`Preferences: ${detection.v2.hasPreferences ? "configured" : "not set"}`);
  }

  const choice = await showNextAction(ctx, {
    title: "GSD — Already Initialized",
    summary,
    actions: [
      {
        id: "prefs",
        label: "Re-configure preferences",
        description: "Update project preferences without affecting milestones",
        recommended: true,
      },
      {
        id: "cancel",
        label: "Cancel",
        description: "Keep everything as-is",
      },
    ],
    notYetMessage: "Run /gsd init when ready.",
  });

  if (choice === "prefs") {
    ctx.ui.notify("Use /gsd prefs project to update project preferences.", "info");
  }
}

// ─── Git Preferences Customization ──────────────────────────────────────────────

async function customizeGitPrefs(
  ctx: ExtensionCommandContext,
  prefs: ProjectPreferences,
  signals: ProjectSignals,
): Promise<void> {
  // Isolation strategy
  const hasSubmodules = existsSync(join(process.cwd(), ".gitmodules"));
  const isolationActions = [
    { id: "worktree", label: "Worktree", description: "Isolated git worktree per milestone (recommended)", recommended: !hasSubmodules },
    { id: "branch", label: "Branch", description: "Work on branches in project root (better for submodules)", recommended: hasSubmodules },
    { id: "none", label: "None", description: "No isolation — commits on current branch" },
  ];

  const isolationSummary = hasSubmodules
    ? ["Submodules detected — branch mode recommended over worktree."]
    : ["Worktree isolation creates a separate copy for each milestone."];

  const isolationChoice = await showNextAction(ctx, {
    title: "Git isolation strategy",
    summary: isolationSummary,
    actions: isolationActions,
  });
  if (isolationChoice !== "not_yet") {
    prefs.gitIsolation = isolationChoice as "worktree" | "branch" | "none";
  }
}

// ─── Advanced Preferences Customization ─────────────────────────────────────────

async function customizeAdvancedPrefs(
  ctx: ExtensionCommandContext,
  prefs: ProjectPreferences,
): Promise<void> {
  // Token profile
  const profileChoice = await showNextAction(ctx, {
    title: "Token usage profile",
    summary: [
      "Controls how much context GSD uses per task.",
      "Budget: cheaper, faster. Quality: thorough, more expensive.",
    ],
    actions: [
      { id: "balanced", label: "Balanced", description: "Good trade-off (default)", recommended: true },
      { id: "budget", label: "Budget", description: "Minimize token usage" },
      { id: "quality", label: "Quality", description: "Maximize thoroughness" },
    ],
  });
  if (profileChoice !== "not_yet") {
    prefs.tokenProfile = profileChoice as "budget" | "balanced" | "quality";
  }

  // Skip research
  const researchChoice = await showNextAction(ctx, {
    title: "Research phase",
    summary: [
      "GSD can research the codebase before planning each milestone.",
      "Small projects may not need this step.",
    ],
    actions: [
      { id: "keep", label: "Keep research", description: "Explore codebase before planning", recommended: true },
      { id: "skip", label: "Skip research", description: "Go straight to planning" },
    ],
  });
  prefs.skipResearch = researchChoice === "skip";

  // Auto-push
  const pushChoice = await showNextAction(ctx, {
    title: "Auto-push after merge",
    summary: [
      "After merging a milestone branch, auto-push to remote?",
      prefs.mode === "team"
        ? "Team mode: usually disabled so changes go through PR review."
        : "Solo mode: usually enabled for convenience.",
    ],
    actions: [
      { id: "yes", label: "Yes", description: "Push automatically", recommended: prefs.mode === "solo" },
      { id: "no", label: "No", description: "Manual push only", recommended: prefs.mode === "team" },
    ],
  });
  prefs.autoPush = pushChoice !== "no";
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────────

function bootstrapGsdDirectory(
  basePath: string,
  prefs: ProjectPreferences,
  signals: ProjectSignals,
): void {
  // Final safety check before writing any files
  assertSafeDirectory(basePath);

  const gsd = gsdRoot(basePath);
  mkdirSync(join(gsd, "milestones"), { recursive: true });

  // Write preferences.md from wizard answers
  const preferencesContent = buildPreferencesFile(prefs);
  writeFileSync(join(gsd, "preferences.md"), preferencesContent, "utf-8");

  // Seed CONTEXT.md with detected project signals
  const contextContent = buildContextSeed(signals);
  if (contextContent) {
    writeFileSync(join(gsd, "CONTEXT.md"), contextContent, "utf-8");
  }
}

function buildPreferencesFile(prefs: ProjectPreferences): string {
  const lines: string[] = ["---"];
  lines.push("version: 1");
  lines.push(`mode: ${prefs.mode}`);

  // Git preferences
  lines.push("git:");
  lines.push(`  isolation: ${prefs.gitIsolation}`);
  lines.push(`  main_branch: ${prefs.mainBranch}`);
  lines.push(`  auto_push: ${prefs.autoPush}`);

  // Verification commands
  if (prefs.verificationCommands.length > 0) {
    lines.push("verification_commands:");
    for (const cmd of prefs.verificationCommands) {
      lines.push(`  - "${cmd}"`);
    }
  }

  // Custom instructions
  if (prefs.customInstructions.length > 0) {
    lines.push("custom_instructions:");
    for (const inst of prefs.customInstructions) {
      lines.push(`  - "${inst.replace(/"/g, '\\"')}"`);
    }
  }

  // Token profile (only if non-default)
  if (prefs.tokenProfile !== "balanced") {
    lines.push(`token_profile: ${prefs.tokenProfile}`);
  }

  // Phase skips
  if (prefs.skipResearch) {
    lines.push("phases:");
    lines.push("  skip_research: true");
  }

  // Defaults for wizard-generated files
  lines.push("always_use_skills: []");
  lines.push("prefer_skills: []");
  lines.push("avoid_skills: []");
  lines.push("skill_rules: []");

  lines.push("---");
  lines.push("");
  lines.push("# GSD Project Preferences");
  lines.push("");
  lines.push("Generated by `/gsd init`. Edit directly or use `/gsd prefs project` to modify.");
  lines.push("");
  lines.push("See `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation.");
  lines.push("");

  return lines.join("\n");
}

function buildContextSeed(signals: ProjectSignals): string | null {
  const lines: string[] = [];

  if (signals.detectedFiles.length === 0 && !signals.isGitRepo) {
    return null; // Empty folder, no context to seed
  }

  lines.push("# Project Context");
  lines.push("");
  lines.push("Auto-detected by GSD init wizard. Edit or expand as needed.");
  lines.push("");

  if (signals.primaryLanguage) {
    lines.push(`## Language / Stack`);
    lines.push("");
    lines.push(`Primary: ${signals.primaryLanguage}`);
    if (signals.isMonorepo) {
      lines.push("Structure: monorepo");
    }
    lines.push("");
  }

  if (signals.detectedFiles.length > 0) {
    lines.push("## Project Files");
    lines.push("");
    for (const f of signals.detectedFiles) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  if (signals.hasCI) {
    lines.push("## CI/CD");
    lines.push("");
    lines.push("CI configuration detected.");
    lines.push("");
  }

  if (signals.hasTests) {
    lines.push("## Testing");
    lines.push("");
    lines.push("Test infrastructure detected.");
    if (signals.verificationCommands.length > 0) {
      lines.push("");
      lines.push("Verification commands:");
      for (const cmd of signals.verificationCommands) {
        lines.push(`- \`${cmd}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function buildDetectionSummary(signals: ProjectSignals): string[] {
  const lines: string[] = [];

  if (signals.primaryLanguage) {
    const typeStr = signals.isMonorepo ? "monorepo" : "project";
    lines.push(`  ${signals.primaryLanguage} ${typeStr}`);
  }

  if (signals.detectedFiles.length > 0) {
    lines.push(`  Project files: ${signals.detectedFiles.join(", ")}`);
  }

  if (signals.packageManager) {
    lines.push(`  Package manager: ${signals.packageManager}`);
  }

  if (signals.hasCI) lines.push("  CI/CD: detected");
  if (signals.hasTests) lines.push("  Tests: detected");

  if (signals.verificationCommands.length > 0) {
    lines.push(`  Verification: ${signals.verificationCommands.join(", ")}`);
  }

  return lines;
}

function detectMainBranch(basePath: string): string | null {
  try {
    // Check HEAD reference for common branch names
    const headPath = join(basePath, ".git", "HEAD");
    if (existsSync(headPath)) {
      const head = readFileSync(headPath, "utf-8").trim();
      const match = head.match(/^ref: refs\/heads\/(.+)$/);
      if (match) return match[1];
    }

    // Check for common remote branches
    const refsPath = join(basePath, ".git", "refs", "remotes", "origin");
    if (existsSync(refsPath)) {
      if (existsSync(join(refsPath, "main"))) return "main";
      if (existsSync(join(refsPath, "master"))) return "master";
    }
  } catch {
    // Fall through to null
  }
  return null;
}
