import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Regression for #4470: /gsd onboarding re-entry used to replay the @clack
// first-run wizard, which wedged the TUI (clack takes over raw stdin and
// pauses it on teardown) and rendered a duplicate intro/logo header.
//
// The fix replaces re-entry with a ctx.ui.select setup hub owned by the TUI.
// These assertions guarantee the handler does NOT invoke runOnboarding (the
// clack wizard) and therefore cannot re-render the intro/logo or wedge stdin.

test("re-entry onboarding handler does not replay the clack wizard", () => {
  const handlerSource = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "resources",
      "extensions",
      "gsd",
      "commands",
      "handlers",
      "onboarding.ts",
    ),
    "utf-8",
  )

  assert.doesNotMatch(
    handlerSource,
    /\brunOnboarding\s*\(/,
    "re-entry handler must not call runOnboarding — that path owns stdin via @clack and wedges the TUI",
  )
  assert.doesNotMatch(
    handlerSource,
    /from\s+["'][^"']*\/onboarding(\.js)?["']/,
    "re-entry handler must not import the first-run wizard module",
  )
  assert.match(
    handlerSource,
    /ctx\.ui\.select\(/,
    "re-entry handler must route through ctx.ui.select (the setup hub)",
  )
})

test("first-run wizard still supports showIntro option for boot-time caller", () => {
  // src/onboarding.ts is still used by the first-run boot path in src/cli.ts;
  // its showIntro option stays so boot can suppress a duplicate intro when
  // another surface has already rendered the logo.
  const onboardingSource = readFileSync(
    join(import.meta.dirname, "..", "onboarding.ts"),
    "utf-8",
  )

  assert.match(
    onboardingSource,
    /interface RunOnboardingOptions[\s\S]*showIntro\?: boolean/,
    "runOnboarding should accept a showIntro option",
  )
  assert.match(
    onboardingSource,
    /if \(opts\.showIntro !== false\)/,
    "runOnboarding should gate logo/intro rendering behind showIntro",
  )
})
