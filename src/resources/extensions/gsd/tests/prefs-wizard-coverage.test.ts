// Guard test — every key in KNOWN_PREFERENCE_KEYS must be reachable from the
// /gsd prefs wizard.  Without this guard, a new preference can be added to the
// schema without anyone wiring it into the TUI, silently re-creating the gap
// this test exists to prevent.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { KNOWN_PREFERENCE_KEYS } from "../preferences-types.ts";

// Keys exposed via a dedicated command rather than the wizard.  They're still
// reachable by the user, just not inside the category menu flow.  If you add a
// new key here, add a comment explaining where it lives.
const EXPOSED_OUTSIDE_WIZARD = new Set<string>([
  "version",          // auto-managed by writePreferencesFile
  "modelOverrides",   // advanced routing — edit PREFERENCES.md directly (not in KNOWN_PREFERENCE_KEYS)
  "context_mode",     // advanced sandbox config (gsd_exec + compaction) — enabled by default; edit PREFERENCES.md directly to tune timeouts/caps. Wizard coverage tracked separately.
]);

test("every KNOWN_PREFERENCE_KEYS entry is reachable from the wizard source", () => {
  const src = readFileSync(
    new URL("../commands-prefs-wizard.ts", import.meta.url),
    "utf-8",
  );

  const missing: string[] = [];
  for (const key of KNOWN_PREFERENCE_KEYS) {
    if (EXPOSED_OUTSIDE_WIZARD.has(key)) continue;
    // The key must appear somewhere in the wizard — either as a direct
    // prefs[...] / pref reference, or in the orderedKeys serialization list.
    // A plain substring match is enough because all prefs-wizard references
    // use the exact key name.
    if (!src.includes(`"${key}"`) && !src.includes(`.${key}`)) {
      missing.push(key);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `These preference keys are in KNOWN_PREFERENCE_KEYS but are not referenced anywhere in the /gsd prefs wizard — they cannot be configured through the UI. Either add wizard coverage or add them to EXPOSED_OUTSIDE_WIZARD with an explanatory comment:\n${missing.join("\n")}`,
  );
});
