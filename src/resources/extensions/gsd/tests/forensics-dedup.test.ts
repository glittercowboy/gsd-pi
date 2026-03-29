import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { KNOWN_PREFERENCE_KEYS } from "../preferences-types.js";
import { DEDUP_PROMPT_SECTION, resolveDedupSection } from "../forensics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("forensics dedup (#2096)", () => {
  it("forensics_dedup is in KNOWN_PREFERENCE_KEYS", () => {
    assert.ok(
      KNOWN_PREFERENCE_KEYS.has("forensics_dedup"),
      "KNOWN_PREFERENCE_KEYS must contain forensics_dedup",
    );
  });

  it("forensics prompt contains {{dedupSection}} placeholder", () => {
    const prompt = readFileSync(join(__dirname, "..", "prompts", "forensics.md"), "utf-8");
    assert.ok(prompt.includes("{{dedupSection}}"), "forensics.md must contain {{dedupSection}} placeholder");
  });

  it("DEDUP_PROMPT_SECTION contains required search commands", () => {
    assert.ok(DEDUP_PROMPT_SECTION.includes("gh issue list --repo gsd-build/gsd-2 --state closed"));
    assert.ok(DEDUP_PROMPT_SECTION.includes("gh pr list --repo gsd-build/gsd-2 --state open"));
    assert.ok(DEDUP_PROMPT_SECTION.includes("gh pr list --repo gsd-build/gsd-2 --state merged"));
  });

  it("resolveDedupSection returns prompt section when enabled", () => {
    const section = resolveDedupSection(true);
    assert.strictEqual(section, DEDUP_PROMPT_SECTION);
  });

  it("resolveDedupSection returns empty string when disabled", () => {
    assert.strictEqual(resolveDedupSection(false), "");
  });

  it("resolveDedupSection returns empty string when preference is undefined (first-time opt-in not yet answered)", () => {
    assert.strictEqual(resolveDedupSection(undefined), "");
  });
});
