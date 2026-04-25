/**
 * GSD Preparation — Structured brief generation for discussion LLM sessions.
 *
 * Produces structured briefs (codebase, prior context, ecosystem) before
 * the discussion LLM session starts.
 *
 * Pure functions, zero UI dependencies (except for runPreparation orchestrator).
 */

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative } from "node:path";
import { readdirSync as readdirSyncNode } from "node:fs";
import {
  detectProjectSignals,
  scanProjectFiles,
  PROJECT_FILES,
  type ProjectSignals,
} from "./detection.js";
import { loadFile } from "./files.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Detected patterns in the codebase. */
export interface CodePatterns {
  /** Primary async style: "async/await" | "callbacks" | "promises" | "mixed" */
  asyncStyle: "async/await" | "callbacks" | "promises" | "mixed" | "unknown";
  /** Primary error handling: "try/catch" | "error-callbacks" | "result-types" | "mixed" */
  errorHandling: "try/catch" | "error-callbacks" | "result-types" | "mixed" | "unknown";
  /** Primary naming convention: "camelCase" | "snake_case" | "PascalCase" | "mixed" */
  namingConvention: "camelCase" | "snake_case" | "PascalCase" | "mixed" | "unknown";
  /** Sample evidence strings for each pattern (for debugging/transparency) */
  evidence: {
    asyncStyle: string[];
    errorHandling: string[];
    namingConvention: string[];
  };
  /** File counts for each pattern type (for formatted output) */
  fileCounts: {
    asyncAwait: number;
    promises: number;
    callbacks: number;
    tryCatch: number;
    errorCallbacks: number;
    resultTypes: number;
  };
}

/** Language-specific pattern detection configuration. */
export interface LanguagePatternEntry {
  /** Display name for the language (e.g., "JavaScript/TypeScript") */
  displayName: string;
  /** File extensions to sample for this language */
  extensions: string[];
  /** Async style detection patterns */
  asyncStyle: {
    modern: RegExp;
    modernLabel: string;
    legacy: RegExp;
    legacyLabel: string;
  };
  /** Error handling detection patterns */
  errorHandling: {
    structured: RegExp;
    structuredLabel: string;
    inline: RegExp;
    inlineLabel: string;
  };
}

/** Module structure detected in the codebase. */
export interface ModuleStructure {
  /** Top-level directories found (e.g., ["src", "lib", "test"]) */
  topLevelDirs: string[];
  /** Subdirectories within src/ or lib/ (e.g., ["components", "utils", "hooks"]) */
  srcSubdirs: string[];
  /** Total file count sampled */
  totalFilesSampled: number;
}

/** A single decision entry parsed from DECISIONS.md. */
export interface DecisionEntry {
  id: string;
  scope: string;
  decision: string;
  choice: string;
  rationale: string;
}

/** A single requirement entry parsed from REQUIREMENTS.md. */
export interface RequirementEntry {
  id: string;
  description: string;
  status: "active" | "validated" | "deferred" | "out-of-scope";
}

/** Prior context brief aggregated from GSD artifacts. */
export interface PriorContextBrief {
  /** Decisions grouped by scope. */
  decisions: {
    byScope: Map<string, DecisionEntry[]>;
    totalCount: number;
  };
  /** Requirements grouped by status. */
  requirements: {
    active: RequirementEntry[];
    validated: RequirementEntry[];
    deferred: RequirementEntry[];
    totalCount: number;
  };
  /** Knowledge entries (raw content, truncated). */
  knowledge: string;
  /** Prior milestone summaries (combined, truncated). */
  summaries: string;
}

/** Codebase analysis brief. */
export interface CodebaseBrief {
  /** Tech stack and language from detectProjectSignals */
  techStack: {
    primaryLanguage?: string;
    detectedFiles: string[];
    packageManager?: string;
    isMonorepo: boolean;
    hasTests: boolean;
    hasCI: boolean;
  };
  /** Module structure */
  moduleStructure: ModuleStructure;
  /** Detected code patterns */
  patterns: CodePatterns;
  /** Source files that were sampled for pattern extraction */
  sampledFiles: string[];
}

/** A single ecosystem research finding. */
export interface EcosystemFinding {
  /** Query that produced this finding */
  query: string;
  /** Title or snippet from search result */
  title: string;
  /** URL source */
  url?: string;
  /** Brief content snippet */
  snippet: string;
}

/** Ecosystem research brief from web search. */
export interface EcosystemBrief {
  /** Whether ecosystem research was performed */
  available: boolean;
  /** Search queries that were executed */
  queries: string[];
  /** Aggregated findings from search results */
  findings: EcosystemFinding[];
  /** Reason why research was skipped (if available === false) */
  skippedReason?: string;
  /** Which search provider was used */
  provider?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Maximum characters for the codebase section. */
const MAX_CODEBASE_BRIEF_CHARS = 3000;

/** Number of files to sample for pattern extraction. */
const SAMPLE_FILE_COUNT = 5;

/** Maximum bytes to read from each sampled file. */
const MAX_FILE_SAMPLE_BYTES = 8192;

/** Directories to skip when sampling. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  ".turbo",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

/** File patterns to exclude when sampling. */
const EXCLUDE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.d\.ts$/,
  /test-.*\.(ts|tsx|js|jsx)$/,
  /.*\.min\.(js|css)$/,
];

/** File extensions to sample for pattern extraction (JS/TS default). */
const SAMPLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Common source file extensions for universal pattern detection (naming convention).
 *  Used when the language is not in LANGUAGE_PATTERNS but we still want to detect camelCase/snake_case. */
const UNIVERSAL_SOURCE_EXTENSIONS = [
  // JavaScript/TypeScript
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  // Python
  ".py", ".pyw", ".pyi",
  // Ruby
  ".rb", ".rake", ".gemspec",
  // Go
  ".go",
  // Rust
  ".rs",
  // Java/Kotlin
  ".java", ".kt", ".kts",
  // C/C++
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp",
  // C#
  ".cs",
  // Swift
  ".swift",
  // PHP
  ".php",
  // Scala
  ".scala",
  // Elixir/Erlang
  ".ex", ".exs", ".erl",
  // Haskell
  ".hs", ".lhs",
  // Shell
  ".sh", ".bash", ".zsh",
  // Lua
  ".lua",
  // Dart
  ".dart",
];

// ─── Pattern Detection Regexes ──────────────────────────────────────────────────

/** Async/await usage patterns. */
const ASYNC_AWAIT_RE = /\basync\s+function\b|\basync\s*\(|\bawait\s+/g;

/** Callback-style patterns (common patterns like done, callback, cb). */
const CALLBACK_RE = /\b(callback|cb|done)\s*\(|\bfunction\s*\([^)]*\bfunction\b/g;

/** Promise patterns (.then, .catch, new Promise). */
const PROMISE_RE = /\.then\s*\(|\.catch\s*\(|\bnew\s+Promise\s*\(/g;

/** Try/catch patterns. */
const TRY_CATCH_RE = /\btry\s*\{[\s\S]*?\bcatch\s*\(/g;

/** Error-first callback patterns. */
const ERROR_CALLBACK_RE = /\bif\s*\(\s*(err|error)\s*\)|\(err(or)?\s*,/g;

/** Result type patterns (Rust-style, fp-ts, etc.). */
const RESULT_TYPE_RE = /\bResult<|\bEither<|\bisOk\(|\bisErr\(|\b(Ok|Err)\(/g;

/** camelCase identifier patterns. */
const CAMEL_CASE_RE = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g;

/** snake_case identifier patterns. */
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g;

/** PascalCase identifier patterns (for types/classes). */
const PASCAL_CASE_RE = /\bclass\s+[A-Z][a-zA-Z0-9]*|\binterface\s+[A-Z][a-zA-Z0-9]*|\btype\s+[A-Z][a-zA-Z0-9]*/g;

// ─── Language Pattern Registry ──────────────────────────────────────────────────

/**
 * Registry of language-specific patterns for code analysis.
 * Keys MUST match detection.ts LANGUAGE_MAP values exactly.
 */
export const LANGUAGE_PATTERNS: Record<string, LanguagePatternEntry> = {
  "javascript/typescript": {
    displayName: "JavaScript/TypeScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    asyncStyle: {
      modern: /\basync\s+function\b|\basync\s*\(|\bawait\s+/g,
      modernLabel: "async/await",
      legacy: /\.then\s*\(|\.catch\s*\(|\bnew\s+Promise\s*\(/g,
      legacyLabel: "promises",
    },
    errorHandling: {
      structured: /\btry\s*\{[\s\S]*?\bcatch\s*\(/g,
      structuredLabel: "try/catch",
      inline: /\bif\s*\(\s*(err|error)\s*\)|\(err(or)?\s*,/g,
      inlineLabel: "error-callbacks",
    },
  },
  python: {
    displayName: "Python",
    extensions: [".py", ".pyw", ".pyi"],
    asyncStyle: {
      modern: /\basync\s+def\b|\bawait\s+/g,
      modernLabel: "async/await",
      legacy: /\.add_done_callback\(|ThreadPoolExecutor|ProcessPoolExecutor/g,
      legacyLabel: "futures/executors",
    },
    errorHandling: {
      structured: /\btry\s*:[\s\S]*?\bexcept\b/g,
      structuredLabel: "try/except",
      inline: /\braise\s+\w+Error|\bassert\s+/g,
      inlineLabel: "raise/assert",
    },
  },
  rust: {
    displayName: "Rust",
    extensions: [".rs"],
    asyncStyle: {
      modern: /\basync\s+fn\b|\.await\b/g,
      modernLabel: "async/await",
      legacy: /\bthread::spawn\(|\bmpsc::/g,
      legacyLabel: "threads/channels",
    },
    errorHandling: {
      structured: /\bResult<|\bOption<|\?\s*;/g,
      structuredLabel: "Result/Option",
      inline: /\bunwrap\(\)|\bexpect\(/g,
      inlineLabel: "unwrap/expect",
    },
  },
  go: {
    displayName: "Go",
    extensions: [".go"],
    asyncStyle: {
      modern: /\bgo\s+func\b|\bgo\s+\w+\(/g,
      modernLabel: "goroutines",
      legacy: /\bchan\s+\w+|<-\s*\w+|\w+\s*<-/g,
      legacyLabel: "channels",
    },
    errorHandling: {
      structured: /\bif\s+err\s*!=\s*nil\b/g,
      structuredLabel: "if err != nil",
      inline: /\bpanic\(|\brecover\(\)/g,
      inlineLabel: "panic/recover",
    },
  },
  java: {
    displayName: "Java",
    extensions: [".java"],
    asyncStyle: {
      modern: /\bCompletableFuture<|\bCompletionStage<|\bthenApply\(/g,
      modernLabel: "CompletableFuture",
      legacy: /\bThread\s+\w+\s*=|\bnew\s+Thread\(|\bExecutorService\b/g,
      legacyLabel: "threads/executors",
    },
    errorHandling: {
      structured: /\btry\s*\{[\s\S]*?\bcatch\s*\(/g,
      structuredLabel: "try/catch",
      inline: /\bthrows\s+\w+Exception|\bthrow\s+new\s+\w+Exception/g,
      inlineLabel: "throws/throw",
    },
  },
  "java/kotlin": {
    displayName: "Java/Kotlin",
    extensions: [".java", ".kt", ".kts"],
    asyncStyle: {
      modern: /\bsuspend\s+fun\b|\blaunch\s*\{|\basync\s*\{|\bwithContext\(/g,
      modernLabel: "coroutines",
      legacy: /\bThread\s+\w+\s*=|\bnew\s+Thread\(|\bExecutorService\b|\bCompletableFuture</g,
      legacyLabel: "threads/futures",
    },
    errorHandling: {
      structured: /\btry\s*\{[\s\S]*?\bcatch\s*\(/g,
      structuredLabel: "try/catch",
      inline: /\bthrows\s+\w+Exception|\bthrow\s+\w+Exception|\brunCatching\s*\{/g,
      inlineLabel: "throws/runCatching",
    },
  },
};

// ─── Core Functions ─────────────────────────────────────────────────────────────

/**
 * Analyze the codebase and produce a structured brief.
 *
 * @param basePath - Root directory of the project
 * @returns CodebaseBrief with tech stack, module structure, and patterns
 */
export async function analyzeCodebase(basePath: string): Promise<CodebaseBrief> {
  // Get project signals from detection.ts
  const signals = detectProjectSignals(basePath);

  // Detect module structure
  const moduleStructure = detectModuleStructure(basePath);

  // Sample files and extract patterns, passing primary language for language-aware detection
  const sampledFiles = sampleSourceFiles(basePath, signals.primaryLanguage);
  const patterns = extractPatterns(basePath, sampledFiles, signals.primaryLanguage);

  return {
    techStack: {
      primaryLanguage: signals.primaryLanguage,
      detectedFiles: signals.detectedFiles,
      packageManager: signals.packageManager,
      isMonorepo: signals.isMonorepo,
      hasTests: signals.hasTests,
      hasCI: signals.hasCI,
    },
    moduleStructure,
    patterns,
    sampledFiles,
  };
}

/**
 * Detect the module structure of the codebase.
 *
 * @param basePath - Root directory of the project
 * @returns ModuleStructure with top-level and src subdirs
 */
function detectModuleStructure(basePath: string): ModuleStructure {
  const topLevelDirs: string[] = [];
  const srcSubdirs: string[] = [];

  try {
    const entries = readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
        topLevelDirs.push(entry.name);
      }
    }
  } catch {
    // Directory not readable
  }

  // Scan for subdirs in src/ or lib/
  for (const srcDir of ["src", "lib", "app"]) {
    const srcPath = join(basePath, srcDir);
    try {
      const entries = readdirSync(srcPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          srcSubdirs.push(entry.name);
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }
  }

  return {
    topLevelDirs,
    srcSubdirs: [...new Set(srcSubdirs)], // Dedupe
    totalFilesSampled: 0, // Will be set after sampling
  };
}

/**
 * Sample source files from the codebase for pattern extraction.
 *
 * Prefers files in src/ directory, excludes test files and node_modules.
 * Extension selection:
 * - If language is in LANGUAGE_PATTERNS: use language-specific extensions
 * - If language is undefined (no manifest): use JS/TS defaults (common case)
 * - If language is set but not in LANGUAGE_PATTERNS: use UNIVERSAL_SOURCE_EXTENSIONS
 *   so we can still detect naming conventions even for unrecognized languages
 *
 * @param basePath - Root directory of the project
 * @param primaryLanguage - Optional primary language identifier from detection.ts LANGUAGE_MAP
 * @returns Array of relative file paths to sampled files
 */
function sampleSourceFiles(basePath: string, primaryLanguage?: string): string[] {
  // Use scanProjectFiles from detection.ts for bounded recursion
  const allFiles = scanProjectFiles(basePath);

  // Get extensions to sample based on language detection status
  const languageEntry = primaryLanguage ? LANGUAGE_PATTERNS[primaryLanguage] : undefined;
  let extensionsToSample: string[];
  
  if (languageEntry) {
    // Language is in registry — use its specific extensions
    extensionsToSample = languageEntry.extensions;
  } else if (primaryLanguage === undefined) {
    // No language detected (no manifest) — use JS/TS defaults
    extensionsToSample = SAMPLE_EXTENSIONS;
  } else {
    // Language detected but not in registry (e.g., Ruby, Haskell)
    // Use universal extensions so we can still detect naming conventions
    extensionsToSample = UNIVERSAL_SOURCE_EXTENSIONS;
  }

  // Filter to target language files, excluding tests and dist
  const candidates = allFiles.filter((file) => {
    // Check extension
    const hasValidExtension = extensionsToSample.some((ext) => file.endsWith(ext));
    if (!hasValidExtension) return false;

    // Check exclusion patterns
    for (const pattern of EXCLUDE_PATTERNS) {
      if (pattern.test(file)) return false;
    }

    // Check for excluded directories in path
    const parts = file.split(/[/\\]/);
    for (const part of parts) {
      if (SKIP_DIRS.has(part)) return false;
    }

    return true;
  });

  // Prioritize files in src/ directory
  const srcFiles = candidates.filter((f) => f.startsWith("src/") || f.startsWith("src\\"));
  const otherFiles = candidates.filter((f) => !f.startsWith("src/") && !f.startsWith("src\\"));

  // Take SAMPLE_FILE_COUNT files, preferring src/
  const sampled: string[] = [];

  // First, add src files
  for (const file of srcFiles) {
    if (sampled.length >= SAMPLE_FILE_COUNT) break;
    sampled.push(file);
  }

  // Then add other files if needed
  for (const file of otherFiles) {
    if (sampled.length >= SAMPLE_FILE_COUNT) break;
    sampled.push(file);
  }

  return sampled;
}

/**
 * Extract code patterns from sampled files.
 *
 * Pattern detection behavior:
 * 1. When primaryLanguage exists in LANGUAGE_PATTERNS → uses language-specific patterns
 * 2. When primaryLanguage is undefined (no manifest) → falls back to JS/TS patterns
 *    since the sampled files are filtered by JS/TS extensions anyway
 * 3. When primaryLanguage is a known value NOT in LANGUAGE_PATTERNS (e.g., "haskell",
 *    "elixir") → returns "unknown" for language-specific patterns instead of running
 *    JS/TS patterns which would produce misleading results
 *
 * Universal patterns (naming convention) always run regardless of language.
 *
 * @param basePath - Root directory of the project
 * @param sampledFiles - Array of relative file paths
 * @param primaryLanguage - Optional primary language identifier from detection.ts LANGUAGE_MAP
 * @returns CodePatterns with detected patterns and evidence
 */
function extractPatterns(basePath: string, sampledFiles: string[], primaryLanguage?: string): CodePatterns {
  const evidence = {
    asyncStyle: [] as string[],
    errorHandling: [] as string[],
    namingConvention: [] as string[],
  };

  const counts = {
    asyncAwait: 0,
    callbacks: 0,
    promises: 0,
    tryCatch: 0,
    errorCallbacks: 0,
    resultTypes: 0,
    camelCase: 0,
    snakeCase: 0,
    pascalCase: 0,
  };

  // Track how many files contain each pattern type (for formatted output)
  const fileCounts = {
    asyncAwait: 0,
    promises: 0,
    callbacks: 0,
    tryCatch: 0,
    errorCallbacks: 0,
    resultTypes: 0,
  };

  // Get language-specific patterns if available
  // When primaryLanguage is undefined, fall back to JS/TS (sampled files are JS/TS extensions)
  // When primaryLanguage is set but not in registry, skip language-specific patterns entirely
  const languageEntry = primaryLanguage 
    ? LANGUAGE_PATTERNS[primaryLanguage] 
    : LANGUAGE_PATTERNS["javascript/typescript"]; // Fallback for undefined only
  
  // Language is "unsupported" only when it's explicitly set but not in our registry
  // undefined → use JS/TS fallback (the sampled files are .ts/.js anyway)
  // "haskell" → unsupported, don't run JS patterns against Haskell code
  const languageUnsupported = primaryLanguage !== undefined && !LANGUAGE_PATTERNS[primaryLanguage];

  // If language is explicitly set but not in registry, add evidence explaining why patterns aren't available
  if (languageUnsupported) {
    evidence.asyncStyle.push(`Language "${primaryLanguage}" not in pattern registry — async style detection not available`);
    evidence.errorHandling.push(`Language "${primaryLanguage}" not in pattern registry — error handling detection not available`);
  }

  for (const file of sampledFiles) {
    let content: string;
    try {
      const fullPath = join(basePath, file);
      const buffer = Buffer.alloc(MAX_FILE_SAMPLE_BYTES);
      const fd = openSync(fullPath, "r");
      try {
        const bytesRead = readSync(fd, buffer, 0, MAX_FILE_SAMPLE_BYTES, 0);
        content = buffer.toString("utf-8", 0, bytesRead);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue; // Skip unreadable files
    }

    // Only run language-specific patterns if we have a valid language entry
    // This prevents misleading results from running JS/TS patterns against Haskell, etc.
    if (!languageUnsupported && languageEntry) {
      // Count async patterns using language-appropriate patterns
      // Use String.match() to avoid mutating lastIndex on regex with /g flag
      const asyncModernMatches = content.match(languageEntry.asyncStyle.modern) || [];
      counts.asyncAwait += asyncModernMatches.length;
      if (asyncModernMatches.length > 0) {
        fileCounts.asyncAwait++;
        if (evidence.asyncStyle.length < 3) {
          evidence.asyncStyle.push(`${file}: ${languageEntry.asyncStyle.modernLabel} (${asyncModernMatches.length} occurrences)`);
        }
      }

      // For JS/TS, also check callbacks (universal pattern)
      if (primaryLanguage === "javascript/typescript") {
        const callbackMatches = content.match(CALLBACK_RE) || [];
        counts.callbacks += callbackMatches.length;
        if (callbackMatches.length > 0) {
          fileCounts.callbacks++;
          if (evidence.asyncStyle.length < 3) {
            evidence.asyncStyle.push(`${file}: callbacks (${callbackMatches.length} occurrences)`);
          }
        }
      }

      const asyncLegacyMatches = content.match(languageEntry.asyncStyle.legacy) || [];
      counts.promises += asyncLegacyMatches.length;
      if (asyncLegacyMatches.length > 0) {
        fileCounts.promises++;
        if (evidence.asyncStyle.length < 3) {
          evidence.asyncStyle.push(`${file}: ${languageEntry.asyncStyle.legacyLabel} (${asyncLegacyMatches.length} occurrences)`);
        }
      }

      // Count error handling patterns using language-appropriate patterns
      const errorStructuredMatches = content.match(languageEntry.errorHandling.structured) || [];
      counts.tryCatch += errorStructuredMatches.length;
      if (errorStructuredMatches.length > 0) {
        fileCounts.tryCatch++;
        if (evidence.errorHandling.length < 3) {
          evidence.errorHandling.push(`${file}: ${languageEntry.errorHandling.structuredLabel} (${errorStructuredMatches.length} occurrences)`);
        }
      }

      const errorInlineMatches = content.match(languageEntry.errorHandling.inline) || [];
      counts.errorCallbacks += errorInlineMatches.length;
      if (errorInlineMatches.length > 0) {
        fileCounts.errorCallbacks++;
        if (evidence.errorHandling.length < 3) {
          evidence.errorHandling.push(`${file}: ${languageEntry.errorHandling.inlineLabel} (${errorInlineMatches.length} occurrences)`);
        }
      }

      // Result types are still useful for some languages (Rust, fp-ts)
      const resultTypeMatches = content.match(RESULT_TYPE_RE) || [];
      counts.resultTypes += resultTypeMatches.length;
      if (resultTypeMatches.length > 0) {
        fileCounts.resultTypes++;
        if (evidence.errorHandling.length < 3) {
          evidence.errorHandling.push(`${file}: result-types (${resultTypeMatches.length} occurrences)`);
        }
      }
    }

    // Count naming convention patterns (universal across all languages)
    // These patterns work regardless of whether the language is in the registry
    const camelMatches = content.match(CAMEL_CASE_RE) || [];
    counts.camelCase += camelMatches.length;

    const snakeMatches = content.match(SNAKE_CASE_RE) || [];
    counts.snakeCase += snakeMatches.length;

    const pascalMatches = content.match(PASCAL_CASE_RE) || [];
    counts.pascalCase += pascalMatches.length;
  }

  // Add naming evidence
  if (counts.camelCase > 0) {
    evidence.namingConvention.push(`camelCase: ${counts.camelCase} occurrences`);
  }
  if (counts.snakeCase > 0) {
    evidence.namingConvention.push(`snake_case: ${counts.snakeCase} occurrences`);
  }
  if (counts.pascalCase > 0) {
    evidence.namingConvention.push(`PascalCase: ${counts.pascalCase} occurrences`);
  }

  // For explicitly set but unrecognized languages, return "unknown" for language-specific patterns
  // but still provide naming convention detection (which is universal)
  if (languageUnsupported) {
    return {
      asyncStyle: "unknown",
      errorHandling: "unknown",
      namingConvention: determineNamingConvention(counts),
      evidence,
      fileCounts,
    };
  }

  return {
    asyncStyle: determineAsyncStyle(counts),
    errorHandling: determineErrorHandling(counts),
    namingConvention: determineNamingConvention(counts),
    evidence,
    fileCounts,
  };
}

/**
 * Determine the primary async style based on pattern counts.
 */
function determineAsyncStyle(counts: {
  asyncAwait: number;
  callbacks: number;
  promises: number;
}): CodePatterns["asyncStyle"] {
  const total = counts.asyncAwait + counts.callbacks + counts.promises;
  if (total === 0) return "unknown";

  const asyncAwaitRatio = counts.asyncAwait / total;
  const callbackRatio = counts.callbacks / total;
  const promiseRatio = counts.promises / total;

  // If one style dominates (>60%), report it
  if (asyncAwaitRatio > 0.6) return "async/await";
  if (callbackRatio > 0.6) return "callbacks";
  if (promiseRatio > 0.6) return "promises";

  return "mixed";
}

/**
 * Determine the primary error handling style based on pattern counts.
 */
function determineErrorHandling(counts: {
  tryCatch: number;
  errorCallbacks: number;
  resultTypes: number;
}): CodePatterns["errorHandling"] {
  const total = counts.tryCatch + counts.errorCallbacks + counts.resultTypes;
  if (total === 0) return "unknown";

  const tryCatchRatio = counts.tryCatch / total;
  const errorCallbackRatio = counts.errorCallbacks / total;
  const resultTypeRatio = counts.resultTypes / total;

  if (tryCatchRatio > 0.6) return "try/catch";
  if (errorCallbackRatio > 0.6) return "error-callbacks";
  if (resultTypeRatio > 0.6) return "result-types";

  return "mixed";
}

/**
 * Determine the primary naming convention based on pattern counts.
 */
function determineNamingConvention(counts: {
  camelCase: number;
  snakeCase: number;
  pascalCase: number;
}): CodePatterns["namingConvention"] {
  const total = counts.camelCase + counts.snakeCase + counts.pascalCase;
  if (total === 0) return "unknown";

  // PascalCase is usually for types/classes, so we compare camelCase vs snake_case
  const camelRatio = counts.camelCase / total;
  const snakeRatio = counts.snakeCase / total;

  if (camelRatio > 0.6) return "camelCase";
  if (snakeRatio > 0.6) return "snake_case";
  if (counts.pascalCase > counts.camelCase && counts.pascalCase > counts.snakeCase) return "PascalCase";

  return "mixed";
}

// ─── Formatting ─────────────────────────────────────────────────────────────────

/**
 * Format a CodebaseBrief as LLM-readable markdown.
 *
 * @param brief - The codebase brief to format
 * @returns Markdown string capped at MAX_CODEBASE_BRIEF_CHARS
 */
export function formatCodebaseBrief(brief: CodebaseBrief): string {
  const sections: string[] = [];

  // Tech Stack section
  sections.push("## Tech Stack");
  if (brief.techStack.primaryLanguage) {
    sections.push(`- **Language:** ${brief.techStack.primaryLanguage}`);
  }
  if (brief.techStack.packageManager) {
    sections.push(`- **Package Manager:** ${brief.techStack.packageManager}`);
  }
  if (brief.techStack.detectedFiles.length > 0) {
    const files = brief.techStack.detectedFiles.slice(0, 10).join(", ");
    sections.push(`- **Project Files:** ${files}`);
  }
  sections.push(`- **Monorepo:** ${brief.techStack.isMonorepo ? "Yes" : "No"}`);
  sections.push(`- **Has Tests:** ${brief.techStack.hasTests ? "Yes" : "No"}`);
  sections.push(`- **Has CI:** ${brief.techStack.hasCI ? "Yes" : "No"}`);

  // Module Structure section
  sections.push("");
  sections.push("## Module Structure");
  if (brief.moduleStructure.topLevelDirs.length > 0) {
    sections.push(`- **Top-level dirs:** ${brief.moduleStructure.topLevelDirs.join(", ")}`);
  }
  if (brief.moduleStructure.srcSubdirs.length > 0) {
    sections.push(`- **Source subdirs:** ${brief.moduleStructure.srcSubdirs.join(", ")}`);
  }

  // Code Patterns section
  sections.push("");
  sections.push("## Code Patterns");
  
  // Format async style with file counts
  const fc = brief.patterns.fileCounts;
  if (brief.patterns.asyncStyle === "unknown") {
    sections.push(`- **Async Style:** ${brief.patterns.asyncStyle}`);
  } else {
    const asyncParts: string[] = [];
    if (fc.asyncAwait > 0) asyncParts.push(`${fc.asyncAwait} async/await`);
    if (fc.promises > 0) asyncParts.push(`${fc.promises} .then()`);
    if (fc.callbacks > 0) asyncParts.push(`${fc.callbacks} callback`);
    const asyncDetail = asyncParts.length > 0 ? ` (${asyncParts.map(p => p + " files").join(" vs ")})` : "";
    sections.push(`- **Async Style:** ${brief.patterns.asyncStyle}${asyncDetail}`);
  }
  
  // Format error handling with file counts
  if (brief.patterns.errorHandling === "unknown") {
    sections.push(`- **Error Handling:** ${brief.patterns.errorHandling}`);
  } else {
    const errorParts: string[] = [];
    if (fc.tryCatch > 0) errorParts.push(`${fc.tryCatch} try/catch`);
    if (fc.errorCallbacks > 0) errorParts.push(`${fc.errorCallbacks} error-callback`);
    if (fc.resultTypes > 0) errorParts.push(`${fc.resultTypes} result-type`);
    const errorDetail = errorParts.length > 0 ? ` (${errorParts.map(p => p + " files").join(" vs ")})` : "";
    sections.push(`- **Error Handling:** ${brief.patterns.errorHandling}${errorDetail}`);
  }
  
  sections.push(`- **Naming Convention:** ${brief.patterns.namingConvention}`);

  let result = sections.join("\n");

  // Truncate if necessary
  if (result.length > MAX_CODEBASE_BRIEF_CHARS) {
    result = result.slice(0, MAX_CODEBASE_BRIEF_CHARS - 3) + "...";
  }

  return result;
}

// ─── Prior Context Aggregation ──────────────────────────────────────────────────

/** Maximum characters per section in the prior context brief. */
const MAX_SECTION_CHARS = 2000;

/** Maximum total characters for the prior context brief. */
const MAX_PRIOR_CONTEXT_CHARS = 6000;

/**
 * Aggregate prior context from GSD artifacts.
 *
 * Reads DECISIONS.md, REQUIREMENTS.md, KNOWLEDGE.md from the .gsd directory
 * and milestone summaries from each milestone's MILESTONE-SUMMARY.md file.
 *
 * @param basePath - Root directory of the project (contains .gsd/)
 * @returns PriorContextBrief with aggregated context
 */
export async function aggregatePriorContext(basePath: string): Promise<PriorContextBrief> {
  const gsdPath = join(basePath, ".gsd");

  // Load decisions
  const decisionsContent = await loadFile(join(gsdPath, "DECISIONS.md"));
  const decisions = parseDecisions(decisionsContent);

  // Load requirements
  const requirementsContent = await loadFile(join(gsdPath, "REQUIREMENTS.md"));
  const requirements = parseRequirements(requirementsContent);

  // Load knowledge
  const knowledgeContent = await loadFile(join(gsdPath, "KNOWLEDGE.md"));
  const knowledge = truncateSection(knowledgeContent || "", MAX_SECTION_CHARS);

  // Load milestone summaries
  const summaries = await loadMilestoneSummaries(gsdPath);

  return {
    decisions,
    requirements,
    knowledge: knowledge || "No prior knowledge recorded.",
    summaries: summaries || "No prior milestone summaries.",
  };
}

/**
 * Parse decisions from DECISIONS.md content.
 *
 * Groups decisions by scope (e.g., "pattern", "architecture").
 */
function parseDecisions(content: string | null): PriorContextBrief["decisions"] {
  const byScope = new Map<string, DecisionEntry[]>();

  if (!content) {
    return { byScope, totalCount: 0 };
  }

  // Parse table rows: | D001 | M001/S01 | pattern | ... |
  // Skip header rows (start with | # or |---)
  const lines = content.split("\n");
  let totalCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip non-table lines, header, and separator rows
    if (!trimmed.startsWith("|")) continue;
    if (trimmed.startsWith("| #") || trimmed.startsWith("|---") || trimmed.startsWith("| -")) continue;

    // Parse: | D001 | M001/S01 | pattern | Decision | Choice | Rationale | Revisable? | Made By |
    const cells = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (cells.length < 6) continue;

    const id = cells[0]; // D001
    if (!id.match(/^D\d+$/)) continue; // Must be a decision ID

    const scope = cells[2]; // pattern, architecture, etc.
    const decision = cells[3];
    const choice = cells[4];
    const rationale = cells[5];

    const entry: DecisionEntry = { id, scope, decision, choice, rationale };

    if (!byScope.has(scope)) {
      byScope.set(scope, []);
    }
    byScope.get(scope)!.push(entry);
    totalCount++;
  }

  return { byScope, totalCount };
}

/**
 * Parse requirements from REQUIREMENTS.md content.
 *
 * Groups requirements by status (active, validated, deferred).
 */
function parseRequirements(content: string | null): PriorContextBrief["requirements"] {
  const result: PriorContextBrief["requirements"] = {
    active: [],
    validated: [],
    deferred: [],
    totalCount: 0,
  };

  if (!content) {
    return result;
  }

  // Parse requirement entries: ### R101 — Description
  // Look for Status: line to determine status
  const reqBlocks = content.split(/(?=^### R\d+)/m);

  for (const block of reqBlocks) {
    const idMatch = block.match(/^### (R\d+)\s*—\s*(.+)/m);
    if (!idMatch) continue;

    const id = idMatch[1];
    const description = idMatch[2].trim();

    // Extract status from "- Status: active" line
    const statusMatch = block.match(/^-\s*Status:\s*(\w+)/m);
    const statusRaw = statusMatch ? statusMatch[1].toLowerCase() : "active";

    let status: RequirementEntry["status"] = "active";
    if (statusRaw === "validated") status = "validated";
    else if (statusRaw === "deferred") status = "deferred";
    else if (statusRaw === "out-of-scope" || statusRaw === "outofscope") status = "out-of-scope";

    const entry: RequirementEntry = { id, description, status };

    if (status === "active") result.active.push(entry);
    else if (status === "validated") result.validated.push(entry);
    else if (status === "deferred") result.deferred.push(entry);

    result.totalCount++;
  }

  return result;
}

/**
 * Load and combine milestone summaries from each milestone directory.
 *
 * Returns combined content, truncated to MAX_SECTION_CHARS.
 */
async function loadMilestoneSummaries(gsdPath: string): Promise<string> {
  const milestonesPath = join(gsdPath, "milestones");
  const summaries: string[] = [];

  try {
    const entries = readdirSyncNode(milestonesPath, { withFileTypes: true });
    const milestoneIds = entries
      .filter((e) => e.isDirectory() && e.name.match(/^M\d+/))
      .map((e) => e.name)
      .sort(); // Sort by milestone ID

    for (const mid of milestoneIds) {
      const summaryPath = join(milestonesPath, mid, "MILESTONE-SUMMARY.md");
      const content = await loadFile(summaryPath);
      if (content) {
        // Extract the one-liner and first section for brevity
        const oneLiner = extractOneLiner(content);
        summaries.push(`### ${mid}\n${oneLiner}`);
      }
    }
  } catch {
    // Milestones directory doesn't exist or not readable
  }

  if (summaries.length === 0) {
    return "";
  }

  return truncateSection(summaries.join("\n\n"), MAX_SECTION_CHARS);
}

/**
 * Extract the one-liner summary from a MILESTONE-SUMMARY.md.
 *
 * Looks for bold text on a line by itself (e.g., "**Completed X and Y**").
 */
function extractOneLiner(content: string): string {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Look for **bold text** that's the whole line
    if (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4) {
      return trimmed.slice(2, -2);
    }
  }
  // Fallback: return first non-empty, non-heading line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 200);
    }
  }
  return "Summary available";
}

/**
 * Truncate content to maxChars without cutting mid-section.
 *
 * Prefers to cut at section boundaries (## headings) or paragraph breaks.
 */
function truncateSection(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const SECTION_SUFFIX = "\n\n[truncated]"; // 14 chars
  const WORD_SUFFIX = "... [truncated]"; // 15 chars

  // Reserve space for suffix in all slicing operations
  const sectionMaxSlice = maxChars - SECTION_SUFFIX.length;
  const wordMaxSlice = maxChars - WORD_SUFFIX.length;

  // Try to cut at a section boundary
  const truncated = content.slice(0, sectionMaxSlice);
  const lastSection = truncated.lastIndexOf("\n## ");
  if (lastSection > sectionMaxSlice * 0.5) {
    return truncated.slice(0, lastSection).trim() + SECTION_SUFFIX;
  }

  // Try to cut at a paragraph break
  const lastPara = truncated.lastIndexOf("\n\n");
  if (lastPara > sectionMaxSlice * 0.5) {
    return truncated.slice(0, lastPara).trim() + SECTION_SUFFIX;
  }

  // Last resort: cut at word boundary
  const wordTruncated = content.slice(0, wordMaxSlice);
  const lastSpace = wordTruncated.lastIndexOf(" ");
  if (lastSpace > wordMaxSlice * 0.8) {
    return wordTruncated.slice(0, lastSpace).trim() + WORD_SUFFIX;
  }

  return content.slice(0, wordMaxSlice) + WORD_SUFFIX;
}

/**
 * Format a PriorContextBrief as LLM-readable markdown.
 *
 * @param brief - The prior context brief to format
 * @returns Markdown string capped at MAX_PRIOR_CONTEXT_CHARS
 */
export function formatPriorContextBrief(brief: PriorContextBrief): string {
  const sections: string[] = [];

  // Decisions section
  sections.push("## Prior Decisions");
  if (brief.decisions.totalCount === 0) {
    sections.push("No prior decisions recorded.");
  } else {
    sections.push(`${brief.decisions.totalCount} decisions recorded.`);
    sections.push("");

    // Group by scope
    for (const [scope, entries] of brief.decisions.byScope) {
      sections.push(`### ${scope}`);
      for (const entry of entries.slice(0, 5)) { // Limit per scope
        sections.push(`- **${entry.id}:** ${entry.decision} → ${entry.choice}`);
      }
      if (entries.length > 5) {
        sections.push(`- _(${entries.length - 5} more in this scope)_`);
      }
      sections.push("");
    }
  }

  // Requirements section
  sections.push("## Prior Requirements");
  const reqTotal = brief.requirements.totalCount;
  if (reqTotal === 0) {
    sections.push("No prior requirements recorded.");
  } else {
    sections.push(
      `${reqTotal} requirements: ${brief.requirements.active.length} active, ` +
        `${brief.requirements.validated.length} validated, ` +
        `${brief.requirements.deferred.length} deferred.`,
    );
    sections.push("");

    // Show active requirements (most relevant)
    if (brief.requirements.active.length > 0) {
      sections.push("### Active");
      for (const req of brief.requirements.active.slice(0, 10)) {
        sections.push(`- **${req.id}:** ${req.description}`);
      }
      if (brief.requirements.active.length > 10) {
        sections.push(`- _(${brief.requirements.active.length - 10} more active)_`);
      }
      sections.push("");
    }

    // Show validated (recently completed)
    if (brief.requirements.validated.length > 0) {
      sections.push("### Validated");
      for (const req of brief.requirements.validated.slice(0, 5)) {
        sections.push(`- **${req.id}:** ${req.description}`);
      }
      if (brief.requirements.validated.length > 5) {
        sections.push(`- _(${brief.requirements.validated.length - 5} more validated)_`);
      }
      sections.push("");
    }
  }

  // Knowledge section
  sections.push("## Prior Knowledge");
  if (brief.knowledge === "No prior knowledge recorded.") {
    sections.push(brief.knowledge);
  } else {
    sections.push(truncateSection(brief.knowledge, MAX_SECTION_CHARS));
  }
  sections.push("");

  // Summaries section
  sections.push("## Prior Milestone Summaries");
  if (brief.summaries === "No prior milestone summaries.") {
    sections.push(brief.summaries);
  } else {
    sections.push(truncateSection(brief.summaries, MAX_SECTION_CHARS));
  }

  let result = sections.join("\n");

  // Final truncation if total exceeds max
  if (result.length > MAX_PRIOR_CONTEXT_CHARS) {
    result = truncateSection(result, MAX_PRIOR_CONTEXT_CHARS);
  }

  return result;
}

// ─── Ecosystem Research ─────────────────────────────────────────────────────────

/** Maximum characters for the ecosystem brief. */
const MAX_ECOSYSTEM_BRIEF_CHARS = 4000;

/**
 * Research the ecosystem for best practices and known issues.
 *
 * Ecosystem research is now performed during the discussion session (between
 * Layer 1 and Layer 2) using whatever web search tools are available to the
 * LLM — native Anthropic web search for Claude, search-the-web for other
 * providers. The preparation phase focuses on mechanical work only.
 *
 * @param _techStack - Array of technology names from codebase analysis (unused)
 * @param _basePath - Root directory of the project (unused)
 * @returns EcosystemBrief indicating research happens during discussion
 */
export async function researchEcosystem(
  _techStack: string[],
  _basePath: string,
): Promise<EcosystemBrief> {
  return {
    available: false,
    queries: [],
    findings: [],
    skippedReason: "Ecosystem research is performed during the discussion using web search tools, not during preparation.",
  };
}

/**
 * Format an EcosystemBrief as LLM-readable markdown.
 *
 * @param brief - The ecosystem brief to format
 * @returns Markdown string capped at MAX_ECOSYSTEM_BRIEF_CHARS
 */
// ─── Preparation Result ─────────────────────────────────────────────────────────

/**
 * Combined result from the preparation phase.
 * Includes briefs from all three analyzers, plus metadata about the run.
 */
export interface PreparationResult {
  /** Codebase analysis brief. */
  codebase: CodebaseBrief;
  /** Formatted codebase brief as markdown. */
  codebaseBrief: string;
  /** Prior context brief. */
  priorContext: PriorContextBrief;
  /** Formatted prior context brief as markdown. */
  priorContextBrief: string;
  /** Ecosystem research brief. */
  ecosystem: EcosystemBrief;
  /** Formatted ecosystem brief as markdown. */
  ecosystemBrief: string;
  /** Whether preparation was enabled. */
  enabled: boolean;
  /** Whether ecosystem research was performed. */
  ecosystemResearchPerformed: boolean;
  /** Total duration of preparation in milliseconds. */
  durationMs: number;
}

/**
 * Minimal UI context interface for preparation phase.
 * Mirrors the notify method from ExtensionUIContext.
 */
export interface PreparationUIContext {
  notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
}

/**
 * Minimal preferences interface for preparation phase.
 * Only includes the preferences needed by runPreparation.
 */
export interface PreparationPreferences {
  /** Enable the preparation phase. Default: true. */
  discuss_preparation?: boolean;
  /** Enable web research during preparation. Default: true. */
  discuss_web_research?: boolean;
  /** Depth of analysis. Default: "standard". */
  discuss_depth?: "quick" | "standard" | "thorough";
}

/**
 * Run the preparation phase before a discussion session.
 *
 * Orchestrates all three analyzers (codebase, prior context, ecosystem)
 * with TUI progress updates. Returns early if preparation is disabled.
 *
 * @param basePath - Root directory of the project
 * @param ui - UI context for progress notifications (null = silent mode)
 * @param prefs - Preferences controlling preparation behavior
 * @returns PreparationResult with all briefs and metadata
 */
export async function runPreparation(
  basePath: string,
  ui: PreparationUIContext | null,
  prefs: PreparationPreferences,
): Promise<PreparationResult> {
  const startTime = performance.now();

  // Check if preparation is disabled
  const preparationEnabled = prefs.discuss_preparation !== false; // Default: true

  if (!preparationEnabled) {
    // Return minimal result with empty briefs
    const emptyCodebase: CodebaseBrief = {
      techStack: {
        primaryLanguage: undefined,
        detectedFiles: [],
        packageManager: undefined,
        isMonorepo: false,
        hasTests: false,
        hasCI: false,
      },
      moduleStructure: {
        topLevelDirs: [],
        srcSubdirs: [],
        totalFilesSampled: 0,
      },
      patterns: {
        asyncStyle: "unknown",
        errorHandling: "unknown",
        namingConvention: "unknown",
        evidence: {
          asyncStyle: [],
          errorHandling: [],
          namingConvention: [],
        },
        fileCounts: {
          asyncAwait: 0,
          promises: 0,
          callbacks: 0,
          tryCatch: 0,
          errorCallbacks: 0,
          resultTypes: 0,
        },
      },
      sampledFiles: [],
    };

    const emptyPriorContext: PriorContextBrief = {
      decisions: {
        byScope: new Map(),
        totalCount: 0,
      },
      requirements: {
        active: [],
        validated: [],
        deferred: [],
        totalCount: 0,
      },
      knowledge: "No prior knowledge recorded.",
      summaries: "No prior milestone summaries.",
    };

    const emptyEcosystem: EcosystemBrief = {
      available: false,
      queries: [],
      findings: [],
      skippedReason: "Preparation phase disabled.",
    };

    return {
      codebase: emptyCodebase,
      codebaseBrief: "",
      priorContext: emptyPriorContext,
      priorContextBrief: "",
      ecosystem: emptyEcosystem,
      ecosystemBrief: "",
      enabled: false,
      ecosystemResearchPerformed: false,
      durationMs: performance.now() - startTime,
    };
  }

  // --- Phase 1: Analyze codebase ---
  ui?.notify("Analyzing codebase...", "info");
  const codebase = await analyzeCodebase(basePath);
  const codebaseBrief = formatCodebaseBrief(codebase);
  ui?.notify("✓ Analyzed codebase", "success");

  // --- Phase 2: Review prior context ---
  ui?.notify("Reviewing prior context...", "info");
  const priorContext = await aggregatePriorContext(basePath);
  const priorContextBrief = formatPriorContextBrief(priorContext);
  ui?.notify("✓ Reviewed prior context", "success");

  // --- Ecosystem research ---
  // Ecosystem research is now performed during the discussion session (between
  // Layer 1 and Layer 2) using available web search tools. The preparation
  // phase focuses on mechanical work only.
  const ecosystem: EcosystemBrief = await researchEcosystem([], basePath);
  const ecosystemBrief = formatEcosystemBrief(ecosystem);

  return {
    codebase,
    codebaseBrief,
    priorContext,
    priorContextBrief,
    ecosystem,
    ecosystemBrief,
    enabled: true,
    ecosystemResearchPerformed: false,
    durationMs: performance.now() - startTime,
  };
}

/**
 * Format an EcosystemBrief as LLM-readable markdown.
 *
 * Since ecosystem research now always returns unavailable from the preparation
 * phase (research happens during discussion using web search tools), this
 * function returns a simple fixed message.
 *
 * @param _brief - The ecosystem brief (unused, always unavailable from preparation)
 * @returns Markdown string directing the LLM to perform research during discussion
 */
export function formatEcosystemBrief(_brief: EcosystemBrief): string {
  return "## Ecosystem Research\n\nEcosystem research is performed during the discussion using web search tools.";
}
