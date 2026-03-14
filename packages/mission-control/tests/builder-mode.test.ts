/**
 * builder-mode.test.ts — tests for BUILDER-01, BUILDER-02, BUILDER-03
 *
 * Tests:
 * 1. BUILDER_VOCAB maps milestone/slice/task/mustHaves/uat/decisionLog correctly
 * 2. DEVELOPER_VOCAB maps default terminology
 * 3. InterfaceModeContext default value has builderMode===false and DEVELOPER_VOCAB
 * 4. SettingsView source text contains 'interface_mode' and 'Builder' (static analysis)
 * 5. MISSING — classifyIntent stub (Plan 18-02 will fill this)
 */
import { describe, it, expect } from "bun:test";
import { BUILDER_VOCAB, DEVELOPER_VOCAB } from "../src/lib/builder-vocab";
import { InterfaceModeContext } from "../src/context/InterfaceModeContext";
import { classifyIntent } from "../src/server/classify-intent-api";

describe("builder-vocab", () => {
  it("BUILDER_VOCAB maps milestone → Version", () => {
    expect(BUILDER_VOCAB.milestone).toBe("Version");
  });

  it("BUILDER_VOCAB maps slice → Feature", () => {
    expect(BUILDER_VOCAB.slice).toBe("Feature");
  });

  it("BUILDER_VOCAB maps task → Step", () => {
    expect(BUILDER_VOCAB.task).toBe("Step");
  });

  it("BUILDER_VOCAB maps mustHaves → Goals", () => {
    expect(BUILDER_VOCAB.mustHaves).toBe("Goals");
  });

  it("BUILDER_VOCAB maps uat → Testing", () => {
    expect(BUILDER_VOCAB.uat).toBe("Testing");
  });

  it("BUILDER_VOCAB maps decisionLog → Your decisions so far", () => {
    expect(BUILDER_VOCAB.decisionLog).toBe("Your decisions so far");
  });
});

describe("developer-vocab", () => {
  it("DEVELOPER_VOCAB maps slice → Slice", () => {
    expect(DEVELOPER_VOCAB.slice).toBe("Slice");
  });

  it("DEVELOPER_VOCAB maps milestone → Milestone", () => {
    expect(DEVELOPER_VOCAB.milestone).toBe("Milestone");
  });

  it("DEVELOPER_VOCAB maps decisionLog → Decisions", () => {
    expect(DEVELOPER_VOCAB.decisionLog).toBe("Decisions");
  });
});

describe("InterfaceModeContext defaults", () => {
  it("default context value has builderMode === false", () => {
    // Access the raw context default value
    // React.createContext stores defaultValue internally; we access it via _currentValue
    const ctx = InterfaceModeContext as unknown as { _currentValue: { builderMode: boolean; vocab: typeof DEVELOPER_VOCAB } };
    expect(ctx._currentValue.builderMode).toBe(false);
  });

  it("default context value has DEVELOPER_VOCAB", () => {
    const ctx = InterfaceModeContext as unknown as { _currentValue: { builderMode: boolean; vocab: typeof DEVELOPER_VOCAB } };
    expect(ctx._currentValue.vocab).toEqual(DEVELOPER_VOCAB);
  });
});

describe("SettingsView static analysis", () => {
  it("SettingsView source contains interface_mode", async () => {
    const src = await Bun.file("src/components/views/SettingsView.tsx").text();
    expect(src.includes("interface_mode")).toBe(true);
  });

  it("SettingsView source contains Builder", async () => {
    const src = await Bun.file("src/components/views/SettingsView.tsx").text();
    expect(src.includes("Builder")).toBe(true);
  });
});

describe("classifyIntent import", () => {
  it("classifyIntent is a function (Plan 18-02)", () => {
    expect(typeof classifyIntent).toBe("function");
  });
});
