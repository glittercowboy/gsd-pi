/**
 * ANSI-aware text measurement and slicing.
 *
 * High-performance UTF-16 native implementation with ASCII fast-paths,
 * single-pass ANSI scanning, and proper Unicode grapheme cluster support.
 */

import { native } from "../native.js";
import { eastAsianWidth } from "get-east-asian-width";
import type { ExtractSegmentsResult, SliceResult } from "./types.js";

export type { ExtractSegmentsResult, SliceResult };
export { EllipsisKind } from "./types.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const DEFAULT_TAB_WIDTH = 3;
const ANSI_RESET = "\x1b[0m";

type ActiveAnsiState = {
  osc8Open: string | null;
  sgrCodes: string[];
};

type WrapToken = {
  text: string;
  width: number;
  kind: "ansi" | "grapheme" | "whitespace";
};

function isNativeUnavailableError(err: unknown, fnName: string): boolean {
  return (
    err instanceof Error &&
    err.message.includes(`Native function '${fnName}' is not available`)
  );
}

function withNativeFallback<T>(
  fnName: string,
  invoke: () => T,
  fallback: () => T,
): T {
  try {
    return invoke();
  } catch (err) {
    if (!isNativeUnavailableError(err, fnName)) throw err;
    return fallback();
  }
}

function cloneActiveState(state: ActiveAnsiState): ActiveAnsiState {
  return {
    osc8Open: state.osc8Open,
    sgrCodes: [...state.sgrCodes],
  };
}

function prefixForState(state: ActiveAnsiState): WrapToken[] {
  const tokens: WrapToken[] = [];
  if (state.osc8Open) tokens.push({ text: state.osc8Open, width: 0, kind: "ansi" });
  for (const code of state.sgrCodes) tokens.push({ text: code, width: 0, kind: "ansi" });
  return tokens;
}

function suffixForState(state: ActiveAnsiState): string {
  let suffix = "";
  if (state.sgrCodes.length > 0) suffix += ANSI_RESET;
  if (state.osc8Open) suffix += "\x1b]8;;\x07";
  return suffix;
}

function updateActiveAnsiState(state: ActiveAnsiState, seq: string): void {
  if (seq.startsWith("\x1b]8;;")) {
    if (seq === "\x1b]8;;\x07" || seq === "\x1b]8;;\x1b\\") state.osc8Open = null;
    else state.osc8Open = seq;
    return;
  }

  if (!seq.endsWith("m")) return;

  if (seq === ANSI_RESET || seq === "\x1b[m") {
    state.sgrCodes = [];
    return;
  }

  state.sgrCodes.push(seq);
}

function readAnsiSequence(text: string, start: number): string | null {
  if (text[start] !== "\x1b") return null;
  const next = text[start + 1];
  if (!next) return null;

  if (next === "[") {
    let i = start + 2;
    while (i < text.length) {
      const ch = text.charCodeAt(i);
      if (ch >= 0x40 && ch <= 0x7e) return text.slice(start, i + 1);
      i += 1;
    }
    return text.slice(start);
  }

  if (next === "]") {
    let i = start + 2;
    while (i < text.length) {
      if (text[i] === "\x07") return text.slice(start, i + 1);
      if (text[i] === "\x1b" && text[i + 1] === "\\") return text.slice(start, i + 2);
      i += 1;
    }
    return text.slice(start);
  }

  return text.slice(start, Math.min(text.length, start + 2));
}

function graphemeWidth(segment: string, tabWidth: number): number {
  if (segment === "\t") return tabWidth;
  let width = 0;
  for (const char of segment) {
    width += eastAsianWidth(char.codePointAt(0) ?? 0) === 2 ? 2 : 1;
  }
  return width;
}

function visibleWidthFallback(text: string, tabWidth = DEFAULT_TAB_WIDTH): number {
  let width = 0;
  let index = 0;

  while (index < text.length) {
    const ansi = readAnsiSequence(text, index);
    if (ansi) {
      index += ansi.length;
      continue;
    }

    const segmentData = graphemeSegmenter
      .segment(text.slice(index))
      [Symbol.iterator]()
      .next();
    const segment = segmentData.value?.segment ?? text[index]!;
    if (segment === "\n" || segment === "\r") {
      index += segment.length;
      continue;
    }

    width += graphemeWidth(segment, tabWidth);
    index += segment.length;
  }

  return width;
}

function tokenizeForWrap(text: string, tabWidth: number): WrapToken[] {
  const tokens: WrapToken[] = [];
  let index = 0;

  while (index < text.length) {
    const ansi = readAnsiSequence(text, index);
    if (ansi) {
      tokens.push({ text: ansi, width: 0, kind: "ansi" });
      index += ansi.length;
      continue;
    }

    const char = text[index];
    if (char === "\n") {
      tokens.push({ text: "\n", width: 0, kind: "whitespace" });
      index += 1;
      continue;
    }

    const segmentData = graphemeSegmenter.segment(text.slice(index))[Symbol.iterator]().next();
    const segment = segmentData.value?.segment ?? char;
    tokens.push({
      text: segment,
      width: graphemeWidth(segment, tabWidth),
      kind: /^\s+$/.test(segment) ? "whitespace" : "grapheme",
    });
    index += segment.length;
  }

  return tokens;
}

function tokensToString(tokens: WrapToken[], state?: ActiveAnsiState): string {
  const text = tokens.map((token) => token.text).join("");
  return state ? text + suffixForState(state) : text;
}

function tokenWidths(tokens: WrapToken[]): number {
  return tokens.reduce((sum, token) => sum + token.width, 0);
}

function rebaseLine(tokens: WrapToken[], state: ActiveAnsiState): WrapToken[] {
  return [...prefixForState(state), ...tokens];
}

function wrapTextWithAnsiFallback(
  text: string,
  width: number,
  tabWidth = DEFAULT_TAB_WIDTH,
): string[] {
  const maxWidth = Math.max(1, Math.floor(width) || 1);
  const tokens = tokenizeForWrap(text, tabWidth);
  const lines: string[] = [];
  const activeState: ActiveAnsiState = { osc8Open: null, sgrCodes: [] };

  let lineTokens: WrapToken[] = [];
  let lineWidth = 0;
  let lastWhitespaceIndex = -1;
  let stateAtLastWhitespace: ActiveAnsiState | null = null;

  const refreshBreakPoint = (): void => {
    lastWhitespaceIndex = -1;
    stateAtLastWhitespace = null;
    for (let i = lineTokens.length - 1; i >= 0; i -= 1) {
      if (lineTokens[i]?.kind === "whitespace" && lineTokens[i]?.text !== "\n") {
        lastWhitespaceIndex = i;
        stateAtLastWhitespace = cloneActiveState(activeState);
        return;
      }
    }
  };

  const pushLine = (tokensToPush: WrapToken[], state: ActiveAnsiState): void => {
    lines.push(tokensToString(tokensToPush, state));
  };

  for (const token of tokens) {
    if (token.kind === "ansi") {
      lineTokens.push(token);
      updateActiveAnsiState(activeState, token.text);
      continue;
    }

    if (token.text === "\n") {
      pushLine(lineTokens, activeState);
      lineTokens = prefixForState(activeState);
      lineWidth = 0;
      lastWhitespaceIndex = -1;
      stateAtLastWhitespace = null;
      continue;
    }

    lineTokens.push(token);
    lineWidth += token.width;

    if (token.kind === "whitespace") {
      lastWhitespaceIndex = lineTokens.length - 1;
      stateAtLastWhitespace = cloneActiveState(activeState);
    }

    if (lineWidth <= maxWidth) continue;

    if (lastWhitespaceIndex >= 0 && stateAtLastWhitespace) {
      const before = lineTokens.slice(0, lastWhitespaceIndex);
      const after = lineTokens.slice(lastWhitespaceIndex + 1);
      pushLine(before, stateAtLastWhitespace);
      lineTokens = rebaseLine(after, stateAtLastWhitespace);
      lineWidth = tokenWidths(lineTokens);
      refreshBreakPoint();
      continue;
    }

    const current = lineTokens.pop();
    lineWidth -= current?.width ?? 0;

    if (lineTokens.length > 0) {
      pushLine(lineTokens, activeState);
      lineTokens = rebaseLine(current ? [current] : [], activeState);
      lineWidth = current?.width ?? 0;
    } else if (current) {
      pushLine([current], activeState);
      lineTokens = prefixForState(activeState);
      lineWidth = 0;
    }

    refreshBreakPoint();
  }

  if (lineTokens.length > 0 || lines.length === 0) {
    lines.push(tokensToString(lineTokens, activeState));
  }

  return lines;
}

/**
 * Word-wrap text to a visible width, preserving ANSI escape codes across
 * line breaks.
 *
 * Active SGR codes (colors, bold, etc.) are carried to continuation lines.
 * Underline and strikethrough are reset at line ends and restored on the
 * next line.
 */
export function wrapTextWithAnsi(
  text: string,
  width: number,
  tabWidth?: number,
): string[] {
  return withNativeFallback(
    "wrapTextWithAnsi",
    () =>
      (native as Record<string, Function>).wrapTextWithAnsi(
        text,
        width,
        tabWidth,
      ) as string[],
    () => wrapTextWithAnsiFallback(text, width, tabWidth),
  );
}

/**
 * Truncate text to a visible width with an optional ellipsis.
 *
 * @param text       Input string (may contain ANSI codes).
 * @param maxWidth   Maximum visible width in terminal cells.
 * @param ellipsisKind  0 = "\u2026", 1 = "...", 2 = none.
 * @param pad        When true, pad with spaces to exactly `maxWidth`.
 * @param tabWidth   Tab stop width (default 3, range 1-16).
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsisKind: number,
  pad: boolean,
  tabWidth?: number,
): string {
  return (native as Record<string, Function>).truncateToWidth(
    text,
    maxWidth,
    ellipsisKind,
    pad,
    tabWidth,
  ) as string;
}

/**
 * Slice a range of visible columns from a line.
 *
 * Counts terminal cells (skipping ANSI escapes). When `strict` is true,
 * wide characters that would exceed the range are excluded.
 */
export function sliceWithWidth(
  line: string,
  startCol: number,
  length: number,
  strict: boolean,
  tabWidth?: number,
): SliceResult {
  return (native as Record<string, Function>).sliceWithWidth(
    line,
    startCol,
    length,
    strict,
    tabWidth,
  ) as SliceResult;
}

/**
 * Extract the before/after segments around an overlay region.
 *
 * ANSI state is tracked so the `after` segment renders correctly even when
 * the overlay truncates styled text.
 */
export function extractSegments(
  line: string,
  beforeEnd: number,
  afterStart: number,
  afterLen: number,
  strictAfter: boolean,
  tabWidth?: number,
): ExtractSegmentsResult {
  return (native as Record<string, Function>).extractSegments(
    line,
    beforeEnd,
    afterStart,
    afterLen,
    strictAfter,
    tabWidth,
  ) as ExtractSegmentsResult;
}

/**
 * Strip ANSI escape sequences, remove control characters and lone
 * surrogates, and normalize line endings (CR removed).
 *
 * Returns the original string when no changes are needed (zero-copy).
 */
export function sanitizeText(text: string): string {
  return (native as Record<string, Function>).sanitizeText(text) as string;
}

/**
 * Calculate visible width of text excluding ANSI escape sequences.
 *
 * Tabs count as `tabWidth` cells (default 3).
 */
export function visibleWidth(text: string, tabWidth?: number): number {
  return withNativeFallback(
    "visibleWidth",
    () =>
      (native as Record<string, Function>).visibleWidth(
        text,
        tabWidth,
      ) as number,
    () => visibleWidthFallback(text, tabWidth),
  );
}
