import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashboardPath = join(process.cwd(), "web", "components", "gsd", "dashboard.tsx");
const source = readFileSync(dashboardPath, "utf-8");

test("dashboard renders an RTK Saved metric card", () => {
  assert.match(source, /label="RTK Saved"/, "dashboard should render an RTK Saved card");
});

test("dashboard fetches the RTK savings API", () => {
  assert.match(source, /buildProjectPath\("\/api\/rtk-savings"/, "dashboard should fetch /api/rtk-savings");
});
