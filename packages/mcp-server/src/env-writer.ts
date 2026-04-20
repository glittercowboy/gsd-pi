// @gsd-build/mcp-server — Environment variable write utilities
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// Shared helpers for writing env vars to .env files, detecting project
// destinations, and checking existing keys. Used by secure_env_collect
// MCP tool. No TUI dependencies — pure filesystem + process.env operations.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// checkExistingEnvKeys
// ---------------------------------------------------------------------------

/**
 * Check which keys already exist in a .env file or process.env.
 * Returns the subset of `keys` that are already set.
 */
export async function checkExistingEnvKeys(keys: string[], envFilePath: string): Promise<string[]> {
  let fileContent = "";
  try {
    fileContent = await readFile(envFilePath, "utf8");
  } catch {
    // ENOENT or other read error — proceed with empty content
  }

  const existing: string[] = [];
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped}\\s*=`, "m");
    if (regex.test(fileContent) || key in process.env) {
      existing.push(key);
    }
  }
  return existing;
}

// ---------------------------------------------------------------------------
// detectDestination
// ---------------------------------------------------------------------------

/**
 * Detect the write destination based on project files in basePath.
 * Priority: vercel.json → convex/ dir → fallback "dotenv".
 */
export function detectDestination(basePath: string): "dotenv" | "vercel" | "convex" {
  if (existsSync(resolve(basePath, "vercel.json"))) {
    return "vercel";
  }
  const convexPath = resolve(basePath, "convex");
  try {
    if (existsSync(convexPath) && statSync(convexPath).isDirectory()) {
      return "convex";
    }
  } catch {
    // stat error — treat as not found
  }
  return "dotenv";
}

// ---------------------------------------------------------------------------
// writeEnvKey
// ---------------------------------------------------------------------------

/**
 * Write a single key=value pair to a .env file.
 * Updates existing keys in-place, appends new ones at the end.
 */
export async function writeEnvKey(filePath: string, key: string, value: string): Promise<void> {
  if (typeof value !== "string") {
    throw new TypeError(`writeEnvKey expects a string value for key "${key}", got ${typeof value}`);
  }
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    content = "";
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");
  const line = `${key}=${escaped}`;
  const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    content += `${line}\n`;
  }
  await writeFile(filePath, content, "utf8");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function isSafeEnvVarKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function isSupportedDeploymentEnvironment(env: string): boolean {
  return env === "development" || env === "preview" || env === "production";
}

// ---------------------------------------------------------------------------
// Shell helpers (for vercel/convex CLI)
// ---------------------------------------------------------------------------

export function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// applySecrets
// ---------------------------------------------------------------------------

interface ApplyResult {
  applied: string[];
  errors: string[];
}

/**
 * Apply collected secrets to the target destination.
 * Dotenv writes are handled directly; vercel/convex shell out via execFn.
 */
export async function applySecrets(
  provided: Array<{ key: string; value: string }>,
  destination: "dotenv" | "vercel" | "convex",
  opts: {
    envFilePath: string;
    environment?: string;
    execFn?: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
  },
): Promise<ApplyResult> {
  const applied: string[] = [];
  const errors: string[] = [];

  if (destination === "dotenv") {
    for (const { key, value } of provided) {
      try {
        await writeEnvKey(opts.envFilePath, key, value);
        applied.push(key);
        // Hydrate process.env so the current session sees the new value
        process.env[key] = value;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${key}: ${msg}`);
      }
    }
  }

  if ((destination === "vercel" || destination === "convex") && opts.execFn) {
    const env = opts.environment ?? "development";
    if (!isSupportedDeploymentEnvironment(env)) {
      errors.push(`environment: unsupported target environment "${env}"`);
      return { applied, errors };
    }
    for (const { key, value } of provided) {
      if (!isSafeEnvVarKey(key)) {
        errors.push(`${key}: invalid environment variable name`);
        continue;
      }
      const cmd = destination === "vercel"
        ? `printf %s ${shellEscapeSingle(value)} | vercel env add ${key} ${env}`
        : "";
      try {
        const result = destination === "vercel"
          ? await opts.execFn("sh", ["-c", cmd])
          : await opts.execFn("npx", ["convex", "env", "set", key, value]);
        if (result.code !== 0) {
          errors.push(`${key}: ${result.stderr.slice(0, 200)}`);
        } else {
          applied.push(key);
          process.env[key] = value;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${key}: ${msg}`);
      }
    }
  }

  return { applied, errors };
}
