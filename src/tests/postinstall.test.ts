import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("postinstall respects PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", () => {
  const result = spawnSync("node", ["scripts/postinstall.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      GSD_SKIP_RTK_INSTALL: "1",
    },
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, `postinstall exits cleanly: ${result.stderr}`);
});
