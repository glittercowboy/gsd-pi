/**
 * Fixture Recording Helper
 *
 * Records LLM conversations as fixture files for replay in CI.
 *
 * Usage:
 *   GSD_FIXTURE_MODE=record npm run test:fixtures:record
 *
 * This script is a placeholder for the full recording workflow.
 * To create new fixture recordings:
 *
 * 1. Set GSD_FIXTURE_MODE=record in your environment
 * 2. Run an agent conversation that you want to capture
 * 3. The FixtureRecorder (from provider.ts) collects turns automatically
 * 4. Recordings are saved as JSON to tests/fixtures/recordings/
 *
 * For manual fixture creation, create a JSON file in recordings/ matching
 * the FixtureRecording interface from provider.ts:
 *
 *   {
 *     "name": "descriptive-name",
 *     "description": "What this fixture tests",
 *     "turns": [
 *       { "role": "user", "content": "..." },
 *       { "role": "assistant", "content": "...", "toolUses": [...] }
 *     ]
 *   }
 *
 * Then run `npm run test:fixtures` to validate the recording.
 */

import { getFixtureMode, getFixtureDir } from "./provider.ts";

const mode = getFixtureMode();
const dir = getFixtureDir();

if (mode !== "record") {
  console.log("Fixture recording is not active.");
  console.log("Set GSD_FIXTURE_MODE=record to enable recording.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run test:fixtures:record    # Start recording");
  console.log(
    "  npm run test:fixtures            # Replay and verify recordings",
  );
  console.log("");
  console.log(`Recordings directory: ${dir}`);
  process.exit(0);
}

console.log(`Recording mode active. Fixture directory: ${dir}`);
console.log("Recording integration is pending full agent hookup.");
