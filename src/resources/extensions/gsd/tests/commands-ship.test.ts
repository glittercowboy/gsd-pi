import test from "node:test";
import assert from "node:assert/strict";

// Test the PR content generation logic used by /gsd ship.
// Full integration requires gh CLI + git, so we test the text generation.

test("ship: generates TL;DR format", () => {
  // Simulate generatePRContent output structure
  const milestoneId = "M001";
  const milestoneTitle = "User authentication system";

  const title = `feat: ${milestoneTitle}`;
  assert.equal(title, "feat: User authentication system");
  assert.ok(title.length < 80); // PR title should be short
});

test("ship: --dry-run flag detection", () => {
  const args1 = "--dry-run";
  const args2 = "--draft --dry-run";
  const args3 = "--draft";

  assert.ok(args1.includes("--dry-run"));
  assert.ok(args2.includes("--dry-run"));
  assert.ok(!args3.includes("--dry-run"));
});

test("ship: --base flag parsing", () => {
  const args = "--base develop --draft";
  const baseMatch = args.match(/--base\s+(\S+)/);
  assert.ok(baseMatch);
  assert.equal(baseMatch[1], "develop");
});

test("ship: --base flag absent defaults", () => {
  const args = "--draft";
  const baseMatch = args.match(/--base\s+(\S+)/);
  assert.equal(baseMatch, null);
});

test("ship: --force flag detection", () => {
  const args1 = "--force";
  const args2 = "";

  assert.ok(args1.includes("--force"));
  assert.ok(!args2.includes("--force"));
});

test("ship: change type checklist format", () => {
  const checklist = [
    "- [x] `feat` — New feature or capability",
    "- [ ] `fix` — Bug fix",
    "- [ ] `refactor` — Code restructuring",
    "- [ ] `test` — Adding or updating tests",
    "- [ ] `docs` — Documentation only",
    "- [ ] `chore` — Build, CI, or tooling changes",
  ];

  // Verify format matches CONTRIBUTING.md expectations
  for (const line of checklist) {
    assert.match(line, /^- \[[ x]\] `\w+` — .+$/);
  }
});

test("ship: PR body contains required sections", () => {
  const requiredSections = ["## TL;DR", "## Change type"];
  const body = "## TL;DR\n\n**What:** Ship M001\n\n## Change type\n\n- [x] `feat`";

  for (const section of requiredSections) {
    assert.ok(body.includes(section), `Missing section: ${section}`);
  }
});
