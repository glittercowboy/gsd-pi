/**
 * Native addon loader.
 *
 * Locates and loads the compiled Rust N-API addon (`.node` file).
 * Resolution order:
 *   1. @gsd-build/engine-{platform} npm optional dependency (production install)
 *   2. native/addon/gsd_engine.{platform}.node (local release build)
 *   3. native/addon/gsd_engine.dev.node (local debug build)
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const addonDir = path.resolve(__dirname, "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;

/** Map Node.js platform/arch to the npm package suffix */
const platformPackageMap: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "win32-x64": "win32-x64-msvc",
};

function loadNative(): Record<string, unknown> {
  const errors: string[] = [];

  // 1. Try the platform-specific npm optional dependency
  const packageSuffix = platformPackageMap[platformTag];
  if (packageSuffix) {
    try {
      return require(`@gsd-build/engine-${packageSuffix}`) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`@gsd-build/engine-${packageSuffix}: ${message}`);
    }
  }

  // 2. Try local release build (native/addon/gsd_engine.{platform}.node)
  const releasePath = path.join(addonDir, `gsd_engine.${platformTag}.node`);
  try {
    return require(releasePath) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${releasePath}: ${message}`);
  }

  // 3. Try local dev build (native/addon/gsd_engine.dev.node)
  const devPath = path.join(addonDir, "gsd_engine.dev.node");
  try {
    return require(devPath) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${devPath}: ${message}`);
  }

  const details = errors.map((e) => `  - ${e}`).join("\n");
  const supportedPlatforms = Object.keys(platformPackageMap);
  throw new Error(
    `Failed to load gsd_engine native addon for ${platformTag}.\n\n` +
      `Tried:\n${details}\n\n` +
      `Supported platforms: ${supportedPlatforms.join(", ")}\n` +
      `If your platform is listed, try reinstalling: npm i -g gsd-pi\n` +
      `Otherwise, please open an issue: https://github.com/gsd-build/gsd-2/issues`,
  );
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
  parseJson: (text: string) => unknown;
  parsePartialJson: (text: string) => unknown;
  parseStreamingJson: (text: string) => unknown;
};
