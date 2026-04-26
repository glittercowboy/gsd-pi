/**
 * Behavioural validation for the docker/ template artifacts.
 *
 * Replaces the source-grep `docker-template.test.ts` (deleted in #4884).
 * Each assertion exercises the parsed / evaluated artifact rather than the
 * literal source text — moving a directive into a comment, swapping it for
 * a synonym, or breaking the YAML grammar must visibly fail at least one
 * test here.
 *
 * Refs: #4881
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import ignore from "ignore";
import { parse as parseYaml } from "yaml";

const repoRoot = process.cwd();
const dockerDir = resolve(repoRoot, "docker");

// ─── helpers ──────────────────────────────────────────────────────────────

function readDockerFile(relPath: string): string {
  const full = resolve(dockerDir, relPath);
  assert.ok(existsSync(full), `expected ${full} to exist`);
  return readFileSync(full, "utf-8");
}

function readRepoFile(relPath: string): string {
  const full = resolve(repoRoot, relPath);
  assert.ok(existsSync(full), `expected ${full} to exist`);
  return readFileSync(full, "utf-8");
}

type DockerfileInstruction = { directive: string; args: string };

/**
 * Minimal Dockerfile parser — strips comments, joins backslash-continued
 * lines, splits the leading directive from its argument string. Returns
 * the ordered list of instructions actually evaluated by Docker (so a
 * `# RUN useradd` comment is correctly invisible to the assertions below).
 */
function parseDockerfile(source: string): DockerfileInstruction[] {
  // 1. Strip full-line comments. (Shell # inside a RUN is preserved by docker
  //    itself, but the directive form `# CMD ...` is a comment.)
  const rawLines = source.split(/\r?\n/);
  const significant: string[] = [];
  for (const line of rawLines) {
    if (/^\s*#/.test(line)) continue;
    significant.push(line);
  }

  // 2. Join backslash-continuations into single logical instructions.
  const logical: string[] = [];
  let buffer = "";
  for (const line of significant) {
    if (/\\\s*$/.test(line)) {
      buffer += line.replace(/\\\s*$/, "") + " ";
      continue;
    }
    buffer += line;
    if (buffer.trim().length > 0) {
      logical.push(buffer.trim());
    }
    buffer = "";
  }
  if (buffer.trim().length > 0) {
    logical.push(buffer.trim());
  }

  // 3. Split into directive + args.
  const out: DockerfileInstruction[] = [];
  for (const stmt of logical) {
    const match = stmt.match(/^([A-Za-z]+)\s+([\s\S]*)$/);
    if (!match) continue;
    out.push({ directive: match[1].toUpperCase(), args: match[2].trim() });
  }
  return out;
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// ─── 1. docker-compose.yaml — minimal sandbox ─────────────────────────────

test("docker-compose.yaml parses as YAML and exposes the gsd service contract", () => {
  const parsed = parseYaml(readDockerFile("docker-compose.yaml")) as any;
  const gsd = parsed?.services?.gsd;
  assert.ok(gsd, "gsd service must be present in docker-compose.yaml");

  // Build context resolves to docker/ ; uses the sandbox Dockerfile.
  assert.equal(gsd.build?.dockerfile, "Dockerfile.sandbox");

  // Port 3000 must be mapped 1:1 to the host. Compare on parsed form so
  // string vs sequence ("3000:3000" vs { published: 3000, ... }) both
  // pass once normalised.
  const ports: unknown[] = Array.isArray(gsd.ports) ? gsd.ports : [];
  const has3000 = ports.some((p) => {
    if (typeof p === "string") return /^3000:3000(\/tcp)?$/.test(p);
    if (p && typeof p === "object") {
      const o = p as { published?: number | string; target?: number | string };
      return Number(o.published) === 3000 && Number(o.target) === 3000;
    }
    return false;
  });
  assert.ok(has3000, `expected ports to map 3000:3000, got ${JSON.stringify(ports)}`);

  // /workspace mount must be declared as a volume on the gsd service.
  const volumes: unknown[] = Array.isArray(gsd.volumes) ? gsd.volumes : [];
  const mountsWorkspace = volumes.some((v) => {
    if (typeof v === "string") return /:\/workspace(:.*)?$/.test(v);
    if (v && typeof v === "object") {
      const o = v as { target?: string };
      return o.target === "/workspace";
    }
    return false;
  });
  assert.ok(mountsWorkspace, `expected a /workspace mount, got ${JSON.stringify(volumes)}`);

  // Security contract: no hardcoded user override on the service. The
  // entrypoint remaps PUID/PGID — a top-level `user:` would defeat that.
  assert.equal(gsd.user, undefined, "gsd service must not pin a user: directive");
});

// ─── 2. docker-compose.full.yaml — reference template ─────────────────────

test("docker-compose.full.yaml surfaces healthcheck and PUID/PGID env", () => {
  const parsed = parseYaml(readDockerFile("docker-compose.full.yaml")) as any;
  const gsd = parsed?.services?.gsd;
  assert.ok(gsd, "gsd service must exist");

  // Healthcheck must be a structured directive (not a comment).
  const healthcheck = gsd.healthcheck;
  assert.ok(healthcheck, "healthcheck must be defined as YAML, not a comment");
  assert.deepEqual(healthcheck.test, ["CMD", "gsd", "--version"]);
  assert.ok(typeof healthcheck.interval === "string" && healthcheck.interval.length > 0);

  // PUID / PGID must surface to the runtime as environment variables
  // (a comment-only mention would not). Compose accepts environment as
  // either an object or a "KEY=VALUE" array — handle both.
  const env = gsd.environment;
  const hasKey = (key: string): boolean => {
    if (Array.isArray(env)) return env.some((e) => typeof e === "string" && e.startsWith(`${key}=`));
    if (env && typeof env === "object") return Object.prototype.hasOwnProperty.call(env, key);
    return false;
  };
  assert.ok(hasKey("PUID"), "PUID must be surfaced as an environment variable");
  assert.ok(hasKey("PGID"), "PGID must be surfaced as an environment variable");
});

// ─── 2b. Optional runtime: `docker compose config` ────────────────────────

test("docker compose config validates both compose files", { skip: !dockerAvailable() }, () => {
  // Both compose files declare `env_file: - .env` (relative to docker/),
  // which compose insists must exist on disk during `config`. If the
  // host doesn't already have a real .env (CI, fresh checkouts), seed
  // an empty placeholder so the schema validator can run, then remove
  // it. Never clobber a developer's real .env.
  const sentinelEnv = resolve(dockerDir, ".env");
  const createdSentinel = !existsSync(sentinelEnv);
  if (createdSentinel) {
    writeFileSync(sentinelEnv, "# generated by docker-template-contract test\n", "utf-8");
  }
  try {
    const validate = (rel: string): void => {
      const file = resolve(dockerDir, rel);
      // `docker compose -f <compose> config --quiet` resolves variables
      // and exits 0 only if the file is a valid compose schema. It's
      // stricter than YAML.parse — catches reserved-word misuse,
      // missing services, unresolved !include refs, etc.
      execFileSync("docker", ["compose", "-f", file, "config", "--quiet"], {
        cwd: dockerDir,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, COMPOSE_PROJECT_NAME: "gsd-template-contract" },
      });
    };
    validate("docker-compose.yaml");
    validate("docker-compose.full.yaml");
  } finally {
    if (createdSentinel) {
      try {
        rmSync(sentinelEnv, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

// ─── 3. Dockerfile.sandbox — directive structure ──────────────────────────

test("Dockerfile.sandbox directive structure satisfies the runtime contract", () => {
  const instructions = parseDockerfile(readDockerFile("Dockerfile.sandbox"));

  // FROM: base must be node:24*. (Anchored: a comment mentioning
  // `node:24` would not appear in the parsed instruction list.)
  const from = instructions.find((i) => i.directive === "FROM");
  assert.ok(from, "Dockerfile must have a FROM directive");
  assert.match(from!.args, /^node:24(\.|-|$)/, `FROM must be node:24*, got: ${from!.args}`);

  // RUN: at least one step must install gsd-pi globally. Match on the
  // parsed argument string of an actual RUN, not a comment.
  const installsGsdPi = instructions.some(
    (i) => i.directive === "RUN" && /\bnpm\s+install\s+(?:[^&|;]*\s)?-g\s[^&|;]*\bgsd-pi\b/.test(i.args),
  );
  assert.ok(installsGsdPi, "expected a RUN step that runs `npm install -g gsd-pi`");

  // Non-root contract: image must end as a real non-root user. The legacy
  // test only asserted `useradd` — that satisfied the directive even if
  // `USER` was never set. Here we require the actual USER directive.
  // The current sandbox uses gosu via entrypoint to drop privileges; in
  // that case the contract is the entrypoint script itself. Accept either
  // form: a USER directive OR an ENTRYPOINT that hands off to gosu.
  const hasUserDirective = instructions.some((i) => i.directive === "USER");
  const hasGosuEntrypoint = instructions.some(
    (i) => i.directive === "ENTRYPOINT" && /entrypoint\.sh/.test(i.args),
  );
  assert.ok(
    hasUserDirective || hasGosuEntrypoint,
    "image must drop privileges via USER directive or gosu entrypoint",
  );
  if (!hasUserDirective) {
    // Verify the entrypoint script actually runs gosu (the privilege drop)
    // — otherwise "gosu entrypoint" is just a name.
    const entrypointPath = resolve(dockerDir, "entrypoint.sh");
    assert.ok(existsSync(entrypointPath), "entrypoint.sh must exist when relied on for privilege drop");
    const entrypoint = readFileSync(entrypointPath, "utf-8");
    // The entrypoint may use a literal username (`gosu gsd`) or a quoted
    // variable (`gosu "${GSD_USER}"`). Both are valid privilege drops; only
    // a missing `exec gosu` is a contract break.
    assert.match(entrypoint, /\bexec\s+gosu\s+\S+/, "entrypoint.sh must `exec gosu <user> ...`");
  }

  // EXPOSE 3000 must be a real directive.
  const exposes3000 = instructions.some(
    (i) => i.directive === "EXPOSE" && /\b3000\b/.test(i.args),
  );
  assert.ok(exposes3000, "Dockerfile.sandbox must EXPOSE 3000");
});

// ─── 4. .dockerignore — glob behaviour ────────────────────────────────────

test(".dockerignore actually excludes the documented paths", () => {
  const matcher = ignore().add(readRepoFile(".dockerignore"));

  // Paths that MUST be ignored — exercises the glob, not the literal text.
  // node_modules/x is matched by the trailing-slash directory rule
  // `node_modules/`. .env is matched by the literal `.env` line. dist/foo
  // is matched by `dist/`.
  const mustIgnore = [
    "node_modules/some-dep/index.js",
    "packages/foo/node_modules/dep/x.js",
    ".env",
    ".env.local",
    "dist/index.js",
    "dist/nested/file.txt",
  ];
  for (const p of mustIgnore) {
    assert.ok(matcher.ignores(p), `expected ${p} to be ignored by .dockerignore`);
  }

  // Carve-out: .env.example must NOT be ignored (the file is shipped in
  // the repo intentionally). The current .dockerignore uses `!.env.example`.
  assert.equal(
    matcher.ignores(".env.example"),
    false,
    ".env.example must remain un-ignored — it is the shipped template",
  );

  // Sanity: source files that should pass through.
  assert.equal(matcher.ignores("src/index.ts"), false);
  assert.equal(matcher.ignores("docker/Dockerfile.sandbox"), false);
});

// ─── 5. .env.example — dotenv shape ───────────────────────────────────────

test(".env.example declares the required provider keys with empty values", () => {
  const source = readDockerFile(".env.example");

  // Hand-rolled dotenv parse — match KEY=VALUE on non-comment lines, AND
  // KEY values reachable only via uncommenting (lines starting with `# `
  // followed by `KEY=`). The original file ships with provider keys
  // commented out so users uncomment + fill them in. We need to assert
  // the SHAPE — that the keys are documented, and that the example value
  // is empty / placeholder (never a real secret).
  const lines = source.split(/\r?\n/);
  type Entry = { commented: boolean; value: string };
  const entries = new Map<string, Entry>();
  for (const raw of lines) {
    const trimmed = raw.replace(/^\s+/, "");
    const commented = trimmed.startsWith("#");
    const body = commented ? trimmed.replace(/^#\s?/, "") : trimmed;
    const m = body.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (entries.has(m[1])) continue; // first occurrence wins
    entries.set(m[1], { commented, value: m[2] });
  }

  for (const required of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    const entry = entries.get(required);
    assert.ok(entry, `${required} must be declared in .env.example (commented or live)`);
    // Placeholder must be empty OR a documented placeholder pattern (sk-...).
    // It must NEVER be a real-looking secret — guard against an accidental
    // real key being committed to the example file.
    const placeholderOk = entry!.value.length === 0 || /^(sk-[a-z\-]*\.{3}|<.+>|"")$/.test(entry!.value);
    assert.ok(
      placeholderOk,
      `${required} in .env.example must be empty or a placeholder, got: ${JSON.stringify(entry!.value)}`,
    );
  }
});
