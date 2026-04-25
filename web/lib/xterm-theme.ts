export type XtermPaletteMode = "classic" | "vivid";

const XTERM_CLASSIC_DARK_THEME = {
  background: "#18181e",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  cursorAccent: "#18181e",
  selectionBackground: "#2a2f3f",
  selectionForeground: "#e4e4e7",
  black: "#1e1e24",
  red: "#cc6666",
  green: "#b5bd68",
  yellow: "#e6b800",
  blue: "#5f87ff",
  magenta: "#9575cd",
  cyan: "#00d7ff",
  white: "#e4e4e7",
  brightBlack: "#666666",
  brightRed: "#e07b7b",
  brightGreen: "#c3cf79",
  brightYellow: "#f0c95a",
  brightBlue: "#81a2ff",
  brightMagenta: "#b294bb",
  brightCyan: "#53e5ff",
  brightWhite: "#fafafa",
} as const;

const XTERM_VIVID_DARK_THEME = {
  background: "#05070f",
  foreground: "#e6edf3",
  cursor: "#e6edf3",
  cursorAccent: "#05070f",
  selectionBackground: "#1b2440",
  selectionForeground: "#e6edf3",
  black: "#111827",
  red: "#ff6b8a",
  green: "#34d399",
  yellow: "#ffd166",
  blue: "#4f8cff",
  magenta: "#d266ff",
  cyan: "#22d3ee",
  white: "#e6edf3",
  brightBlack: "#64748b",
  brightRed: "#ff8fab",
  brightGreen: "#4ade80",
  brightYellow: "#ffe08a",
  brightBlue: "#82b1ff",
  brightMagenta: "#e29bff",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
} as const;

const XTERM_CLASSIC_LIGHT_THEME = {
  background: "#f5f5f5",
  foreground: "#18181b",
  cursor: "#18181b",
  cursorAccent: "#f5f5f5",
  selectionBackground: "#d4d4d8",
  selectionForeground: "#18181b",
  black: "#18181b",
  red: "#b91c1c",
  green: "#166534",
  yellow: "#854d0e",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0f766e",
  white: "#52525b",
  brightBlack: "#71717a",
  brightRed: "#dc2626",
  brightGreen: "#15803d",
  brightYellow: "#713f12",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0f766e",
  brightWhite: "#27272a",
} as const;

const XTERM_VIVID_LIGHT_THEME = {
  background: "#f8fafc",
  foreground: "#0f172a",
  cursor: "#0f172a",
  cursorAccent: "#f8fafc",
  selectionBackground: "#cbd5e1",
  selectionForeground: "#0f172a",
  black: "#0f172a",
  red: "#be123c",
  green: "#166534",
  yellow: "#92400e",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0f766e",
  // Keep ANSI white entries readable on a light terminal surface.
  white: "#334155",
  brightBlack: "#475569",
  brightRed: "#e11d48",
  brightGreen: "#15803d",
  brightYellow: "#854d0e",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0e7490",
  brightWhite: "#1e293b",
} as const;

export function getXtermTheme(isDark: boolean, palette: XtermPaletteMode = "classic") {
  if (palette === "vivid") {
    return isDark ? XTERM_VIVID_DARK_THEME : XTERM_VIVID_LIGHT_THEME;
  }
  return isDark ? XTERM_CLASSIC_DARK_THEME : XTERM_CLASSIC_LIGHT_THEME;
}

export function getXtermOptions(isDark: boolean, fontSize?: number, palette: XtermPaletteMode = "classic") {
  return {
    cursorBlink: true,
    cursorStyle: "bar" as const,
    fontSize: fontSize ?? 13,
    fontFamily:
      "'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
    lineHeight: 1.35,
    letterSpacing: 0,
    theme: getXtermTheme(isDark, palette),
    allowProposedApi: true,
    scrollback: 10000,
    convertEol: false,
  };
}
