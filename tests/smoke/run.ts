/**
 * Smoke test runner.
 *
 * Each `test-*.ts` child may exit 0 (pass), 77 (POSIX skip convention),
 * or any other non-zero code (fail).  We key off exit status rather than
 * substring-matching stdout so a test that crashes after printing
 * "SKIPPED" is correctly reported as a failure.
 */
import { readdirSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const testFiles = readdirSync(__dirname)
  .filter((f) => f.startsWith("test-") && f.endsWith(".ts"))
  .sort();

if (testFiles.length === 0) {
  console.error("No smoke test files found");
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
      timeout: 30_000,
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
  `\nSmoke tests: ${passed} passed, ${failed} failed, ${skipped} skipped`,
);
if (failed > 0) process.exit(1);
