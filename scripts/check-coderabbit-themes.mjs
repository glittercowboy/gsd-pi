#!/usr/bin/env node

/**
 * GSD-2 — Lint for three recurring CodeRabbit defect classes.
 * See issue #4931 for the motivation.
 *
 * Checks:
 *   1. sqlite-null-guard  — `!== null` / `=== null` applied to a variable
 *                            that was assigned from `.get(…)` on a better-sqlite3
 *                            Statement. `Statement#get()` returns `undefined`,
 *                            not `null`, so the guard is a logic bug.
 *   2. once-after-trigger — `X.once('event', …)` appearing after
 *                            `X.kill(…)` / `X.send(…)` / `X.write(…)` /
 *                            `X.emit(…)` / `X.end(…)` in the same block. The
 *                            listener can miss a synchronous or very-fast
 *                            event.
 *   3. mjs-ts-import      — a `.mjs` file that imports a `.ts` module. Every
 *                            invocation of that mjs must include
 *                            `--experimental-strip-types` or an equivalent
 *                            loader, otherwise Node throws
 *                            ERR_UNKNOWN_FILE_EXTENSION.
 *
 * Escape hatch: add `// allow-coderabbit-theme: <reason>` on the offending
 * line or the line immediately above it. The reason becomes part of the diff
 * and is visible at review.
 *
 * Usage:
 *   check-coderabbit-themes.mjs                          # CI mode (diff vs base)
 *   check-coderabbit-themes.mjs --files <path> ...       # explicit files
 *   check-coderabbit-themes.mjs --all                    # full repo
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOW_MARKER = "allow-coderabbit-theme:";

// ─── Input discovery ───────────────────────────────────────────────────────

function gitDiffNames(base) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=AM", base, "HEAD"],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

function getChangedFiles() {
  const base =
    process.env.PR_BASE_SHA ||
    process.env.PUSH_BEFORE_SHA ||
    "origin/main";
  const primary = gitDiffNames(base);
  if (primary !== null) return primary;
  const fallback = gitDiffNames("HEAD~1");
  return fallback ?? [];
}

const WALK_EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-test",
  "__fixtures__",
]);

// Files whose source contains intentional bad examples inside template
// literals (e.g. the checker's own test file). Skip these for the --all
// sweep; diff mode will still scan them if an author modifies them.
const SWEEP_SKIP_BASENAMES = new Set([
  "check-coderabbit-themes.test.mjs",
]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (WALK_EXCLUDE.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(relative(REPO_ROOT, full));
  }
  return out;
}

function parseArgs(argv) {
  const args = { mode: "diff", files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--all") args.mode = "all";
    else if (argv[i] === "--files") {
      args.mode = "files";
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args.files.push(argv[++i]);
      }
    }
  }
  return args;
}

function hasAllowMarker(lines, lineIdx) {
  const self = lines[lineIdx] || "";
  if (self.includes(ALLOW_MARKER)) return true;
  const prev = lineIdx > 0 ? lines[lineIdx - 1] : "";
  if (prev.includes(ALLOW_MARKER)) return true;
  return false;
}

// ─── Check 1: sqlite-null-guard ────────────────────────────────────────────
//
// Strategy: find variable names assigned from `.get(…)` in the file. For
// each such variable, scan subsequent lines for `<var> !== null` or
// `<var> === null` and flag them.

const SQLITE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

function checkSqliteNullGuard(filePath, source) {
  if (!SQLITE_EXT.has(extname(filePath))) return [];
  // Scope: only files that import better-sqlite3. JS Map#get, URLSearchParams
  // #get, and Headers#get all return undefined/null and would false-flag
  // without this guard.
  const usesBetterSqlite =
    /\bfrom\s+['"]better-sqlite3['"]/.test(source) ||
    /\brequire\s*\(\s*['"]better-sqlite3['"]\s*\)/.test(source);
  if (!usesBetterSqlite) return [];

  const lines = source.split("\n");
  const stmtVars = new Map(); // name -> line index of assignment
  const offenders = [];

  // Capture patterns:
  //   const <v> = <expr>.get(...)
  //   const <v> = <expr>.pluck().get(...)
  //   let/var/const <v> = stmt.get(...)
  const assignRe = /(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*[^;]*?\.get\s*\(/;
  lines.forEach((line, i) => {
    const m = line.match(assignRe);
    if (m) stmtVars.set(m[1], i);
  });

  if (stmtVars.size === 0) return [];

  // Scan every line for `<var> !== null` / `=== null`.
  // We scan regardless of position to catch usage inside helper functions.
  const guardRe = (name) =>
    new RegExp(`\\b${name}\\b\\s*(?:!==|===)\\s*null\\b`);

  lines.forEach((line, i) => {
    for (const [name] of stmtVars) {
      if (guardRe(name).test(line)) {
        if (hasAllowMarker(lines, i)) continue;
        offenders.push({
          file: filePath,
          line: i + 1,
          rule: "sqlite-null-guard",
          message: `${name} was assigned from .get() (better-sqlite3 Statement#get returns undefined, not null). Use \`!= null\` / \`== null\` or \`=== undefined\`.`,
          snippet: line.trim(),
        });
      }
    }
  });

  return offenders;
}

// ─── Check 2: once-after-trigger ───────────────────────────────────────────
//
// Strategy: scan each file for `<X>.once('event', …)`. If a preceding line
// (within the same contiguous non-blank block, up to N lines back) contains
// `<X>.kill(…)` / `.send(…)` / `.write(…)` / `.emit(…)` / `.end(…)` on the
// same receiver, flag it.

const TRIGGER_METHODS = ["kill", "send", "write", "emit", "end"];
const EVENT_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

function checkOnceAfterTrigger(filePath, source) {
  if (!EVENT_EXT.has(extname(filePath))) return [];
  const lines = source.split("\n");
  const offenders = [];

  // Find every `<X>.once(...)` occurrence.
  const onceRe = /(?<!\w)(\w+(?:\??\.\w+)*?)\.once\s*\(\s*['"]/g;

  lines.forEach((line, i) => {
    onceRe.lastIndex = 0;
    let m;
    while ((m = onceRe.exec(line)) !== null) {
      const receiver = m[1]; // e.g. `proc`, `proc.stdout`, `em`
      // Look backward up to 6 lines (same block) for a trigger on the same receiver.
      const lookbackStart = Math.max(0, i - 6);
      for (let j = lookbackStart; j < i; j++) {
        const prev = lines[j];
        if (!prev.trim()) continue;
        const escReceiver = receiver.replace(/[.?]/g, "\\$&");
        const triggerRe = new RegExp(
          `(?<!\\w)${escReceiver}\\.(?:${TRIGGER_METHODS.join("|")})\\s*\\(`,
        );
        if (triggerRe.test(prev)) {
          if (hasAllowMarker(lines, i)) continue;
          offenders.push({
            file: filePath,
            line: i + 1,
            rule: "once-after-trigger",
            message: `${receiver}.once(…) is attached after ${receiver}.${TRIGGER_METHODS.join("/")}(…) on line ${j + 1}. Attach the listener first.`,
            snippet: line.trim(),
          });
          break;
        }
      }
    }
  });

  return offenders;
}

// ─── Check 3: mjs-ts-import ────────────────────────────────────────────────
//
// Strategy: for every *.mjs file with `from "...*.ts"` or `import("...*.ts")`,
// check that any invocation in package.json "scripts" or in
// .github/workflows/*.yml targeting that mjs includes
// `--experimental-strip-types` or `--import tsx` (or similar).

const TS_IMPORT_RE = /(?:from\s+['"]|import\s*\(\s*['"])[^'"]+\.ts['"]/;

function stripCommentsAndStrings(source) {
  // Remove // line comments, /* */ block comments, and template/quoted
  // string contents before scanning for actual import statements. This
  // prevents false positives when doc comments or string fixtures contain
  // text that looks like a .ts import.
  let out = source.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:])\/\/.*$/gm, "$1");
  // Strip string and template-literal bodies (preserve the quote chars so
  // import statements outside strings remain intact).
  out = out.replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, "``");
  out = out.replace(/'(?:\\.|[^'\\])*'/g, "''");
  // Keep real `from "…"` import quotes — use a regex that only collapses
  // strings NOT immediately following `from ` or `import(` (those are what
  // we want to scan).
  out = out.replace(/(?<!from\s|import\s*\(\s*)"(?:\\.|[^"\\])*"/g, '""');
  return out;
}

function checkMjsTsImport(filePath, source, invocationsOverride) {
  if (extname(filePath) !== ".mjs") return [];
  const scannable = stripCommentsAndStrings(source);
  if (!TS_IMPORT_RE.test(scannable)) return [];
  const invocations =
    invocationsOverride !== undefined
      ? invocationsOverride
      : findMjsInvocations(filePath);
  if (invocations.length === 0) {
    // Orphan: file imports .ts but has no tracked invocation. Not a CURRENT
    // bug — may be a new file that will be wired up, or invoked from a shell
    // context we don't see. No offense.
    return [];
  }
  const unsafe = invocations.filter((inv) => !hasStripTypesFlag(inv.command));
  if (unsafe.length === 0) return [];
  return unsafe.map((inv) => ({
    file: filePath,
    line: 1,
    rule: "mjs-ts-import",
    message: `${filePath} imports a .ts module but is invoked by ${inv.origin} without --experimental-strip-types (and without --import tsx/ts-node). Node will throw ERR_UNKNOWN_FILE_EXTENSION.`,
    snippet: inv.command,
  }));
}

function hasStripTypesFlag(cmd) {
  return (
    cmd.includes("--experimental-strip-types") ||
    cmd.includes("--import tsx") ||
    cmd.includes("--loader tsx") ||
    cmd.includes("--loader ts-node") ||
    cmd.includes("--import ts-node")
  );
}

let _invocationCache = null;
function loadInvocationSources() {
  if (_invocationCache) return _invocationCache;
  const sources = [];
  const pkgPath = join(REPO_ROOT, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      sources.push({ origin: `package.json:scripts.${name}`, command: cmd });
    }
  }
  try {
    const packagesDir = join(REPO_ROOT, "packages");
    if (existsSync(packagesDir)) {
      for (const entry of readdirSync(packagesDir)) {
        const pkgFile = join(packagesDir, entry, "package.json");
        if (!existsSync(pkgFile)) continue;
        const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
        for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
          sources.push({
            origin: `packages/${entry}/package.json:scripts.${name}`,
            command: cmd,
          });
        }
      }
    }
  } catch {
    // If packages/ cannot be read (missing or malformed), skip silently —
    // .mjs invocations listed there are not discoverable but that's a best-
    // effort signal, not a correctness requirement.
  }
  const wfDir = join(REPO_ROOT, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const entry of readdirSync(wfDir)) {
      if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
      const content = readFileSync(join(wfDir, entry), "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("-") || trimmed.startsWith("run:")) {
          sources.push({
            origin: `.github/workflows/${entry}`,
            command: trimmed,
          });
        }
      }
    }
  }
  _invocationCache = sources;
  return sources;
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^$|()[\]{}\\]/g, "\\$&");
  const pattern = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${pattern}$`);
}

function commandGlobMatches(command, relPath) {
  // Find glob-like tokens (contain * or **) in the command that look like a
  // path ending in .mjs or .cjs or .js; return true if any matches relPath.
  const tokenRe = /(?:^|\s)(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m;
  while ((m = tokenRe.exec(command)) !== null) {
    const tok = m[1] || m[2] || m[3];
    if (!tok) continue;
    if (!/[*?]/.test(tok)) continue;
    if (!/\.(mjs|cjs|js)$/.test(tok)) continue;
    try {
      if (globToRegex(tok).test(relPath)) return true;
      // Also try matching without leading path prefix variations
      const normalized = relPath.split("/").slice(-tok.split("/").length).join("/");
      if (globToRegex(tok).test(normalized)) return true;
    } catch {
      // Invalid glob token — skip.
    }
  }
  return false;
}

function findMjsInvocations(mjsPath) {
  const rel = relative(REPO_ROOT, resolve(mjsPath));
  const base = rel.split("/").pop();
  const sources = loadInvocationSources();
  return sources.filter(
    (s) =>
      s.command.includes(rel) ||
      s.command.includes(base) ||
      commandGlobMatches(s.command, rel),
  );
}

// ─── Driver ────────────────────────────────────────────────────────────────

function shouldSkipScannedFile(file) {
  // The fixtures directory contains intentional bad examples; scanning it
  // produces known "offenses" by design.
  if (file.includes("scripts/__fixtures__/coderabbit-themes/")) return true;
  // The checker's own test file includes bad patterns inside template
  // literals for verification. stripCommentsAndStrings handles most, but
  // the template-literal stripper is imperfect — skip explicitly.
  if (file.endsWith("scripts/__tests__/check-coderabbit-themes.test.mjs")) {
    return true;
  }
  return false;
}

function runChecks(files) {
  const offenders = [];
  for (const file of files) {
    if (shouldSkipScannedFile(file)) continue;
    const abs = resolve(REPO_ROOT, file);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (!st.isFile()) continue;
    const source = readFileSync(abs, "utf-8");
    offenders.push(...checkSqliteNullGuard(file, source));
    offenders.push(...checkOnceAfterTrigger(file, source));
    offenders.push(...checkMjsTsImport(file, source));
  }
  return offenders;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let files;
  if (args.mode === "all") {
    files = walk(REPO_ROOT)
      .filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f))
      .filter((f) => !SWEEP_SKIP_BASENAMES.has(f.split("/").pop()));
  } else if (args.mode === "files") {
    files = args.files;
  } else {
    files = getChangedFiles().filter((f) =>
      /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f),
    );
  }

  if (files.length === 0) {
    console.log("✓ No eligible files — coderabbit-themes check does not apply");
    return 0;
  }

  const offenders = runChecks(files);
  if (offenders.length === 0) {
    console.log(
      `✓ coderabbit-themes check passed (${files.length} file${files.length === 1 ? "" : "s"} scanned)`,
    );
    return 0;
  }

  console.error("──────────────────────────────────────────────────────");
  console.error("✗ FAILED: coderabbit-themes lint");
  console.error("──────────────────────────────────────────────────────");
  for (const o of offenders) {
    console.error(`\n${o.file}:${o.line}: [${o.rule}]`);
    console.error(`  ${o.message}`);
    console.error(`  > ${o.snippet}`);
  }
  console.error("");
  console.error(
    "Escape hatch: add `// allow-coderabbit-theme: <reason>` on or above the line.",
  );
  console.error("");
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}

// Exports for tests
export {
  checkSqliteNullGuard,
  checkOnceAfterTrigger,
  checkMjsTsImport,
  runChecks,
  hasStripTypesFlag,
};
