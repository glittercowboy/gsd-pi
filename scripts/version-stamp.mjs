import { readFileSync, writeFileSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const shortSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const channel = process.env.VERSION_CHANNEL || "dev";
const devVersion = `${pkg.version}-${channel}.${shortSha}`;

pkg.version = devVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Stamped version: ${devVersion}`);

// Regenerate package-lock.json to reflect the stamped dev version.
// --package-lock-only updates the lockfile in-place without touching node_modules.
execSync("npm install --package-lock-only --ignore-scripts", { cwd: root, stdio: "inherit" });
console.log(`[version-stamp] package-lock.json regenerated at ${devVersion}`);
