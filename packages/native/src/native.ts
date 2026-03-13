/**
 * Native addon loader.
 *
 * Locates and loads the compiled Rust N-API addon (`.node` file).
 * Tries platform-tagged release builds first, then falls back to dev builds.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const addonDir = path.resolve(__dirname, "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;

const candidates = [
  path.join(addonDir, `gsd_engine.${platformTag}.node`),
  path.join(addonDir, "gsd_engine.dev.node"),
];

function loadNative(): Record<string, unknown> {
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      return require(candidate) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${candidate}: ${message}`);
    }
  }

  const details = errors.map((e) => `  - ${e}`).join("\n");
  throw new Error(
    `Failed to load gsd_engine native addon for ${platformTag}.\n\n` +
      `Tried:\n${details}\n\n` +
      `Build with: npm run build:native -w @gsd/native`,
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
};
