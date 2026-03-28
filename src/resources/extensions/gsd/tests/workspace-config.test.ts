import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseWorkspaceConfig,
  loadWorkspaceConfig,
  classifyFile,
  classifyFiles,
  validateConfig,
} from "../workspace-config.ts";

import type { DomainRules } from "../workspace-config.ts";

// ─── Parse: valid config ───────────────────────────────────────────────────

test("parseWorkspaceConfig: parses valid YAML config", () => {
  const yaml = `
name: backend-api
source: /Users/dev/Projects/myapp
domainRules:
  primary:
    - "src/api/**"
    - "src/db/**"
  excluded:
    - "src/frontend/**"
    - "src/mobile/**"
  shared:
    - "src/types/**"
    - "package.json"
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(result.ok, `Expected ok but got: ${!result.ok && result.error}`);
  if (!result.ok) return;

  assert.equal(result.config.name, "backend-api");
  assert.equal(result.config.source, "/Users/dev/Projects/myapp");
  assert.deepEqual(result.config.domainRules.primary, ["src/api/**", "src/db/**"]);
  assert.deepEqual(result.config.domainRules.excluded, ["src/frontend/**", "src/mobile/**"]);
  assert.deepEqual(result.config.domainRules.shared, ["src/types/**", "package.json"]);
});

test("parseWorkspaceConfig: trims whitespace from name and source", () => {
  const yaml = `
name: "  my-workspace  "
source: "  /path/to/source  "
domainRules:
  primary: []
  excluded: []
  shared: []
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.name, "my-workspace");
  assert.equal(result.config.source, "/path/to/source");
});

test("parseWorkspaceConfig: accepts empty glob arrays", () => {
  const yaml = `
name: minimal
source: /repo
domainRules:
  primary: []
  excluded: []
  shared: []
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.config.domainRules.primary, []);
  assert.deepEqual(result.config.domainRules.excluded, []);
  assert.deepEqual(result.config.domainRules.shared, []);
});

// ─── Parse: validation errors ──────────────────────────────────────────────

test("parseWorkspaceConfig: rejects missing name", () => {
  const yaml = `
source: /repo
domainRules:
  primary: []
  excluded: []
  shared: []
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("name"), `Error should mention 'name': ${result.error}`);
});

test("parseWorkspaceConfig: rejects empty name", () => {
  const yaml = `
name: ""
source: /repo
domainRules:
  primary: []
  excluded: []
  shared: []
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("name"));
});

test("parseWorkspaceConfig: rejects missing source", () => {
  const yaml = `
name: test
domainRules:
  primary: []
  excluded: []
  shared: []
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("source"));
});

test("parseWorkspaceConfig: rejects missing domainRules", () => {
  const yaml = `
name: test
source: /repo
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("domainRules"));
});

test("parseWorkspaceConfig: rejects domainRules as array", () => {
  const yaml = `
name: test
source: /repo
domainRules:
  - one
  - two
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("domainRules"));
});

test("parseWorkspaceConfig: rejects missing primary array", () => {
  const yaml = `
name: test
source: /repo
domainRules:
  excluded: []
  shared: []
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("primary"));
});

test("parseWorkspaceConfig: rejects non-string glob entries", () => {
  const yaml = `
name: test
source: /repo
domainRules:
  primary:
    - 123
  excluded: []
  shared: []
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("primary[0]") && result.error.includes("string"));
});

test("parseWorkspaceConfig: rejects invalid YAML", () => {
  const result = parseWorkspaceConfig("  :\n  : : bad yaml {{{}}}");
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("YAML parse error"));
});

test("parseWorkspaceConfig: rejects null/empty content", () => {
  const result = parseWorkspaceConfig("");
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("empty") || result.error.includes("null"));
});

test("parseWorkspaceConfig: rejects scalar YAML", () => {
  const result = parseWorkspaceConfig("just a string");
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("mapping") || result.error.includes("object"));
});

// ─── validateConfig direct ─────────────────────────────────────────────────

test("validateConfig: returns null for valid config", () => {
  assert.equal(
    validateConfig({
      name: "ok",
      source: "/repo",
      domainRules: { primary: [], excluded: [], shared: [] },
    }),
    null,
  );
});

test("validateConfig: catches non-array domainRules.excluded", () => {
  const err = validateConfig({
    name: "ok",
    source: "/repo",
    domainRules: { primary: [], excluded: "not-an-array", shared: [] },
  });
  assert.ok(err?.includes("excluded"));
});

// ─── classifyFile ──────────────────────────────────────────────────────────

const testRules: DomainRules = {
  primary: ["src/api/**", "src/db/**"],
  excluded: ["src/frontend/**", "src/mobile/**"],
  shared: ["src/types/**", "package.json", "tsconfig.json"],
};

test("classifyFile: matches primary glob", () => {
  assert.equal(classifyFile("src/api/routes.ts", testRules), "primary");
  assert.equal(classifyFile("src/db/migrations/001.sql", testRules), "primary");
});

test("classifyFile: matches excluded glob", () => {
  assert.equal(classifyFile("src/frontend/App.tsx", testRules), "excluded");
  assert.equal(classifyFile("src/mobile/index.ts", testRules), "excluded");
});

test("classifyFile: matches shared glob", () => {
  assert.equal(classifyFile("src/types/user.ts", testRules), "shared");
  assert.equal(classifyFile("package.json", testRules), "shared");
  assert.equal(classifyFile("tsconfig.json", testRules), "shared");
});

test("classifyFile: unclaimed for unmatched files", () => {
  assert.equal(classifyFile("README.md", testRules), "unclaimed");
  assert.equal(classifyFile("src/utils/helper.ts", testRules), "unclaimed");
  assert.equal(classifyFile(".github/workflows/ci.yml", testRules), "unclaimed");
});

test("classifyFile: normalizes leading ./", () => {
  assert.equal(classifyFile("./src/api/routes.ts", testRules), "primary");
});

test("classifyFile: normalizes leading /", () => {
  assert.equal(classifyFile("/src/api/routes.ts", testRules), "primary");
});

test("classifyFile: primary wins over excluded for overlapping globs", () => {
  // A file matching both primary and excluded — primary has higher priority
  const overlapping: DomainRules = {
    primary: ["src/**/*.ts"],
    excluded: ["src/vendor/**"],
    shared: [],
  };
  // src/vendor/lib.ts matches both primary (src/**/*.ts) and excluded (src/vendor/**)
  assert.equal(classifyFile("src/vendor/lib.ts", overlapping), "primary");
});

test("classifyFile: excluded wins over shared", () => {
  const rules: DomainRules = {
    primary: [],
    excluded: ["config/**"],
    shared: ["config/shared.json"],
  };
  // Matches excluded first, so shared never checked
  assert.equal(classifyFile("config/shared.json", rules), "excluded");
});

test("classifyFile: normalizes Windows backslash paths", () => {
  assert.equal(classifyFile("src\\api\\routes.ts", testRules), "primary");
  assert.equal(classifyFile("src\\frontend\\App.tsx", testRules), "excluded");
  assert.equal(classifyFile(".\\src\\types\\user.ts", testRules), "shared");
});

test("parseWorkspaceConfig: trims whitespace from glob patterns", () => {
  const yaml = `name: test
source: /repo
domainRules:
  primary:
    - "  src/api/**  "
  excluded:
    - " src/frontend/** "
  shared:
    - " package.json "
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.config.domainRules.primary, ["src/api/**"]);
  assert.deepEqual(result.config.domainRules.excluded, ["src/frontend/**"]);
  assert.deepEqual(result.config.domainRules.shared, ["package.json"]);
});

test("parseWorkspaceConfig: filters empty glob strings after trim", () => {
  const yaml = `name: test
source: /repo
domainRules:
  primary:
    - "src/**"
    - "   "
    - ""
  excluded: []
  shared: []
`;
  const result = parseWorkspaceConfig(yaml);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.config.domainRules.primary, ["src/**"]);
});

test("classifyFile: all empty rules → everything unclaimed", () => {
  const empty: DomainRules = { primary: [], excluded: [], shared: [] };
  assert.equal(classifyFile("anything.ts", empty), "unclaimed");
  assert.equal(classifyFile("src/deep/nested/file.rs", empty), "unclaimed");
});

test("classifyFile: dot files match with dot:true", () => {
  const rules: DomainRules = {
    primary: [".github/**"],
    excluded: [],
    shared: [".eslintrc.json"],
  };
  assert.equal(classifyFile(".github/workflows/ci.yml", rules), "primary");
  assert.equal(classifyFile(".eslintrc.json", rules), "shared");
});

test("classifyFile: brace expansion works", () => {
  const rules: DomainRules = {
    primary: ["src/**/*.{ts,tsx}"],
    excluded: [],
    shared: [],
  };
  assert.equal(classifyFile("src/app/page.tsx", rules), "primary");
  assert.equal(classifyFile("src/util.ts", rules), "primary");
  assert.equal(classifyFile("src/style.css", rules), "unclaimed");
});

// ─── classifyFiles (batch) ─────────────────────────────────────────────────

test("classifyFiles: groups files correctly", () => {
  const files = [
    "src/api/routes.ts",
    "src/frontend/App.tsx",
    "package.json",
    "README.md",
  ];
  const result = classifyFiles(files, testRules);
  assert.deepEqual(result.primary, ["src/api/routes.ts"]);
  assert.deepEqual(result.excluded, ["src/frontend/App.tsx"]);
  assert.deepEqual(result.shared, ["package.json"]);
  assert.deepEqual(result.unclaimed, ["README.md"]);
});

test("classifyFiles: handles empty input", () => {
  const result = classifyFiles([], testRules);
  assert.deepEqual(result.primary, []);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.shared, []);
  assert.deepEqual(result.unclaimed, []);
});

// ─── loadWorkspaceConfig ───────────────────────────────────────────────────

test("loadWorkspaceConfig: returns null when file doesn't exist", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gsd-wc-test-"));
  try {
    const result = loadWorkspaceConfig(tmpDir);
    assert.equal(result, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadWorkspaceConfig: reads and parses valid config", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gsd-wc-test-"));
  const gsdDir = join(tmpDir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  writeFileSync(
    join(gsdDir, "workspace-config.yaml"),
    `name: test-workspace
source: /origin/repo
domainRules:
  primary:
    - "src/backend/**"
  excluded:
    - "src/frontend/**"
  shared:
    - "shared/**"
`,
  );

  try {
    const result = loadWorkspaceConfig(tmpDir);
    assert.ok(result !== null);
    assert.ok(result!.ok);
    if (!result!.ok) return;
    assert.equal(result!.config.name, "test-workspace");
    assert.deepEqual(result!.config.domainRules.primary, ["src/backend/**"]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadWorkspaceConfig: returns error for invalid config file", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gsd-wc-test-"));
  const gsdDir = join(tmpDir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  writeFileSync(join(gsdDir, "workspace-config.yaml"), "name: oops\n");

  try {
    const result = loadWorkspaceConfig(tmpDir);
    assert.ok(result !== null);
    assert.ok(!result!.ok);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
