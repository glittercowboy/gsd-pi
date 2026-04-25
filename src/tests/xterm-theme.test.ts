import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { getXtermTheme, getXtermOptions } = await import("../../web/lib/xterm-theme.ts");

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((char) => char + char).join("")
    : normalized;
  const int = Number.parseInt(value, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function srgbToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("light xterm palette keeps warning and ANSI white entries readable", () => {
  const theme = getXtermTheme(false);

  assert.ok(contrastRatio(theme.foreground, theme.background) >= 14, "foreground should remain highly legible");
  assert.ok(contrastRatio(theme.yellow, theme.background) >= 4.5, "yellow should meet readable contrast");
  assert.ok(contrastRatio(theme.brightYellow, theme.background) >= 4.5, "bright yellow should meet readable contrast");
  assert.ok(contrastRatio(theme.white, theme.background) >= 4.5, "white should stay readable on light background");
  assert.ok(contrastRatio(theme.brightWhite, theme.background) >= 4.5, "bright white should stay readable on light background");
});

test("terminal components share the central xterm theme helper", () => {
  const shellSource = readFileSync(
    resolve(import.meta.dirname, "../../web/components/gsd/shell-terminal.tsx"),
    "utf8",
  );
  const mainSource = readFileSync(
    resolve(import.meta.dirname, "../../web/components/gsd/main-session-terminal.tsx"),
    "utf8",
  );

  assert.match(shellSource, /from \"@\/lib\/xterm-theme\"/);
  assert.match(mainSource, /from \"@\/lib\/xterm-theme\"/);
  assert.doesNotMatch(shellSource, /const XTERM_LIGHT_THEME =/);
  assert.doesNotMatch(mainSource, /const XTERM_LIGHT_THEME =/);
});

test("xterm palette mode defaults to classic and supports vivid override", () => {
  const classicDark = getXtermTheme(true, "classic");
  const vividDark = getXtermTheme(true, "vivid");
  const defaultDark = getXtermTheme(true);

  assert.equal(classicDark.red, "#cc6666");
  assert.equal(vividDark.red, "#ff6b8a");
  assert.deepEqual(defaultDark, classicDark, "default palette mode should remain classic");

  const vividOptions = getXtermOptions(true, 13, "vivid");
  assert.equal(vividOptions.theme.red, "#ff6b8a");
});
