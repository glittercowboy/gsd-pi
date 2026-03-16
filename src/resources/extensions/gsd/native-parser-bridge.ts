// Native GSD Parser Bridge
// Provides drop-in replacements for the JS parsing functions in files.ts,
// backed by the Rust native parser for better performance on large projects.
//
// Functions fall back to JS implementations if the native module is unavailable.

import type { Roadmap, BoundaryMapEntry, RoadmapSliceEntry, RiskLevel } from './types.js';

// Issue #453: auto-mode post-turn reconciliation must stay on the stable JS path
// unless the native parser is explicitly requested.
const NATIVE_GSD_PARSER_ENABLED = process.env.GSD_ENABLE_NATIVE_GSD_PARSER === "1";

let nativeModule: {
  parseFrontmatter: (content: string) => { metadata: string; body: string };
  extractSection: (content: string, heading: string, level?: number) => { content: string; found: boolean };
  extractAllSections: (content: string, level?: number) => string;
  batchParseGsdFiles: (directory: string) => { files: Array<{ path: string; metadata: string; body: string; sections: string; rawContent: string }>; count: number };
  parseRoadmapFile: (content: string) => {
    title: string;
    vision: string;
    successCriteria: string[];
    slices: Array<{ id: string; title: string; risk: string; depends: string[]; done: boolean; demo: string }>;
    boundaryMap: Array<{ fromSlice: string; toSlice: string; produces: string; consumes: string }>;
  };
  scanGsdTree: (directory: string) => Array<{ path: string; name: string; isDir: boolean }>;
  parseJsonlTail: (filePath: string, maxBytes?: number, maxEntries?: number) => { entries: string; count: number; truncated: boolean };
  parsePlanFile: (content: string) => NativePlanResult;
  parseSummaryFile: (content: string) => NativeSummaryResult;
} | null = null;

let loadAttempted = false;

function loadNative(): typeof nativeModule {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;
  if (!NATIVE_GSD_PARSER_ENABLED) return nativeModule;

  try {
    // Dynamic import to avoid hard dependency - fails gracefully if native module not built
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@gsd/native');
    if (mod.parseFrontmatter && mod.extractSection && mod.batchParseGsdFiles) {
      nativeModule = mod;
    }
  } catch {
    // Native module not available - all functions fall back to JS
  }

  return nativeModule;
}

/**
 * Native-backed frontmatter splitting.
 * Returns [parsedMetadata, body] where parsedMetadata is the parsed key-value map.
 */
export function nativeSplitFrontmatter(content: string): { metadata: Record<string, unknown>; body: string } | null {
  const native = loadNative();
  if (!native) return null;

  const result = native.parseFrontmatter(content);
  return {
    metadata: JSON.parse(result.metadata) as Record<string, unknown>,
    body: result.body,
  };
}

/** Sentinel value indicating the native module is not available. */
const NATIVE_UNAVAILABLE = Symbol('native-unavailable');

/**
 * Native-backed section extraction.
 * Returns section content, null if not found, or NATIVE_UNAVAILABLE symbol
 * if the native module isn't loaded.
 */
export function nativeExtractSection(content: string, heading: string, level: number = 2): string | null | typeof NATIVE_UNAVAILABLE {
  const native = loadNative();
  if (!native) return NATIVE_UNAVAILABLE;

  const result = native.extractSection(content, heading, level);
  return result.found ? result.content : null;
}

export { NATIVE_UNAVAILABLE };

/**
 * Native-backed roadmap parsing.
 * Returns a Roadmap object or null if native module unavailable.
 */
export function nativeParseRoadmap(content: string): Roadmap | null {
  const native = loadNative();
  if (!native) return null;

  const result = native.parseRoadmapFile(content);
  return {
    title: result.title,
    vision: result.vision,
    successCriteria: result.successCriteria,
    slices: result.slices.map(s => ({
      id: s.id,
      title: s.title,
      risk: s.risk as RiskLevel,
      depends: s.depends,
      done: s.done,
      demo: s.demo,
    })),
    boundaryMap: result.boundaryMap.map(b => ({
      fromSlice: b.fromSlice,
      toSlice: b.toSlice,
      produces: b.produces,
      consumes: b.consumes,
    })),
  };
}

export interface BatchParsedFile {
  path: string;
  metadata: Record<string, unknown>;
  body: string;
  sections: Record<string, string>;
  rawContent: string;
}

/**
 * Batch-parse all .md files in a .gsd/ directory tree using the native parser.
 * Returns null if native module unavailable.
 */
export function nativeBatchParseGsdFiles(directory: string): BatchParsedFile[] | null {
  const native = loadNative();
  if (!native) return null;

  const result = native.batchParseGsdFiles(directory);
  return result.files.map(f => ({
    path: f.path,
    metadata: JSON.parse(f.metadata) as Record<string, unknown>,
    body: f.body,
    sections: JSON.parse(f.sections) as Record<string, string>,
    rawContent: f.rawContent,
  }));
}

/**
 * Check if the native parser is available.
 */
export function isNativeParserAvailable(): boolean {
  return loadNative() !== null;
}

// ─── Tree Scanning ────────────────────────────────────────────────────────────

export interface GsdTreeEntry {
  path: string;
  name: string;
  isDir: boolean;
}

/**
 * Native-backed directory tree scan of a .gsd/ directory.
 * Returns a flat list of all entries, or null if native module unavailable.
 */
export function nativeScanGsdTree(directory: string): GsdTreeEntry[] | null {
  const native = loadNative();
  if (!native) return null;
  return native.scanGsdTree(directory);
}

// ─── JSONL Parsing ────────────────────────────────────────────────────────────

export interface JsonlParseResult {
  entries: unknown[];
  count: number;
  truncated: boolean;
}

/**
 * Native-backed JSONL tail parser. Reads the last `maxBytes` of a JSONL file
 * and parses up to `maxEntries` entries with constant memory usage.
 * Returns null if native module unavailable.
 */
export function nativeParseJsonlTail(filePath: string, maxBytes?: number, maxEntries?: number): JsonlParseResult | null {
  const native = loadNative();
  if (!native) return null;
  const result = native.parseJsonlTail(filePath, maxBytes, maxEntries);
  return {
    entries: JSON.parse(result.entries),
    count: result.count,
    truncated: result.truncated,
  };
}

// ─── Plan & Summary File Parsing ──────────────────────────────────────────────

export interface NativeTaskEntry {
  id: string;
  title: string;
  description: string;
  done: boolean;
  estimate: string;
  files: string[];
  verify: string;
}

export interface NativePlanResult {
  id: string;
  title: string;
  goal: string;
  demo: string;
  mustHaves: string[];
  tasks: NativeTaskEntry[];
  filesLikelyTouched: string[];
}

/**
 * Native-backed plan file parser.
 * Returns structured plan data or null if native module unavailable.
 */
export function nativeParsePlanFile(content: string): NativePlanResult | null {
  const native = loadNative();
  if (!native) return null;
  return native.parsePlanFile(content) as NativePlanResult;
}

export interface NativeSummaryRequires {
  slice: string;
  provides: string;
}

export interface NativeSummaryFrontmatter {
  id: string;
  parent: string;
  milestone: string;
  provides: string[];
  requires: NativeSummaryRequires[];
  affects: string[];
  keyFiles: string[];
  keyDecisions: string[];
  patternsEstablished: string[];
  drillDownPaths: string[];
  observabilitySurfaces: string[];
  duration: string;
  verificationResult: string;
  completedAt: string;
  blockerDiscovered: boolean;
}

export interface NativeFileModified {
  path: string;
  description: string;
}

export interface NativeSummaryResult {
  frontmatter: NativeSummaryFrontmatter;
  title: string;
  oneLiner: string;
  whatHappened: string;
  deviations: string;
  filesModified: NativeFileModified[];
}

/**
 * Native-backed summary file parser.
 * Returns structured summary data or null if native module unavailable.
 */
export function nativeParseSummaryFile(content: string): NativeSummaryResult | null {
  const native = loadNative();
  if (!native) return null;
  return native.parseSummaryFile(content) as NativeSummaryResult;
}
