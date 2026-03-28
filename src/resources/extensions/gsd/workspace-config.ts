/**
 * Workspace Config — Domain-Ownership Schema, Parser, and File Classifier
 *
 * Defines the workspace-config.yaml schema that lets each workspace copy
 * declare which parts of the codebase it "owns" (primary), which it should
 * never touch (excluded), and which are shared across copies.
 *
 * The classifier uses these rules to tag files as primary/excluded/shared/unclaimed,
 * enabling domain-aware sync assessment and risk scoring.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import picomatch from "picomatch";
import { getErrorMessage } from "./error-utils.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Classification result for a single file path. */
export type DomainClassification = "primary" | "excluded" | "shared" | "unclaimed";

/** Glob patterns defining domain ownership boundaries. */
export interface DomainRules {
  /** Globs for files this workspace owns / is responsible for. */
  primary: string[];
  /** Globs for files this workspace should never modify. */
  excluded: string[];
  /** Globs for files shared across workspace copies (e.g. configs, types). */
  shared: string[];
}

/** Full workspace domain-ownership config (lives in .gsd/workspace-config.yaml). */
export interface WorkspaceDomainConfig {
  /** Human-readable name for this workspace copy (e.g. "backend-api", "frontend"). */
  name: string;
  /** Path or URL of the source repo this was copied from (informational). */
  source: string;
  /** Domain ownership rules. */
  domainRules: DomainRules;
  /** Whether this workspace is active. Defaults to true when undefined (backward compat). */
  active?: boolean;
}

/** Result of parsing workspace-config.yaml — either success or validation error. */
export type ParseResult =
  | { ok: true; config: WorkspaceDomainConfig }
  | { ok: false; error: string };

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Validate a parsed config object for required fields and correct structure.
 * Returns null if valid, or an error message string.
 */
export function validateConfig(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return "Config is empty or null.";
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return "Config must be a YAML mapping (object), not an array or scalar.";
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    return "Missing or empty required field: name";
  }
  if (typeof obj.source !== "string" || obj.source.trim().length === 0) {
    return "Missing or empty required field: source";
  }

  if (obj.domainRules === null || obj.domainRules === undefined || typeof obj.domainRules !== "object" || Array.isArray(obj.domainRules)) {
    return "Missing or invalid required field: domainRules (must be a mapping with primary, excluded, shared arrays)";
  }

  const rules = obj.domainRules as Record<string, unknown>;

  for (const key of ["primary", "excluded", "shared"] as const) {
    const val = rules[key];
    if (val === undefined || val === null) {
      return `Missing required field: domainRules.${key}`;
    }
    if (!Array.isArray(val)) {
      return `domainRules.${key} must be an array of glob strings, got ${typeof val}`;
    }
    for (let i = 0; i < val.length; i++) {
      if (typeof val[i] !== "string") {
        return `domainRules.${key}[${i}] must be a string, got ${typeof val[i]}`;
      }
    }
  }

  return null;
}

// ─── Parser ────────────────────────────────────────────────────────────────

/**
 * Parse a workspace-config.yaml string into a typed WorkspaceDomainConfig.
 * Validates required fields and glob array structure.
 */
export function parseWorkspaceConfig(yamlContent: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (err) {
    return { ok: false, error: `YAML parse error: ${getErrorMessage(err)}` };
  }

  const validationError = validateConfig(raw);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const obj = raw as Record<string, unknown>;
  const rules = obj.domainRules as Record<string, string[]>;

  const trimGlobs = (arr: string[]) => arr.map(s => s.trim()).filter(s => s.length > 0);

  const config: WorkspaceDomainConfig = {
    name: (obj.name as string).trim(),
    source: (obj.source as string).trim(),
    domainRules: {
      primary: trimGlobs(rules.primary),
      excluded: trimGlobs(rules.excluded),
      shared: trimGlobs(rules.shared),
    },
  };

  // Preserve active field when explicitly set (undefined = active for backward compat)
  if (typeof obj.active === "boolean") {
    config.active = obj.active;
  }

  return { ok: true, config };
}

// ─── Loader ────────────────────────────────────────────────────────────────

const CONFIG_FILENAME = "workspace-config.yaml";

/**
 * Load and parse workspace-config.yaml from the given base path's .gsd/ directory.
 * Returns null if the file doesn't exist (not an error — config is optional).
 */
export function loadWorkspaceConfig(basePath: string): ParseResult | null {
  const configPath = join(basePath, ".gsd", CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return null;
  }

  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (err) {
    return { ok: false, error: `Failed to read ${CONFIG_FILENAME}: ${getErrorMessage(err)}` };
  }

  return parseWorkspaceConfig(content);
}

/**
 * Write a WorkspaceDomainConfig to .gsd/workspace-config.yaml.
 * Creates .gsd/ if it doesn't exist. Overwrites any existing config file.
 */
export function writeWorkspaceConfig(basePath: string, config: WorkspaceDomainConfig): void {
  const gsdDir = join(basePath, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const configPath = join(gsdDir, CONFIG_FILENAME);
  const yamlObj: Record<string, unknown> = {
    name: config.name,
    source: config.source,
    domainRules: {
      primary: config.domainRules.primary,
      excluded: config.domainRules.excluded,
      shared: config.domainRules.shared,
    },
  };
  // Only write active field when explicitly set (undefined = active for backward compat)
  if (typeof config.active === "boolean") {
    yamlObj.active = config.active;
  }
  const yamlContent = stringifyYaml(yamlObj);
  writeFileSync(configPath, yamlContent);
}

// ─── File Classifier ───────────────────────────────────────────────────────

/**
 * Classify a file path against domain ownership rules.
 *
 * Priority order: primary → excluded → shared → unclaimed.
 * First matching glob wins — if a file matches both primary and excluded,
 * primary takes precedence (you own it).
 *
 * Uses picomatch for glob matching (supports **, *, ?, brace expansion).
 */
/** Normalize a file path for glob matching: convert backslashes, strip leading ./ or / */
function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");
}

export function classifyFile(filePath: string, rules: DomainRules): DomainClassification {
  const normalized = normalizePath(filePath);
  const opts = { dot: true } as const;

  if (rules.primary.length > 0 && picomatch(rules.primary, opts)(normalized)) return "primary";
  if (rules.excluded.length > 0 && picomatch(rules.excluded, opts)(normalized)) return "excluded";
  if (rules.shared.length > 0 && picomatch(rules.shared, opts)(normalized)) return "shared";

  return "unclaimed";
}

/**
 * Batch-classify multiple file paths. Returns a map of classification → file list.
 * Pre-compiles picomatch matchers for efficiency over large file sets.
 */
export function classifyFiles(
  filePaths: string[],
  rules: DomainRules,
): Record<DomainClassification, string[]> {
  const result: Record<DomainClassification, string[]> = {
    primary: [],
    excluded: [],
    shared: [],
    unclaimed: [],
  };

  // Pre-compile matchers once for the entire batch
  const opts = { dot: true } as const;
  const matchers: Array<[DomainClassification, picomatch.Matcher]> = [];
  if (rules.primary.length > 0) matchers.push(["primary", picomatch(rules.primary, opts)]);
  if (rules.excluded.length > 0) matchers.push(["excluded", picomatch(rules.excluded, opts)]);
  if (rules.shared.length > 0) matchers.push(["shared", picomatch(rules.shared, opts)]);

  for (const fp of filePaths) {
    const normalized = normalizePath(fp);
    let classified: DomainClassification = "unclaimed";
    for (const [classification, matcher] of matchers) {
      if (matcher(normalized)) { classified = classification; break; }
    }
    result[classified].push(fp);
  }

  return result;
}
