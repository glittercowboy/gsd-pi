import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact } from "../auto-recovery.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-milestone-artifact-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeRoadmap(base: string, milestoneId: string, content: string): void {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, `${milestoneId}-ROADMAP.md`), content, "utf-8");
}

function writeLegacyRoadmap(base: string, milestoneId: string, content: string): void {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "ROADMAP.md"), content, "utf-8");
}

test("#3405: plan-milestone roadmap stub does not count as a verified artifact", () => {
  const base = createFixtureBase();
  try {
    writeRoadmap(base, "M001", [
      "# M001: Placeholder",
      "",
      "**Vision:** Stub only.",
      "",
      "## Slices",
      "",
      "_TBD_",
      "",
    ].join("\n"));

    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, false, "zero-slice roadmap stubs must fail verification");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#3405: plan-milestone roadmap with real slices still passes artifact verification", () => {
  const base = createFixtureBase();
  try {
    writeRoadmap(base, "M001", [
      "# M001: Real roadmap",
      "",
      "**Vision:** Real work.",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      "  > After this: a real slice exists.",
      "",
    ].join("\n"));

    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, true, "real roadmap slices should keep passing verification");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("plan-milestone verification accepts legacy ROADMAP.md via shared resolver", () => {
  const base = createFixtureBase();
  try {
    writeLegacyRoadmap(base, "M001", [
      "# M001: Legacy roadmap",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      "  > After this: a real slice exists.",
      "",
    ].join("\n"));

    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, true, "legacy unprefixed ROADMAP.md should resolve");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("discuss-milestone verification accepts legacy CONTEXT.md via shared resolver", () => {
  const base = createFixtureBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, "CONTEXT.md"), "# M001 Context\n", "utf-8");

    const result = verifyExpectedArtifact("discuss-milestone", "M001", base);
    assert.equal(result, true, "legacy unprefixed CONTEXT.md should resolve");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
