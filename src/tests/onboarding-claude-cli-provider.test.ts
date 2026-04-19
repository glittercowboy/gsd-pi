import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Source-level regression test: the claude-cli onboarding path must persist
 * defaultProvider = 'claude-code' so the user is not left on the
 * 'anthropic' direct-API provider after selecting Claude Code CLI.
 *
 * Without this, the auto-migration in cli.ts does not fire when the user
 * also has a stored Anthropic API key, leaving them on the wrong provider.
 */
test("onboarding claude-cli path persists defaultProvider to settings.json", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "onboarding.ts"),
    "utf-8",
  )

  // The claude-cli branch must persist defaultProvider = 'claude-code'
  const cliBlock = source.slice(
    source.indexOf("method === 'claude-cli'"),
    source.indexOf("// ── Step 2"),
  )
  assert.ok(cliBlock.length > 0, "claude-cli block not found in onboarding.ts")
  assert.match(
    cliBlock,
    /persistDefaultProvider\(\s*['"]claude-code['"]\s*\)/,
    "claude-cli onboarding path must set defaultProvider = 'claude-code'",
  )
})
