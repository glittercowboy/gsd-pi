#!/usr/bin/env node
/**
 * Parse conventional commits since the last stable tag.
 * Outputs JSON: { bumpType, newVersion, changelogEntry, releaseNotes }
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. Find last stable tag (skip -next, -dev prereleases)
// ---------------------------------------------------------------------------
const allTags = execSync("git tag --sort=-v:refname", { cwd: root, encoding: "utf-8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const stableTag = allTags.find((t) => /^v\d+\.\d+\.\d+$/.test(t));
if (!stableTag) {
  console.error("No stable vX.Y.Z tag found");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Collect commits since that tag
// ---------------------------------------------------------------------------
const range = `${stableTag}..HEAD`;
const rawLog = execSync(
  `git log ${range} --pretty=format:"%H %s" --no-merges`,
  { cwd: root, encoding: "utf-8" }
).trim();

if (!rawLog) {
  console.error(`No commits since ${stableTag}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Parse conventional commits
// ---------------------------------------------------------------------------
const CONVENTIONAL_RE = /^(?<type>\w+)(?:\((?<scope>[^)]*)\))?!?:\s*(?<desc>.+)$/;
const DISPLAY_FILTER = new Set(["ci", "docs", "test", "tests", "style"]);

const groups = { Added: [], Fixed: [], Changed: [], Removed: [] };
const TYPE_MAP = {
  feat: "Added",
  fix: "Fixed",
  refactor: "Changed",
  perf: "Changed",
  chore: "Changed",
  revert: "Removed",
};

let hasBreaking = false;
let hasFeat = false;
let userFacingCount = 0;

for (const line of rawLog.split("\n")) {
  const spaceIdx = line.indexOf(" ");
  const subject = line.slice(spaceIdx + 1);

  if (subject.includes("BREAKING CHANGE") || subject.includes("!:")) {
    hasBreaking = true;
  }

  const match = CONVENTIONAL_RE.exec(subject);
  if (!match) continue;

  const { type, scope, desc } = match.groups;

  if (type === "feat") hasFeat = true;

  // Skip display-only types but still count them for bump logic
  if (DISPLAY_FILTER.has(type)) continue;

  const group = TYPE_MAP[type];
  if (!group) continue;

  userFacingCount++;
  const scopePrefix = scope ? `**${scope}**: ` : "";
  groups[group].push(`- ${scopePrefix}${desc}`);
}

if (userFacingCount === 0) {
  console.error(`No user-facing commits since ${stableTag}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Determine bump type and new version
// ---------------------------------------------------------------------------
const bumpType = hasBreaking ? "major" : hasFeat ? "minor" : "patch";

// Use the higher of (latest stable tag, package.json version) as the baseline.
// Tag is the authoritative record of what's already published; package.json can
// be clobbered by rebases. Taking the max prevents version regressions if the
// source version is accidentally reverted.
const tagVersion = stableTag.replace(/^v/, "");
const currentPkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const pkgVersion = currentPkg.version.replace(/-.*$/, "");
const cmp = (a, b) => {
  const [aMaj, aMin, aPat] = a.split(".").map(Number);
  const [bMaj, bMin, bPat] = b.split(".").map(Number);
  return aMaj - bMaj || aMin - bMin || aPat - bPat;
};
const baseline = cmp(pkgVersion, tagVersion) >= 0 ? pkgVersion : tagVersion;
if (baseline !== pkgVersion) {
  console.error(`[generate-changelog] package.json (${pkgVersion}) is behind latest tag (${tagVersion}); using tag as baseline.`);
}
const [major, minor, patch] = baseline.split(".").map(Number);

let newVersion;
switch (bumpType) {
  case "major":
    newVersion = `${major + 1}.0.0`;
    break;
  case "minor":
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case "patch":
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
}

// ---------------------------------------------------------------------------
// 5. Build changelog entry
// ---------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const sections = [];

for (const [heading, items] of Object.entries(groups)) {
  if (items.length > 0) {
    sections.push(`### ${heading}\n${items.join("\n")}`);
  }
}

const releaseNotes = sections.join("\n\n");
const changelogEntry = `## [${newVersion}] - ${today}\n\n${releaseNotes}`;

// ---------------------------------------------------------------------------
// 6. Output JSON
// ---------------------------------------------------------------------------
const output = JSON.stringify(
  { bumpType, newVersion, changelogEntry, releaseNotes },
  null,
  2
);
process.stdout.write(output);
