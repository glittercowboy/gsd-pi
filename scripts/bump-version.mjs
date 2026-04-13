#!/usr/bin/env node
/**
 * Bump version in package.json, then sync platform packages and pkg/package.json.
 * Usage: node scripts/bump-version.mjs <new-version>
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error("Usage: node scripts/bump-version.mjs <X.Y.Z>");
  process.exit(1);
}

// 1. Update root package.json
const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const oldVersion = pkg.version;
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`[bump-version] package.json: ${oldVersion} → ${newVersion}`);

// 2. Update packages/pi-coding-agent/package.json (sync-pkg-version reads from here)
const piPkgPath = resolve(root, "packages", "pi-coding-agent", "package.json");
const piPkg = JSON.parse(readFileSync(piPkgPath, "utf-8"));
piPkg.version = newVersion;
writeFileSync(piPkgPath, JSON.stringify(piPkg, null, 2) + "\n");
console.log(`[bump-version] pi-coding-agent: ${oldVersion} → ${newVersion}`);

// 3. Sync platform package versions (reads from root package.json)
execSync("node native/scripts/sync-platform-versions.cjs", { cwd: root, stdio: "inherit" });

// 4. Sync pkg/package.json (reads from pi-coding-agent)
execSync("node scripts/sync-pkg-version.cjs", { cwd: root, stdio: "inherit" });

// 5. Regenerate package-lock.json to match the new version.
//    --package-lock-only updates the lockfile in-place without touching node_modules.
execSync("npm install --package-lock-only", { cwd: root, stdio: "inherit" });
console.log(`[bump-version] package-lock.json regenerated at ${newVersion}`);
