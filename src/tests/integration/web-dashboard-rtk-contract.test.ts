import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashboardPath = join(process.cwd(), "web", "components", "gsd", "dashboard.tsx");
const source = readFileSync(dashboardPath, "utf-8");

test("dashboard gates RTK Saved metric card on rtkEnabled", () => {
  assert.match(source, /rtkEnabled && \(/, "dashboard should gate the RTK card on rtkEnabled");
  assert.match(source, /label="RTK Saved"/, "dashboard should contain an RTK Saved card (gated)");
});

test("dashboard reads rtkEnabled from live auto state", () => {
  assert.match(source, /const rtkEnabled = auto\?\.rtkEnabled === true/, "dashboard should derive rtkEnabled from the live auto payload");
});

test("dashboard reads RTK savings from live auto state", () => {
  assert.match(source, /const rtkSavings = auto\?\.rtkSavings \?\? null/, "dashboard should source RTK savings from the live auto payload");
  assert.doesNotMatch(source, /\/api\/rtk-savings/, "dashboard should not fetch RTK savings through a dedicated API route");
});
