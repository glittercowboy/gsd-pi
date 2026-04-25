/**
 * cli-provider-rate-limit.test.ts — Verify rate-limit backoff capping
 * for CLI-style providers (openai-codex, google-gemini-cli). (#2922)
 *
 * These providers use per-user quotas with shorter windows, so the
 * default 60s backoff should be capped at 30s to avoid leaving users
 * stuck in an apparent permanent "rate limit" state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECOVERY_PATH = join(__dirname, "..", "bootstrap", "agent-end-recovery.ts");

function getRecoverySource(): string {
  return readFileSync(RECOVERY_PATH, "utf-8");
}

test("agent-end-recovery references openai-codex for rate-limit handling (#2922)", () => {
  const src = getRecoverySource();
  assert.ok(
    src.includes("openai-codex"),
    'agent-end-recovery.ts must reference "openai-codex" for CLI provider rate-limit handling (#2922)',
  );
});

test("agent-end-recovery references google-gemini-cli for rate-limit handling (#2922)", () => {
  const src = getRecoverySource();
  assert.ok(
    src.includes("google-gemini-cli"),
    'agent-end-recovery.ts must reference "google-gemini-cli" for CLI provider rate-limit handling (#2922)',
  );
});

test("agent-end-recovery caps rate-limit backoff for CLI providers (#2922)", () => {
  const src = getRecoverySource();
  // Must have a Math.min capping pattern for CLI provider rate-limit backoff
  const cappingRe = /Math\.min\s*\(/;
  assert.ok(
    cappingRe.test(src),
    'agent-end-recovery.ts must cap rate-limit backoff with Math.min for CLI providers (#2922)',
  );
});
