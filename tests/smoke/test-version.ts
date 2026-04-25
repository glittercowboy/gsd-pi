/**
 * Smoke: `gsd --version` must match the repo's package.json exactly.
 *
 * Defaults to the locally built binary (`dist/loader.js`) — never `npx`
 * — so the test exercises the artifact produced by the current
 * checkout.  The version assertion is anchored so `1.2.3.garbage` is
 * rejected, and compared against `package.json` so a build that mis-stamps
 * the version fails loudly.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const DEFAULT_BINARY = join(REPO_ROOT, "dist", "loader.js");

const binary = process.env.GSD_SMOKE_BINARY || DEFAULT_BINARY;
if (!existsSync(binary)) {
  console.error(
    `Smoke binary not found: ${binary}\n` +
      `Run \`npm run build\` first, or set GSD_SMOKE_BINARY to an existing binary.`,
  );
  process.exit(77);
}

const pkg = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
) as { version: string };

const output = execFileSync("node", [binary, "--version"], {
  encoding: "utf8",
  timeout: 30_000,
}).trim();

// Anchored semver — must match X.Y.Z (with optional pre-release/build),
// then end-of-string or a non-digit separator.  Catches `1.2.3.garbage`
// which the unanchored `/^\d+\.\d+\.\d+/` let through.
const SEMVER_ANCHORED = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
if (!SEMVER_ANCHORED.test(output)) {
  console.error(`Version output is not a valid anchored semver: "${output}"`);
  process.exit(1);
}

// When running against the locally built binary, require an exact match
// with the repo's package.json.  External binaries (smoke against an
// installed tarball in a post-publish pipeline) may differ, so we only
// compare when the binary is our local dist/loader.js.
if (binary === DEFAULT_BINARY && output !== pkg.version) {
  console.error(
    `Version mismatch: binary reports "${output}" but package.json has "${pkg.version}"`,
  );
  process.exit(1);
}
