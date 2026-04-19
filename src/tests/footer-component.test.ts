import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const footerSource = readFileSync(
  join(process.cwd(), "packages", "pi-coding-agent", "src", "modes", "interactive", "components", "footer.ts"),
  "utf-8",
);

test("FooterComponent dims the pwd row including right-aligned extension statuses", () => {
  // Extension statuses now render on the right side of the pwd line instead
  // of a dedicated row. The whole line is wrapped in a single dim() call.
  assert.match(
    footerSource,
    /theme\.fg\("dim", pwd \+ padding \+ extStatusText\)/,
    "pwd row with merged extension statuses should be wrapped in the dim footer color",
  );
});
