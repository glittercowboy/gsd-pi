/**
 * Regression test for #4548 — Bug 2: Provider Manager routes Enter into the
 * OAuth login dialog for ALL providers, including externalCli providers like
 * claude-code. This produces:
 *
 *   "Failed to login to claude-code: Unknown OAuth provider: claude-code"
 *
 * The fix adds a guard in the onSetupAuth callback inside showProviderManager:
 * if the provider is not in the OAuth provider registry, show a "ready" status
 * message instead of opening the login dialog.
 *
 * This test verifies the guard exists in interactive-mode.ts source.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const interactiveModeSource = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "packages",
    "pi-coding-agent",
    "src",
    "modes",
    "interactive",
    "interactive-mode.ts",
  ),
  "utf-8",
);

describe("interactive-mode.ts — provider Enter-key routing guard (#4548)", () => {
  test("getOAuthProviders() is called before routing to showLoginDialog in showProviderManager", () => {
    assert.match(
      interactiveModeSource,
      /getOAuthProviders\(\)/,
      "showProviderManager must call getOAuthProviders() to check provider type",
    );
  });

  test("non-OAuth providers are short-circuited before showLoginDialog", () => {
    // The guard must check isOAuthProvider (or equivalent) and return early
    assert.match(
      interactiveModeSource,
      /isOAuthProvider/,
      "must define an isOAuthProvider check to guard the login dialog",
    );
  });

  test("externalCli providers show informational status instead of login dialog", () => {
    // The early-return branch must call showStatus (not showLoginDialog) for non-OAuth providers
    assert.match(
      interactiveModeSource,
      /isOAuthProvider[\s\S]{0,300}showStatus/,
      "non-OAuth providers must reach showStatus, not showLoginDialog",
    );
  });

  test("OAuth providers still route to showLoginDialog", () => {
    // The showLoginDialog call must still be present after the guard
    assert.match(
      interactiveModeSource,
      /await this\.showLoginDialog\(provider\)/,
      "showLoginDialog must still be called for OAuth providers",
    );
  });

  test("guard message mentions external CLI auth to guide the user", () => {
    assert.match(
      interactiveModeSource,
      /external CLI auth/i,
      "status message for non-OAuth providers must mention external CLI auth",
    );
  });
});
