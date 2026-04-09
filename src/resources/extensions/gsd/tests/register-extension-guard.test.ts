import test from "node:test";
import assert from "node:assert/strict";

import { handleRecoverableExtensionProcessError } from "../bootstrap/register-extension.ts";

test("handleRecoverableExtensionProcessError swallows spawn ENOENT", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const handled = handleRecoverableExtensionProcessError(
      Object.assign(new Error("missing binary"), {
        code: "ENOENT",
        syscall: "spawn npm",
        path: "npm",
      }),
    );
    assert.equal(handled, true);
    assert.match(stderr, /spawn ENOENT: npm/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("handleRecoverableExtensionProcessError swallows uv_cwd ENOENT", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const handled = handleRecoverableExtensionProcessError(
      Object.assign(new Error("process.cwd failed"), {
        code: "ENOENT",
        syscall: "uv_cwd",
      }),
    );
    assert.equal(handled, true);
    assert.match(stderr, /ENOENT \(uv_cwd\): process\.cwd failed/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("handleRecoverableExtensionProcessError leaves unrelated errors unhandled", () => {
  const handled = handleRecoverableExtensionProcessError(
    Object.assign(new Error("permission denied"), {
      code: "EPERM",
      syscall: "open",
    }),
  );
  assert.equal(handled, false);
});
