import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const footerSource = readFileSync(
  join(process.cwd(), "packages", "pi-coding-agent", "src", "modes", "interactive", "components", "footer.ts"),
  "utf-8",
);

test("FooterComponent dims extension status lines to match the rest of the footer", () => {
  assert.match(
    footerSource,
    /theme\.fg\("dim", statusLine\)/,
    "extension status line should be wrapped in the dim footer color",
  );
});
