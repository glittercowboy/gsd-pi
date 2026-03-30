import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

describe("forensics dedup (#2096)", () => {
  it("forensics_dedup is in KNOWN_PREFERENCE_KEYS", () => {
    const source = readFileSync(join(gsdDir, "preferences-types.ts"), "utf-8");
    assert.ok(source.includes('"forensics_dedup"'),
      "KNOWN_PREFERENCE_KEYS must contain forensics_dedup");
    assert.ok(source.includes("forensics_dedup?: boolean"),
      "GSDPreferences must declare forensics_dedup as optional boolean");
  });

  it("forensics prompt contains {{dedupSection}} placeholder", () => {
    const prompt = readFileSync(join(gsdDir, "prompts", "forensics.md"), "utf-8");
    assert.ok(prompt.includes("{{dedupSection}}"),
      "forensics.md must contain {{dedupSection}} placeholder");
  });

  it("DEDUP_PROMPT_SECTION contains required search commands", async () => {
    const source = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
    assert.ok(source.includes("DEDUP_PROMPT_SECTION"), "forensics.ts must define DEDUP_PROMPT_SECTION");
    assert.ok(source.includes("gh issue list --repo gsd-build/gsd-2 --state closed"));
    assert.ok(source.includes("gh pr list --repo gsd-build/gsd-2 --state open"));
    assert.ok(source.includes("gh pr list --repo gsd-build/gsd-2 --state merged"));
  });

  it("handleForensics checks forensics_dedup preference", () => {
    const source = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
    assert.ok(source.includes("forensics_dedup"),
      "handleForensics must reference forensics_dedup preference");
    assert.ok(source.includes("dedupSection"),
      "handleForensics must pass dedupSection to loadPrompt");
  });

  it("first-time opt-in shows when preference is undefined", () => {
    const source = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
    assert.ok(source.includes("=== undefined"),
      "first-time detection must check for undefined (not false)");
    assert.ok(source.includes("Duplicate detection available") || source.includes("duplicate detection"),
      "opt-in notice must mention duplicate detection");
  });
});

describe("forensics dedup ordering (#2704)", () => {
  it("{{dedupSection}} appears before Investigation Protocol in the prompt template", () => {
    const prompt = readFileSync(join(gsdDir, "prompts", "forensics.md"), "utf-8");
    const dedupIndex = prompt.indexOf("{{dedupSection}}");
    const investigationIndex = prompt.indexOf("## Investigation Protocol");
    assert.ok(dedupIndex !== -1, "prompt must contain {{dedupSection}}");
    assert.ok(investigationIndex !== -1, "prompt must contain ## Investigation Protocol");
    assert.ok(
      dedupIndex < investigationIndex,
      `{{dedupSection}} (index ${dedupIndex}) must appear before Investigation Protocol (index ${investigationIndex}) — dedup should run before expensive investigation to avoid wasting tokens on already-fixed bugs`,
    );
  });

  it("DEDUP_PROMPT_SECTION contains a decision gate to skip investigation", () => {
    const source = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
    // The dedup section must instruct the agent to skip investigation when a match is found
    assert.ok(
      source.includes("Skip full investigation") || source.includes("skip full investigation") || source.includes("Skip investigation"),
      "DEDUP_PROMPT_SECTION must contain a decision gate telling the agent to skip full investigation when a duplicate is found",
    );
  });

  it("DEDUP_PROMPT_SECTION heading reflects pre-investigation role", () => {
    const source = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
    assert.ok(
      source.includes("Pre-Investigation") || source.includes("pre-investigation"),
      "DEDUP_PROMPT_SECTION heading must indicate it runs before investigation, not just before issue creation",
    );
  });
});
