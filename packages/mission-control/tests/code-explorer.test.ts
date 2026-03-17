import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Code Explorer", () => {
  test("useCodeExplorer hook exports expected interface", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/code-explorer/useCodeExplorer.ts"), "utf8");
    expect(src).toContain("isOpen");
    expect(src).toContain("openExplorer");
    expect(src).toContain("closeExplorer");
    expect(src).toContain("selectedFile");
    expect(src).toContain("selectFile");
    expect(src).toContain("LAST_FILE_KEY");
    expect(src).toContain("localStorage");
  });

  test("CodeExplorer modal renders when open", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/code-explorer/CodeExplorer.tsx"), "utf8");
    expect(src).toContain("Code Explorer");
    expect(src).toContain("FileTree");
    expect(src).toContain("FileEditor");
    expect(src).toContain("onClose");
    expect(src).toContain("api/fs/read");
    expect(src).toContain("api/fs/write");
  });

  test("FileTree uses /api/fs/list to load entries", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/code-explorer/FileTree.tsx"), "utf8");
    expect(src).toContain("api/fs/list");
    expect(src).toContain("onSelectFile");
    expect(src).toContain("expandedDirs");
  });

  test("FileEditor uses CodeMirror", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/code-explorer/FileEditor.tsx"), "utf8");
    expect(src).toContain("EditorView");
    expect(src).toContain("basicSetup");
    expect(src).toContain("oneDark");
    expect(src).toContain("Mod-s");
  });

  test("Sidebar has Code Explorer button", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/layout/Sidebar.tsx"), "utf8");
    expect(src).toContain("Code Explorer");
    expect(src).toContain("onOpenCodeExplorer");
  });

  test("AppShell wires Code Explorer modal", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/layout/AppShell.tsx"), "utf8");
    expect(src).toContain("useCodeExplorer");
    expect(src).toContain("CodeExplorer");
    expect(src).toContain("codeExplorerOpen");
  });
});
