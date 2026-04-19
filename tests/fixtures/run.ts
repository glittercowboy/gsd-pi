import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadFixture, FixtureReplayer } from "./provider.ts";
import type { FixtureTurn, FixtureRecording } from "./provider.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const recordingsDir = join(__dirname, "recordings");

const files = readdirSync(recordingsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.error("No fixture recordings found");
  process.exit(1);
}

let passed = 0;
let failed = 0;

for (const file of files) {
  const filePath = join(recordingsDir, file);
  const label = file.replace(/\.json$/, "");

  try {
    const recording = loadFixture(filePath);

    // Validate recording structure
    assertRecordingShape(recording, label);

    // Replay through FixtureReplayer and verify responses
    const replayer = new FixtureReplayer(recording);
    const assistantTurns = recording.turns.filter(
      (t) => t.role === "assistant",
    );

    for (let i = 0; i < assistantTurns.length; i++) {
      const response = replayer.nextResponse();
      if (!response) {
        throw new Error(
          `Replayer exhausted at turn ${i}, expected ${assistantTurns.length} assistant turns`,
        );
      }
      assertTurnShape(response, `${label} turn ${i}`);

      // Verify response matches the original
      if (response.content !== assistantTurns[i].content) {
        throw new Error(
          `Turn ${i} content mismatch: "${response.content}" !== "${assistantTurns[i].content}"`,
        );
      }
    }

    // Verify replayer is exhausted
    const extra = replayer.nextResponse();
    if (extra !== null) {
      throw new Error(
        "Replayer returned extra responses beyond expected count",
      );
    }

    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err: any) {
    console.error(`  FAIL  ${label}: ${err.message}`);
    failed++;
  }
}

console.log(`\nFixture tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

function assertRecordingShape(
  recording: FixtureRecording,
  label: string,
): void {
  if (!recording.name || typeof recording.name !== "string") {
    throw new Error(`${label}: missing or invalid 'name'`);
  }
  if (!Array.isArray(recording.turns) || recording.turns.length === 0) {
    throw new Error(`${label}: 'turns' must be a non-empty array`);
  }
  for (const turn of recording.turns) {
    assertTurnShape(turn, label);
  }
}

function assertTurnShape(turn: FixtureTurn, label: string): void {
  if (turn.role !== "user" && turn.role !== "assistant") {
    throw new Error(`${label}: invalid role "${turn.role}"`);
  }
  if (typeof turn.content !== "string") {
    throw new Error(`${label}: turn content must be a string`);
  }
  if (turn.toolUses) {
    if (!Array.isArray(turn.toolUses)) {
      throw new Error(`${label}: toolUses must be an array`);
    }
    for (const tool of turn.toolUses) {
      if (!tool.name || typeof tool.name !== "string") {
        throw new Error(`${label}: tool use missing 'name'`);
      }
      if (!tool.input || typeof tool.input !== "object") {
        throw new Error(`${label}: tool use missing 'input'`);
      }
    }
  }
}
