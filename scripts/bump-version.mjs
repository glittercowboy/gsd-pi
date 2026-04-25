#!/usr/bin/env node
/**
 * Bump version in package.json, then sync platform packages and pkg/package.json.
 * Usage: node scripts/bump-version.mjs <new-version>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
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

// 2. Update all non-private workspace packages under packages/
//    These share the root version to keep the repo's source of truth coherent
//    with what ships. Private packages (studio, web) are skipped — they're not
//    published and have their own lifecycle.
const workspacePackages = [
  "daemon",
  "mcp-server",
  "native",
  "pi-agent-core",
  "pi-ai",
  "pi-coding-agent",
  "pi-tui",
  "rpc-client",
];
for (const name of workspacePackages) {
  const wsPath = resolve(root, "packages", name, "package.json");
  if (!existsSync(wsPath)) continue;
  const ws = JSON.parse(readFileSync(wsPath, "utf-8"));
  const wsOld = ws.version;
  ws.version = newVersion;
  // Bump any internal @gsd-build/* or @gsd/* dep references to match.
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (!ws[field]) continue;
    for (const dep of Object.keys(ws[field])) {
      if (workspacePackages.some((n) => dep === `@gsd-build/${n}` || dep === `@gsd/${n}`)) {
        ws[field][dep] = `^${newVersion}`;
      }
    }
  }
  writeFileSync(wsPath, JSON.stringify(ws, null, 2) + "\n");
  console.log(`[bump-version] ${name}: ${wsOld} → ${newVersion}`);
}

// 3. Sync platform package versions (reads from root package.json)
execSync("node native/scripts/sync-platform-versions.cjs", { cwd: root, stdio: "inherit" });

// 4. Sync pkg/package.json (reads from pi-coding-agent)
execSync("node scripts/sync-pkg-version.cjs", { cwd: root, stdio: "inherit" });

// 5. Regenerate root package-lock.json to match the new version.
//    --package-lock-only updates the lockfile in-place without touching node_modules.
execSync("npm install --package-lock-only --ignore-scripts", { cwd: root, stdio: "inherit" });
console.log(`[bump-version] package-lock.json regenerated at ${newVersion}`);

// 6. Regenerate web/package-lock.json if the web app is present.
const webDir = resolve(root, "web");
if (existsSync(webDir)) {
  execSync("npm install --package-lock-only --ignore-scripts", { cwd: webDir, stdio: "inherit" });
  console.log(`[bump-version] web/package-lock.json regenerated`);
}
