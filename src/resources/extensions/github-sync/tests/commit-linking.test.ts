import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTaskCommitMessage } from "../../gsd/git-service.ts";

describe("commit linking", () => {
  it("appends Resolves #N when issueNumber is set", () => {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "implement auth",
      issueNumber: 43,
    });
    assert.ok(msg.includes("Resolves #43"), "should include Resolves trailer");
    assert.ok(msg.startsWith("feat:"), "subject line has no scope");
    assert.ok(msg.includes("GSD-Task: S01/T02"), "GSD-Task trailer present");
  });

  it("includes both key files and Resolves #N", () => {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "implement auth",
      keyFiles: ["src/auth.ts"],
      issueNumber: 43,
    });
    assert.ok(msg.includes("- src/auth.ts"), "key files present");
    assert.ok(msg.includes("Resolves #43"), "Resolves trailer present");
    assert.ok(msg.includes("GSD-Task: S01/T02"), "GSD-Task trailer present");
    // GSD-Task should come after key files but before Resolves
    const keyFilesIdx = msg.indexOf("- src/auth.ts");
    const taskIdx = msg.indexOf("GSD-Task: S01/T02");
    const resolvesIdx = msg.indexOf("Resolves #43");
    assert.ok(taskIdx > keyFilesIdx, "GSD-Task after key files");
    assert.ok(resolvesIdx > taskIdx, "Resolves after GSD-Task");
  });

  it("no Resolves trailer when issueNumber is not set", () => {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "implement auth",
    });
    assert.ok(!msg.includes("Resolves"), "no Resolves when no issueNumber");
    assert.ok(msg.includes("GSD-Task: S01/T02"), "GSD-Task trailer still present");
  });
});
