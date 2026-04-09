import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Validates that all Discord invite links in user-facing files point to valid,
 * consistent invite URLs — not expired vanity links.
 *
 * Regression test for https://github.com/gsd-build/gsd-2/issues/2699
 */

const ROOT = process.cwd();

/** Canonical Discord invite for the GSD community. */
const VALID_INVITE = "https://discord.com/invite/nKXTsAcmbT";

/** Files that contain user-facing Discord invite links. */
const FILES_WITH_INVITE_LINKS: string[] = [
  "README.md",
  "docs/what-is-pi/15-pi-packages-the-ecosystem.md",
];

describe("Discord invite links (#2699)", () => {
  for (const relPath of FILES_WITH_INVITE_LINKS) {
    it(`${relPath} contains only the canonical Discord invite`, () => {
      const content = readFileSync(join(ROOT, relPath), "utf8");

      // Extract all Discord invite URLs (discord.gg/X or discord.com/invite/X)
      const invitePattern = /https?:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9]+/g;
      const matches = content.match(invitePattern);

      assert.ok(
        matches && matches.length > 0,
        `Expected at least one Discord invite link in ${relPath}`,
      );

      for (const link of matches) {
        assert.equal(
          link,
          VALID_INVITE,
          `Invalid Discord invite in ${relPath}: found "${link}", expected "${VALID_INVITE}"`,
        );
      }
    });
  }
});
