/**
 * Post-Execution Checks — Validate task output after execution completes.
 *
 * Runs these checks against a completed task's output:
 *   1. Import resolution — verify relative imports in key_files resolve to existing files
 *   2. Cross-task signatures — detect hallucination cascades (function exists in task output
 *      but doesn't match prior tasks' actual code)
 *   3. Pattern consistency — warn on async style drift, naming convention inconsistencies
 *
 * Design principles:
 *   - Pure functions taking (taskRow, priorTasks, basePath) for testability
 *   - Import checks are blocking failures; pattern checks are warnings
 *   - No AST parsers — uses regex heuristics
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import type { TaskRow } from "./gsd-db.ts";

// ─── Result Types ────────────────────────────────────────────────────────────

export interface PostExecutionCheckJSON {
  /** Check category: import, signature, pattern */
  category: "import" | "signature" | "pattern";
  /** What was checked (e.g., file path, function name) */
  target: string;
  /** Whether the check passed */
  passed: boolean;
  /** Human-readable message explaining the result */
  message: string;
  /** Whether this failure should block completion (only meaningful when passed=false) */
  blocking?: boolean;
}

export interface PostExecutionResult {
  /** Overall result: pass if no blocking failures, warn if non-blocking issues, fail if blocking issues */
  status: "pass" | "warn" | "fail";
  /** All check results */
  checks: PostExecutionCheckJSON[];
  /** Total duration in milliseconds */
  durationMs: number;
}

// ─── Import Resolution Check ─────────────────────────────────────────────────

/**
 * Extract relative import paths from TypeScript/JavaScript source code.
 * Returns array of { importPath, lineNum } for relative imports.
 */
export function extractRelativeImports(
  source: string
): Array<{ importPath: string; lineNum: number }> {
  const imports: Array<{ importPath: string; lineNum: number }> = [];
  const lines = source.split("\n");

  // Match:
  //   import ... from './path'
  //   import ... from "../path"
  //   import './path'
  //   require('./path')
  //   require("../path")
  const importPattern = /(?:import\s+(?:.*?\s+from\s+)?|require\s*\(\s*)(['"])(\.\.?\/[^'"]+)\1/g;

  // Track if we're inside a block comment
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle block comment boundaries
    if (inBlockComment) {
      if (line.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }

    // Check for block comment start (that doesn't end on same line)
    const blockStart = line.indexOf("/*");
    const blockEnd = line.indexOf("*/");
    if (blockStart !== -1 && (blockEnd === -1 || blockEnd < blockStart)) {
      inBlockComment = true;
      continue;
    }

    // Skip single-line comments (// at start or after whitespace)
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) {
      continue;
    }

    // Skip JSDoc-style lines (e.g., " * import ...")
    if (trimmed.startsWith("*")) {
      continue;
    }

    let match: RegExpExecArray | null;

    // Reset lastIndex for each line
    importPattern.lastIndex = 0;

    while ((match = importPattern.exec(line)) !== null) {
      // Check if this match is after a // comment marker on the same line
      const beforeMatch = line.substring(0, match.index);
      if (beforeMatch.includes("//")) {
        continue;
      }

      imports.push({
        importPath: match[2],
        lineNum: i + 1,
      });
    }
  }

  return imports;
}

/**
 * Check if a relative import resolves to an existing file.
 * Handles .ts, .tsx, .js, .jsx extensions and index files.
 * Also handles TypeScript ESM convention where imports use .js but resolve to .ts.
 */
export function resolveImportPath(
  importPath: string,
  sourceFile: string,
  basePath: string
): { exists: boolean; resolvedPath: string | null } {
  const sourceDir = dirname(resolve(basePath, sourceFile));
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

  // Handle TypeScript ESM convention: .js imports resolve to .ts files
  // e.g., import './types.js' -> ./types.ts
  let normalizedPath = importPath;
  if (importPath.endsWith(".js")) {
    normalizedPath = importPath.slice(0, -3);
  } else if (importPath.endsWith(".jsx")) {
    normalizedPath = importPath.slice(0, -4);
  } else if (importPath.endsWith(".mjs")) {
    normalizedPath = importPath.slice(0, -4);
  } else if (importPath.endsWith(".cjs")) {
    normalizedPath = importPath.slice(0, -4);
  }

  // Try the normalized path with common extensions first
  for (const ext of extensions) {
    const fullPath = resolve(sourceDir, normalizedPath + ext);
    if (existsSync(fullPath)) {
      return { exists: true, resolvedPath: fullPath };
    }
  }

  // Try as a directory with index file
  for (const ext of extensions) {
    const indexPath = resolve(sourceDir, normalizedPath, `index${ext}`);
    if (existsSync(indexPath)) {
      return { exists: true, resolvedPath: indexPath };
    }
  }

  // Check if path already has extension (for .json, etc.)
  const hasExt = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].some(
    (ext) => importPath.endsWith(ext)
  );
  if (hasExt) {
    const fullPath = resolve(sourceDir, importPath);
    if (existsSync(fullPath)) {
      return { exists: true, resolvedPath: fullPath };
    }
  }

  return { exists: false, resolvedPath: null };
}

/**
 * Check that all relative imports in the task's key_files resolve to existing files.
 * Reads modified files from task.key_files, extracts import statements via regex,
 * verifies relative imports resolve to existing files.
 */
export function checkImportResolution(
  taskRow: TaskRow,
  _priorTasks: TaskRow[],
  basePath: string
): PostExecutionCheckJSON[] {
  const results: PostExecutionCheckJSON[] = [];

  // Get files from key_files
  const filesToCheck = taskRow.key_files.filter((f) => {
    const ext = extname(f);
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  });

  for (const file of filesToCheck) {
    const absolutePath = resolve(basePath, file);

    // Skip if file doesn't exist (might have been deleted or renamed)
    if (!existsSync(absolutePath)) {
      continue;
    }

    let source: string;
    try {
      source = readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }

    const imports = extractRelativeImports(source);

    for (const { importPath, lineNum } of imports) {
      const resolution = resolveImportPath(importPath, file, basePath);

      if (!resolution.exists) {
        results.push({
          category: "import",
          target: `${file}:${lineNum}`,
          passed: false,
          message: `Import '${importPath}' in ${file}:${lineNum} does not resolve to an existing file`,
          blocking: true,
        });
      }
    }
  }

  return results;
}

// ─── Cross-Task Signature Check ──────────────────────────────────────────────

interface FunctionSignature {
  name: string;
  params: string;
  returnType: string;
  file: string;
  lineNum: number;
}

/**
 * Extract function signatures from TypeScript/JavaScript source code.
 */
function extractFunctionSignatures(
  source: string,
  fileName: string
): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  const lines = source.split("\n");

  // Match function declarations and exports
  // Patterns:
  //   function name(params): ReturnType
  //   export function name(params): ReturnType
  //   export async function name(params): Promise<ReturnType>
  //   const name = (params): ReturnType =>
  //   export const name = (params): ReturnType =>
  const funcPattern =
    /(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+)(\w+)(?:\s*=\s*)?\s*\(([^)]*)\)(?:\s*:\s*([^{=>\n]+))?/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    funcPattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = funcPattern.exec(line)) !== null) {
      const [, name, params, returnType] = match;
      signatures.push({
        name,
        params: normalizeParams(params),
        returnType: normalizeType(returnType || "void"),
        file: fileName,
        lineNum: i + 1,
      });
    }
  }

  return signatures;
}

/**
 * Normalize parameter list for comparison.
 */
function normalizeParams(params: string): string {
  return params
    .replace(/\/\*[\s\S]*?\*\//g, "") // Remove block comments
    .replace(/\/\/[^\n]*/g, "") // Remove line comments
    .replace(/\s*=\s*[^,)]+/g, "") // Remove default values
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

/**
 * Normalize type for comparison.
 */
function normalizeType(type: string): string {
  return type.replace(/\s+/g, " ").trim();
}

/**
 * Compare function signatures in current task's output against prior tasks' key_files
 * to catch hallucination cascades — when a task references functions that don't exist
 * or have different signatures than what was actually created.
 */
export function checkCrossTaskSignatures(
  taskRow: TaskRow,
  priorTasks: TaskRow[],
  basePath: string
): PostExecutionCheckJSON[] {
  const results: PostExecutionCheckJSON[] = [];

  // Build map of functions from prior tasks' key_files
  const priorSignatures = new Map<string, FunctionSignature[]>();

  for (const task of priorTasks) {
    for (const file of task.key_files) {
      const ext = extname(file);
      if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;

      const absolutePath = resolve(basePath, file);
      if (!existsSync(absolutePath)) continue;

      try {
        const source = readFileSync(absolutePath, "utf-8");
        const sigs = extractFunctionSignatures(source, file);
        for (const sig of sigs) {
          const existing = priorSignatures.get(sig.name) || [];
          existing.push(sig);
          priorSignatures.set(sig.name, existing);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Extract function calls/references from current task's key_files
  // and check they match prior definitions
  for (const file of taskRow.key_files) {
    const ext = extname(file);
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;

    const absolutePath = resolve(basePath, file);
    if (!existsSync(absolutePath)) continue;

    try {
      const source = readFileSync(absolutePath, "utf-8");
      const currentSigs = extractFunctionSignatures(source, file);

      // Check each function in current task against prior definitions
      for (const currentSig of currentSigs) {
        const priorDefs = priorSignatures.get(currentSig.name);

        // If this function was defined in a prior task, check for signature drift
        if (priorDefs && priorDefs.length > 0) {
          const priorDef = priorDefs[0]; // Use first definition

          // Check parameter mismatch
          if (currentSig.params !== priorDef.params) {
            results.push({
              category: "signature",
              target: currentSig.name,
              passed: false,
              message: `Function '${currentSig.name}' in ${file}:${currentSig.lineNum} has parameters '${currentSig.params}' but prior definition in ${priorDef.file}:${priorDef.lineNum} has '${priorDef.params}'`,
              blocking: false, // Warn only — may be intentional override
            });
          }

          // Check return type mismatch
          if (currentSig.returnType !== priorDef.returnType) {
            results.push({
              category: "signature",
              target: currentSig.name,
              passed: false,
              message: `Function '${currentSig.name}' in ${file}:${currentSig.lineNum} returns '${currentSig.returnType}' but prior definition in ${priorDef.file}:${priorDef.lineNum} returns '${priorDef.returnType}'`,
              blocking: false, // Warn only — may be intentional override
            });
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

// ─── Pattern Consistency Check ───────────────────────────────────────────────

/**
 * Detect async style drift (mixing async/await with .then()) and
 * naming convention inconsistencies within a task's key_files.
 * Warn only — these are style issues, not correctness issues.
 */
export function checkPatternConsistency(
  taskRow: TaskRow,
  _priorTasks: TaskRow[],
  basePath: string
): PostExecutionCheckJSON[] {
  const results: PostExecutionCheckJSON[] = [];

  for (const file of taskRow.key_files) {
    const ext = extname(file);
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;

    const absolutePath = resolve(basePath, file);
    if (!existsSync(absolutePath)) continue;

    try {
      const source = readFileSync(absolutePath, "utf-8");

      // Check for async style drift
      const asyncStyleResult = checkAsyncStyleDrift(source, file);
      if (asyncStyleResult) {
        results.push(asyncStyleResult);
      }

      // Check for naming convention inconsistencies
      const namingResults = checkNamingConsistency(source, file);
      results.push(...namingResults);
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

/**
 * Detect async style drift within a single file.
 * Returns a warning if both async/await AND .then() promise chaining are used.
 */
function checkAsyncStyleDrift(
  source: string,
  fileName: string
): PostExecutionCheckJSON | null {
  // Check for async/await usage
  const hasAsyncAwait = /\basync\b[\s\S]*?\bawait\b/.test(source);

  // Check for .then() promise chaining (excluding comments)
  // Filter out common false positives like Array.prototype.then doesn't exist
  const hasThenChaining = /\.\s*then\s*\(/.test(source);

  // If both patterns are present, flag as style drift
  if (hasAsyncAwait && hasThenChaining) {
    return {
      category: "pattern",
      target: fileName,
      passed: true, // Warning only
      message: `File ${fileName} mixes async/await with .then() promise chaining — consider using consistent async style`,
      blocking: false,
    };
  }

  return null;
}

/**
 * Check for naming convention inconsistencies within a file.
 * Detects mixing of camelCase and snake_case for similar identifier types.
 */
function checkNamingConsistency(
  source: string,
  fileName: string
): PostExecutionCheckJSON[] {
  const results: PostExecutionCheckJSON[] = [];

  // Extract function names
  const functionNames: string[] = [];
  const funcPattern = /(?:function\s+|const\s+|let\s+|var\s+)(\w+)(?:\s*=\s*(?:async\s*)?\(|\s*\()/g;
  let match: RegExpExecArray | null;

  while ((match = funcPattern.exec(source)) !== null) {
    functionNames.push(match[1]);
  }

  // Check for mixed naming conventions in functions
  const camelCaseFuncs = functionNames.filter((n) => /^[a-z][a-zA-Z0-9]*$/.test(n) && /[A-Z]/.test(n));
  const snakeCaseFuncs = functionNames.filter((n) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(n));

  if (camelCaseFuncs.length > 0 && snakeCaseFuncs.length > 0) {
    results.push({
      category: "pattern",
      target: fileName,
      passed: true, // Warning only
      message: `File ${fileName} mixes camelCase (${camelCaseFuncs.slice(0, 2).join(", ")}) and snake_case (${snakeCaseFuncs.slice(0, 2).join(", ")}) function names`,
      blocking: false,
    });
  }

  return results;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Run all post-execution checks against a completed task.
 *
 * @param taskRow - The completed task row
 * @param priorTasks - Array of TaskRow from prior completed tasks in the slice
 * @param basePath - Base path for resolving file references
 * @returns PostExecutionResult with status, checks, and duration
 */
export function runPostExecutionChecks(
  taskRow: TaskRow,
  priorTasks: TaskRow[],
  basePath: string
): PostExecutionResult {
  const startTime = Date.now();
  const allChecks: PostExecutionCheckJSON[] = [];

  // Run all checks
  const importChecks = checkImportResolution(taskRow, priorTasks, basePath);
  const signatureChecks = checkCrossTaskSignatures(taskRow, priorTasks, basePath);
  const patternChecks = checkPatternConsistency(taskRow, priorTasks, basePath);

  allChecks.push(...importChecks, ...signatureChecks, ...patternChecks);

  const durationMs = Date.now() - startTime;

  // Determine overall status
  const hasBlockingFailure = allChecks.some((c) => !c.passed && c.blocking);
  const hasNonBlockingIssue = allChecks.some(
    (c) => (!c.passed && !c.blocking) || (c.passed && c.category === "pattern")
  );

  let status: "pass" | "warn" | "fail";
  if (hasBlockingFailure) {
    status = "fail";
  } else if (hasNonBlockingIssue) {
    status = "warn";
  } else {
    status = "pass";
  }

  return {
    status,
    checks: allChecks,
    durationMs,
  };
}
