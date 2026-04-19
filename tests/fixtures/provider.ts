import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

/**
 * A single tool use within a conversation turn.
 */
export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
}

/**
 * A file referenced in a fixture (for setup or assertions).
 */
export interface FixtureFile {
  path: string;
  content: string;
}

/**
 * A single turn in a recorded LLM conversation.
 */
export interface FixtureTurn {
  role: "user" | "assistant";
  content: string;
  toolUses?: ToolUse[];
}

/**
 * A complete fixture recording.
 */
export interface FixtureRecording {
  name: string;
  description?: string;
  turns: FixtureTurn[];
  files?: FixtureFile[];
}

/**
 * Returns the current fixture mode from the environment.
 */
export function getFixtureMode(): "record" | "replay" | "off" {
  const mode = process.env.GSD_FIXTURE_MODE?.toLowerCase();
  if (mode === "record") return "record";
  if (mode === "replay") return "replay";
  return "off";
}

/**
 * Returns the fixture recordings directory path.
 */
export function getFixtureDir(): string {
  return (
    process.env.GSD_FIXTURE_DIR ||
    new URL("recordings", import.meta.url).pathname
  );
}

/**
 * Loads a fixture recording from a JSON file.
 */
export function loadFixture(filePath: string): FixtureRecording {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as FixtureRecording;
}

/**
 * Saves a fixture recording to a JSON file.
 */
export function saveFixture(
  filePath: string,
  recording: FixtureRecording,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(recording, null, 2) + "\n");
}

/**
 * Creates a readable stream of responses from a fixture recording,
 * returning one assistant turn at a time.
 */
export function createReplayStream(
  recording: FixtureRecording,
): Iterator<FixtureTurn> {
  const assistantTurns = recording.turns.filter((t) => t.role === "assistant");
  let index = 0;
  return {
    next(): IteratorResult<FixtureTurn> {
      if (index < assistantTurns.length) {
        return { value: assistantTurns[index++], done: false };
      }
      return { value: undefined as any, done: true };
    },
  };
}

/**
 * Records conversation turns and saves them as a fixture.
 */
export class FixtureRecorder {
  private turns: FixtureTurn[] = [];
  private files: FixtureFile[] = [];
  private name: string;
  private description?: string;

  constructor(name: string, description?: string) {
    this.name = name;
    this.description = description;
  }

  addTurn(turn: FixtureTurn): void {
    this.turns.push(turn);
  }

  addFile(file: FixtureFile): void {
    this.files.push(file);
  }

  save(filePath: string): void {
    const recording: FixtureRecording = {
      name: this.name,
      ...(this.description ? { description: this.description } : {}),
      turns: this.turns,
      ...(this.files.length > 0 ? { files: this.files } : {}),
    };
    saveFixture(filePath, recording);
  }

  getTurns(): FixtureTurn[] {
    return [...this.turns];
  }
}

/**
 * Replays saved fixture responses by turn index.
 */
export class FixtureReplayer {
  private stream: Iterator<FixtureTurn>;

  constructor(recording: FixtureRecording) {
    this.stream = createReplayStream(recording);
  }

  nextResponse(): FixtureTurn | null {
    const result = this.stream.next();
    return result.done ? null : result.value;
  }
}
