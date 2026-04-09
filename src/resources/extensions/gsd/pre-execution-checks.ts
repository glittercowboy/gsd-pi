/**
 * Pre-Execution Checks — Validate task plans before execution begins.
 *
 * Runs these checks against a slice's task plan:
 *   1. Package existence — npm view calls in parallel with timeout
 *   2. File path consistency — verify files exist or are in prior expected_output
 *   3. Task ordering — detect impossible ordering (task reads file created later)
 *   4. Interface contracts — detect contradictory function signatures (warn only)
 *
 * Design principles:
 *   - Pure functions taking (tasks: TaskRow[], basePath: string) for testability
 *   - Network failures warn, don't fail (R012 conservative design)
 *   - Total execution <2s target (R013)
 *   - No AST parsers — interface parsing is heuristic (regex on code blocks)
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { TaskRow } from "./gsd-db.ts";
import type { PreExecutionCheckJSON } from "./verification-evidence.ts";

// ─── Result Types ────────────────────────────────────────────────────────────

export interface PreExecutionResult {
  /** Overall result: pass if no blocking failures, warn if non-blocking issues, fail if blocking issues */
  status: "pass" | "warn" | "fail";
  /** All check results */
  checks: PreExecutionCheckJSON[];
  /** Total duration in milliseconds */
  durationMs: number;
}

// ─── Package Existence Check ─────────────────────────────────────────────────

/**
 * Extract npm package names from task descriptions.
 * Looks for:
 *   - `npm install <pkg>` patterns
 *   - Code blocks with `require('<pkg>')` or `import ... from '<pkg>'`
 *   - Explicit mentions like "uses lodash" or "package: axios"
 */
export function extractPackageReferences(description: string): string[] {
  const packages = new Set<string>();

  // Common words that aren't package names but might appear after install
  const stopwords = new Set([
    "then", "and", "the", "to", "a", "an", "in", "for", "with", "from", "or",
    "npm", "yarn", "pnpm", "i", // Don't capture the command itself
  ]);

  // npm install <pkg> patterns (handles npm i, npm add, yarn add, pnpm add)
  // Use a global pattern to find all install commands, then parse following tokens
  const installCmdPattern = /(?:npm\s+(?:install|i|add)|yarn\s+add|pnpm\s+add)\s+/g;
  let cmdMatch: RegExpExecArray | null;
  
  while ((cmdMatch = installCmdPattern.exec(description)) !== null) {
    // Start after the install command
    const afterCmd = description.slice(cmdMatch.index + cmdMatch[0].length);
    
    // Match package-like tokens (alphanumeric, @, /, -, _) until we hit
    // something that's not a package (non-token char after whitespace)
    const tokenPattern = /^([@a-zA-Z][a-zA-Z0-9@/_-]*)(?:\s+|$)/;
    let remaining = afterCmd;
    
    while (remaining.length > 0) {
      // Skip any flags like -D, --save-dev
      const flagMatch = remaining.match(/^(-[a-zA-Z-]+)\s*/);
      if (flagMatch) {
        remaining = remaining.slice(flagMatch[0].length);
        continue;
      }
      
      // Try to match a package name
      const pkgMatch = remaining.match(tokenPattern);
      if (pkgMatch) {
        const token = pkgMatch[1];
        // Skip stopwords - they indicate end of package list
        if (stopwords.has(token.toLowerCase())) {
          break;
        }
        packages.add(normalizePackageName(token));
        remaining = remaining.slice(pkgMatch[0].length);
      } else {
        // Not a package name, stop parsing this install command
        break;
      }
    }
  }

  // require('pkg') or import from 'pkg' in code blocks
  const importPattern = /(?:require\s*\(\s*['"]|from\s+['"])([a-zA-Z0-9@/_-]+)['"\)]/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(description)) !== null) {
    // Skip relative imports and node builtins
    const pkg = importMatch[1];
    if (!pkg.startsWith(".") && !pkg.startsWith("node:")) {
      packages.add(normalizePackageName(pkg));
    }
  }

  return Array.from(packages);
}

/**
 * Normalize package name to registry-checkable form.
 * Handles scoped packages (@org/pkg) and subpaths (pkg/subpath → pkg).
 */
function normalizePackageName(raw: string): string {
  // Scoped package: @org/pkg or @org/pkg/subpath
  if (raw.startsWith("@")) {
    const parts = raw.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : raw;
  }
  // Regular package: pkg or pkg/subpath
  return raw.split("/")[0];
}

/**
 * Check if a package exists on npm registry.
 * Returns null on success, error message on failure.
 * Times out after timeoutMs (default 5000ms).
 */
async function checkPackageOnNpm(
  packageName: string,
  timeoutMs = 5000
): Promise<{ exists: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["view", packageName, "name"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exists: false, error: `Timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve({ exists: true });
      } else if (stderr.includes("404") || stderr.includes("not found")) {
        resolve({ exists: false, error: `Package not found: ${packageName}` });
      } else if (code !== 0) {
        // Network error or other issue — warn, don't fail
        resolve({ exists: true, error: `npm view failed (code ${code}): ${stderr.slice(0, 100)}` });
      } else {
        resolve({ exists: true });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exists: true, error: `npm spawn error: ${err.message}` });
    });
  });
}

/**
 * Check all package references in tasks for existence on npm.
 * Runs checks in parallel with a 5s timeout per package.
 * Network failures warn but don't fail (R012 conservative design).
 */
export async function checkPackageExistence(
  tasks: TaskRow[],
  _basePath: string
): Promise<PreExecutionCheckJSON[]> {
  const results: PreExecutionCheckJSON[] = [];
  const packagesToCheck = new Set<string>();

  // Collect all package references from task descriptions
  for (const task of tasks) {
    const packages = extractPackageReferences(task.description);
    for (const pkg of packages) {
      packagesToCheck.add(pkg);
    }
  }

  if (packagesToCheck.size === 0) {
    return results;
  }

  // Check packages in parallel
  const checkPromises = Array.from(packagesToCheck).map(async (pkg) => {
    const result = await checkPackageOnNpm(pkg);
    return { pkg, result };
  });

  const checkResults = await Promise.all(checkPromises);

  for (const { pkg, result } of checkResults) {
    if (!result.exists && !result.error?.includes("Timeout") && !result.error?.includes("spawn error")) {
      // Package genuinely doesn't exist — blocking failure
      results.push({
        category: "package",
        target: pkg,
        passed: false,
        message: result.error || `Package '${pkg}' not found on npm`,
        blocking: true,
      });
    } else if (result.error) {
      // Network issue or timeout — warn but don't block
      results.push({
        category: "package",
        target: pkg,
        passed: true,
        message: `Warning: ${result.error}`,
        blocking: false,
      });
    }
    // Silent success for existing packages — no need to report
  }

  return results;
}

// ─── File Path Consistency Check ─────────────────────────────────────────────

/**
 * Normalize a file path for consistent comparison.
 * - Strips leading ./
 * - Normalizes path separators to forward slashes
 * - Resolves redundant segments (e.g., foo/../bar → bar)
 * 
 * This ensures that "./src/a.ts", "src/a.ts", and "src//a.ts" all compare equal.
 */
export function normalizeFilePath(filePath: string): string {
  if (!filePath) return filePath;

  let normalized = extractPathFromAnnotation(filePath);

  // Normalize path separators to forward slashes
  normalized = normalized.replace(/\\/g, "/");
  
  // Remove leading ./
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  
  // Remove duplicate slashes
  normalized = normalized.replace(/\/+/g, "/");
  
  // Remove trailing slash unless it's the root
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  
  return normalized;
}

function extractPathFromAnnotation(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const backtickMatch = trimmed.match(/^`([^`]+)`(?:\s+[—–-]\s+.*)?$/);
  if (backtickMatch) {
    return backtickMatch[1].trim();
  }

  const annotatedMatch = trimmed.match(/^(.+?)\s+[—–-]\s+.+$/);
  if (annotatedMatch) {
    return annotatedMatch[1].trim();
  }

  // Fall back to the original behavior for already-plain paths.
  return trimmed.replace(/`/g, "");
}

/**
 * Build a set of files that will be created by tasks up to (but not including) taskIndex.
 * All paths are normalized for consistent comparison.
 */
function getExpectedOutputsUpTo(tasks: TaskRow[], taskIndex: number): Set<string> {
  const outputs = new Set<string>();
  for (let i = 0; i < taskIndex; i++) {
    for (const file of tasks[i].expected_output) {
      outputs.add(normalizeFilePath(file));
    }
  }
  return outputs;
}

/**
 * Check that all files referenced in task.inputs either:
 *   1. Exist on disk, OR
 *   2. Are in a prior task's expected_output
 *
 * task.files ("files likely touched") is excluded — it intentionally includes
 * files the task will create, so they don't need to pre-exist (#3626).
 *
 * All paths are normalized before comparison to ensure ./src/a.ts matches src/a.ts.
 */
export function checkFilePathConsistency(
  tasks: TaskRow[],
  basePath: string
): PreExecutionCheckJSON[] {
  const results: PreExecutionCheckJSON[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const priorOutputs = getExpectedOutputsUpTo(tasks, i);
    const filesToCheck = [...task.inputs];

    for (const file of filesToCheck) {
      // Skip empty strings
      if (!file.trim()) continue;

      // Normalize path for consistent comparison
      const normalizedFile = normalizeFilePath(file);

      // Check if file exists on disk
      const absolutePath = resolve(basePath, normalizedFile);
      const existsOnDisk = existsSync(absolutePath);

      // Check if file is in prior expected outputs (priorOutputs already normalized)
      const inPriorOutputs = priorOutputs.has(normalizedFile);

      if (!existsOnDisk && !inPriorOutputs) {
        results.push({
          category: "file",
          target: file,
          passed: false,
          message: `Task ${task.id} references '${file}' which doesn't exist and isn't created by prior tasks`,
          blocking: true,
        });
      }
    }
  }

  return results;
}

// ─── Task Ordering Check ─────────────────────────────────────────────────────

/**
 * Detect impossible task ordering: task N reads a file that task N+M creates.
 * This is a fatal error — the plan has an impossible dependency.
 * 
 * All paths are normalized before comparison to ensure ./src/a.ts matches src/a.ts.
 */
export function checkTaskOrdering(
  tasks: TaskRow[],
  _basePath: string
): PreExecutionCheckJSON[] {
  const results: PreExecutionCheckJSON[] = [];

  // Build map: normalized file → task index that creates it
  const fileCreators = new Map<string, { taskId: string; index: number; originalPath: string }>();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    for (const file of task.expected_output) {
      const normalizedFile = normalizeFilePath(file);
      if (!fileCreators.has(normalizedFile)) {
        fileCreators.set(normalizedFile, { taskId: task.id, index: i, originalPath: file });
      }
    }
  }

  // Check each task's inputs against file creators.
  // Only check task.inputs — task.files ("files likely touched") intentionally
  // includes files the task will create, so they don't indicate read-before-create (#3677).
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const filesToCheck = [...task.inputs];

    for (const file of filesToCheck) {
      const normalizedFile = normalizeFilePath(file);
      const creator = fileCreators.get(normalizedFile);
      if (creator && creator.index > i) {
        // Task reads file that is created later — impossible ordering
        results.push({
          category: "file",
          target: file,
          passed: false,
          message: `Task ${task.id} reads '${file}' but it's created by task ${creator.taskId} (sequence violation)`,
          blocking: true,
        });
      }
    }
  }

  return results;
}

// ─── Interface Contract Check ────────────────────────────────────────────────

interface FunctionSignature {
  name: string;
  params: string;
  returnType: string;
  taskId: string;
  raw: string;
}

/**
 * Extract function signatures from code blocks in task description.
 * Uses heuristic regex — not an AST parser.
 */
function extractFunctionSignatures(description: string, taskId: string): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];

  // Match code blocks (```...```)
  const codeBlockPattern = /```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = codeBlockPattern.exec(description)) !== null) {
    const codeBlock = blockMatch[1];

    // Match function declarations and exports
    // Patterns:
    //   function name(params): ReturnType
    //   export function name(params): ReturnType
    //   export async function name(params): Promise<ReturnType>
    //   const name = (params): ReturnType =>
    //   export const name = (params): ReturnType =>
    const funcPattern = /(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+)(\w+)(?:\s*=\s*)?\s*\(([^)]*)\)(?:\s*:\s*([^{=>\n]+))?/g;
    let funcMatch: RegExpExecArray | null;

    while ((funcMatch = funcPattern.exec(codeBlock)) !== null) {
      const [raw, name, params, returnType] = funcMatch;
      signatures.push({
        name,
        params: normalizeParams(params),
        returnType: normalizeType(returnType || "void"),
        taskId,
        raw: raw.trim(),
      });
    }

    // Match interface method signatures
    // Pattern: methodName(params): ReturnType;
    const methodPattern = /^\s*(\w+)\s*\(([^)]*)\)\s*:\s*([^;]+);/gm;
    let methodMatch: RegExpExecArray | null;

    while ((methodMatch = methodPattern.exec(codeBlock)) !== null) {
      const [raw, name, params, returnType] = methodMatch;
      signatures.push({
        name,
        params: normalizeParams(params),
        returnType: normalizeType(returnType),
        taskId,
        raw: raw.trim(),
      });
    }
  }

  return signatures;
}

/**
 * Normalize parameter list for comparison.
 * Removes whitespace, comments, and default values.
 */
function normalizeParams(params: string): string {
  return params
    .replace(/\/\*[\s\S]*?\*\//g, "") // Remove block comments
    .replace(/\/\/[^\n]*/g, "")       // Remove line comments
    .replace(/\s*=\s*[^,)]+/g, "")    // Remove default values
    .replace(/\s+/g, " ")             // Normalize whitespace
    .trim();
}

/**
 * Normalize type for comparison.
 */
function normalizeType(type: string): string {
  return type
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check for contradictory function signatures across tasks.
 * Same function name with different signatures is a warning (not blocking).
 */
export function checkInterfaceContracts(
  tasks: TaskRow[],
  _basePath: string
): PreExecutionCheckJSON[] {
  const results: PreExecutionCheckJSON[] = [];

  // Collect all signatures
  const allSignatures: FunctionSignature[] = [];
  for (const task of tasks) {
    const sigs = extractFunctionSignatures(task.description, task.id);
    allSignatures.push(...sigs);
  }

  // Group by function name
  const byName = new Map<string, FunctionSignature[]>();
  for (const sig of allSignatures) {
    const existing = byName.get(sig.name) || [];
    existing.push(sig);
    byName.set(sig.name, existing);
  }

  // Check for contradictions
  for (const [name, sigs] of byName) {
    if (sigs.length < 2) continue;

    // Compare signatures
    const first = sigs[0];
    for (let i = 1; i < sigs.length; i++) {
      const current = sigs[i];

      // Check parameter mismatch
      if (first.params !== current.params) {
        results.push({
          category: "schema",
          target: name,
          passed: true, // Warning only, not blocking
          message: `Function '${name}' has different parameters: '${first.params}' (${first.taskId}) vs '${current.params}' (${current.taskId})`,
          blocking: false,
        });
      }

      // Check return type mismatch
      if (first.returnType !== current.returnType) {
        results.push({
          category: "schema",
          target: name,
          passed: true, // Warning only, not blocking
          message: `Function '${name}' has different return types: '${first.returnType}' (${first.taskId}) vs '${current.returnType}' (${current.taskId})`,
          blocking: false,
        });
      }
    }
  }

  return results;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Run all pre-execution checks against a slice's task plan.
 *
 * @param tasks - Array of TaskRow from the slice
 * @param basePath - Base path for resolving file references
 * @returns PreExecutionResult with status, checks, and duration
 */
export async function runPreExecutionChecks(
  tasks: TaskRow[],
  basePath: string
): Promise<PreExecutionResult> {
  const startTime = Date.now();
  const allChecks: PreExecutionCheckJSON[] = [];

  // Run sync checks first
  const fileChecks = checkFilePathConsistency(tasks, basePath);
  const orderingChecks = checkTaskOrdering(tasks, basePath);
  const contractChecks = checkInterfaceContracts(tasks, basePath);

  allChecks.push(...fileChecks, ...orderingChecks, ...contractChecks);

  // Run async package checks
  const packageChecks = await checkPackageExistence(tasks, basePath);
  allChecks.push(...packageChecks);

  const durationMs = Date.now() - startTime;

  // Determine overall status
  const hasBlockingFailure = allChecks.some((c) => !c.passed && c.blocking);
  const hasNonBlockingFailure = allChecks.some((c) => !c.passed && !c.blocking);
  // Interface contract checks pass but still report warnings via message
  const hasInterfaceWarning = allChecks.some(
    (c) => c.category === "schema" && c.message && !c.message.startsWith("Warning:")
  );
  const hasNetworkWarning = allChecks.some(
    (c) => c.passed && c.message?.startsWith("Warning:")
  );

  let status: "pass" | "warn" | "fail";
  if (hasBlockingFailure) {
    status = "fail";
  } else if (hasNonBlockingFailure || hasInterfaceWarning || hasNetworkWarning) {
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
