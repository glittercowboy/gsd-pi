import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

/**
 * Test suite for #2941: Forensics report context lost on follow-up turns.
 *
 * The forensics flow sends a one-shot message via sendMessage() with
 * triggerTurn: true. On follow-up turns, the context is gone because
 * there's no re-injection mechanism like buildGuidedExecuteContextInjection
 * provides for task execution.
 *
 * Fix: write an active-forensics.json marker when forensics starts, and
 * have buildBeforeAgentStartResult() re-inject the forensics prompt on
 * subsequent turns.
 */

describe("forensics context persistence (#2941)", () => {
  // ─── Source-level invariant tests ──────────────────────────────────────────

  it("forensics.ts writes active-forensics marker after saving report", () => {
    const src = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
    assert.ok(
      src.includes("active-forensics.json"),
      "forensics.ts must reference active-forensics.json marker file",
    );
    assert.ok(
      src.includes("writeForensicsMarker"),
      "forensics.ts must call writeForensicsMarker to persist session state",
    );
  });

  it("system-context.ts checks for active forensics marker in buildBeforeAgentStartResult", () => {
    const src = readFileSync(join(gsdDir, "bootstrap", "system-context.ts"), "utf-8");
    assert.ok(
      src.includes("active-forensics.json"),
      "system-context.ts must check for active-forensics.json marker",
    );
    assert.ok(
      src.includes("gsd-forensics"),
      "system-context.ts must inject gsd-forensics customType message",
    );
  });

  it("system-context.ts exports clearForensicsMarker for cleanup", () => {
    const src = readFileSync(join(gsdDir, "bootstrap", "system-context.ts"), "utf-8");
    assert.ok(
      src.includes("clearForensicsMarker"),
      "system-context.ts must export clearForensicsMarker function",
    );
  });

  // ─── Functional tests using temp directories ──────────────────────────────

  const tmpBase = join(__dirname, "__tmp_forensics_persist__");

  beforeEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    mkdirSync(join(tmpBase, ".gsd", "runtime"), { recursive: true });
    mkdirSync(join(tmpBase, ".gsd", "forensics"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("writeForensicsMarker creates marker with reportPath and promptContent", async () => {
    const { writeForensicsMarker } = await import("../forensics.ts");

    const reportPath = join(tmpBase, ".gsd", "forensics", "report-2026-01-01.md");
    writeFileSync(reportPath, "# Test Report", "utf-8");

    writeForensicsMarker(tmpBase, reportPath, "Test forensics prompt content");

    const markerPath = join(tmpBase, ".gsd", "runtime", "active-forensics.json");
    assert.ok(existsSync(markerPath), "marker file must be created");

    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    assert.equal(marker.reportPath, reportPath);
    assert.equal(marker.promptContent, "Test forensics prompt content");
    assert.ok(marker.createdAt, "marker must have createdAt timestamp");
  });

  it("readForensicsMarker returns null when no marker exists", async () => {
    const { readForensicsMarker } = await import("../forensics.ts");

    const result = readForensicsMarker(join(tmpBase, "nonexistent"));
    assert.equal(result, null);
  });

  it("readForensicsMarker returns marker data when file exists", async () => {
    const { readForensicsMarker } = await import("../forensics.ts");

    const markerPath = join(tmpBase, ".gsd", "runtime", "active-forensics.json");
    const markerData = {
      reportPath: "/some/report.md",
      promptContent: "forensics prompt",
      createdAt: new Date().toISOString(),
    };
    writeFileSync(markerPath, JSON.stringify(markerData), "utf-8");

    const result = readForensicsMarker(tmpBase);
    assert.ok(result);
    assert.equal(result.reportPath, "/some/report.md");
    assert.equal(result.promptContent, "forensics prompt");
  });

  it("clearForensicsMarker removes the marker file", async () => {
    const { clearForensicsMarker } = await import("../bootstrap/system-context.ts");

    const markerPath = join(tmpBase, ".gsd", "runtime", "active-forensics.json");
    writeFileSync(markerPath, JSON.stringify({ reportPath: "/x", promptContent: "y", createdAt: new Date().toISOString() }), "utf-8");
    assert.ok(existsSync(markerPath), "precondition: marker must exist");

    clearForensicsMarker(tmpBase);
    assert.ok(!existsSync(markerPath), "marker must be removed after clear");
  });

  it("clearForensicsMarker is a no-op when no marker exists", async () => {
    const { clearForensicsMarker } = await import("../bootstrap/system-context.ts");
    // Should not throw
    clearForensicsMarker(join(tmpBase, "nonexistent"));
  });

  it("buildForensicsContextInjection keeps marker for low-entropy resume prompts", async () => {
    const { buildForensicsContextInjection } = await import("../bootstrap/system-context.ts");

    const markerPath = join(tmpBase, ".gsd", "runtime", "active-forensics.json");
    writeFileSync(markerPath, JSON.stringify({
      reportPath: "/some/report.md",
      promptContent: "forensics prompt",
      createdAt: new Date().toISOString(),
    }), "utf-8");

    const result = buildForensicsContextInjection(tmpBase, "continue");
    assert.equal(result, "forensics prompt");
    assert.ok(existsSync(markerPath), "resume-like follow-up should keep marker intact");
  });

  it("buildForensicsContextInjection clears marker on unrelated user prompts", async () => {
    const { buildForensicsContextInjection } = await import("../bootstrap/system-context.ts");

    const markerPath = join(tmpBase, ".gsd", "runtime", "active-forensics.json");
    writeFileSync(markerPath, JSON.stringify({
      reportPath: "/some/report.md",
      promptContent: "forensics prompt",
      createdAt: new Date().toISOString(),
    }), "utf-8");

    const result = buildForensicsContextInjection(tmpBase, "please summarize the README");
    assert.equal(result, null);
    assert.ok(!existsSync(markerPath), "unrelated follow-up should clear the stale marker");
  });
});
