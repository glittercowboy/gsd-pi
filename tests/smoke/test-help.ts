/**
 * Smoke: `gsd --help` must print usage.
 *
 * Defaults to the locally built binary (`dist/loader.js`) so the test
 * exercises the artifact produced by the current checkout, not whatever
 * is currently published on npm.  Setting `GSD_SMOKE_BINARY` overrides
 * the target (used by post-publish pipelines that install the tarball
 * into a scratch directory).
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BINARY = join(__dirname, "..", "..", "dist", "loader.js");

const binary = process.env.GSD_SMOKE_BINARY || DEFAULT_BINARY;
if (!existsSync(binary)) {
  console.error(
    `Smoke binary not found: ${binary}\n` +
      `Run \`npm run build\` first, or set GSD_SMOKE_BINARY to an existing binary.`,
  );
  // POSIX skip convention — harness recognises exit 77 as "skipped".
  process.exit(77);
}

const output = execFileSync("node", [binary, "--help"], {
  encoding: "utf8",
  timeout: 30_000,
});

const lower = output.toLowerCase();

if (!lower.includes("gsd")) {
  console.error(`Help output does not contain "gsd": "${output}"`);
  process.exit(1);
}

if (!lower.includes("usage")) {
  console.error(`Help output does not contain "usage": "${output}"`);
  process.exit(1);
}
