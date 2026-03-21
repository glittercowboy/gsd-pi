import test from "node:test";
import assert from "node:assert/strict";

import {
  atomicWriteAsyncWithOps,
  atomicWriteSyncWithOps,
  type AtomicWriteAsyncOps,
  type AtomicWriteSyncOps,
} from "../atomic-write.ts";

function makeError(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function createAsyncHarness(plan: Array<Error | null>) {
  const files = new Map<string, string>();
  const renameCalls: Array<{ from: string; to: string }> = [];
  const unlinkCalls: string[] = [];
  const sleepCalls: number[] = [];
  let tempCounter = 0;

  const ops: AtomicWriteAsyncOps = {
    mkdir: async () => {},
    writeFile: async (path, content) => {
      files.set(path, String(content));
    },
    rename: async (from, to) => {
      renameCalls.push({ from, to });
      const outcome = plan.shift() ?? null;
      if (outcome) throw outcome;
      const content = files.get(from);
      if (content === undefined) throw makeError("ENOENT", "temp missing");
      files.set(to, content);
      files.delete(from);
    },
    unlink: async (path) => {
      unlinkCalls.push(path);
      files.delete(path);
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`,
  };

  return { ops, files, renameCalls, unlinkCalls, sleepCalls };
}

function createSyncHarness(plan: Array<Error | null>) {
  const files = new Map<string, string>();
  const renameCalls: Array<{ from: string; to: string }> = [];
  const unlinkCalls: string[] = [];
  const sleepCalls: number[] = [];
  let tempCounter = 0;

  const ops: AtomicWriteSyncOps = {
    mkdir: () => {},
    writeFile: (path, content) => {
      files.set(path, String(content));
    },
    rename: (from, to) => {
      renameCalls.push({ from, to });
      const outcome = plan.shift() ?? null;
      if (outcome) throw outcome;
      const content = files.get(from);
      if (content === undefined) throw makeError("ENOENT", "temp missing");
      files.set(to, content);
      files.delete(from);
    },
    unlink: (path) => {
      unlinkCalls.push(path);
      files.delete(path);
    },
    sleep: (ms) => {
      sleepCalls.push(ms);
    },
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`,
  };

  return { ops, files, renameCalls, unlinkCalls, sleepCalls };
}

test("atomicWriteAsync retries transient rename failures and preserves atomicity", async () => {
  const harness = createAsyncHarness([makeError("EBUSY"), makeError("EPERM"), null]);
  harness.files.set("C:/tmp/output.txt", "old-content");

  await atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops);

  assert.equal(harness.renameCalls.length, 3);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "new-content");
  assert.equal(harness.unlinkCalls.length, 0);
  assert.equal(harness.sleepCalls.length, 2);
});

test("atomicWriteAsync cleans up temp file and reports attempts after repeated transient failures", async () => {
  const harness = createAsyncHarness([
    makeError("EACCES"),
    makeError("EBUSY"),
    makeError("EPERM"),
    makeError("EACCES"),
    makeError("EBUSY"),
  ]);
  harness.files.set("C:/tmp/output.txt", "old-content");

  await assert.rejects(
    atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops),
    (error: unknown) => {
      assert.match(String(error), /C:\\\/tmp\/output\.txt|C:\/tmp\/output\.txt/);
      assert.match(String(error), /attempt/i);
      assert.match(String(error), /EBUSY|EPERM|EACCES/);
      return true;
    },
  );

  assert.equal(harness.renameCalls.length, 5);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "old-content");
  assert.equal(harness.unlinkCalls.length, 1);
});

test("atomicWriteAsync does not retry non-transient rename failures", async () => {
  const harness = createAsyncHarness([makeError("ENOENT")]);
  harness.files.set("C:/tmp/output.txt", "old-content");

  await assert.rejects(() => atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops));

  assert.equal(harness.renameCalls.length, 1);
  assert.equal(harness.sleepCalls.length, 0);
  assert.equal(harness.unlinkCalls.length, 1);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "old-content");
});

test("atomicWriteSync retries transient rename failures and succeeds", () => {
  const harness = createSyncHarness([makeError("EACCES"), makeError("EBUSY"), null]);
  harness.files.set("C:/tmp/output.txt", "old-content");

  atomicWriteSyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops);

  assert.equal(harness.renameCalls.length, 3);
  assert.equal(harness.sleepCalls.length, 2);
  assert.equal(harness.unlinkCalls.length, 0);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "new-content");
});
