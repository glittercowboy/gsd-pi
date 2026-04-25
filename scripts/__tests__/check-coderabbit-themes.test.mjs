import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkSqliteNullGuard,
  checkOnceAfterTrigger,
  checkMjsTsImport,
  hasStripTypesFlag,
} from "../check-coderabbit-themes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../__fixtures__/coderabbit-themes");

function readFixture(name) {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

// ─── Theme 1: sqlite-null-guard ────────────────────────────────────────────

test("sqlite-null-guard flags !== null after .get()", () => {
  const src = readFixture("bad-sqlite-null-guard.ts");
  const offenders = checkSqliteNullGuard("bad.ts", src);
  assert.ok(offenders.length >= 3, `expected ≥3 offenders, got ${offenders.length}`);
  for (const o of offenders) {
    assert.equal(o.rule, "sqlite-null-guard");
  }
});

test("sqlite-null-guard does not flag != null, === undefined, ??, or truthy", () => {
  const src = readFixture("good-sqlite-null-guard.ts");
  const offenders = checkSqliteNullGuard("good.ts", src);
  assert.equal(offenders.length, 0, `unexpected offenders: ${JSON.stringify(offenders)}`);
});

test("sqlite-null-guard ignores non-.get() null checks", () => {
  const src = `
    import Database from "better-sqlite3";
    const obj: { v: number } | null = maybeObj();
    if (obj !== null) {
      use(obj.v);
    }
  `;
  const offenders = checkSqliteNullGuard("unrelated.ts", src);
  assert.equal(offenders.length, 0);
});

test("sqlite-null-guard skips files without better-sqlite3 import", () => {
  // This guards against false-flagging Map#get, URLSearchParams#get, etc.
  const src = `
    const sortMode = searchParams.get("sortMode");
    if (sortMode !== null) use(sortMode);
    const parentId = parentMap.get(entryId);
    if (parentId === null) return;
  `;
  const offenders = checkSqliteNullGuard("route.ts", src);
  assert.equal(offenders.length, 0, `unexpected offenders: ${JSON.stringify(offenders)}`);
});

test("sqlite-null-guard honours allow-coderabbit-theme marker", () => {
  const src = [
    `import Database from "better-sqlite3";`,
    `const row = stmt.get(1);`,
    `// allow-coderabbit-theme: typing quirk, see #9999`,
    `if (row !== null) { use(row); }`,
  ].join("\n");
  const offenders = checkSqliteNullGuard("allowed.ts", src);
  assert.equal(offenders.length, 0);
});

// ─── Theme 2: once-after-trigger ───────────────────────────────────────────

test("once-after-trigger flags once() after kill()/emit()/write() on same receiver", () => {
  const src = readFixture("bad-once-after-trigger.ts");
  const offenders = checkOnceAfterTrigger("bad.ts", src);
  assert.ok(offenders.length >= 3, `expected ≥3 offenders, got ${offenders.length}`);
  for (const o of offenders) assert.equal(o.rule, "once-after-trigger");
});

test("once-after-trigger does not flag when listener is registered first", () => {
  const src = readFixture("good-once-after-trigger.ts");
  const offenders = checkOnceAfterTrigger("good.ts", src);
  assert.equal(offenders.length, 0, `unexpected offenders: ${JSON.stringify(offenders)}`);
});

test("once-after-trigger ignores different receivers", () => {
  const src = `
    other.kill("SIGINT");
    proc.once("exit", resolve);
  `;
  const offenders = checkOnceAfterTrigger("diff.ts", src);
  assert.equal(offenders.length, 0);
});

test("once-after-trigger respects the 6-line lookback window", () => {
  const lines = [
    `proc.kill("SIGINT");`,
    `// line A`,
    `// line B`,
    `// line C`,
    `// line D`,
    `// line E`,
    `// line F`,
    `// line G`,
    `proc.once("exit", resolve);`,
  ];
  const offenders = checkOnceAfterTrigger("far.ts", lines.join("\n"));
  assert.equal(offenders.length, 0, "trigger should be out-of-window");
});

// ─── Theme 3: mjs-ts-import ────────────────────────────────────────────────

test("mjs-ts-import flags .mjs importing .ts when invocation lacks --experimental-strip-types", () => {
  const src = readFixture("bad-mjs-ts-import.mjs");
  const offenders = checkMjsTsImport(
    "scripts/__fixtures__/coderabbit-themes/bad-mjs-ts-import.mjs",
    src,
    [{ origin: "package.json:scripts.test", command: "node --test bad.mjs" }],
  );
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].rule, "mjs-ts-import");
});

test("mjs-ts-import passes when invocation includes --experimental-strip-types", () => {
  const src = readFixture("bad-mjs-ts-import.mjs");
  const offenders = checkMjsTsImport(
    "scripts/__fixtures__/coderabbit-themes/bad-mjs-ts-import.mjs",
    src,
    [
      {
        origin: "package.json:scripts.test",
        command: "node --experimental-strip-types --test bad.mjs",
      },
    ],
  );
  assert.equal(offenders.length, 0);
});

test("mjs-ts-import does not flag orphan files with no tracked invocation", () => {
  const src = readFixture("bad-mjs-ts-import.mjs");
  const offenders = checkMjsTsImport(
    "scripts/__fixtures__/coderabbit-themes/bad-mjs-ts-import.mjs",
    src,
    [],
  );
  assert.equal(offenders.length, 0);
});

test("mjs-ts-import does not flag .mjs without .ts imports", () => {
  const src = readFixture("good-mjs-no-ts-import.mjs");
  const offenders = checkMjsTsImport(
    "scripts/__fixtures__/coderabbit-themes/good-mjs-no-ts-import.mjs",
    src,
    [],
  );
  assert.equal(offenders.length, 0);
});

test("hasStripTypesFlag recognizes supported invocations", () => {
  assert.ok(hasStripTypesFlag("node --experimental-strip-types run.mjs"));
  assert.ok(hasStripTypesFlag("node --import tsx run.mjs"));
  assert.ok(hasStripTypesFlag("node --loader tsx run.mjs"));
  assert.ok(hasStripTypesFlag("node --loader ts-node run.mjs"));
  assert.ok(hasStripTypesFlag("node --import ts-node/register run.mjs"));
  assert.ok(!hasStripTypesFlag("node run.mjs"));
});
