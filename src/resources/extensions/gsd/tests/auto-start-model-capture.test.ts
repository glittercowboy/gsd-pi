import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourcePath = join(import.meta.dirname, "..", "auto-start.ts");
const source = readFileSync(sourcePath, "utf-8");

test("bootstrapAutoSession snapshots ctx.model before guided-flow entry (#2829)", () => {
  // #3517 changed the snapshot to prefer GSD preferences, but the ordering
  // guarantee still holds: the snapshot must be built before guided-flow.
  const snapshotIdx = source.indexOf("const startModelSnapshot = preferredModel");
  assert.ok(snapshotIdx > -1, "auto-start.ts should snapshot model at bootstrap start");

  const firstDiscussIdx = source.indexOf('await showSmartEntry(ctx, pi, base, { step: requestedStepMode });');
  assert.ok(firstDiscussIdx > -1, "auto-start.ts should route through showSmartEntry during guided flow");

  assert.ok(
    snapshotIdx < firstDiscussIdx,
    "auto-start.ts must capture the start model before guided-flow can mutate ctx.model",
  );
});

test("bootstrapAutoSession restores autoModeStartModel from the early snapshot (#2829)", () => {
  const assignmentIdx = source.indexOf("s.autoModeStartModel = {");
  assert.ok(assignmentIdx > -1, "auto-start.ts should assign autoModeStartModel");

  const snapshotRefIdx = source.indexOf("provider: startModelSnapshot.provider", assignmentIdx);
  assert.ok(snapshotRefIdx > -1, "autoModeStartModel should be restored from startModelSnapshot");
});

test("bootstrapAutoSession prefers GSD PREFERENCES.md over settings.json for start model (#3517)", () => {
  // resolveDefaultSessionModel() should be called before the snapshot is built
  const preferredIdx = source.indexOf("const preferredModel = resolveDefaultSessionModel(");
  assert.ok(preferredIdx > -1, "auto-start.ts should call resolveDefaultSessionModel()");

  // Session provider should be passed for bare model ID resolution
  const withProviderIdx = source.indexOf("resolveDefaultSessionModel(ctx.model?.provider)");
  assert.ok(withProviderIdx > -1, "auto-start.ts should pass ctx.model?.provider for bare ID resolution");

  const snapshotIdx = source.indexOf("const startModelSnapshot = preferredModel");
  assert.ok(snapshotIdx > -1, "startModelSnapshot should use preferredModel when available");

  assert.ok(
    preferredIdx < snapshotIdx,
    "resolveDefaultSessionModel() must be called before building startModelSnapshot",
  );
});
