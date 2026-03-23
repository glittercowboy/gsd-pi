/**
 * GSD Detection — Project state and ecosystem detection.
 *
 * Pure functions, zero UI dependencies, zero side effects.
 * Used by init-wizard.ts and guided-flow.ts to determine what onboarding
 * flow to show when entering a project directory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gsdRoot } from "./paths.js";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ProjectDetection {
  /** What kind of GSD state exists in this directory */
  state: "none" | "v1-planning" | "v2-gsd" | "v2-gsd-empty";

  /** Is this the first time GSD has been used on this machine? */
  isFirstEverLaunch: boolean;

  /** Does ~/.gsd/ exist with preferences? */
  hasGlobalSetup: boolean;

  /** v1 details (only when state === 'v1-planning') */
  v1?: V1Detection;

  /** v2 details (only when state === 'v2-gsd' or 'v2-gsd-empty') */
  v2?: V2Detection;

  /** Detected project ecosystem signals */
  projectSignals: ProjectSignals;
}

export interface V1Detection {
  path: string;
  hasPhasesDir: boolean;
  hasRoadmap: boolean;
  phaseCount: number;
}

export interface V2Detection {
  milestoneCount: number;
  hasPreferences: boolean;
  hasContext: boolean;
}

export interface ProjectSignals {
  /** Detected project/package files */
  detectedFiles: string[];
  /** Is this already a git repo? */
  isGitRepo: boolean;
  /** Is this a monorepo? */
  isMonorepo: boolean;
  /** Primary language hint */
  primaryLanguage?: string;
  /** Has existing CI configuration? */
  hasCI: boolean;
  /** Has existing test setup? */
  hasTests: boolean;
  /** Detected package manager */
  packageManager?: string;
  /** Auto-detected verification commands */
  verificationCommands: string[];
}

// ─── Project File Markers ───────────────────────────────────────────────────────

export const PROJECT_FILES = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "Makefile",
  "composer.json",
  "pubspec.yaml",
  "Package.swift",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
  // .NET
  ".sln",
  ".csproj",
  "Directory.Build.props",
  // Git submodules
  ".gitmodules",
  // Xcode
  "project.yml",
  ".xcodeproj",
  ".xcworkspace",
  // Docker
  "Dockerfile",
] as const;

const LANGUAGE_MAP: Record<string, string> = {
  "package.json": "javascript/typescript",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pyproject.toml": "python",
  "setup.py": "python",
  "Gemfile": "ruby",
  "pom.xml": "java",
  "build.gradle": "java/kotlin",
  "build.gradle.kts": "kotlin",
  "CMakeLists.txt": "c/c++",
  "composer.json": "php",
  "pubspec.yaml": "dart/flutter",
  "Package.swift": "swift",
  "mix.exs": "elixir",
  "deno.json": "typescript/deno",
  "deno.jsonc": "typescript/deno",
  ".sln": "dotnet",
  ".csproj": "dotnet",
  "Directory.Build.props": "dotnet",
  "project.yml": "swift/xcode",
  ".xcodeproj": "swift/xcode",
  ".xcworkspace": "swift/xcode",
  "Dockerfile": "docker",
};

const MONOREPO_MARKERS = [
  "lerna.json",
  "nx.json",
  "turbo.json",
  "pnpm-workspace.yaml",
] as const;

const CI_MARKERS = [
  ".github/workflows",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  ".circleci",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
] as const;

const TEST_MARKERS = [
  "__tests__",
  "tests",
  "test",
  "spec",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  ".mocharc.yml",
  "pytest.ini",
  "conftest.py",
  "phpunit.xml",
] as const;

// ─── Core Detection ─────────────────────────────────────────────────────────────

/**
 * Detect the full project state for a given directory.
 * This is the main entry point — calls all sub-detectors.
 */
export function detectProjectState(basePath: string): ProjectDetection {
  const v1 = detectV1Planning(basePath);
  const v2 = detectV2Gsd(basePath);
  const projectSignals = detectProjectSignals(basePath);
  const globalSetup = hasGlobalSetup();
  const firstEver = isFirstEverLaunch();

  let state: ProjectDetection["state"];
  if (v2 && v2.milestoneCount > 0) {
    state = "v2-gsd";
  } else if (v2 && v2.milestoneCount === 0) {
    state = "v2-gsd-empty";
  } else if (v1) {
    state = "v1-planning";
  } else {
    state = "none";
  }

  return {
    state,
    isFirstEverLaunch: firstEver,
    hasGlobalSetup: globalSetup,
    v1: v1 ?? undefined,
    v2: v2 ?? undefined,
    projectSignals,
  };
}

// ─── V1 Planning Detection ──────────────────────────────────────────────────────

/**
 * Detect a v1 .planning/ directory with GSD v1 markers.
 * Returns null if no .planning/ directory found.
 */
export function detectV1Planning(basePath: string): V1Detection | null {
  const planningPath = join(basePath, ".planning");

  if (!existsSync(planningPath)) return null;

  try {
    const stat = statSync(planningPath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const hasRoadmap = existsSync(join(planningPath, "ROADMAP.md"));
  const phasesPath = join(planningPath, "phases");
  const hasPhasesDir = existsSync(phasesPath);

  let phaseCount = 0;
  if (hasPhasesDir) {
    try {
      const entries = readdirSync(phasesPath, { withFileTypes: true });
      phaseCount = entries.filter(e => e.isDirectory()).length;
    } catch {
      // unreadable — report 0
    }
  }

  return {
    path: planningPath,
    hasPhasesDir,
    hasRoadmap,
    phaseCount,
  };
}

// ─── V2 GSD Detection ──────────────────────────────────────────────────────────

function detectV2Gsd(basePath: string): V2Detection | null {
  const gsdPath = gsdRoot(basePath);

  if (!existsSync(gsdPath)) return null;

  const hasPreferences =
    existsSync(join(gsdPath, "preferences.md")) ||
    existsSync(join(gsdPath, "PREFERENCES.md"));

  const hasContext = existsSync(join(gsdPath, "CONTEXT.md"));

  let milestoneCount = 0;
  const milestonesPath = join(gsdPath, "milestones");
  if (existsSync(milestonesPath)) {
    try {
      const entries = readdirSync(milestonesPath, { withFileTypes: true });
      milestoneCount = entries.filter(e => e.isDirectory()).length;
    } catch {
      // unreadable — report 0
    }
  }

  return { milestoneCount, hasPreferences, hasContext };
}

// ─── Project Signals Detection ──────────────────────────────────────────────────

/**
 * Quick filesystem scan for project ecosystem markers.
 * Reads only file existence + minimal content (package.json for monorepo/scripts).
 */
export function detectProjectSignals(basePath: string): ProjectSignals {
  const detectedFiles: string[] = [];
  let primaryLanguage: string | undefined;

  // Detect project files
  for (const file of PROJECT_FILES) {
    if (existsSync(join(basePath, file))) {
      detectedFiles.push(file);
      if (!primaryLanguage) {
        primaryLanguage = LANGUAGE_MAP[file];
      }
    }
  }

  // Git repo detection
  const isGitRepo = existsSync(join(basePath, ".git"));

  // Monorepo detection
  let isMonorepo = false;
  for (const marker of MONOREPO_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      isMonorepo = true;
      break;
    }
  }
  // Also check package.json workspaces
  if (!isMonorepo && detectedFiles.includes("package.json")) {
    isMonorepo = packageJsonHasWorkspaces(basePath);
  }

  // CI detection
  let hasCI = false;
  for (const marker of CI_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      hasCI = true;
      break;
    }
  }

  // Test detection
  let hasTests = false;
  for (const marker of TEST_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      hasTests = true;
      break;
    }
  }

  // Package manager detection
  const packageManager = detectPackageManager(basePath);

  // Verification commands
  const verificationCommands = detectVerificationCommands(basePath, detectedFiles, packageManager);

  return {
    detectedFiles,
    isGitRepo,
    isMonorepo,
    primaryLanguage,
    hasCI,
    hasTests,
    packageManager,
    verificationCommands,
  };
}

// ─── Package Manager Detection ──────────────────────────────────────────────────

function detectPackageManager(basePath: string): string | undefined {
  if (existsSync(join(basePath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(basePath, "yarn.lock"))) return "yarn";
  if (existsSync(join(basePath, "bun.lockb")) || existsSync(join(basePath, "bun.lock"))) return "bun";
  if (existsSync(join(basePath, "package-lock.json"))) return "npm";
  if (existsSync(join(basePath, "package.json"))) return "npm";
  return undefined;
}

// ─── Verification Command Detection ─────────────────────────────────────────────

/**
 * Auto-detect verification commands from project files.
 * Returns commands in priority order (test first, then build, then lint).
 */
function detectVerificationCommands(
  basePath: string,
  detectedFiles: string[],
  packageManager?: string,
): string[] {
  const commands: string[] = [];
  const pm = packageManager ?? "npm";
  const run = pm === "npm" ? "npm run" : pm === "yarn" ? "yarn" : pm === "bun" ? "bun run" : `${pm} run`;

  if (detectedFiles.includes("package.json")) {
    const scripts = readPackageJsonScripts(basePath);
    if (scripts) {
      // Test commands (highest priority)
      if (scripts.test && scripts.test !== "echo \"Error: no test specified\" && exit 1") {
        commands.push(pm === "npm" ? "npm test" : `${pm} test`);
      }
      // Build commands
      if (scripts.build) {
        commands.push(`${run} build`);
      }
      // Lint commands
      if (scripts.lint) {
        commands.push(`${run} lint`);
      }
      // Typecheck commands
      if (scripts.typecheck) {
        commands.push(`${run} typecheck`);
      } else if (scripts.tsc) {
        commands.push(`${run} tsc`);
      }
    }
  }

  if (detectedFiles.includes("Cargo.toml")) {
    commands.push("cargo test");
    commands.push("cargo clippy");
  }

  if (detectedFiles.includes("go.mod")) {
    commands.push("go test ./...");
    commands.push("go vet ./...");
  }

  if (detectedFiles.includes("pyproject.toml") || detectedFiles.includes("setup.py")) {
    commands.push("pytest");
  }

  if (detectedFiles.includes("Gemfile")) {
    // Check for rspec vs minitest
    if (existsSync(join(basePath, "spec"))) {
      commands.push("bundle exec rspec");
    } else {
      commands.push("bundle exec rake test");
    }
  }

  if (detectedFiles.includes("Makefile")) {
    const makeTargets = readMakefileTargets(basePath);
    if (makeTargets.includes("test")) {
      commands.push("make test");
    }
  }

  return commands;
}

// ─── Global Setup Detection ─────────────────────────────────────────────────────

/**
 * Check if global GSD setup exists (has ~/.gsd/ with preferences).
 */
export function hasGlobalSetup(): boolean {
  return (
    existsSync(join(gsdHome, "preferences.md")) ||
    existsSync(join(gsdHome, "PREFERENCES.md"))
  );
}

/**
 * Check if this is the very first time GSD has been used on this machine.
 * Returns true if ~/.gsd/ doesn't exist or has no preferences or auth.
 */
export function isFirstEverLaunch(): boolean {
  if (!existsSync(gsdHome)) return true;

  // If we have preferences, not first launch
  if (
    existsSync(join(gsdHome, "preferences.md")) ||
    existsSync(join(gsdHome, "PREFERENCES.md"))
  ) {
    return false;
  }

  // If we have auth.json, not first launch (onboarding.ts already ran)
  if (existsSync(join(gsdHome, "agent", "auth.json"))) return false;

  // Check legacy path too
  const legacyPath = join(homedir(), ".pi", "agent", "gsd-preferences.md");
  if (existsSync(legacyPath)) return false;

  return true;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function packageJsonHasWorkspaces(basePath: string): boolean {
  try {
    const raw = readFileSync(join(basePath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return Array.isArray(pkg.workspaces) || (pkg.workspaces && typeof pkg.workspaces === "object");
  } catch {
    return false;
  }
}

function readPackageJsonScripts(basePath: string): Record<string, string> | null {
  try {
    const raw = readFileSync(join(basePath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : null;
  } catch {
    return null;
  }
}

function readMakefileTargets(basePath: string): string[] {
  try {
    const raw = readFileSync(join(basePath, "Makefile"), "utf-8");
    const targets: string[] = [];
    for (const line of raw.split("\n")) {
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/);
      if (match) targets.push(match[1]);
    }
    return targets;
  } catch {
    return [];
  }
}
