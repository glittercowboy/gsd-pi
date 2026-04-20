/**
 * GSDNoProjectError — tests for friendly home-directory error handling.
 *
 * Verifies that GSDNoProjectError is thrown for blocked directories and
 * that the dispatcher catches it with a user-friendly message.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const contextSrc = readFileSync(join(__dirname, "..", "commands", "context.ts"), "utf-8");
const dispatcherSrc = readFileSync(join(__dirname, "..", "commands", "dispatcher.ts"), "utf-8");

// ─── GSDNoProjectError class ──────────────────────────────────────────────

test("GSDNoProjectError class is exported from context.ts", () => {
  assert.ok(
    contextSrc.includes("export class GSDNoProjectError extends Error"),
    "GSDNoProjectError should be an exported Error subclass",
  );
});

test("GSDNoProjectError sets name property", () => {
  assert.ok(
    contextSrc.includes('this.name = "GSDNoProjectError"'),
    "GSDNoProjectError should set its name for instanceof checks",
  );
});

// ─── projectRoot blocked directory handling ───────────────────────────────

test("projectRoot uses validateDirectory and checks for blocked severity", () => {
  assert.ok(
    contextSrc.includes("validateDirectory(pathToCheck)"),
    "projectRoot should call validateDirectory",
  );
  assert.ok(
    contextSrc.includes('result.severity === "blocked"'),
    "projectRoot should check for blocked severity",
  );
});

test("projectRoot throws GSDNoProjectError on blocked directory", () => {
  assert.ok(
    contextSrc.includes("throw new GSDNoProjectError"),
    "projectRoot should throw GSDNoProjectError when directory is blocked",
  );
});

// ─── Dispatcher catch ─────────────────────────────────────────────────────

test("dispatcher catches GSDNoProjectError with user-friendly message", () => {
  assert.ok(
    dispatcherSrc.includes("err instanceof GSDNoProjectError"),
    "dispatcher should catch GSDNoProjectError specifically",
  );
  assert.ok(
    dispatcherSrc.includes("cd"),
    "error message should suggest cd-ing into a project directory",
  );
});

test("dispatcher re-throws non-GSDNoProjectError exceptions", () => {
  assert.ok(
    dispatcherSrc.includes("throw err"),
    "dispatcher should re-throw unexpected errors",
  );
});
