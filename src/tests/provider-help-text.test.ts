import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Validate that help-text.ts includes updated provider references
const { printSubcommandHelp } = await import("../../dist/help-text.js");

describe("help-text provider references", () => {
  it("config help mentions OpenRouter and Ollama", () => {
    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: string) => { lines.push(chunk); return true; };
    try {
      printSubcommandHelp("config", "0.0.0");
    } finally {
      (process.stdout as any).write = origWrite;
    }
    const text = lines.join("");
    assert.ok(text.includes("OpenRouter"), "OpenRouter should be mentioned in config help");
    assert.ok(text.includes("Ollama"), "Ollama should be mentioned in config help");
    assert.ok(text.includes("docs/providers.md"), "providers.md reference should be in config help");
  });
});
