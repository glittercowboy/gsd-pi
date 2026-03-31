import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

// ─── #2942: Zombie .gsd state skips init wizard ─────────────────────────────
//
// A partially initialized .gsd/ (symlink exists but no PREFERENCES.md or
// milestones/) causes the init wizard gate in showSmartEntry to be skipped,
// resulting in an uninitialized project session.

const guidedFlowSrc = readFileSync(
  join(import.meta.dirname, "..", "guided-flow.ts"),
  "utf-8",
);

const autoStartSrc = readFileSync(
  join(import.meta.dirname, "..", "auto-start.ts"),
  "utf-8",
);

test("#2942: guided-flow.ts defines showSmartEntry", () => {
  const smartEntryIdx = guidedFlowSrc.indexOf("export async function showSmartEntry(");
  assert.ok(smartEntryIdx >= 0, "guided-flow.ts defines showSmartEntry");
});

test("#2942: init wizard gate checks for PREFERENCES.md, not just .gsd/ existence", () => {
  const smartEntryIdx = guidedFlowSrc.indexOf("export async function showSmartEntry(");
  assert.ok(smartEntryIdx >= 0, "guided-flow.ts defines showSmartEntry");

  const afterSmartEntry = guidedFlowSrc.slice(smartEntryIdx, smartEntryIdx + 3000);

  assert.ok(
    afterSmartEntry.includes("PREFERENCES.md") || afterSmartEntry.includes("PREFERENCES"),
    "init wizard gate checks for PREFERENCES.md, not just .gsd/ existence (#2942)",
  );
});

test("#2942: init wizard gate checks for milestones/ directory, not just .gsd/ existence", () => {
  const smartEntryIdx = guidedFlowSrc.indexOf("export async function showSmartEntry(");
  assert.ok(smartEntryIdx >= 0, "guided-flow.ts defines showSmartEntry");

  const afterSmartEntry = guidedFlowSrc.slice(smartEntryIdx, smartEntryIdx + 3000);

  assert.ok(
    afterSmartEntry.includes("milestones"),
    "init wizard gate checks for milestones/ directory, not just .gsd/ existence (#2942)",
  );
});

test("#2942: detection preamble gate references bootstrap artifacts", () => {
  const smartEntryIdx = guidedFlowSrc.indexOf("export async function showSmartEntry(");
  assert.ok(smartEntryIdx >= 0, "guided-flow.ts defines showSmartEntry");

  const afterSmartEntry = guidedFlowSrc.slice(smartEntryIdx, smartEntryIdx + 3000);

  const detectionPreambleIdx = afterSmartEntry.indexOf("Detection preamble");
  const detectionRegion = detectionPreambleIdx >= 0
    ? afterSmartEntry.slice(detectionPreambleIdx, detectionPreambleIdx + 600)
    : afterSmartEntry.slice(0, 1500);

  assert.match(
    detectionRegion,
    /PREFERENCES\.md|milestones/,
    "detection preamble gate references bootstrap artifacts, not just directory existence (#2942)",
  );
});

test("#2942: auto-start.ts calls ensureGsdSymlink(base)", () => {
  const symlinkIdx = autoStartSrc.indexOf("ensureGsdSymlink(base)");
  assert.ok(symlinkIdx >= 0, "auto-start.ts calls ensureGsdSymlink(base)");
});

test("#2942: auto-start.ts creates milestones/ directory after ensureGsdSymlink", () => {
  const symlinkIdx = autoStartSrc.indexOf("ensureGsdSymlink(base)");
  assert.ok(symlinkIdx >= 0, "auto-start.ts calls ensureGsdSymlink(base)");

  const afterSymlink = autoStartSrc.slice(symlinkIdx, symlinkIdx + 800);

  assert.ok(
    afterSymlink.includes("milestones") && afterSymlink.includes("mkdirSync"),
    "auto-start.ts creates milestones/ directory after ensureGsdSymlink (#2942)",
  );
});

test("#2942: milestones bootstrap checks milestones path existence, not .gsd/", () => {
  const symlinkIdx = autoStartSrc.indexOf("ensureGsdSymlink(base)");
  assert.ok(symlinkIdx >= 0, "auto-start.ts calls ensureGsdSymlink(base)");

  const afterSymlink = autoStartSrc.slice(symlinkIdx, symlinkIdx + 800);
  const mkdirRegion = afterSymlink.slice(0, afterSymlink.indexOf("mkdirSync") + 200);

  assert.match(
    mkdirRegion,
    /existsSync\([^)]*milestones/,
    "milestones bootstrap checks milestones path existence, not .gsd/ (#2942)",
  );
});
