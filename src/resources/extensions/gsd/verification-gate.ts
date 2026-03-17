// GSD Extension — Verification Gate
// Pure functions for discovering and running verification commands.
// Discovery order (D003): preference → task plan verify → package.json scripts.
// First non-empty source wins.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationCheck, VerificationResult } from "./types.js";

/** Maximum bytes of stdout/stderr to retain per command (10 KB). */
const MAX_OUTPUT_BYTES = 10 * 1024;

/** Truncate a string to maxBytes, appending a marker if truncated. */
function truncate(value: string | null | undefined, maxBytes: number): string {
  if (!value) return "";
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  // Slice conservatively then trim to last full character
  const buf = Buffer.from(value, "utf-8").subarray(0, maxBytes);
  return buf.toString("utf-8") + "\n…[truncated]";
}

// ─── Command Discovery ──────────────────────────────────────────────────────

export interface DiscoverCommandsOptions {
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  cwd: string;
}

export interface DiscoveredCommands {
  commands: string[];
  source: VerificationResult["discoverySource"];
}

/** Package.json script keys to probe, in order. */
const PACKAGE_SCRIPT_KEYS = ["typecheck", "lint", "test"] as const;

/**
 * Discover verification commands using the first-non-empty-wins strategy (D003):
 *   1. Explicit preference commands
 *   2. Task plan verify field (split on &&)
 *   3. package.json scripts (typecheck, lint, test)
 *   4. None found
 */
export function discoverCommands(options: DiscoverCommandsOptions): DiscoveredCommands {
  // 1. Preference commands
  if (options.preferenceCommands && options.preferenceCommands.length > 0) {
    const filtered = options.preferenceCommands
      .map(c => c.trim())
      .filter(Boolean);
    if (filtered.length > 0) {
      return { commands: filtered, source: "preference" };
    }
  }

  // 2. Task plan verify field
  if (options.taskPlanVerify && options.taskPlanVerify.trim()) {
    const commands = options.taskPlanVerify
      .split("&&")
      .map(c => c.trim())
      .filter(Boolean);
    if (commands.length > 0) {
      return { commands, source: "task-plan" };
    }
  }

  // 3. package.json scripts
  const pkgPath = join(options.cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
        const commands: string[] = [];
        for (const key of PACKAGE_SCRIPT_KEYS) {
          if (typeof pkg.scripts[key] === "string") {
            commands.push(`npm run ${key}`);
          }
        }
        if (commands.length > 0) {
          return { commands, source: "package-json" };
        }
      }
    } catch {
      // Malformed package.json — fall through to "none"
    }
  }

  // 4. Nothing found
  return { commands: [], source: "none" };
}

// ─── Gate Execution ─────────────────────────────────────────────────────────

export interface RunVerificationGateOptions {
  basePath: string;
  unitId: string;
  cwd: string;
  preferenceCommands?: string[];
  taskPlanVerify?: string;
}

/**
 * Run the verification gate: discover commands, execute each via spawnSync,
 * and return a structured result.
 *
 * - All commands run sequentially regardless of individual pass/fail.
 * - `passed` is true when every command exits 0 (or no commands are discovered).
 * - stdout/stderr per command are truncated to 10 KB.
 */
export function runVerificationGate(options: RunVerificationGateOptions): VerificationResult {
  const timestamp = Date.now();

  const { commands, source } = discoverCommands({
    preferenceCommands: options.preferenceCommands,
    taskPlanVerify: options.taskPlanVerify,
    cwd: options.cwd,
  });

  if (commands.length === 0) {
    return {
      passed: true,
      checks: [],
      discoverySource: source,
      timestamp,
    };
  }

  const checks: VerificationCheck[] = [];

  for (const command of commands) {
    const start = Date.now();
    const result = spawnSync(command, {
      shell: true,
      cwd: options.cwd,
      stdio: "pipe",
      encoding: "utf-8",
    });
    const durationMs = Date.now() - start;

    let exitCode: number;
    let stderr: string;

    if (result.error) {
      // Command not found or spawn failure
      exitCode = 127;
      stderr = truncate(
        (result.stderr || "") + "\n" + (result.error as Error).message,
        MAX_OUTPUT_BYTES,
      );
    } else {
      // status is null when killed by signal — treat as failure
      exitCode = result.status ?? 1;
      stderr = truncate(result.stderr, MAX_OUTPUT_BYTES);
    }

    checks.push({
      command,
      exitCode,
      stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
      stderr,
      durationMs,
    });
  }

  return {
    passed: checks.every(c => c.exitCode === 0),
    checks,
    discoverySource: source,
    timestamp,
  };
}
