// gsd-pi — Regression tests for the validate-milestone stuck-loop guard (#4094)

import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runPostUnitVerification, type VerificationContext } from "../auto-verification.ts";
import { AutoSession } from "../auto/session.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { _clearGsdRootCache } from "../paths.ts";

let tempDir: string;
let dbPath: string;
let originalCwd: string;

function makeMockCtx() {
  return {
    ui: {
      notify: mock.fn(),
      setStatus: () => {},
      setWidget: () => {},
      setFooter: () => {},
    },
    model: { id: "test-model" },
  } as any;
}

function makeMockPi() {
  return {
    sendMessage: mock.fn(),
    setModel: mock.fn(async () => true),
  } as any;
}

function makeMockSession(basePath: string, unitType: string, unitId: string): AutoSession {
  const s = new AutoSession();
  s.basePath = basePath;
  s.active = true;
  s.pendingVerificationRetry = null;
  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  return s;
}

function setupTestEnvironment(): void {
  originalCwd = process.cwd();
  tempDir = join(tmpdir(), `validate-milestone-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });

  const milestoneDir = join(tempDir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });

  process.chdir(tempDir);
  _clearGsdRootCache();

  dbPath = join(tempDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  invalidateAllCaches();
}

function cleanupTestEnvironment(): void {
  try { process.chdir(originalCwd); } catch { /* ignore */ }
  try { closeDatabase(); } catch { /* ignore */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeValidationFile(verdict: string): void {
  const path = join(tempDir, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  const content = `---
verdict: ${verdict}
remediation_round: 1
---

# Milestone Validation: M001

## Verdict Rationale
Test fixture
`;
  writeFileSync(path, content, "utf-8");
  invalidateAllCaches();
}

describe("validate-milestone stuck-loop guard (#4094)", () => {
  beforeEach(() => setupTestEnvironment());
  afterEach(() => cleanupTestEnvironment());

  test("pauses when verdict=needs-remediation and all slices are closed", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice 2", status: "done" });
    writeValidationFile("needs-remediation");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
    assert.equal(ctx.ui.notify.mock.callCount(), 1);
    const notifyArgs = ctx.ui.notify.mock.calls[0].arguments;
    assert.match(notifyArgs[0], /needs-remediation/);
    assert.equal(notifyArgs[1], "error");
  });

  test("treats skipped slices as closed", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice 2", status: "skipped" });
    writeValidationFile("needs-remediation");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
  });

  test("continues when verdict=needs-remediation but a queued remediation slice exists", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Remediation", status: "queued" });
    writeValidationFile("needs-remediation");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("continues when verdict is pass", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeValidationFile("pass");

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });

  test("continues when no VALIDATION file exists yet", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, "validate-milestone", "M001");

    const result = await runPostUnitVerification({ s, ctx, pi } as VerificationContext, pauseAutoMock);

    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });
});
