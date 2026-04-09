import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Load a JSON file with validation, returning a default on failure.
 * Handles missing files, corrupt JSON, and schema mismatches uniformly.
 */
export function loadJsonFile<T>(
  filePath: string,
  validate: (data: unknown) => data is T,
  defaultFactory: () => T,
): T {
  try {
    if (!existsSync(filePath)) return defaultFactory();
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return validate(parsed) ? parsed : defaultFactory();
  } catch {
    return defaultFactory();
  }
}

/**
 * Load a JSON file with validation, returning null on failure.
 * For callers that distinguish "no data" from "default data".
 */
export function loadJsonFileOrNull<T>(
  filePath: string,
  validate: (data: unknown) => data is T,
): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Save a JSON file atomically (write to .tmp, then rename).
 * Creates parent directories as needed.
 * Non-fatal — swallows errors to prevent persistence from breaking operations.
 *
 * Uses atomic write-tmp-rename to prevent partial/corrupt files on crash.
 * This is the canonical way to persist JSON state in GSD — all callers
 * (queue-order, metrics, routing-history, reactive-graph) benefit from
 * crash-safety without code changes.
 */
export function saveJsonFile<T>(filePath: string, data: T): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    // Use randomized tmp suffix to prevent concurrent-write data loss
    const tmp = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, filePath);
    // No cleanup needed — renameSync atomically removes tmp on success
  } catch {
    // Non-fatal — don't let persistence failures break operation
  }
}

/**
 * Write a JSON file atomically (write to .tmp, then rename).
 * Creates parent directories as needed. Non-fatal on error.
 */
export function writeJsonFileAtomic<T>(filePath: string, data: T): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch {
    // Non-fatal — don't let persistence failures break operation
  }
}
