/**
 * GSD Doctor — Environment Health Checks (#1221)
 *
 * Deterministic checks for environment readiness that prevent the model
 * from spinning its wheels on missing tools, port conflicts, stale
 * dependencies, and other infrastructure issues.
 *
 * These checks complement the existing git/runtime health checks and
 * integrate into the doctor pipeline via checkEnvironmentHealth().
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import type { DoctorIssue, DoctorIssueCode } from "./doctor-types.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface EnvironmentCheckResult {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Default dev server ports to scan for conflicts. */
const DEFAULT_DEV_PORTS = [3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888];

/** Minimum free disk space in bytes (500MB). */
const MIN_DISK_BYTES = 500 * 1024 * 1024;

/** Timeout for external commands (ms). */
const CMD_TIMEOUT = 5_000;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Worktree sentinel — path segment that marks an auto-worktree directory. */
const WORKTREE_PATH_SEGMENT = `${join(".gsd", "worktrees")}/`;

/**
 * Resolve the project root when running inside a `.gsd/worktrees/<name>/`
 * auto-worktree. Returns `null` if not in a worktree.
 *
 * Detection order:
 *   1. `GSD_WORKTREE` env var (set by the worktree launcher)
 *   2. `.gsd/worktrees/` segment in basePath
 */
function resolveWorktreeProjectRoot(basePath: string): string | null {
  const envRoot = process.env.GSD_WORKTREE;
  if (envRoot) return envRoot;

  const normalised = basePath.replace(/\\/g, "/");
  const idx = normalised.indexOf(WORKTREE_PATH_SEGMENT.replace(/\\/g, "/"));
  if (idx === -1) return null;

  // Everything before `.gsd/worktrees/` is the project root
  return basePath.slice(0, idx);
}

function tryExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, {
      cwd,
      timeout: CMD_TIMEOUT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function commandExists(name: string, cwd: string): boolean {
  const whichCmd = process.platform === "win32" ? `where ${name}` : `command -v ${name}`;
  return tryExec(whichCmd, cwd) !== null;
}

// ── Individual Checks ──────────────────────────────────────────────────────

/**
 * Check that Node.js version meets the project's engines requirement.
 */
function checkNodeVersion(basePath: string): EnvironmentCheckResult | null {
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const required = pkg.engines?.node;
    if (!required) return null;

    const currentVersion = tryExec("node --version", basePath);
    if (!currentVersion) {
      return { name: "node_version", status: "error", message: "Node.js not found in PATH" };
    }

    // Parse semver requirement (handles >=X.Y.Z format)
    const reqMatch = required.match(/>=?\s*(\d+)(?:\.(\d+))?/);
    if (!reqMatch) return null;

    const reqMajor = parseInt(reqMatch[1], 10);
    const reqMinor = parseInt(reqMatch[2] ?? "0", 10);

    const curMatch = currentVersion.match(/v?(\d+)\.(\d+)/);
    if (!curMatch) return null;

    const curMajor = parseInt(curMatch[1], 10);
    const curMinor = parseInt(curMatch[2], 10);

    if (curMajor < reqMajor || (curMajor === reqMajor && curMinor < reqMinor)) {
      return {
        name: "node_version",
        status: "warning",
        message: `Node.js ${currentVersion} does not meet requirement "${required}"`,
        detail: `Current: ${currentVersion}, Required: ${required}`,
      };
    }

    return { name: "node_version", status: "ok", message: `Node.js ${currentVersion}` };
  } catch {
    return null;
  }
}

/**
 * Check if node_modules exists and is not stale vs the lockfile.
 */
function checkDependenciesInstalled(basePath: string): EnvironmentCheckResult | null {
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;

  const nodeModules = join(basePath, "node_modules");
  if (!existsSync(nodeModules)) {
    // In auto-worktrees node_modules is absent by design — the worktree
    // symlinks to (or expects) the project root's copy.  Fall back to
    // checking the project root before reporting an error (#2303).
    const projectRoot = resolveWorktreeProjectRoot(basePath);
    if (projectRoot && existsSync(join(projectRoot, "node_modules"))) {
      return { name: "dependencies", status: "ok", message: "Dependencies installed (project root)" };
    }

    return {
      name: "dependencies",
      status: "error",
      message: "node_modules missing — run npm install",
    };
  }

  // Check if lockfile is newer than the last install.
  //
  // Each package manager writes a metadata marker inside node_modules on
  // every install. Comparing the lockfile mtime against the marker is
  // reliable; comparing against the node_modules *directory* mtime is not,
  // because directory mtime only changes when entries are added or removed
  // — not when files inside it are updated. (#1974)
  const lockfiles: Array<{ lock: string; markers: string[] }> = [
    { lock: "package-lock.json", markers: ["node_modules/.package-lock.json"] },
    { lock: "yarn.lock",         markers: ["node_modules/.yarn-integrity"] },
    { lock: "pnpm-lock.yaml",    markers: ["node_modules/.modules.yaml"] },
  ];

  for (const { lock, markers } of lockfiles) {
    const lockPath = join(basePath, lock);
    if (!existsSync(lockPath)) continue;

    try {
      const lockMtime = statSync(lockPath).mtimeMs;

      // Prefer the package manager's marker file; fall back to directory mtime
      // only when no marker exists (e.g., manually created node_modules).
      let installMtime = 0;
      for (const marker of markers) {
        const markerPath = join(basePath, marker);
        if (existsSync(markerPath)) {
          installMtime = Math.max(installMtime, statSync(markerPath).mtimeMs);
        }
      }
      if (installMtime === 0) {
        installMtime = statSync(nodeModules).mtimeMs;
      }

      if (lockMtime > installMtime) {
        return {
          name: "dependencies",
          status: "warning",
          message: `${lock} is newer than node_modules — dependencies may be stale`,
          detail: `Run npm install / yarn / pnpm install to update`,
        };
      }
    } catch {
      // stat failed — skip
    }
  }

  return { name: "dependencies", status: "ok", message: "Dependencies installed" };
}

/**
 * Check for .env.example files without corresponding .env files.
 */
function checkEnvFiles(basePath: string): EnvironmentCheckResult | null {
  const examplePath = join(basePath, ".env.example");
  if (!existsSync(examplePath)) return null;

  const envPath = join(basePath, ".env");
  const envLocalPath = join(basePath, ".env.local");

  if (!existsSync(envPath) && !existsSync(envLocalPath)) {
    return {
      name: "env_file",
      status: "warning",
      message: ".env.example exists but no .env or .env.local found",
      detail: "Copy .env.example to .env and fill in values",
    };
  }

  return { name: "env_file", status: "ok", message: "Environment file present" };
}

/**
 * Check for port conflicts on common dev server ports.
 * Only checks ports that appear in package.json scripts.
 */
function checkPortConflicts(basePath: string): EnvironmentCheckResult[] {
  // Only run on macOS/Linux — lsof is not available on Windows
  if (process.platform === "win32") return [];

  const results: EnvironmentCheckResult[] = [];

  // Try to detect ports from package.json scripts
  const portsToCheck = new Set<number>();
  const pkgPath = join(basePath, "package.json");

  if (!existsSync(pkgPath)) {
    // No package.json — this isn't a Node.js project. Skip port checks
    // entirely to avoid false positives from system services (e.g., macOS
    // AirPlay Receiver on port 5000). (#1381)
    return [];
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const scripts = pkg.scripts ?? {};
    const scriptText = Object.values(scripts).join(" ");

    // Look for --port NNNN, -p NNNN, PORT=NNNN, :NNNN patterns
    const portMatches = scriptText.matchAll(/(?:--port\s+|(?:^|[^a-z])PORT[=:]\s*|-p\s+|:)(\d{4,5})\b/gi);
    for (const m of portMatches) {
      const port = parseInt(m[1], 10);
      if (port >= 1024 && port <= 65535) portsToCheck.add(port);
    }
  } catch {
    // parse failed — skip port checks rather than using defaults
    return [];
  }

  // If no ports found in scripts, check common defaults.
  // Filter out port 5000 on macOS — AirPlay Receiver uses it by default (#1381).
  if (portsToCheck.size === 0) {
    for (const p of DEFAULT_DEV_PORTS) {
      if (p === 5000 && process.platform === "darwin") continue;
      portsToCheck.add(p);
    }
  }

  for (const port of portsToCheck) {
    const result = tryExec(`lsof -i :${port} -sTCP:LISTEN -t`, basePath);
    if (result && result.length > 0) {
      // Get process name
      const nameResult = tryExec(`lsof -i :${port} -sTCP:LISTEN -Fp | head -2`, basePath);
      const processName = nameResult?.match(/p(\d+)\n?c?(.+)?/)?.[2] ?? "unknown";

      results.push({
        name: "port_conflict",
        status: "warning",
        message: `Port ${port} is already in use by ${processName} (PID ${result.split("\n")[0]})`,
        detail: `Kill the process or use a different port`,
      });
    }
  }

  return results;
}

/**
 * Check available disk space on the working directory partition.
 */
function checkDiskSpace(basePath: string): EnvironmentCheckResult | null {
  // Only run on macOS/Linux
  if (process.platform === "win32") return null;

  const dfOutput = tryExec(`df -k "${basePath}" | tail -1`, basePath);
  if (!dfOutput) return null;

  try {
    // df output: filesystem blocks used avail capacity mount
    const parts = dfOutput.split(/\s+/);
    const availKB = parseInt(parts[3], 10);
    if (isNaN(availKB)) return null;

    const availBytes = availKB * 1024;
    const availMB = Math.round(availBytes / (1024 * 1024));
    const availGB = (availBytes / (1024 * 1024 * 1024)).toFixed(1);

    if (availBytes < MIN_DISK_BYTES) {
      return {
        name: "disk_space",
        status: "error",
        message: `Low disk space: ${availMB}MB free`,
        detail: `Free up space — builds and git operations may fail`,
      };
    }

    if (availBytes < MIN_DISK_BYTES * 4) {
      return {
        name: "disk_space",
        status: "warning",
        message: `Disk space getting low: ${availGB}GB free`,
      };
    }

    return { name: "disk_space", status: "ok", message: `${availGB}GB free` };
  } catch {
    return null;
  }
}

/**
 * Check if Docker is available when project has a Dockerfile.
 */
function checkDocker(basePath: string): EnvironmentCheckResult | null {
  const hasDockerfile = existsSync(join(basePath, "Dockerfile")) ||
    existsSync(join(basePath, "docker-compose.yml")) ||
    existsSync(join(basePath, "docker-compose.yaml")) ||
    existsSync(join(basePath, "compose.yml")) ||
    existsSync(join(basePath, "compose.yaml"));

  if (!hasDockerfile) return null;

  if (!commandExists("docker", basePath)) {
    return {
      name: "docker",
      status: "warning",
      message: "Project has Docker files but docker is not installed",
    };
  }

  const info = tryExec("docker info --format '{{.ServerVersion}}'", basePath);
  if (!info) {
    return {
      name: "docker",
      status: "warning",
      message: "Docker is installed but daemon is not running",
      detail: "Start Docker Desktop or the docker daemon",
    };
  }

  return { name: "docker", status: "ok", message: `Docker ${info}` };
}

/**
 * Check for common project tools that should be available.
 */
function checkProjectTools(basePath: string): EnvironmentCheckResult[] {
  const results: EnvironmentCheckResult[] = [];
  const pkgPath = join(basePath, "package.json");

  if (!existsSync(pkgPath)) return results;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };

    // Check for package manager
    const packageManager = pkg.packageManager;
    if (packageManager) {
      const managerName = packageManager.split("@")[0];
      if (managerName && managerName !== "npm" && !commandExists(managerName, basePath)) {
        results.push({
          name: "package_manager",
          status: "warning",
          message: `Project requires ${managerName} but it's not installed`,
          detail: `Install with: npm install -g ${managerName}`,
        });
      }
    }

    // Check for TypeScript if it's a dependency
    if (allDeps["typescript"] && !existsSync(join(basePath, "node_modules", ".bin", "tsc"))) {
      results.push({
        name: "typescript",
        status: "warning",
        message: "TypeScript is a dependency but tsc is not available (run npm install)",
      });
    }

    // Check for Python if pyproject.toml or requirements.txt exists
    if (existsSync(join(basePath, "pyproject.toml")) || existsSync(join(basePath, "requirements.txt"))) {
      if (!commandExists("python3", basePath) && !commandExists("python", basePath)) {
        results.push({
          name: "python",
          status: "warning",
          message: "Project has Python config but python is not installed",
        });
      }
    }

    // Check for Rust if Cargo.toml exists
    if (existsSync(join(basePath, "Cargo.toml"))) {
      if (!commandExists("cargo", basePath)) {
        results.push({
          name: "cargo",
          status: "warning",
          message: "Project has Cargo.toml but cargo is not installed",
        });
      }
    }

    // Check for Go if go.mod exists
    if (existsSync(join(basePath, "go.mod"))) {
      if (!commandExists("go", basePath)) {
        results.push({
          name: "go",
          status: "warning",
          message: "Project has go.mod but go is not installed",
        });
      }
    }
  } catch {
    // parse failed — skip
  }

  return results;
}

/**
 * Check git remote reachability.
 */
function checkGitRemote(basePath: string): EnvironmentCheckResult | null {
  // Only check if it's a git repo with a remote
  const remote = tryExec("git remote get-url origin", basePath);
  if (!remote) return null;

  // Quick connectivity check with short timeout
  const result = tryExec("git ls-remote --exit-code -h origin HEAD", basePath);
  if (result === null) {
    return {
      name: "git_remote",
      status: "warning",
      message: "Git remote 'origin' is unreachable",
      detail: `Remote: ${remote}`,
    };
  }

  return { name: "git_remote", status: "ok", message: "Git remote reachable" };
}

/**
 * Check if the project build passes (opt-in slow check, use --build flag).
 * Runs npm run build and reports failure as env_build.
 */
function checkBuildHealth(basePath: string): EnvironmentCheckResult | null {
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const buildScript = pkg.scripts?.build;
    if (!buildScript) return null;

    const result = tryExec("npm run build 2>&1", basePath);
    if (result === null) {
      return {
        name: "build",
        status: "error",
        message: "Build failed — npm run build exited non-zero",
        detail: "Fix build errors before dispatching work",
      };
    }
    return { name: "build", status: "ok", message: "Build passes" };
  } catch {
    return null;
  }
}

/**
 * Check if tests pass (opt-in slow check, use --test flag).
 * Runs npm test and reports failures as env_test.
 */
function checkTestHealth(basePath: string): EnvironmentCheckResult | null {
  const pkgPath = join(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const testScript = pkg.scripts?.test;
    // Skip if no test script or the default placeholder
    if (!testScript || testScript.includes("no test specified")) return null;

    const result = tryExec("npm test 2>&1", basePath);
    if (result === null) {
      return {
        name: "test",
        status: "warning",
        message: "Tests failing — npm test exited non-zero",
        detail: "Fix failing tests before shipping",
      };
    }
    return { name: "test", status: "ok", message: "Tests pass" };
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run all environment health checks. Returns structured results for
 * integration with the doctor pipeline.
 */
export function runEnvironmentChecks(basePath: string): EnvironmentCheckResult[] {
  const results: EnvironmentCheckResult[] = [];

  const nodeCheck = checkNodeVersion(basePath);
  if (nodeCheck) results.push(nodeCheck);

  const depsCheck = checkDependenciesInstalled(basePath);
  if (depsCheck) results.push(depsCheck);

  const envCheck = checkEnvFiles(basePath);
  if (envCheck) results.push(envCheck);

  results.push(...checkPortConflicts(basePath));

  const diskCheck = checkDiskSpace(basePath);
  if (diskCheck) results.push(diskCheck);

  const dockerCheck = checkDocker(basePath);
  if (dockerCheck) results.push(dockerCheck);

  results.push(...checkProjectTools(basePath));

  // Git remote check can be slow — only run on explicit doctor invocation
  // (not on pre-dispatch gate)

  return results;
}

/**
 * Run environment checks with git remote check included.
 * Use this for explicit /gsd doctor invocations, not pre-dispatch gates.
 */
export function runFullEnvironmentChecks(basePath: string): EnvironmentCheckResult[] {
  const results = runEnvironmentChecks(basePath);

  const remoteCheck = checkGitRemote(basePath);
  if (remoteCheck) results.push(remoteCheck);

  return results;
}

/**
 * Run slow opt-in checks (build and/or test).
 * These are never run on the pre-dispatch gate — only on explicit /gsd doctor --build/--test.
 */
export function runSlowEnvironmentChecks(
  basePath: string,
  options?: { includeBuild?: boolean; includeTests?: boolean },
): EnvironmentCheckResult[] {
  const results: EnvironmentCheckResult[] = [];
  if (options?.includeBuild) {
    const buildCheck = checkBuildHealth(basePath);
    if (buildCheck) results.push(buildCheck);
  }
  if (options?.includeTests) {
    const testCheck = checkTestHealth(basePath);
    if (testCheck) results.push(testCheck);
  }
  return results;
}

/**
 * Convert environment check results to DoctorIssue format for the doctor pipeline.
 */
export function environmentResultsToDoctorIssues(results: EnvironmentCheckResult[]): DoctorIssue[] {
  return results
    .filter(r => r.status !== "ok")
    .map(r => ({
      severity: r.status === "error" ? "error" as const : "warning" as const,
      code: `env_${r.name}` as DoctorIssueCode,
      scope: "project" as const,
      unitId: "environment",
      message: r.detail ? `${r.message} — ${r.detail}` : r.message,
      fixable: false,
    }));
}

/**
 * Integration point for the doctor pipeline. Runs environment checks
 * and appends issues to the provided array.
 */
export async function checkEnvironmentHealth(
  basePath: string,
  issues: DoctorIssue[],
  options?: { includeRemote?: boolean; includeBuild?: boolean; includeTests?: boolean },
): Promise<void> {
  const results = options?.includeRemote
    ? runFullEnvironmentChecks(basePath)
    : runEnvironmentChecks(basePath);

  if (options?.includeBuild || options?.includeTests) {
    results.push(...runSlowEnvironmentChecks(basePath, options));
  }

  issues.push(...environmentResultsToDoctorIssues(results));
}

/**
 * Format environment check results for display.
 */
export function formatEnvironmentReport(results: EnvironmentCheckResult[]): string {
  if (results.length === 0) return "No environment checks applicable.";

  const lines: string[] = [];
  lines.push("Environment Health:");

  for (const r of results) {
    const icon = r.status === "ok" ? "\u2705" : r.status === "warning" ? "\u26A0\uFE0F" : "\uD83D\uDED1";
    lines.push(`  ${icon} ${r.message}`);
    if (r.detail && r.status !== "ok") {
      lines.push(`     ${r.detail}`);
    }
  }

  return lines.join("\n");
}
