import test from "node:test";
import assert from "node:assert/strict";

const { builtinThemes } = await import("../../packages/pi-coding-agent/src/modes/interactive/theme/themes.ts");

test("tui-classic built-in theme preserves legacy PR palette tokens", () => {
  assert.ok("tui-classic" in builtinThemes, "tui-classic should be available as a built-in theme");
  const theme = builtinThemes["tui-classic"];

  assert.equal(theme.vars?.accent, "#8abeb7");
  assert.equal(theme.vars?.cyan, "#00d7ff");
  assert.equal(theme.colors.warning, "yellow");
  assert.equal(theme.colors.toolPendingBg, "toolPendingBg");
});

