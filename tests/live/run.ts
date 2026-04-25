/**
 * Live-test runner.
 *
 * Children exit 0 (pass), 77 (POSIX skip — e.g., no API key), or other
 * non-zero (fail).  We key off exit status instead of substring-matching
 * stderr so a test that crashes after printing "SKIPPED" is correctly
 * reported as a failure, not silently ignored.
 */
import { readdirSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.env.GSD_LIVE_TESTS !== "1") {
  console.log("Skipping live tests (set GSD_LIVE_TESTS=1 to enable)");
  process.exit(0);
}

const testFiles = readdirSync(__dirname)
  .filter((f) => f.startsWith("test-") && f.endsWith(".ts"))
  .sort();

if (testFiles.length === 0) {
  console.error("No live test files found");
  process.exit(1);
}

let passed = 0;
let failed = 0;
let skipped = 0;

for (const file of testFiles) {
  const filePath = join(__dirname, file);
  const label = file.replace(/\.ts$/, "");
  try {
    execFileSync("node", ["--experimental-strip-types", filePath], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    });
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err: any) {
    if (err.status === 77) {
      console.log(`  SKIP  ${label}`);
      if (err.stdout) console.log(err.stdout.toString().trimEnd());
      skipped++;
      continue;
    }
    console.error(`  FAIL  ${label}`);
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    failed++;
  }
}

console.log(
  `\nLive tests: ${passed} passed, ${failed} failed, ${skipped} skipped`,
);
if (failed > 0) process.exit(1);
