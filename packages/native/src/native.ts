/**
 * Native addon loader.
 *
 * Locates and loads the compiled Rust N-API addon (`.node` file).
 * Resolution order:
 *   1. @gsd-build/engine-{platform} npm optional dependency (production install)
 *   2. native/addon/gsd_engine.{platform}.node (local release build)
 *   3. native/addon/gsd_engine.dev.node (local debug build)
 */

import { familySync, GLIBC, MUSL } from "detect-libc";
import * as path from "node:path";

// __dirname and require are available in both execution contexts:
//   - CJS (production build via tsc): provided natively by Node
//   - ESM (CI test loader): injected by the dist-redirect.mjs preamble
const _dirname = __dirname;
const _require = require;

const addonDir = path.resolve(_dirname, "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;
type LibcFamily = typeof GLIBC | typeof MUSL | null;

/** Map Node.js platform/arch to the npm package suffix candidates */
const platformPackageMap: Record<string, string[]> = {
  "darwin-arm64": ["darwin-arm64"],
  "darwin-x64": ["darwin-x64"],
  "win32-x64": ["win32-x64-msvc"],
};
const supportedPlatforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64-gnu",
  "linux-x64-musl",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "win32-x64-msvc",
];

export let nativeLoadedSuccessfully = false;

function detectLibcFamily(): LibcFamily {
  if (process.platform !== "linux") return null;
  try {
    const family = familySync();
    if (family === GLIBC || family === MUSL) return family;
  } catch {
    // ignore detection errors and fall back to the default candidate order
  }
  return null;
}

export function resolveNativeRuntimeTag(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  libcFamily: LibcFamily = platform === "linux" ? detectLibcFamily() : null,
): string {
  if (platform !== "linux") return `${platform}-${arch}`;
  if (libcFamily === MUSL) return `${platform}-${arch}-musl`;
  if (libcFamily === GLIBC) return `${platform}-${arch}-gnu`;
  return `${platform}-${arch}`;
}

export function resolveNativePackageCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  libcFamily: LibcFamily = platform === "linux" ? detectLibcFamily() : null,
): string[] {
  if (platform === "linux") {
    if (arch === "x64") {
      return libcFamily === MUSL
        ? ["linux-x64-musl", "linux-x64-gnu"]
        : ["linux-x64-gnu", "linux-x64-musl"];
    }
    if (arch === "arm64") {
      return libcFamily === MUSL
        ? ["linux-arm64-musl", "linux-arm64-gnu"]
        : ["linux-arm64-gnu", "linux-arm64-musl"];
    }
    return [];
  }
  return platformPackageMap[`${platform}-${arch}`] ?? [];
}

function tryRequire(ref: string, errors: string[]): Record<string, unknown> | null {
  try {
    const loaded = _require(ref) as Record<string, unknown>;
    nativeLoadedSuccessfully = true;
    return loaded;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${ref}: ${message}`);
    return null;
  }
}

function loadNative(): Record<string, unknown> {
  const errors: string[] = [];
  const runtimeTag = resolveNativeRuntimeTag();

  if (process.env.GSD_FORCE_NO_NATIVE === "1") {
    errors.push("native loading disabled via GSD_FORCE_NO_NATIVE=1");
  } else {
    // 1. Try the platform-specific npm optional dependencies
    for (const packageSuffix of resolveNativePackageCandidates()) {
      const loaded = tryRequire(`@gsd-build/engine-${packageSuffix}`, errors);
      if (loaded) return loaded;
    }

    // 2. Try local release build (native/addon/gsd_engine.{platform}.node)
    const releasePath = path.join(addonDir, `gsd_engine.${platformTag}.node`);
    const releaseLoaded = tryRequire(releasePath, errors);
    if (releaseLoaded) return releaseLoaded;

    // 3. Try local dev build (native/addon/gsd_engine.dev.node)
    const devPath = path.join(addonDir, "gsd_engine.dev.node");
    const devLoaded = tryRequire(devPath, errors);
    if (devLoaded) return devLoaded;
  }

  // Graceful fallback: on unsupported platforms (e.g., win32-arm64), return a
  // proxy that throws on individual function calls rather than crashing the
  // entire import chain at startup (#1223). Consumers with JS fallbacks
  // (parseRoadmap, parsePlan, fuzzyFind, etc.) catch these and degrade gracefully.
  process.stderr.write(
    `[gsd] Native addon not available for ${runtimeTag}. Falling back to JS implementations (slower).\n` +
      `  Supported native platforms: ${supportedPlatforms.join(", ")}\n`,
  );
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return (..._args: unknown[]) => {
        throw new Error(`Native function '${String(prop)}' is not available on ${runtimeTag}`);
      };
    },
  });
}

export const native = loadNative() as {
  search: (content: Buffer | Uint8Array, options: unknown) => unknown;
  grep: (options: unknown) => unknown;
  killTree: (pid: number, signal: number) => number;
  listDescendants: (pid: number) => number[];
  processGroupId: (pid: number) => number | null;
  killProcessGroup: (pgid: number, signal: number) => boolean;
  glob: (
    options: unknown,
    onMatch?: ((match: unknown) => void) | undefined | null,
  ) => Promise<unknown>;
  invalidateFsScanCache: (path?: string) => void;
  highlightCode: (code: string, lang: string | null, colors: unknown) => unknown;
  supportsLanguage: (lang: string) => unknown;
  getSupportedLanguages: () => unknown;
  copyToClipboard: (text: string) => void;
  readTextFromClipboard: () => string | null;
  readImageFromClipboard: () => Promise<unknown>;
  astGrep: (options: unknown) => unknown;
  astEdit: (options: unknown) => unknown;
  htmlToMarkdown: (html: string, options: unknown) => unknown;
  wrapTextWithAnsi: (text: string, width: number, tabWidth?: number) => string[];
  truncateToWidth: (
    text: string,
    maxWidth: number,
    ellipsisKind: number,
    pad: boolean,
    tabWidth?: number,
  ) => string;
  sliceWithWidth: (
    line: string,
    startCol: number,
    length: number,
    strict: boolean,
    tabWidth?: number,
  ) => unknown;
  extractSegments: (
    line: string,
    beforeEnd: number,
    afterStart: number,
    afterLen: number,
    strictAfter: boolean,
    tabWidth?: number,
  ) => unknown;
  sanitizeText: (text: string) => string;
  visibleWidth: (text: string, tabWidth?: number) => number;
  fuzzyFind: (options: unknown) => unknown;
  normalizeForFuzzyMatch: (text: string) => string;
  fuzzyFindText: (content: string, oldText: string) => unknown;
  generateDiff: (oldContent: string, newContent: string, contextLines?: number) => unknown;
  NativeImage: unknown;
  ttsrCompileRules: (rules: unknown[]) => number;
  ttsrCheckBuffer: (handle: number, buffer: string) => string[];
  ttsrFreeRules: (handle: number) => void;
  processStreamChunk: (chunk: Buffer, state?: unknown) => unknown;
  stripAnsiNative: (text: string) => string;
  sanitizeBinaryOutputNative: (text: string) => string;
  parseFrontmatter: (content: string) => unknown;
  extractSection: (content: string, heading: string, level?: number) => unknown;
  extractAllSections: (content: string, level?: number) => string;
  batchParseGsdFiles: (directory: string) => unknown;
  parseRoadmapFile: (content: string) => unknown;
  truncateTail: (text: string, maxBytes: number) => unknown;
  truncateHead: (text: string, maxBytes: number) => unknown;
  truncateOutput: (text: string, maxBytes: number, mode?: string) => unknown;
  parseJson: (text: string) => unknown;
  parsePartialJson: (text: string) => unknown;
  parseStreamingJson: (text: string) => unknown;
  xxHash32: (input: string, seed: number) => number;
};
